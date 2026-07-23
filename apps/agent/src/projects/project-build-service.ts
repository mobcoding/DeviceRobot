import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
import { scanAndroidProject } from "./project-service.js";
import {
  LocalProjectManagedSigningService,
  ProjectManagedSigningError,
  type ManagedSigningMaterial,
  type ProjectManagedSigningService,
} from "./project-temporary-signing-service.js";

const execFileAsync = promisify(execFile);
const MAX_BUILD_ARTIFACTS = 100;
const MAX_ARTIFACT_DEPTH = 6;
const MAX_CONCURRENT_BUILDS = 2;
const MAX_BUILD_FAILURE_MESSAGE_LENGTH = 8_000;
const MAX_GRADLE_DISTRIBUTION_DOWNLOAD_ATTEMPTS = 8;
const GRADLE_TASK_DISCOVERY_TIMEOUT_MS = 90_000;
const GENERIC_GRADLE_FAILURE_MESSAGE = "Gradle 构建失败。";
const ansiEscapeSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");
const gradleDistributionDownloads = new Map<string, Promise<boolean>>();

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
  output?: string;
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

export interface ProjectBuildTaskRunner {
  list(options: {
    executable: string;
    args: readonly string[];
    cwd: string;
    environment: NodeJS.ProcessEnv;
  }): Promise<ProjectBuildProcessResult>;
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
  taskRunner?: ProjectBuildTaskRunner;
  sdkService?: AndroidSdkService;
  managedSigningService?: ProjectManagedSigningService;
};

type ActiveBuild = {
  process: ProjectBuildProcess;
  logStream: WriteStream;
  project: AndroidProject;
  target: AndroidBuildTarget;
  run: ProjectBuildRun;
  managedSigning?: ManagedSigningMaterial;
  cancelled: boolean;
  completion: Promise<void>;
};

type QueuedBuild = {
  projectId: string;
  request: StartProjectBuildRequest;
  run: ProjectBuildRun;
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
  return project.modules.filter((module) => module.moduleType === "application").flatMap((module) =>
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

function variantFromAssembleTask(task: string): string | undefined {
  if (!/^assemble[A-Z][A-Za-z0-9]*$/u.test(task)) {
    return undefined;
  }
  const suffix = task.slice("assemble".length);
  if (/AndroidTest|UnitTest/u.test(suffix)) {
    return undefined;
  }
  return `${suffix.slice(0, 1).toLowerCase()}${suffix.slice(1)}`;
}

export function parseAndroidAssembleTasks(output: string): string[] {
  const variants = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const task = /^\s*(assemble[A-Za-z0-9]+)\s+-\s+/u.exec(line)?.[1];
    if (task === undefined) {
      continue;
    }
    const variant = variantFromAssembleTask(task);
    if (variant !== undefined) {
      variants.add(variant);
    }
  }
  return [...variants].sort((left, right) => left.localeCompare(right, "en"));
}

function findWrapper(rootPath: string): string | undefined {
  const names =
    process.platform === "win32" ? ["gradlew.bat", "gradlew"] : ["gradlew", "gradlew.bat"];
  return names.map((name) => join(rootPath, name)).find((path) => existsSync(path));
}

function wrapperDistributionUrl(contents: string): string | undefined {
  return /^\s*distributionUrl\s*=\s*(.+?)\s*$/mu.exec(contents)?.[1]
    ?.trim()
    .replaceAll("\\:", ":");
}

function wrapperDistributionArchiveName(distributionUrl: string): string | undefined {
  const path = distributionUrl
    .split(/[?#]/u, 1)[0]
    ?.split("/")
    .at(-1);
  return path?.endsWith(".zip") === true ? path : undefined;
}

async function hasZipEndRecord(path: string): Promise<boolean> {
  const metadata = await stat(path);
  const minimumSize = 22;
  if (!metadata.isFile() || metadata.size < minimumSize) {
    return false;
  }
  const length = Math.min(metadata.size, 65_557);
  const buffer = Buffer.alloc(length);
  const handle = await open(path, "r");
  try {
    await handle.read(buffer, 0, length, metadata.size - length);
  } finally {
    await handle.close();
  }
  for (let index = length - minimumSize; index >= 0; index -= 1) {
    if (
      buffer[index] === 0x50 &&
      buffer[index + 1] === 0x4b &&
      buffer[index + 2] === 0x05 &&
      buffer[index + 3] === 0x06
    ) {
      return true;
    }
  }
  return false;
}

export async function purgeCorruptGradleWrapperCache(
  projectRoot: string,
  gradleHome: string,
): Promise<number> {
  let properties: string;
  try {
    properties = await readFile(join(projectRoot, "gradle", "wrapper", "gradle-wrapper.properties"), "utf8");
  } catch {
    return 0;
  }
  const distributionUrl = wrapperDistributionUrl(properties);
  const archiveName =
    distributionUrl === undefined ? undefined : wrapperDistributionArchiveName(distributionUrl);
  if (archiveName === undefined) {
    return 0;
  }
  const distributionName = archiveName.slice(0, -".zip".length);
  const distributionRoot = join(gradleHome, "wrapper", "dists", distributionName);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(distributionRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const archivePath = join(distributionRoot, entry.name, archiveName);
    if (!existsSync(archivePath)) {
      continue;
    }
    try {
      if (!(await hasZipEndRecord(archivePath))) {
        await rm(dirname(archivePath), { force: true, recursive: true });
        removed += 1;
      }
    } catch {
      await rm(dirname(archivePath), { force: true, recursive: true });
      removed += 1;
    }
  }
  return removed;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function gradleDistributionChecksum(distributionUrl: string): Promise<string> {
  const response = await fetch(`${distributionUrl}.sha256`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const checksum = (await response.text()).trim().match(/[0-9a-f]{64}/iu)?.[0];
  if (checksum === undefined) {
    throw new Error("Gradle distribution checksum is invalid");
  }
  return checksum.toLowerCase();
}

export async function downloadGradleDistribution(
  distributionUrl: string,
  archivePath: string,
  checksum: string,
): Promise<boolean> {
  const key = resolve(archivePath);
  const existingDownload = gradleDistributionDownloads.get(key);
  if (existingDownload !== undefined) {
    return await existingDownload;
  }

  const download = downloadGradleDistributionOnce(distributionUrl, archivePath, checksum).finally(() => {
    if (gradleDistributionDownloads.get(key) === download) {
      gradleDistributionDownloads.delete(key);
    }
  });
  gradleDistributionDownloads.set(key, download);
  return await download;
}

async function downloadGradleDistributionOnce(
  distributionUrl: string,
  archivePath: string,
  checksum: string,
): Promise<boolean> {
  const temporaryPath = `${archivePath}.download`;
  if (!existsSync(temporaryPath) && existsSync(archivePath)) {
    // A failed rename is harmless: a concurrent Gradle process may already own the archive.
    await rename(archivePath, temporaryPath).catch(() => {});
  }

  try {
    for (let attempt = 0; attempt < MAX_GRADLE_DISTRIBUTION_DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        const downloaded = existsSync(temporaryPath) ? (await stat(temporaryPath)).size : 0;
        const response = await fetch(distributionUrl, {
          signal: AbortSignal.timeout(120_000),
          ...(downloaded === 0 ? {} : { headers: { Range: `bytes=${downloaded}-` } }),
        });
        if (!response.ok) {
          continue;
        }
        if (downloaded > 0 && response.status !== 206) {
          await rm(temporaryPath, { force: true });
          continue;
        }
        if (response.body === null) {
          continue;
        }
        if (!(await appendGradleDistributionResponse(response.body, temporaryPath, downloaded > 0))) {
          continue;
        }
        if ((await sha256(temporaryPath)).toLowerCase() === checksum) {
          await rm(archivePath, { force: true });
          await rename(temporaryPath, archivePath);
          return true;
        }
        await rm(temporaryPath, { force: true });
      } catch {
        // Keep the partially downloaded file and resume it on the next attempt.
      }
    }
    return false;
  } finally {
    if (!existsSync(archivePath) && existsSync(temporaryPath)) {
      await rename(temporaryPath, archivePath).catch(() => {});
    }
  }
}

async function appendGradleDistributionResponse(
  responseBody: ReadableStream<Uint8Array>,
  destination: string,
  append: boolean,
): Promise<boolean> {
  const stream = createWriteStream(destination, { flags: append ? "a" : "w" });
  const reader = responseBody.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!stream.write(value)) {
        await new Promise<void>((resolve) => {
          const settled = (): void => {
            stream.off("drain", settled);
            stream.off("error", settled);
            resolve();
          };
          stream.once("drain", settled);
          stream.once("error", settled);
        });
      }
    }
    await closeLogStream(stream);
    return true;
  } catch {
    await closeLogStream(stream);
    return false;
  } finally {
    reader.releaseLock();
  }
}

async function resumeGradleWrapperDownload(projectRoot: string, gradleHome: string): Promise<number> {
  let properties: string;
  try {
    properties = await readFile(join(projectRoot, "gradle", "wrapper", "gradle-wrapper.properties"), "utf8");
  } catch {
    return 0;
  }
  const distributionUrl = wrapperDistributionUrl(properties);
  const archiveName =
    distributionUrl === undefined ? undefined : wrapperDistributionArchiveName(distributionUrl);
  if (distributionUrl === undefined || archiveName === undefined) {
    return 0;
  }
  const distributionRoot = join(
    gradleHome,
    "wrapper",
    "dists",
    archiveName.slice(0, -".zip".length),
  );
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(distributionRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  let checksum: string;
  try {
    checksum = await gradleDistributionChecksum(distributionUrl);
  } catch {
    return 0;
  }
  let repaired = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const archivePath = join(distributionRoot, entry.name, archiveName);
    const temporaryPath = `${archivePath}.download`;
    if (!existsSync(archivePath) && existsSync(temporaryPath)) {
      await rename(temporaryPath, archivePath).catch(() => {});
    }
    if (!existsSync(archivePath) || (await hasZipEndRecord(archivePath))) {
      continue;
    }
    if (await downloadGradleDistribution(distributionUrl, archivePath, checksum)) {
      repaired += 1;
    }
  }
  return repaired;
}

function shouldRetryWrapperDownload(result: ProjectBuildProcessResult): boolean {
  return result.exitCode !== 0 && /zip END header not found/iu.test(result.output ?? "");
}

function trimBuildFailureMessage(message: string): string {
  return message.length <= MAX_BUILD_FAILURE_MESSAGE_LENGTH
    ? message
    : `${message.slice(0, MAX_BUILD_FAILURE_MESSAGE_LENGTH).trimEnd()}\n...`;
}

export function extractGradleFailureSummary(output: string | undefined): string | undefined {
  if (output === undefined || output.trim().length === 0) {
    return undefined;
  }

  const lines = output
    .replaceAll(ansiEscapeSequence, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n");
  const whatWentWrongIndex = lines.findIndex((line) =>
    /^\s*\*\s*What went wrong:\s*$/iu.test(line),
  );
  if (whatWentWrongIndex >= 0) {
    const details: string[] = [];
    for (const line of lines.slice(whatWentWrongIndex + 1)) {
      if (
        /^\s*\*\s*(Try|Exception is|Get more help):/iu.test(line) ||
        /^\s*BUILD FAILED\b/iu.test(line) ||
        /^\s*FAILURE:/iu.test(line)
      ) {
        break;
      }
      if (line.trim().length > 0) {
        details.push(line.trimEnd());
      }
    }
    const message = details.join("\n").trim();
    if (message.length > 0) {
      return trimBuildFailureMessage(message);
    }
  }

  const failureIndex = lines.findIndex((line) => /^\s*FAILURE:/iu.test(line));
  if (failureIndex >= 0) {
    const details = lines
      .slice(failureIndex + 1)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .filter((line) => !/^\s*\*\s*(Try|Get more help):/iu.test(line))
      .filter((line) => !/^\s*BUILD FAILED\b/iu.test(line));
    const message = details.join("\n").trim();
    if (message.length > 0) {
      return trimBuildFailureMessage(message);
    }
  }

  const fallbackStart = lines.findIndex((line) =>
    /^\s*(Could not|Unable to|Execution failed|A problem occurred|Exception in thread|Caused by:|Reason:|ERROR:)/iu.test(
      line,
    ),
  );
  if (fallbackStart >= 0) {
    const details = lines
      .slice(fallbackStart)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0)
      .filter((line) => !/^\s*at\s+/iu.test(line))
      .filter((line) => !/^\s*BUILD FAILED\b/iu.test(line))
      .slice(0, 12);
    const message = details.join("\n").trim();
    if (message.length > 0) {
      return trimBuildFailureMessage(message);
    }
  }

  return undefined;
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

      let output = "";
      const writeOutput = (chunk: Buffer | string): void => {
        const text = chunk.toString();
        output = `${output}${text}`.slice(-65_536);
        options.onOutput(text);
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
          output,
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

function createDefaultTaskRunner(): ProjectBuildTaskRunner {
  return {
    list: async (options) => {
      const process = createDefaultRunner().start({ ...options, onOutput: () => {} });
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        void process.stop();
      }, GRADLE_TASK_DISCOVERY_TIMEOUT_MS);
      try {
        const result = await process.completed;
        return timedOut
          ? {
              ...result,
              exitCode: null,
              errorMessage: `Gradle 任务发现超时（${GRADLE_TASK_DISCOVERY_TIMEOUT_MS / 1_000} 秒）。`,
            }
          : result;
      } finally {
        clearTimeout(timeout);
      }
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
  readonly #taskRunner: ProjectBuildTaskRunner;
  readonly #sdkService: AndroidSdkService;
  readonly #managedSigningService: ProjectManagedSigningService;
  readonly #activeRuns = new Map<string, ActiveBuild>();
  readonly #queuedBuilds: QueuedBuild[] = [];
  #launchingBuilds = 0;
  #disposed = false;

  public constructor(options: LocalProjectBuildServiceOptions) {
    this.#paths = options.paths;
    this.#projectStore = options.projectStore;
    this.#buildStore = options.buildStore;
    this.#runner = options.runner ?? createDefaultRunner();
    this.#taskRunner = options.taskRunner ?? createDefaultTaskRunner();
    this.#sdkService = options.sdkService ?? new AndroidSdkService({ paths: options.paths });
    this.#managedSigningService =
      options.managedSigningService ?? new LocalProjectManagedSigningService({ paths: options.paths });
    this.#buildStore.recoverInterruptedRuns(new Date().toISOString());
  }

  public async listTargets(projectId: string): Promise<AndroidBuildTargetListResponse> {
    const project = await this.#resolveProjectForBuild(projectId);
    const wrapper = findWrapper(project.rootPath);
    return androidBuildTargetListResponseSchema.parse({
      projectId,
      gradleWrapper: wrapper !== undefined,
      androidSdk: await this.#sdkService.inspect(project.rootPath, project.modules),
      targets: wrapper === undefined ? [] : await this.#discoverBuildTargets(project, wrapper),
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
    const runs = await Promise.all(
      this.#buildStore
        .listByProject(projectId)
        .map(async (run) => await this.#hydrateFailureMessage(run)),
    );
    return projectBuildRunListResponseSchema.parse({
      projectId,
      runs,
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
    queuedRun?: ProjectBuildRun,
  ): Promise<ProjectBuildRun> {
    if (this.#disposed) {
      if (queuedRun !== undefined) {
        return this.#cancelQueuedRun(queuedRun, "Agent 停止前的排队构建已取消。");
      }
      throw new ProjectBuildError("Agent 正在停止，无法创建构建任务。", 503);
    }
    const project = await this.#resolveProjectForBuild(projectId);
    if (queuedRun === undefined && this.#buildStore.findPendingByProject(projectId) !== undefined) {
      throw new ProjectBuildError("该项目已有构建正在运行或排队。", 409);
    }
    const wrapper = findWrapper(project.rootPath);
    if (wrapper === undefined) {
      throw new ProjectBuildError("未找到 Gradle Wrapper，已拒绝执行构建。", 422);
    }
    const target = (await this.#discoverBuildTargets(project, wrapper)).find(
      (candidate) =>
        candidate.modulePath === request.modulePath && candidate.variant === request.variant,
    );
    if (target === undefined) {
      throw new ProjectBuildError("所选构建变体不存在或当前不可执行。", 422);
    }
    if (queuedRun === undefined) {
      const id = randomUUID();
      const run = projectBuildRunSchema.parse({
        id,
        projectId,
        modulePath: target.modulePath,
        variant: target.variant,
        taskName: target.taskName,
        status: "queued",
        logPath: join(this.#paths.logs, "builds", `${id}.log`),
        artifactPaths: [],
        message: "构建任务正在排队。",
        startedAt: new Date().toISOString(),
      });
      this.#buildStore.create(run);
      this.#queuedBuilds.push({ projectId, request, run });
      this.#drainBuildQueue();
      return run;
    }
    let androidSdk: AndroidSdkInfo;
    try {
      androidSdk = await this.#sdkService.install(project.rootPath, project.modules);
    } catch (error) {
      const message = error instanceof AndroidSdkServiceError ? error.message : errorMessage(error);
      throw new ProjectBuildError(`自动准备 Android SDK 失败：${message}`, 503);
    }
    if (this.#disposed) {
      return this.#cancelQueuedRun(queuedRun, "Agent 停止前的排队构建已取消。");
    }
    if (!androidSdk.available || androidSdk.path === undefined || androidSdk.missingPackages.length > 0) {
      const missing = androidSdk.missingPackages.join("、");
      throw new ProjectBuildError(
        missing.length === 0 ? "Android SDK 未就绪。" : `Android SDK 缺少：${missing}。`,
        503,
      );
    }
    const repairedWrapperArchives = await resumeGradleWrapperDownload(
      project.rootPath,
      this.#paths.gradleHome,
    );
    const purgedWrapperArchives = await purgeCorruptGradleWrapperCache(
      project.rootPath,
      this.#paths.gradleHome,
    );

    const buildLogDirectory = join(this.#paths.logs, "builds");
    await mkdir(buildLogDirectory, { recursive: true });
    const run = projectBuildRunSchema.parse({
      ...queuedRun,
      taskName: target.taskName,
      status: "running",
      message: "Gradle 构建正在执行。",
    });
    this.#buildStore.finish(run);

    const logStream = createWriteStream(run.logPath, { flags: "a", encoding: "utf8" });
    logStream.on("error", () => {});
    logStream.write(
      `# DeviceRobot Gradle build\n# Started: ${run.startedAt}\n# Task: ${target.taskName}\n\n`,
    );
    let buildProcess: ProjectBuildProcess;
    let managedSigning: ManagedSigningMaterial | undefined;
    const startBuildProcess = (): ProjectBuildProcess =>
      this.#runner.start({
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
    try {
      if (repairedWrapperArchives > 0) {
        logStream.write(
          `[DeviceRobot] 已从断点续传修复 ${repairedWrapperArchives} 个 Gradle Wrapper 缓存。\n`,
        );
      }
      if (purgedWrapperArchives > 0) {
        logStream.write(
          `[DeviceRobot] 已清理 ${purgedWrapperArchives} 个损坏的 Gradle Wrapper 缓存，将自动重新下载。\n`,
        );
      }
      managedSigning = await this.#managedSigningService.prepare(project);
      if (managedSigning !== undefined) {
        logStream.write(
          "\n[DeviceRobot] 已准备本地受管调试签名；项目内副本会在构建结束后删除，受管密钥会保留以支持后续覆盖安装。\n",
        );
      }
      buildProcess = startBuildProcess();
    } catch (error) {
      await managedSigning?.dispose();
      const failedRun = projectBuildRunSchema.parse({
        ...run,
        status: "failed",
        message:
          error instanceof ProjectManagedSigningError
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
      ...(managedSigning === undefined ? {} : { managedSigning }),
      cancelled: false,
      completion: Promise.resolve(),
    } satisfies ActiveBuild;
    active.completion = buildProcess.completed.then(async (initialResult) => {
      let result = initialResult;
      if (!active.cancelled && shouldRetryWrapperDownload(result)) {
        const repairedArchives = await resumeGradleWrapperDownload(
          project.rootPath,
          this.#paths.gradleHome,
        );
        if (repairedArchives > 0) {
          active.logStream.write(
            `[DeviceRobot] Gradle Wrapper 缓存下载损坏，已清理并自动重试构建。\n`,
          );
          active.process = startBuildProcess();
          result = await active.process.completed;
        }
      }
      await this.#complete(active, result);
      this.#drainBuildQueue();
    });
    this.#activeRuns.set(run.id, active);
    return run;
  }

  public async dispose(): Promise<void> {
    this.#disposed = true;
    const queuedBuilds = this.#queuedBuilds.splice(0);
    for (const queued of queuedBuilds) {
      this.#cancelQueuedRun(queued.run, "Agent 停止前的排队构建已取消。");
    }
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

  #drainBuildQueue(): void {
    if (this.#disposed) {
      return;
    }
    while (
      this.#queuedBuilds.length > 0 &&
      this.#activeRuns.size + this.#launchingBuilds < MAX_CONCURRENT_BUILDS
    ) {
      const queued = this.#queuedBuilds.shift();
      if (queued === undefined) {
        return;
      }
      this.#launchingBuilds += 1;
      void this.start(queued.projectId, queued.request, queued.run)
        .catch((error) => {
          this.#buildStore.finish(
            projectBuildRunSchema.parse({
              ...queued.run,
              status: "failed",
              message: `无法启动排队构建：${errorMessage(error)}`,
              exitCode: null,
              finishedAt: new Date().toISOString(),
            }),
          );
        })
        .finally(() => {
          this.#launchingBuilds -= 1;
          this.#drainBuildQueue();
        });
    }
  }

  #cancelQueuedRun(run: ProjectBuildRun, message: string): ProjectBuildRun {
    const cancelledRun = projectBuildRunSchema.parse({
      ...run,
      status: "cancelled",
      message,
      finishedAt: new Date().toISOString(),
    });
    this.#buildStore.finish(cancelledRun);
    return cancelledRun;
  }

  async #discoverBuildTargets(
    project: AndroidProject,
    wrapper: string,
  ): Promise<AndroidBuildTarget[]> {
    const fallbackTargets = discoverAndroidBuildTargets(project);
    const applicationModules = project.modules.filter((module) => module.moduleType === "application");
    if (applicationModules.length === 0) {
      return fallbackTargets;
    }

    const targets = await Promise.all(
      applicationModules.map(async (module): Promise<AndroidBuildTarget[]> => {
        const moduleTask = module.path === "." ? "tasks" : `:${module.path.replaceAll("/", ":")}:tasks`;
        try {
          const result = await this.#taskRunner.list({
            executable: wrapper,
            args: ["--no-daemon", "--console=plain", moduleTask, "--all"],
            cwd: project.rootPath,
            environment: {
              ...process.env,
              GRADLE_USER_HOME: this.#paths.gradleHome,
            },
          });
          if (result.exitCode !== 0 || result.output === undefined) {
            return fallbackTargets.filter((target) => target.modulePath === module.path);
          }
          const variants = parseAndroidAssembleTasks(result.output);
          if (variants.length === 0) {
            return fallbackTargets.filter((target) => target.modulePath === module.path);
          }
          return variants.map((variant) =>
            androidBuildTargetSchema.parse({
              modulePath: module.path,
              moduleName: module.name,
              variant,
              taskName: taskName(module.path, variant),
            }),
          );
        } catch {
          return fallbackTargets.filter((target) => target.modulePath === module.path);
        }
      }),
    );
    return targets.flat().sort((left, right) => left.taskName.localeCompare(right.taskName, "en"));
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

  async #resolveProjectForBuild(projectId: string): Promise<AndroidProject> {
    const project = this.#requireProject(projectId);
    if (project.modules.every((module) => module.moduleType !== undefined)) {
      return project;
    }

    const scan = await scanAndroidProject(project.rootPath);
    const refreshed: AndroidProject = {
      ...project,
      ...scan,
      updatedAt: new Date().toISOString(),
    };
    this.#projectStore.updateSourceIndex(refreshed);
    return refreshed;
  }

  async #complete(active: ActiveBuild, result: ProjectBuildProcessResult): Promise<void> {
    this.#activeRuns.delete(active.run.id);
    if (active.managedSigning !== undefined) {
      try {
        await active.managedSigning.dispose();
        active.logStream.write("[DeviceRobot] 项目内调试签名副本已清理，受管密钥将保留以支持后续覆盖安装。\n");
      } catch (error) {
        active.logStream.write(`[DeviceRobot] 项目内调试签名副本清理失败：${errorMessage(error)}\n`);
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
        : (extractGradleFailureSummary(result.output) ??
          result.errorMessage ??
          GENERIC_GRADLE_FAILURE_MESSAGE);
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

  async #hydrateFailureMessage(run: ProjectBuildRun): Promise<ProjectBuildRun> {
    if (run.status !== "failed" || run.message !== GENERIC_GRADLE_FAILURE_MESSAGE) {
      return run;
    }
    try {
      const message = extractGradleFailureSummary(await readFile(run.logPath, "utf8"));
      if (message === undefined) {
        return run;
      }
      const hydratedRun = projectBuildRunSchema.parse({ ...run, message });
      this.#buildStore.finish(hydratedRun);
      return hydratedRun;
    } catch {
      return run;
    }
  }
}
