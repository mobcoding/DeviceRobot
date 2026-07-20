import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAgentPaths } from "@device-robot/config";

import {
  AppiumRuntimeService,
  type AppiumCommandRunner,
} from "../src/appium/appium-runtime-service.js";

const temporaryDirectories: string[] = [];

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "device-robot-appium-"));
  temporaryDirectories.push(root);
  return root;
}

function createSdk(root: string): string {
  const sdk = join(root, "sdk");
  mkdirSync(join(sdk, "platform-tools"), { recursive: true });
  writeFileSync(join(sdk, "platform-tools", "adb.exe"), "");
  return sdk;
}

function readyRunner(): AppiumCommandRunner {
  return {
    run: vi.fn(async (_executable, args) => {
      if (args.includes("--version")) {
        return { stdout: "3.5.2\n", stderr: "" };
      }
      if (args.includes("driver")) {
        return {
          stdout: JSON.stringify({ uiautomator2: { version: "8.1.0" } }),
          stderr: "",
        };
      }
      if (args[0] === "-version") {
        return { stdout: "", stderr: 'java version "21.0.7"\n' };
      }
      return { stdout: "", stderr: "" };
    }),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Appium runtime", () => {
  it("reports a complete local Appium and UiAutomator2 runtime", async () => {
    const root = createTemporaryRoot();
    const service = new AppiumRuntimeService({
      paths: resolveAgentPaths(root),
      appiumPath: "appium",
      commandRunner: readyRunner(),
      environment: { ANDROID_HOME: createSdk(root) },
    });

    await expect(service.inspect()).resolves.toMatchObject({
      status: "ready",
      appium: { available: true, version: "3.5.2" },
      uiautomator2: { available: true, version: "8.1.0" },
      java: { available: true },
      androidSdk: { available: true },
      server: { host: "127.0.0.1", port: 4723, state: "stopped" },
      issues: [],
    });
  });

  it("reports a degraded runtime when Appium cannot be executed", async () => {
    const root = createTemporaryRoot();
    const service = new AppiumRuntimeService({
      paths: resolveAgentPaths(root),
      appiumPath: "appium",
      commandRunner: {
        run: async (executable, args) => {
          if (executable === "appium") {
            throw new Error("appium executable was not found");
          }
          if (args[0] === "-version") {
            return { stdout: "", stderr: 'java version "21"' };
          }
          return { stdout: "", stderr: "" };
        },
      },
      environment: { ANDROID_HOME: createSdk(root) },
    });

    await expect(service.inspect()).resolves.toMatchObject({
      status: "degraded",
      appium: { available: false },
      uiautomator2: { available: false },
      issues: expect.arrayContaining(["未找到项目内 Appium 运行时。"]),
    });
  });
});
