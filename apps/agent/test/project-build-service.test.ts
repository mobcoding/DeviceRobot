import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentPaths, type AgentPaths } from "@device-robot/config";
import type { AndroidProject, ProjectBuildRun } from "@device-robot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalProjectBuildService,
  ProjectBuildError,
  type ProjectBuildProcess,
  type ProjectBuildProcessResult,
  type ProjectBuildProcessRunner,
} from "../src/projects/project-build-service.js";
import type { ProjectBuildStore } from "../src/projects/project-build-store.js";
import type { ProjectStore } from "../src/projects/project-store.js";

const temporaryDirectories: string[] = [];

class InMemoryProjectStore implements ProjectStore {
  public constructor(private readonly project: AndroidProject) {}

  public list(): AndroidProject[] {
    return [this.project];
  }

  public findById(id: string): AndroidProject | undefined {
    return id === this.project.id ? this.project : undefined;
  }

  public findByRootPath(rootPath: string): AndroidProject | undefined {
    return rootPath === this.project.rootPath ? this.project : undefined;
  }

  public create(): void {}

  public updateName(): void {}

  public updateSourceIndex(): void {}
}

class InMemoryProjectBuildStore implements ProjectBuildStore {
  readonly runs: ProjectBuildRun[] = [];

  public recoverInterruptedRuns(finishedAt: string): void {
    for (const [index, run] of this.runs.entries()) {
      if (run.status === "running") {
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

  public findRunningByProject(projectId: string): ProjectBuildRun | undefined {
    return this.runs.find((run) => run.projectId === projectId && run.status === "running");
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
  #resolve: ((result: ProjectBuildProcessResult) => void) | undefined;

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
    this.#resolve = resolveCompleted!;
    return { completed, stop: async () => this.complete({ exitCode: 1, errorMessage: "Stopped" }) };
  }

  public complete(result: ProjectBuildProcessResult): void {
    this.#resolve?.(result);
  }
}

function createProject(rootPath: string): AndroidProject {
  return {
    id: "123e4567-e89b-12d3-a456-426614174000",
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
      expect.arrayContaining([expect.objectContaining({ modulePath: "library" })]),
    );

    const running = await service.start(project.id, {
      modulePath: "app",
      variant: "freeDebug",
      approved: true,
    });
    expect(running.status).toBe("running");
    expect(runner.starts).toEqual([
      expect.objectContaining({
        executable: join(root, "gradlew.bat"),
        args: ["--no-daemon", "--console=plain", ":app:assembleFreeDebug"],
        cwd: root,
        environment: expect.objectContaining({
          GRADLE_USER_HOME: join(root, "agent-data", "AIMobileTester", "gradle"),
        }),
      }),
    ]);
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

  it("rejects missing projects and cannot receive arbitrary Gradle task names", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-build-"));
    temporaryDirectories.push(root);
    const project = createProject(root);
    const service = new LocalProjectBuildService({
      paths: resolveAgentPaths(join(root, "agent-data")),
      projectStore: new InMemoryProjectStore(project),
      buildStore: new InMemoryProjectBuildStore(),
      runner: new ControlledBuildRunner(),
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
    await expect(
      service.start(project.id, { modulePath: "app", variant: "debug", approved: true }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
