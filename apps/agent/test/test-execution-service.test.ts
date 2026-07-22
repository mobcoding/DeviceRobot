import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentPaths } from "@device-robot/config";
import type { AndroidProject, TestExecutionRun } from "@device-robot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../src/db/database.js";
import type { DeviceControlService } from "../src/devices/adb-device-control-service.js";
import type { DeviceDiscoveryService } from "../src/devices/adb-device-service.js";
import type { ProjectStore } from "../src/projects/project-store.js";
import {
  LocalTestExecutionService,
  type ApplicationDataService,
  type WebDriverTransport,
} from "../src/test-execution/test-execution-service.js";
import { SqliteTestExecutionStore } from "../src/test-execution/test-execution-store.js";

const temporaryDirectories: string[] = [];

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "device-robot-execution-"));
  temporaryDirectories.push(root);
  return root;
}

function project(): AndroidProject {
  return {
    id: "123e4567-e89b-12d3-a456-426614174000",
    name: "Example",
    source: "local",
    rootPath: "C:\\Example",
    gradleWrapper: true,
    modules: [],
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z",
  };
}

async function waitForFinished(
  service: LocalTestExecutionService,
  runId: string,
): Promise<TestExecutionRun> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = await service.find(runId);
    if (run.status !== "running") {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("测试运行未在预期时间内结束。");
}

function readyDeviceService(): DeviceDiscoveryService {
  return {
    listDevices: async () => ({
      adb: { available: true, executable: "adb" },
      devices: [{ serial: "device-1", state: "device", connection: "usb" }],
      refreshedAt: "2026-07-23T10:00:00.000Z",
    }),
  };
}

function projectStore(): ProjectStore {
  const value = project();
  return {
    list: () => [value],
    findById: (id) => (id === value.id ? value : undefined),
    findByRootPath: () => undefined,
    create: () => {},
    updateName: () => {},
    updateSourceIndex: () => {},
  };
}

function transport(handler?: (path: string) => unknown): WebDriverTransport {
  return {
    request: async (_method, path) => {
      const custom = handler?.(path);
      if (custom !== undefined) {
        return custom;
      }
      if (path === "/session") {
        return { value: { sessionId: "session-1" } };
      }
      return { value: null };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("test execution service", () => {
  it("clears app data, executes approved steps, and saves evidence screenshots", async () => {
    const root = createTemporaryRoot();
    const paths = resolveAgentPaths(root);
    const database = openDatabase(paths.database);
    const clear = vi.fn(async () => {});
    const captureScreenshot = vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const service = new LocalTestExecutionService({
      paths,
      store: new SqliteTestExecutionStore(database.sqlite),
      projectStore: projectStore(),
      deviceService: readyDeviceService(),
      deviceControlService: {
        captureScreenshot,
        readUiTree: async () => ({
          serial: "device-1",
          xml: "<hierarchy/>",
          capturedAt: new Date().toISOString(),
        }),
        execute: async () => ({
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        }),
      } satisfies DeviceControlService,
      appiumRuntimeService: {
        start: async () => ({ server: { state: "running" } }),
      } as never,
      transport: transport(),
      applicationDataService: {
        clear,
        setPermission: async () => {},
      } satisfies ApplicationDataService,
    });

    const started = await service.start({
      plan: {
        id: "plan-1",
        projectId: project().id,
        actions: [
          { action: "app.launch", appId: "com.example.app" },
          { action: "ui.wait", durationMs: 1 },
          { action: "device.screenshot", name: "启动完成" },
        ],
        requiresApproval: true,
      },
      deviceSerial: "device-1",
      appId: "com.example.app",
      approved: true,
    });
    const finished = await waitForFinished(service, started.id);

    expect(finished).toMatchObject({
      status: "succeeded",
      steps: [{ status: "succeeded" }, { status: "succeeded" }, { status: "succeeded" }],
    });
    expect(clear).toHaveBeenCalledWith("device-1", "com.example.app");
    expect(captureScreenshot).toHaveBeenCalledTimes(3);
    await expect(service.screenshotPath(started.id, 0)).resolves.toContain(`${started.id}`);
    await service.dispose();
    database.close();
  });

  it("marks remaining steps as cancelled after an Appium failure", async () => {
    const root = createTemporaryRoot();
    const paths = resolveAgentPaths(root);
    const database = openDatabase(paths.database);
    const service = new LocalTestExecutionService({
      paths,
      store: new SqliteTestExecutionStore(database.sqlite),
      projectStore: projectStore(),
      deviceService: readyDeviceService(),
      deviceControlService: {
        captureScreenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        readUiTree: async () => ({
          serial: "device-1",
          xml: "<hierarchy/>",
          capturedAt: new Date().toISOString(),
        }),
        execute: async () => ({
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        }),
      } satisfies DeviceControlService,
      appiumRuntimeService: {
        start: async () => ({ server: { state: "running" } }),
      } as never,
      transport: (() => {
        let executeCalls = 0;
        return transport((path) => {
          if (path === "/session") {
            return { value: { sessionId: "session-1" } };
          }
          if (path.endsWith("/execute/sync")) {
            executeCalls += 1;
            if (executeCalls > 1) {
              throw new Error("UiAutomator2 会话不可用。");
            }
          }
          return undefined;
        });
      })(),
      applicationDataService: {
        clear: async () => {},
        setPermission: async () => {},
      },
    });

    const started = await service.start({
      plan: {
        id: "plan-2",
        projectId: project().id,
        actions: [
          { action: "app.launch", appId: "com.example.app" },
          { action: "ui.wait", durationMs: 1 },
        ],
        requiresApproval: true,
      },
      deviceSerial: "device-1",
      appId: "com.example.app",
      approved: true,
    });
    const finished = await waitForFinished(service, started.id);

    expect(finished.status).toBe("failed");
    expect(finished.message).toContain("UiAutomator2 会话不可用");
    expect(finished.steps).toMatchObject([{ status: "failed" }, { status: "cancelled" }]);
    await service.dispose();
    database.close();
  });
});
