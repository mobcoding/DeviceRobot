import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentPaths } from "@device-robot/config";
import type { AndroidProject } from "@device-robot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalProjectManagedSigningService } from "../src/projects/project-temporary-signing-service.js";

const temporaryDirectories: string[] = [];

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
        variants: ["debug"],
      },
    ],
    createdAt: "2026-07-21T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
  };
}

function writeSigningBuildFile(root: string): void {
  const appDirectory = join(root, "app");
  writeFileSync(
    join(appDirectory, "build.gradle.kts"),
    `android {
  signingConfigs {
    getByName("debug") {
      storeFile = file("../doc/example.jks")
      storePassword = "123456"
      keyAlias = "key0"
      keyPassword = "123456"
    }
  }
}`,
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("managed project debug signing service", () => {
  it("generates a missing project-local JKS and removes its project copy after the build", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-signing-"));
    temporaryDirectories.push(root);
    const appDirectory = join(root, "app");
    mkdirSync(appDirectory, { recursive: true });
    writeSigningBuildFile(root);
    const keyStorePath = join(root, "doc", "example.jks");
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      writeFileSync(args[args.indexOf("-keystore") + 1]!, "temporary-key");
    });
    const service = new LocalProjectManagedSigningService({ runner: { run } });

    const material = await service.prepare(createProject(root));

    expect(material?.temporaryProjectPaths).toEqual([keyStorePath]);
    expect(existsSync(keyStorePath)).toBe(true);
    expect(run).toHaveBeenCalledWith(
      "keytool",
      expect.arrayContaining(["-storetype", "JKS", "-alias", "key0"]),
    );

    await material?.dispose();

    expect(existsSync(keyStorePath)).toBe(false);
    expect(existsSync(join(root, "doc"))).toBe(false);
  });

  it("does not replace an existing signing file", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-signing-"));
    temporaryDirectories.push(root);
    const appDirectory = join(root, "app");
    mkdirSync(appDirectory, { recursive: true });
    writeSigningBuildFile(root);
    const keyStorePath = join(root, "doc", "example.jks");
    mkdirSync(join(root, "doc"), { recursive: true });
    writeFileSync(keyStorePath, "existing-key");
    const run = vi.fn(async () => {});
    const service = new LocalProjectManagedSigningService({ runner: { run } });

    await expect(service.prepare(createProject(root))).resolves.toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(keyStorePath)).toBe(true);
  });

  it("reuses a managed local key while removing its project-local copy", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-signing-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "app"), { recursive: true });
    writeSigningBuildFile(root);
    const keyStorePath = join(root, "doc", "example.jks");
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      writeFileSync(args[args.indexOf("-keystore") + 1]!, "persistent-key");
    });
    const service = new LocalProjectManagedSigningService({
      paths: resolveAgentPaths(join(root, "agent-data")),
      runner: { run },
    });

    const first = await service.prepare(createProject(root));
    await first?.dispose();
    const managedDirectory = join(root, "agent-data", "AIMobileTester", "signing-keys");

    expect(existsSync(keyStorePath)).toBe(false);
    expect(existsSync(managedDirectory)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);

    const second = await service.prepare(createProject(root));

    expect(existsSync(keyStorePath)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    await second?.dispose();
    expect(existsSync(keyStorePath)).toBe(false);
  });

  it("cleans a partially generated JKS when keytool fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-signing-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "app"), { recursive: true });
    writeSigningBuildFile(root);
    const keyStorePath = join(root, "doc", "example.jks");
    const service = new LocalProjectManagedSigningService({
      runner: {
        run: async (_executable, args) => {
          writeFileSync(args[args.indexOf("-keystore") + 1]!, "partial-key");
          throw new Error("keytool failed");
        },
      },
    });

    await expect(service.prepare(createProject(root))).rejects.toThrow("无法准备本地调试签名");
    expect(existsSync(keyStorePath)).toBe(false);
    expect(existsSync(join(root, "doc"))).toBe(false);
  });
});
