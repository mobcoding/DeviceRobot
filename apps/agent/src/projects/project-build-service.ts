import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { AgentPaths } from "@device-robot/config";
import {
  androidBuildTargetListResponseSchema,
  androidBuildTargetSchema,
  projectBuildRunListResponseSchema,
  projectBuildRunSchema,
  type AndroidBuildTarget,
  type AndroidBuildTargetListResponse,
  type AndroidProject,
  type AndroidSdkInfo,
  type ProjectBuildRun,
  type ProjectBuildRunListResponse,
  type StartProjectBuildRequest,
} from "@device-robot/contracts";

import { AndroidSdkService, AndroidSdkServiceError } from "../android/android-sdk-service.js";
import type { ProjectBuildStore } from "./project-build-store.js";
import type { ProjectStore } from "./project-store.js";
import {
  LocalProjectTemporarySigningService,
  ProjectTemporarySigningError,
  type ProjectTemporarySigningService,
  type TemporarySigningMaterial,
} from "./project-temporary-signing-service.js";

const execFileAsync = promisify(execFile);
const MAX_BUILD_ARTIFACTS = 100;
const MAX_ARTIFACT_DEPTH = 6;

export class ProjectBuildError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 422 | 503,
  ) {
    super(message);
  }
}

export type ProjectBuildProcessResult = {
  exitCode: number | null;
  errorMessage?: string;
};

export type ProjectBuildArtifact = {
  fileName: string;
  filePath: string;
  sizeBytes: number;
};

export interface ProjectBuildProcess {
  readonly completed: Promise<ProjectBuildProcessResult>;
  stop(): Promise<void>;
}

export interface ProjectBuildProcessRunner {
  start(options: {
    executable: string;
    args: readonly string[];
    cwd: string;
    environment: NodeJS.ProcessEnv;
    onOutput(chunk: string): void;
  }): ProjectBuildProcess;
}

export interface ProjectBuildService {
  listTargets(projectId: string): Promise<AndroidBuildTargetListResponse>;
  installSdk(projectId: string): Promise<AndroidSdkInfo>;
  listRuns(projectId: string): Promise<ProjectBuildRunListResponse>;
  getArtifact(
    projectId: string,
    runId: string,
    artifactIndex: number,
  ): Promise<ProjectBuildArtifact>;
  start(projectId: string, request: StartProjectBuildRequest): Promise<ProjectBuildRun>;
  dispose(): Promise<void>;
}

export type LocalProjectBuildServiceOptions = {
  paths: AgentPaths;
  projectStore: ProjectStore;
  buildStore: ProjectBuildStore;
  runner?: ProjectBuildProcessRunner;
  sdkService?: AndroidSdkService;
  temporarySigningService?: ProjectTemporarySigningService;
};

type ActiveBuild = {
  process: ProjectBuildProcess;
  logStream: WriteStream;
  project: AndroidProject;
  target: AndroidBuildTarget;
  run: ProjectBuildRun;
  temporarySigning?: TemporarySigningMaterial;
  cancelled: boolean;
  completion: Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relativeProjectPath(rootPath: string, path: string): string {
  const value = relative(rootPath, path).split(sep).join("/");
  return value.length === 0 ? "." : value;
}

function isPathWithin(rootPath: string, path: string): boolean {
  const pathRelative = relative(rootPath, path);
  return (
    pathRelative.length > 0 &&
    pathRelative !== ".." &&
    !pathRelative.startsWith(`..${sep}`) &&
    !isAbsolute(pathRelative)
  );
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function variantsForModule(project: AndroidProject, modulePath: string): string[] {
  const module = project.modules.find((candidate) => candidate.path === modulePath);
  if (module === undefined) {
    return [];
  }

  const buildTypes = module.variants.filter((variant) => /^(debug|release)$/iu.test(variant));
  const flavors = module.variants.filter((variant) => !/^(debug|release)$/iu.test(variant));
  const variants = new Set<string>(buildTypes);
  if (buildTypes.length > 0) {
    for (const flavor of flavors) {
      for (const buildType of buildTypes) {
        variants.add(`${flavor}${capitalize(buildType)}`);
      }
    }
  } else {
    for (const flavor of flavors) {
      variants.add(flavor);
    }
  }
  return [...variants].sort((left, right) => left.localeCompare(right, "en"));
}

function taskName(modulePath: string, variant: string): string {
  const moduleSegment = modulePath === "." ? "" : `${modulePath.replaceAll("/", ":")}:`;
  return `:${moduleSegment}assemble${capitalize(variant)}`;
}

export function discoverAndroidBuildTargets(project: AndroidProject): AndroidBuildTarget[] {
  return project.modules.flatMap((module) =>
    variantsForModule(project, module.path).map((variant) =>
      androidBuildTargetSchema.parse({
        modulePath: module.path,
        moduleName: module.name,
        variant,
        taskName: taskName(module.path, variant),
      }),
    ),
  );
}

function findWrapper(rootPath: string): string | undefined {
  const names =
    process.platform === "win32" ? ["gradlew.bat", "gradlew"] : ["gradlew", "gradlew.bat"];
  return names.map((name) => join(rootPath, name)).find((path) => existsSync(path));
}

function createDefaultRunner(): ProjectBuildProcessRunner {
  return {
    start: (options) => {
      const useWindowsCommand = process.platform === "win32" && options.executable.endsWith(".bat");
      const command = useWindowsCommand ? (process.env.ComSpec ?? "cmd.exe") : options.executable;
      const args = useWindowsCommand
        ? ["/d", "/s", "/c", `"${options.executable}" ${options.args.join(" ")}`]
        : [...options.args];
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.environment,
        shell: false,
        windowsHide: true,
        // cmd.exe must receive the wrapper path's quote characters verbatim.
        // Without this, Node escapes them as \" and every .bat wrapper fails before Gradle starts.
        windowsVerbatimArguments: useWindowsCommand,
      });

      const writeOutput = (chunk: Buffer | string): void => {
        options.onOutput(chunk.toString());
      };
      child.stdout?.on("data", writeOutput);
      child.stderr?.on("data", writeOutput);

      let settled = false;
      const complete = (result: ProjectBuildProcessResult): void => {
        if (!settled) {
          settled = true;
          resolveCompleted(result);
        }
      };
      let resolveCompleted: (result: ProjectBuildProcessResult) => void;
      const completed = new Promise<ProjectBuildProcessResult>((resolveCompletedPromise) => {
        resolveCompleted = resolveCompletedPromise;
      });
      child.once("error", (error) => complete({ exitCode: null, errorMessage: error.message }));
      child.once("close", (exitCode, signal) =>
        complete({
          exitCode,
          ...(signal === null ? {} : { errorMessage: `进程被信号 ${signal} 终止。` }),
        }),
      );

      return {
        completed,
        stop: async () => await stopChildProcess(child),
      };
    },
  };
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      await execFileAsync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
      });
      return;
    } catch {
      child.kill();
      return;
    }
  }
  child.kill("SIGTERM");
}

async function findApkArtifacts(
  project: AndroidProject,
  target: AndroidBuildTarget,
): Promise<string[]> {
  const moduleDirectory =
    target.modulePath === "."
      ? project.rootPath
      : join(project.rootPath, ...target.modulePath.split("/"));
  const outputRoot = join(moduleDirectory, "build", "outputs", "apk");
  const artifacts: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_ARTIFACT_DEPTH || artifacts.length >= MAX_BUILD_ARTIFACTS) {
      return;
    }
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      if (artifacts.length >= MAX_BUILD_ARTIFACTS) {
        return;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path, depth + 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".apk")) {
        artifacts.push(relativeProjectPath(project.rootPath, path));
      }
    }
  };
  await visit(outputRoot, 0);
  return artifacts;
}

function closeLogStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve) => {
    stream.once("error", resolve);
    stream.end(resolve);
  });
}

export class LocalProjectBuildService implements ProjectBuildService {
  readonly #paths: AgentPaths;
  readonly #projectStore: ProjectStore;
  readonly #buildStore: ProjectBuildStore;
  readonly #runner: ProjectBuildProcessRunner;
  readonly #sdkService: AndroidSdkService;
  readonly #temporarySigningService: ProjectTemporarySigningService;
  readonly #activeRuns = new Map<string, ActiveBuild>();

  public constructor(options: LocalProjectBuildServiceOptions) {
    this.#paths = options.paths;
    this.#projectStore = options.projectStore;
    this.#buildStore = options.buildStore;
    this.#runner = options.runner ?? createDefaultRunner();
    this.#sdkService = options.sdkService ?? new AndroidSdkService({ paths: options.paths });
    this.#temporarySigningService =
      options.temporarySigningService ??
      new LocalProjectTemporarySigningService({ paths: options.paths });
    this.#buildStore.recoverInterruptedRuns(new Date().toISOString());
  }

  public async listTargets(projectId: string): Promise<AndroidBuildTargetListResponse> {
    const project = this.#requireProject(projectId);
    const wrapper = findWrapper(project.rootPath);
    return androidBuildTargetListResponseSchema.parse({
      projectId,
      gradleWrapper: wrapper !== undefined,
      androidSdk: await this.#sdkService.inspect(project.rootPath, project.modules),
      targets: wrapper === undefined ? [] : discoverAndroidBuildTargets(project),
    });
  }

  public async installSdk(projectId: string): Promise<AndroidSdkInfo> {
    const project = this.#requireProject(projectId);
    try {
      return await this.#sdkService.install(project.rootPath, project.modules);
    } catch (error) {
      const message = error instanceof AndroidSdkServiceError ? error.message : errorMessage(error);
      throw new ProjectBuildError(`Android SDK 安装失败：${message}`, 503);
    }
  }

  public async listRuns(projectId: string): Promise<ProjectBuildRunListResponse> {
    this.#requireProject(projectId);
    return projectBuildRunListResponseSchema.parse({
      projectId,
      runs: this.#buildStore.listByProject(projectId),
    });
  }

  public async getArtifact(
    projectId: string,
    runId: string,
    artifactIndex: number,
  ): Promise<ProjectBuildArtifact> {
    const project = this.#requireProject(projectId);
    if (!Number.isSafeInteger(artifactIndex) || artifactIndex < 0) {
      throw new ProjectBuildError("构建产物编号无效。", 400);
    }
    const run = this.#buildStore
      .listByProject(projectId)
      .find((candidate) => candidate.id === runId);
    if (run === undefined) {
      throw new ProjectBuildError("未找到构建记录。", 404);
    }
    if (run.status !== "succeeded") {
      throw new ProjectBuildError("构建尚未完成，暂时不能使用其 APK 产物。", 409);
    }
    const artifactRelativePath = run.artifactPaths[artifactIndex];
    if (artifactRelativePath === undefined) {
      throw new ProjectBuildError("未找到指定的 APK 构建产物。", 404);
    }

    const requestedPath = resolve(project.rootPath, artifactRelativePath);
    if (
      !isPathWithin(project.rootPath, requestedPath) ||
      extname(requestedPath).toLocaleLowerCase() !== ".apk"
    ) {
      throw new ProjectBuildError("构建产物路径无效。", 422);
    }

    try {
      const [projectRoot, artifactPath] = await Promise.all([
        realpath(project.rootPath),
        realpath(requestedPath),
      ]);
      if (!isPathWithin(projectRoot, artifactPath)) {
        throw new ProjectBuildError("构建产物路径无效。", 422);
      }
      const metadata = await stat(artifactPath);
      if (!metadata.isFile()) {
        throw new ProjectBuildError("构建产物已不存在或不是文件。", 404);
      }
      return {
        fileName: basename(artifactPath),
        filePath: artifactPath,
        sizeBytes: metadata.size,
      };
    } catch (error) {
      if (error instanceof ProjectBuildError) {
        throw error;
      }
      throw new ProjectBuildError("构建产物已不存在或无法访问。", 404);
    }
  }

  public async start(
    projectId: string,
    request: StartProjectBuildRequest,
  ): Promise<ProjectBuildRun> {
    const project = this.#requireProject(projectId);
    if (this.#buildStore.findRunningByProject(projectId) !== undefined) {
      throw new ProjectBuildError("该项目已有构建正在执行。", 409);
    }
    const target = discoverAndroidBuildTargets(project).find(
      (candidate) =>
        candidate.modulePath === request.modulePath && candidate.variant === request.variant,
    );
    if (target === undefined) {
      throw new ProjectBuildError("所选构建变体不存在或当前不可执行。", 422);
    }
    const wrapper = findWrapper(project.rootPath);
    if (wrapper === undefined) {
      throw new ProjectBuildError("未找到 Gradle Wrapper，已拒绝执行构建。", 422);
    }
    const androidSdk = await this.#sdkService.inspect(project.rootPath, project.modules);
    if (
      !androidSdk.available ||
      androidSdk.path === undefined ||
      androidSdk.missingPackages.length > 0
    ) {
      const missing = androidSdk.missingPackages.join("、");
      throw new ProjectBuildError(
        missing.length === 0 ? "Android SDK 未就绪。" : `Android SDK 缺少：${missing}。`,
        503,
      );
    }

    const buildLogDirectory = join(this.#paths.logs, "builds");
    await mkdir(buildLogDirectory, { recursive: true });
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const logPath = join(buildLogDirectory, `${id}.log`);
    const run = projectBuildRunSchema.parse({
      id,
      projectId,
      modulePath: target.modulePath,
      variant: target.variant,
      taskName: target.taskName,
      status: "running",
      logPath,
      artifactPaths: [],
      message: "Gradle 构建正在执行。",
      startedAt,
    });
    this.#buildStore.create(run);

    const logStream = createWriteStream(logPath, { flags: "a", encoding: "utf8" });
    logStream.on("error", () => {});
    logStream.write(
      `# DeviceRobot Gradle build\n# Started: ${startedAt}\n# Task: ${target.taskName}\n\n`,
    );
    let buildProcess: ProjectBuildProcess;
    let temporarySigning: TemporarySigningMaterial | undefined;
    try {
      temporarySigning = await this.#temporarySigningService.prepare(project);
      if (temporarySigning !== undefined) {
        logStream.write(
          "\n[DeviceRobot] 已生成临时签名，仅用于本次本地构建，构建结束后将自动删除。\n",
        );
      }
      buildProcess = this.#runner.start({
        executable: wrapper,
        args: ["--no-daemon", "--console=plain", target.taskName],
        cwd: project.rootPath,
        environment: {
          ...process.env,
          GRADLE_USER_HOME: this.#paths.gradleHome,
          ANDROID_HOME: androidSdk.path,
          ANDROID_SDK_ROOT: androidSdk.path,
        },
        onOutput: (chunk) => logStream.write(chunk),
      });
    } catch (error) {
      await temporarySigning?.dispose();
      const failedRun = projectBuildRunSchema.parse({
        ...run,
        status: "failed",
        message:
          error instanceof ProjectTemporarySigningError
            ? error.message
            : `无法启动 Gradle Wrapper：${errorMessage(error)}`,
        exitCode: null,
        finishedAt: new Date().toISOString(),
      });
      await closeLogStream(logStream);
      this.#buildStore.finish(failedRun);
      return failedRun;
    }

    const active = {
      process: buildProcess,
      logStream,
      project,
      target,
      run,
      ...(temporarySigning === undefined ? {} : { temporarySigning }),
      cancelled: false,
      completion: Promise.resolve(),
    } satisfies ActiveBuild;
    active.completion = buildProcess.completed.then(async (result) => {
      await this.#complete(active, result);
    });
    this.#activeRuns.set(run.id, active);
    return run;
  }

  public async dispose(): Promise<void> {
    const activeRuns = [...this.#activeRuns.values()];
    for (const active of activeRuns) {
      active.cancelled = true;
    }
    await Promise.all(
      activeRuns.map(async (active) => {
        await active.process.stop();
        await active.completion;
      }),
    );
  }

  #requireProject(projectId: string): AndroidProject {
    const project = this.#projectStore.findById(projectId);
    if (project === undefined) {
      throw new ProjectBuildError("未找到项目。", 404);
    }
    if (!existsSync(project.rootPath)) {
      throw new ProjectBuildError("项目目录已不存在或无法访问。", 422);
    }
    return project;
  }

  async #complete(active: ActiveBuild, result: ProjectBuildProcessResult): Promise<void> {
    this.#activeRuns.delete(active.run.id);
    if (active.temporarySigning !== undefined) {
      try {
        await active.temporarySigning.dispose();
        active.logStream.write("[DeviceRobot] 临时签名已清理。\n");
      } catch (error) {
        active.logStream.write(`[DeviceRobot] 临时签名清理失败：${errorMessage(error)}\n`);
      }
    }
    await closeLogStream(active.logStream);
    const finishedAt = new Date().toISOString();
    const artifactPaths =
      !active.cancelled && result.exitCode === 0
        ? await findApkArtifacts(active.project, active.target)
        : [];
    const status = active.cancelled ? "cancelled" : result.exitCode === 0 ? "succeeded" : "failed";
    const message = active.cancelled
      ? "构建已因 Agent 停止而取消。"
      : result.exitCode === 0
        ? artifactPaths.length === 0
          ? "构建完成，未发现 APK 输出。"
          : `构建完成，发现 ${artifactPaths.length} 个 APK 输出。`
        : (result.errorMessage ?? "Gradle 构建失败。");
    const completedRun = projectBuildRunSchema.parse({
      ...active.run,
      status,
      artifactPaths,
      message,
      exitCode: result.exitCode,
      finishedAt,
    });
    this.#buildStore.finish(completedRun);
  }
}
