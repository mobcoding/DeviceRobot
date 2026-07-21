import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentPaths } from "@device-robot/config";
import type { AndroidProject } from "@device-robot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalProjectService, type ProjectCommandRunner } from "../src/projects/project-service.js";
import type { ProjectStore } from "../src/projects/project-store.js";

const temporaryDirectories: string[] = [];

function createAndroidProject(root: string): void {
  mkdirSync(join(root, "app", "src", "main"), { recursive: true });
  writeFileSync(join(root, "settings.gradle.kts"), 'include(":app")');
  writeFileSync(join(root, "build.gradle.kts"), "plugins { }");
  writeFileSync(join(root, "gradlew.bat"), "@echo off");
  writeFileSync(
    join(root, "app", "build.gradle.kts"),
    [
      "android {",
      '  defaultConfig { applicationId = "com.example.app" }',
      "  buildTypes { debug { } release { } }",
      "}",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "app", "src", "main", "AndroidManifest.xml"),
    '<manifest package="com.example.app"><application /></manifest>',
  );
}

class InMemoryProjectStore implements ProjectStore {
  readonly projects: AndroidProject[] = [];

  public list(): AndroidProject[] {
    return [...this.projects];
  }

  public findByRootPath(rootPath: string): AndroidProject | undefined {
    return this.projects.find((project) => project.rootPath === rootPath);
  }

  public create(project: AndroidProject): void {
    this.projects.push(project);
  }
}

function createFixture(runner?: ProjectCommandRunner): {
  root: string;
  store: InMemoryProjectStore;
  service: LocalProjectService;
  runner: ProjectCommandRunner;
} {
  const root = mkdtempSync(join(tmpdir(), "device-robot-project-"));
  temporaryDirectories.push(root);
  const store = new InMemoryProjectStore();
  const defaultRunner: ProjectCommandRunner = {
    run: vi.fn().mockResolvedValue({ stdout: "0123456789abcdef\n", stderr: "" }),
  };
  const commandRunner = runner ?? defaultRunner;
  return {
    root,
    store,
    runner: commandRunner,
    service: new LocalProjectService({
      paths: resolveAgentPaths(join(root, "agent-data")),
      store,
      gitExecutable: "git",
      runner: commandRunner,
    }),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Android project service", () => {
  it("registers and scans a local Gradle Android project without executing Gradle", async () => {
    const { root, service, store, runner } = createFixture();
    const projectRoot = join(root, "Example");
    mkdirSync(projectRoot);
    createAndroidProject(projectRoot);

    const project = await service.add({ source: "local", rootPath: projectRoot });

    expect(project).toMatchObject({
      name: "Example",
      source: "local",
      gradleWrapper: true,
      modules: expect.arrayContaining([
        expect.objectContaining({
          name: "app",
          path: "app",
          packageName: "com.example.app",
          applicationId: "com.example.app",
          variants: ["debug", "release"],
        }),
      ]),
    });
    expect(store.list()).toHaveLength(1);
    expect(runner.run).toHaveBeenCalledWith(
      "git",
      ["-C", project.rootPath, "rev-parse", "HEAD"],
      10_000,
    );
    await expect(service.add({ source: "local", rootPath: projectRoot })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("clones a HTTPS repository with fixed Git arguments before scanning it", async () => {
    const runner: ProjectCommandRunner = {
      run: vi.fn().mockImplementation(async (_executable, args: readonly string[]) => {
        if (args[0] === "clone") {
          const destination = args[4];
          if (destination === undefined) {
            throw new Error("Missing clone target");
          }
          mkdirSync(destination, { recursive: true });
          createAndroidProject(destination);
          return { stdout: "", stderr: "" };
        }
        return { stdout: "abcdef012345\n", stderr: "" };
      }),
    };
    const { service, runner: injectedRunner } = createFixture(runner);

    const project = await service.add({
      source: "git",
      remoteUrl: "https://github.com/example/android-app.git",
    });

    expect(project).toMatchObject({
      source: "git",
      remoteUrl: "https://github.com/example/android-app.git",
      revision: "abcdef012345",
    });
    expect(injectedRunner.run).toHaveBeenCalledWith(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "https://github.com/example/android-app.git",
        expect.stringContaining("android-app-"),
      ],
      300_000,
    );
  });

  it("rejects non-HTTPS repository addresses before starting Git", async () => {
    const { service, runner } = createFixture();

    await expect(
      service.add({ source: "git", remoteUrl: "ssh://git@example.com/private/project.git" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(runner.run).not.toHaveBeenCalled();
  });
});
