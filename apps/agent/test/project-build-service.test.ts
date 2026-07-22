import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentPaths, type AgentPaths } from "@device-robot/config";
import type { AndroidProject, ProjectBuildRun } from "@device-robot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  extractGradleFailureSummary,
  LocalProjectBuildService,
  ProjectBuildError,
  purgeCorruptGradleWrapperCache,
  type ProjectBuildProcess,
  type ProjectBuildProcessResult,
  type ProjectBuildProcessRunner,
} from "../src/projects/project-build-service.js";
import type { ProjectBuildStore } from "../src/projects/project-build-store.js";
import type { ProjectStore } from "../src/projects/project-store.js";

const temporaryDirectories: string[] = [];
const gradleFailureOutput = [
  "> Task :app:mergeReleaseResources FAILED",
  "",
  "FAILURE: Build failed with an exception.",
  "",
  "* What went wrong:",
  "Execution failed for task ':app:mergeReleaseResources'.",
  "> A failure occurred while executing com.android.build.gradle.internal.res.LinkApplicationAndroidResourcesTask$TaskAction",
  "   > Android resource linking failed",
  "",
  "* Try:",
  "> Run with --stacktrace option to get the stack trace.",
  "",
  "BUILD FAILED in 12s",
].join("\n");
const wrapperFailureOutput = [
  "Could not unzip C:\\agent-data\\gradle-8.14.5-bin.zip to C:\\agent-data\\gradle-8.14.5-bin.",
  "Reason: zip END header not found",
  'Exception in thread "main" java.util.zip.ZipException: zip END header not found',
  "\tat java.base/java.util.zip.ZipFile$Source.findEND(ZipFile.java:1649)",
].join("\n");

class InMemoryProjectStore implements ProjectStore {
  readonly #projects: AndroidProject[];

  public constructor(projects: AndroidProject | AndroidProject[]) {
    this.#projects = Array.isArray(projects) ? projects : [projects];
  }

  public list(): AndroidProject[] {
    return this.#projects;
  }

  public findById(id: string): AndroidProject | undefined {
    return this.#projects.find((project) => project.id === id);
  }

  public findByRootPath(rootPath: string): AndroidProject | undefined {
    return this.#projects.find((project) => project.rootPath === rootPath);
  }

  public create(): void {}

  public updateName(): void {}

  public updateSourceIndex(project: AndroidProject): void {
    const index = this.#projects.findIndex((candidate) => candidate.id === project.id);
    if (index >= 0) {
      this.#projects[index] = project;
    }
  }
}

class InMemoryProjectBuildStore implements ProjectBuildStore {
  readonly runs: ProjectBuildRun[] = [];

  public recoverInterruptedRuns(finishedAt: string): void {
    for (const [index, run] of this.runs.entries()) {
      if (run.status === "queued" || run.status === "running") {
        this.runs[index] = {
          ...run,
          status: "cancelled",
          message: "Agent 重启前的构建已取消。",
          finishedAt,
        };
      }
    }
  }

  public listByProject(projectId: string): ProjectBuildRun[] {
    return this.runs.filter((run) => run.projectId === projectId);
  }

  public findPendingByProject(projectId: string): ProjectBuildRun | undefined {
    return this.runs.find(
      (run) => run.projectId === projectId && (run.status === "queued" || run.status === "running"),
    );
  }

  public create(run: ProjectBuildRun): void {
    this.runs.unshift(run);
  }

  public finish(run: ProjectBuildRun): void {
    const index = this.runs.findIndex((candidate) => candidate.id === run.id);
    if (index >= 0) {
      this.runs[index] = run;
    }
  }
}

class ControlledBuildRunner implements ProjectBuildProcessRunner {
  readonly starts: Array<{
    executable: string;
    args: readonly string[];
    cwd: string;
    environment: NodeJS.ProcessEnv;
  }> = [];
  readonly #resolvers: Array<(result: ProjectBuildProcessResult) => void> = [];

  public start(options: {
    executable: string;
    args: readonly string[];
    cwd: string;
    environment: NodeJS.ProcessEnv;
    onOutput(chunk: string): void;
  }): ProjectBuildProcess {
    this.starts.push(options);
    options.onOutput("> Task :app:assembleFreeDebug\n");
    let resolveCompleted: (result: ProjectBuildProcessResult) => void;
    const completed = new Promise<ProjectBuildProcessResult>((resolve) => {
      resolveCompleted = resolve;
    });
    const resolve = resolveCompleted!;
    this.#resolvers.push(resolve);
    return {
      completed,
      stop: async () => this.#completeResolver(resolve, { exitCode: 1, errorMessage: "Stopped" }),
    };
  }

  public complete(result: ProjectBuildProcessResult): void {
    const resolve = this.#resolvers.shift();
    resolve?.(result);
  }

  #completeResolver(
    resolve: (result: ProjectBuildProcessResult) => void,
    result: ProjectBuildProcessResult,
  ): void {
    const index = this.#resolvers.indexOf(resolve);
    if (index >= 0) {
      this.#resolvers.splice(index, 1);
      resolve(result);
    }
  }
}

function createProject(
  rootPath: string,
  id = "123e4567-e89b-12d3-a456-426614174000",
): AndroidProject {
  return {
    id,
    name: "Example",
    source: "local",
    rootPath,
    gradleWrapper: true,
    modules: [
      {
        name: "app",
        path: "app",
        buildFile: "app/build.gradle.kts",
        moduleType: "application",
        variants: ["debug", "release", "free"],
      },
      {
        name: "library",
        path: "library",
        buildFile: "library/build.gradle.kts",
        moduleType: "library",
        variants: ["release"],
      },
      {
        name: "unknown",
        path: "unknown",
        buildFile: "unknown/build.gradle.kts",
        moduleType: "unknown",
        variants: ["release"],
      },
    ],
    createdAt: "2026-07-21T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
  };
}

function prepareManagedAndroidSdk(paths: AgentPaths): void {
  const executable = process.platform === "win32" ? "adb.exe" : "adb";
  mkdirSync(join(paths.androidSdk, "platform-tools"), { recursive: true });
  writeFileSync(join(paths.androidSdk, "platform-tools", executable), "");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Android project build service", () => {
  it("extracts the actionable Gradle failure section", () => {
    expect(extractGradleFailureSummary(gradleFailureOutput)).toBe(
      [
        "Execution failed for task ':app:mergeReleaseResources'.",
        "> A failure occurred while executing com.android.build.gradle.internal.res.LinkApplicationAndroidResourcesTask$TaskAction",
        "   > Android resource linking failed",
      ].join("\n"),
    );
  });

  it("extracts Gradle Wrapper download failures without a structured Gradle section", () => {
    expect(extractGradleFailureSummary(wrapperFailureOutput)).toBe(
      [
        "Could not unzip C:\\agent-data\\gradle-8.14.5-bin.zip to C:\\agent-data\\gradle-8.14.5-bin.",
        "Reason: zip END header not found",
        'Exception in thread "main" java.util.zip.ZipException: zip END header not found',
      ].join("\n"),
    );
  });

  it("hydrates historical generic build failures from their saved logs", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-build-"));
    temporaryDirectories.push(root);
    const paths = resolveAgentPaths(join(root, "agent-data"));
    const project = createProject(root);
    const store = new InMemoryProjectBuildStore();
    const logPath = join(paths.logs, "builds", "legacy-failure.log");
    mkdirSync(join(paths.logs, "builds"), { recursive: true });
    writeFileSync(logPath, wrapperFailureOutput);
    const legacyRun: ProjectBuildRun = {
      id: "323e4567-e89b-12d3-a456-426614174000",
      projectId: project.id,
      modulePath: "app",
      variant: "release",
      taskName: ":app:assembleRelease",
      status: "failed",
      logPath,
      artifactPaths: [],
      message: "Gradle 构建失败。",
      exitCode: 1,
      startedAt: "2026-07-22T16:45:30.134Z",
      finishedAt: "2026-07-22T16:46:06.073Z",
    };
    store.create(legacyRun);
    const service = new LocalProjectBuildService({
      paths,
      projectStore: new InMemoryProjectStore(project),
      buildStore: store,
    });

    const runs = await service.listRuns(project.id);

    expect(runs.runs[0]).toMatchObject({
      id: legacyRun.id,
      message: expect.stringContaining("zip END header not found"),
    });
    expect(store.runs[0]?.message).toContain("Could not unzip");
  });

  it("removes a corrupt Gradle Wrapper archive before starting a build", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-build-"));
    temporaryDirectories.push(root);
    const paths = resolveAgentPaths(join(root, "agent-data"));
    const wrapperDirectory = join(root, "gradle", "wrapper");
    mkdirSync(wrapperDirectory, { recursive: true });
    writeFileSync(
      join(wrapperDirectory, "gradle-wrapper.properties"),
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.5-bin.zip\n",
    );
    const cacheDirectory = join(
      paths.gradleHome,
      "wrapper",
      "dists",
      "gradle-8.14.5-bin",
      "test-cache",
    );
    const archivePath = join(cacheDirectory, "gradle-8.14.5-bin.zip");
    mkdirSync(cacheDirectory, { recursive: true });
    writeFileSync(archivePath, "partial download");

    await expect(purgeCorruptGradleWrapperCache(root, paths.gradleHome)).resolves.toBe(1);
    expect(existsSync(cacheDirectory)).toBe(false);

    mkdirSync(cacheDirectory, { recursive: true });
    const validZipEnd = Buffer.alloc(22);
    validZipEnd.set([0x50, 0x4b, 0x05, 0x06]);
    writeFileSync(archivePath, validZipEnd);
    await expect(purgeCorruptGradleWrapperCache(root, paths.gradleHome)).resolves.toBe(0);
    expect(existsSync(archivePath)).toBe(true);
  });

  it("refreshes legacy module metadata before listing APK targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-build-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "settings.gradle.kts"), 'include(":app")');
    writeFileSync(join(root, "build.gradle.kts"), "plugins { }");
    writeFileSync(join(root, "gradlew.bat"), "@echo off");
    writeFileSync(
      join(root, "app", "build.gradle.kts"),
      [
        'plugins { id("com.android.application") }',
        "android { buildTypes { debug { } release { } } }",
      ].join("\n"),
    );
    const legacyProject = createProject(root);
    legacyProject.modules = legacyProject.modules.map((module) => {
      const legacyModule = { ...module };
      delete legacyModule.moduleType;
      return legacyModule;
    });
    const store = new InMemoryProjectStore(legacyProject);
    const service = new LocalProjectBuildService({
      paths: resolveAgentPaths(join(root, "agent-data")),
      projectStore: store,
      buildStore: new InMemoryProjectBuildStore(),
    });

    const targets = await service.listTargets(legacyProject.id);

    expect(targets.targets).toEqual(
      expect.arrayContaining([expect.objectContaining({ taskName: ":app:assembleDebug" })]),
    );
    expect(store.findById(legacyProject.id)?.modules).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "app", moduleType: "application" })]),
    );
  });

  it("discovers supported variants and runs only the fixed Gradle Wrapper task after approval", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-build-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "app", "build", "outputs", "apk", "free", "debug"), {
      recursive: true,
    });
    writeFileSync(join(root, "gradlew.bat"), "@echo off");
    const project = createProject(root);
    const store = new InMemoryProjectBuildStore();
    const runner = new ControlledBuildRunner();
    const paths = resolveAgentPaths(join(root, "agent-data"));
    prepareManagedAndroidSdk(paths);
    const service = new LocalProjectBuildService({
      paths,
      projectStore: new InMemoryProjectStore(project),
      buildStore: store,
      runner,
    });

    const targets = await service.listTargets(project.id);

    expect(targets.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variant: "debug", taskName: ":app:assembleDebug" }),
        expect.objectContaining({ variant: "freeDebug", taskName: ":app:assembleFreeDebug" }),
        expect.objectContaining({ variant: "freeRelease", taskName: ":app:assembleFreeRelease" }),
      ]),
    );
    expect(targets.targets).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modulePath: "library" }),
        expect.objectContaining({ modulePath: "unknown" }),
      ]),
    );

    const running = await service.start(project.id, {
      modulePath: "app",
      variant: "freeDebug",
      approved: true,
    });
    expect(running.status).toBe("queued");
    await vi.waitFor(() =>
      expect(runner.starts).toEqual([
        expect.objectContaining({
          executable: join(root, "gradlew.bat"),
          args: ["--no-daemon", "--console=plain", ":app:assembleFreeDebug"],
          cwd: root,
          environment: expect.objectContaining({
            GRADLE_USER_HOME: join(root, "agent-data", "AIMobileTester", "gradle"),
          }),
        }),
      ]),
    );
    await expect(
      service.start(project.id, { modulePath: "app", variant: "debug", approved: true }),
    ).rejects.toBeInstanceOf(ProjectBuildError);

    writeFileSync(
      join(root, "app", "build", "outputs", "apk", "free", "debug", "app-free-debug.apk"),
      "apk",
    );
    runner.complete({ exitCode: 0 });
    await vi.waitFor(async () => {
      const runs = await service.listRuns(project.id);
      expect(runs.runs[0]).toMatchObject({
        id: running.id,
        status: "succeeded",
        artifactPaths: ["app/build/outputs/apk/free/debug/app-free-debug.apk"],
      });
    });

    await expect(service.getArtifact(project.id, running.id, 0)).resolves.toMatchObject({
      fileName: "app-free-debug.apk",
      filePath: join(root, "app", "build", "outputs", "apk", "free", "debug", "app-free-debug.apk"),
      sizeBytes: 3,
    });
    await expect(service.getArtifact(project.id, running.id, 1)).rejects.toMatchObject({
      statusCode: 404,
    });

    store.runs[0] = {
      ...store.runs[0]!,
      artifactPaths: ["../outside.apk"],
    };
    await expect(service.getArtifact(project.id, running.id, 0)).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it.skipIf(process.platform !== "win32")(
    "starts a Windows Gradle Wrapper batch file without escaping its quote characters",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "device-robot-build-"));
      temporaryDirectories.push(root);
      writeFileSync(
        join(root, "gradlew.bat"),
        "@echo off\r\necho wrapper-ran\r\necho task=%3\r\nexit /b 0\r\n",
      );
      const project = createProject(root);
      const paths = resolveAgentPaths(join(root, "agent-data"));
      prepareManagedAndroidSdk(paths);
      const service = new LocalProjectBuildService({
        paths,
        projectStore: new InMemoryProjectStore(project),
        buildStore: new InMemoryProjectBuildStore(),
      });

      const running = await service.start(project.id, {
        modulePath: "app",
        variant: "debug",
        approved: true,
      });
      await vi.waitFor(async () => {
        const runs = await service.listRuns(project.id);
        expect(runs.runs[0]).toMatchObject({ id: running.id, status: "succeeded", exitCode: 0 });
      });

      const runs = await service.listRuns(project.id);
      expect(readFileSync(runs.runs[0]!.logPath, "utf8")).toContain("wrapper-ran");
    },
  );

  it("rejects missing projects and arbitrary Gradle task names", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-build-"));
    temporaryDirectories.push(root);
    const project = createProject(root);
    const runner = new ControlledBuildRunner();
    const paths = resolveAgentPaths(join(root, "agent-data"));
    prepareManagedAndroidSdk(paths);
    const service = new LocalProjectBuildService({
      paths,
      projectStore: new InMemoryProjectStore(project),
      buildStore: new InMemoryProjectBuildStore(),
      runner,
    });

    await expect(service.listTargets("123e4567-e89b-12d3-a456-426614174999")).rejects.toMatchObject(
      {
        statusCode: 404,
      },
    );
    await expect(
      service.start(project.id, { modulePath: "app", variant: "clean", approved: true }),
    ).rejects.toMatchObject({ statusCode: 422 });
    writeFileSync(join(root, "gradlew.bat"), "@echo off");
    const running = await service.start(project.id, {
      modulePath: "app",
      variant: "debug",
      approved: true,
    });
    expect(running.status).toBe("queued");
    await vi.waitFor(() => expect(runner.starts).toHaveLength(1));
    runner.complete({ exitCode: 1, output: gradleFailureOutput });
    await vi.waitFor(async () => {
      const runs = await service.listRuns(project.id);
      expect(runs.runs[0]).toMatchObject({
        id: running.id,
        status: "failed",
        exitCode: 1,
        message: expect.stringContaining("Android resource linking failed"),
      });
    });
  });

  it("runs at most two builds globally and starts the next queued build after a slot opens", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-build-"));
    temporaryDirectories.push(root);
    const projectRoots = ["first", "second", "third"].map((name) => join(root, name));
    const projects = projectRoots.map((projectRoot, index) => {
      mkdirSync(join(projectRoot, "app"), { recursive: true });
      writeFileSync(join(projectRoot, "gradlew.bat"), "@echo off");
      return createProject(
        projectRoot,
        `123e4567-e89b-12d3-a456-42661417400${index + 1}`,
      );
    });
    const paths = resolveAgentPaths(join(root, "agent-data"));
    prepareManagedAndroidSdk(paths);
    const store = new InMemoryProjectBuildStore();
    const runner = new ControlledBuildRunner();
    const service = new LocalProjectBuildService({
      paths,
      projectStore: new InMemoryProjectStore(projects),
      buildStore: store,
      runner,
    });

    const runs = await Promise.all(
      projects.map(async (project) =>
        await service.start(project.id, { modulePath: "app", variant: "debug", approved: true }),
      ),
    );

    expect(runs.map((run) => run.status)).toEqual(["queued", "queued", "queued"]);
    await vi.waitFor(() => expect(runner.starts).toHaveLength(2));
    expect(store.listByProject(projects[2]!.id)[0]).toMatchObject({
      id: runs[2]!.id,
      status: "queued",
    });

    runner.complete({ exitCode: 0 });
    await vi.waitFor(() => expect(runner.starts).toHaveLength(3));
    await vi.waitFor(async () => {
      const queuedProjectRuns = await service.listRuns(projects[2]!.id);
      expect(queuedProjectRuns.runs[0]).toMatchObject({ id: runs[2]!.id, status: "running" });
    });

    runner.complete({ exitCode: 0 });
    runner.complete({ exitCode: 0 });
    await vi.waitFor(async () => {
      const completedRuns = await Promise.all(
        projects.map(async (project) => await service.listRuns(project.id)),
      );
      expect(completedRuns.flatMap((response) => response.runs)).toEqual(
        expect.arrayContaining(runs.map((run) => expect.objectContaining({ id: run.id, status: "succeeded" }))),
      );
    });
  });

  it("cancels queued builds when the Agent stops", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-build-"));
    temporaryDirectories.push(root);
    const projectRoots = ["first", "second", "third"].map((name) => join(root, name));
    const projects = projectRoots.map((projectRoot, index) => {
      mkdirSync(join(projectRoot, "app"), { recursive: true });
      writeFileSync(join(projectRoot, "gradlew.bat"), "@echo off");
      return createProject(
        projectRoot,
        `223e4567-e89b-12d3-a456-42661417400${index + 1}`,
      );
    });
    const paths = resolveAgentPaths(join(root, "agent-data"));
    prepareManagedAndroidSdk(paths);
    const store = new InMemoryProjectBuildStore();
    const runner = new ControlledBuildRunner();
    const service = new LocalProjectBuildService({
      paths,
      projectStore: new InMemoryProjectStore(projects),
      buildStore: store,
      runner,
    });
    const runs = await Promise.all(
      projects.map(async (project) =>
        await service.start(project.id, { modulePath: "app", variant: "debug", approved: true }),
      ),
    );

    await vi.waitFor(() => expect(runner.starts).toHaveLength(2));
    await service.dispose();

    expect(store.runs).toEqual(
      expect.arrayContaining(
        runs.map((run) => expect.objectContaining({ id: run.id, status: "cancelled" })),
      ),
    );
    expect(store.listByProject(projects[2]!.id)[0]).toMatchObject({
      id: runs[2]!.id,
      message: "Agent 停止前的排队构建已取消。",
    });
  });
});
