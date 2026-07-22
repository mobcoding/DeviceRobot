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
  mkdirSync(join(root, "app", "src", "main", "res", "layout"), { recursive: true });
  mkdirSync(join(root, "app", "src", "main", "res", "navigation"), { recursive: true });
  mkdirSync(join(root, "app", "src", "main", "java", "com", "example", "app"), {
    recursive: true,
  });
  writeFileSync(
    join(root, "app", "src", "main", "res", "layout", "activity_main.xml"),
    [
      '<androidx.constraintlayout.widget.ConstraintLayout xmlns:android="http://schemas.android.com/apk/res/android">',
      '  <TextView android:id="@+id/title" />',
      "</androidx.constraintlayout.widget.ConstraintLayout>",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "app", "src", "main", "res", "navigation", "main_navigation.xml"),
    '<navigation xmlns:android="http://schemas.android.com/apk/res/android"><fragment android:id="@+id/home" android:name="com.example.app.HomeFragment" /></navigation>',
  );
  writeFileSync(
    join(root, "app", "src", "main", "java", "com", "example", "app", "HomeScreen.kt"),
    [
      "@Composable",
      "fun HomeScreen() = Unit",
      'fun routes() = composable("home") { }',
      "data class HomeState(val title: String)",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "app", "src", "main", "java", "com", "example", "app", "DeviceBridge.java"),
    "public class DeviceBridge {}",
  );
}

class InMemoryProjectStore implements ProjectStore {
  readonly projects: AndroidProject[] = [];

  public list(): AndroidProject[] {
    return [...this.projects];
  }

  public findById(id: string): AndroidProject | undefined {
    return this.projects.find((project) => project.id === id);
  }

  public findByRootPath(rootPath: string): AndroidProject | undefined {
    return this.projects.find((project) => project.rootPath === rootPath);
  }

  public create(project: AndroidProject): void {
    this.projects.push(project);
  }

  public updateName(id: string, name: string): void {
    const index = this.projects.findIndex((project) => project.id === id);
    if (index >= 0) {
      this.projects[index] = { ...this.projects[index]!, name };
    }
  }

  public updateSourceIndex(project: AndroidProject): void {
    const index = this.projects.findIndex((candidate) => candidate.id === project.id);
    if (index >= 0) {
      this.projects[index] = project;
    }
  }
}

function createFixture(
  runner?: ProjectCommandRunner,
  retryDelay?: (milliseconds: number) => Promise<void>,
): {
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
      ...(retryDelay === undefined ? {} : { retryDelay }),
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
    expect(project.sourceIndex).toMatchObject({
      schemaVersion: 1,
      summary: {
        filesScanned: 4,
        kotlinJavaFileCount: 2,
        xmlViewCount: 2,
        composeScreenCount: 1,
        navigationDestinationCount: 2,
        typeCount: 2,
      },
      evidence: expect.arrayContaining([
        expect.objectContaining({
          kind: "compose-screen",
          name: "HomeScreen",
          filePath: "app/src/main/java/com/example/app/HomeScreen.kt",
          line: 1,
        }),
        expect.objectContaining({
          kind: "navigation-destination",
          name: "home",
          filePath: "app/src/main/java/com/example/app/HomeScreen.kt",
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

  it("rebuilds a stored project's source index without executing Gradle", async () => {
    const { root, service, runner } = createFixture();
    const projectRoot = join(root, "Example");
    mkdirSync(projectRoot);
    createAndroidProject(projectRoot);
    const project = await service.add({ source: "local", rootPath: projectRoot });

    writeFileSync(
      join(projectRoot, "app", "src", "main", "res", "layout", "settings.xml"),
      "<LinearLayout><Button /></LinearLayout>",
    );
    const reindexed = await service.reindex(project.id);

    expect(reindexed.sourceIndex?.summary.xmlViewCount).toBe(4);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("recognizes build types and product flavors declared with Kotlin DSL functions", async () => {
    const { root, service } = createFixture();
    const projectRoot = join(root, "KotlinDslExample");
    mkdirSync(projectRoot);
    createAndroidProject(projectRoot);
    writeFileSync(
      join(projectRoot, "app", "build.gradle.kts"),
      [
        "android {",
        '  defaultConfig { applicationId = "com.example.app" }',
        "  buildTypes {",
        '    getByName("debug") { isDebuggable = true }',
        '    create("release") { isMinifyEnabled = true }',
        "  }",
        "  productFlavors {",
        '    create("free") { }',
        '    register("paid") { }',
        "  }",
        "}",
      ].join("\n"),
    );

    const project = await service.add({ source: "local", rootPath: projectRoot });

    expect(project.modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "app", variants: ["debug", "free", "paid", "release"] }),
      ]),
    );
  });

  it("updates module variants when a project is reindexed", async () => {
    const { root, service } = createFixture();
    const projectRoot = join(root, "ReindexKotlinDslExample");
    mkdirSync(projectRoot);
    createAndroidProject(projectRoot);
    const project = await service.add({ source: "local", rootPath: projectRoot });
    writeFileSync(
      join(projectRoot, "app", "build.gradle.kts"),
      'android { buildTypes { getByName("debug") { } create("release") { } } }',
    );

    const reindexed = await service.reindex(project.id);

    expect(reindexed.modules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "app", variants: ["debug", "release"] }),
      ]),
    );
  });

  it("clones a HTTPS repository with fixed Git arguments before scanning it", async () => {
    const runner: ProjectCommandRunner = {
      run: vi.fn().mockImplementation(async (_executable, args: readonly string[]) => {
        if (args[2] === "clone") {
          const destination = args[7];
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
      name: "android-app",
      source: "git",
      remoteUrl: "https://github.com/example/android-app.git",
      revision: "abcdef012345",
    });
    expect(injectedRunner.run).toHaveBeenCalledWith(
      "git",
      [
        "-c",
        "http.version=HTTP/1.1",
        "clone",
        "--depth",
        "1",
        "--no-tags",
        "https://github.com/example/android-app.git",
        expect.stringContaining("android-app-"),
      ],
      300_000,
    );
  });

  it("retries a transient Git transport failure after clearing the incomplete checkout", async () => {
    let cloneAttempts = 0;
    const retryDelay = vi.fn(async () => {});
    const runner: ProjectCommandRunner = {
      run: vi.fn().mockImplementation(async (_executable, args: readonly string[]) => {
        if (args[2] === "clone") {
          cloneAttempts += 1;
          const destination = args.at(-1);
          if (cloneAttempts === 1) {
            if (destination !== undefined) {
              mkdirSync(destination, { recursive: true });
              writeFileSync(join(destination, "partial"), "incomplete");
            }
            throw new Error("curl 56 Recv failure: Connection was reset");
          }
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
    const { service, runner: injectedRunner } = createFixture(runner, retryDelay);

    await expect(
      service.add({ source: "git", remoteUrl: "https://github.com/example/android-app.git" }),
    ).resolves.toMatchObject({ name: "android-app", source: "git" });
    expect(retryDelay).toHaveBeenCalledWith(800);
    expect(injectedRunner.run).toHaveBeenCalledTimes(3);
  });

  it("falls back to a filtered checkout when complete Git pack transfers keep disconnecting", async () => {
    let fullCloneAttempts = 0;
    const retryDelay = vi.fn(async () => {});
    const runner: ProjectCommandRunner = {
      run: vi.fn().mockImplementation(async (_executable, args: readonly string[]) => {
        const isClone = args.includes("clone");
        const isFilteredClone = args.includes("--filter=blob:none");
        if (isClone && !isFilteredClone) {
          fullCloneAttempts += 1;
          throw new Error("curl 56 Recv failure: Connection was reset");
        }
        if (isClone) {
          const destination = args.at(-1);
          if (destination === undefined) {
            throw new Error("Missing clone target");
          }
          mkdirSync(destination, { recursive: true });
          return { stdout: "", stderr: "" };
        }
        if (args.includes("checkout")) {
          const destination = args[1];
          if (destination === undefined) {
            throw new Error("Missing checkout target");
          }
          createAndroidProject(destination);
          return { stdout: "", stderr: "" };
        }
        return { stdout: "abcdef012345\n", stderr: "" };
      }),
    };
    const { service, runner: injectedRunner } = createFixture(runner, retryDelay);

    await expect(
      service.add({ source: "git", remoteUrl: "https://github.com/example/android-app.git" }),
    ).resolves.toMatchObject({ name: "android-app", source: "git" });

    expect(fullCloneAttempts).toBe(3);
    expect(retryDelay).toHaveBeenNthCalledWith(1, 800);
    expect(retryDelay).toHaveBeenNthCalledWith(2, 1_600);
    expect(injectedRunner.run).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["clone", "--filter=blob:none", "--no-checkout"]),
      300_000,
    );
    expect(injectedRunner.run).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining([
        "sparse-checkout",
        "set",
        "--no-cone",
        "/*",
        "!/.idea/",
        "!/docs/",
        "!/tools/",
      ]),
      30_000,
    );
    expect(injectedRunner.run).toHaveBeenCalledWith(
      "git",
      expect.arrayContaining(["fetch", "--refetch", "--filter=blob:limit=2m", "origin", "HEAD"]),
      300_000,
    );
  });

  it("normalizes existing Git project names from their remote URL", async () => {
    const { root, service, store } = createFixture();
    const projectRoot = join(root, "repositories", "android-app-a1b2c3d4");
    mkdirSync(projectRoot, { recursive: true });
    createAndroidProject(projectRoot);
    store.create({
      id: "123e4567-e89b-12d3-a456-426614174000",
      name: "android-app-a1b2c3d4",
      source: "git",
      rootPath: projectRoot,
      remoteUrl: "https://github.com/example/android-app.git",
      gradleWrapper: true,
      modules: [],
      createdAt: "2026-07-21T00:00:00.000Z",
      updatedAt: "2026-07-21T00:00:00.000Z",
    });

    await expect(service.list()).resolves.toEqual([
      expect.objectContaining({ id: "123e4567-e89b-12d3-a456-426614174000", name: "android-app" }),
    ]);
    expect(store.findById("123e4567-e89b-12d3-a456-426614174000")?.name).toBe("android-app");
  });

  it("rejects non-HTTPS repository addresses before starting Git", async () => {
    const { service, runner } = createFixture();

    await expect(
      service.add({ source: "git", remoteUrl: "ssh://git@example.com/private/project.git" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(runner.run).not.toHaveBeenCalled();
  });
});
