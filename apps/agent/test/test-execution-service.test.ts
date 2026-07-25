import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentPaths } from "@device-robot/config";
import type { AndroidProject, TestExecutionRun } from "@device-robot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../src/db/database.js";
import type { DeviceControlService } from "../src/devices/adb-device-control-service.js";
import type { DeviceDiscoveryService } from "../src/devices/adb-device-service.js";
import type { DeviceManagementService } from "../src/devices/adb-device-management-service.js";
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
  for (let attempt = 0; attempt < 500; attempt += 1) {
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
    delete: () => {},
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

function pngScreenshot(width: number, height: number): Buffer {
  const screenshot = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(screenshot);
  screenshot.writeUInt32BE(width, 16);
  screenshot.writeUInt32BE(height, 20);
  return screenshot;
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
        uninstall: async () => {},
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
    mkdirSync(paths.logs, { recursive: true });
    writeFileSync(join(paths.logs, "appium.log"), "[Appium] session failure");
    const readUiTree = vi.fn(async () => ({
      serial: "device-1",
      xml: "<hierarchy/>",
      capturedAt: new Date().toISOString(),
    }));
    const readLogcat = vi.fn(async () => ({
      serial: "device-1",
      entries: [
        {
          timestamp: "07-23 10:00:01.000",
          processId: 1,
          threadId: 2,
          level: "error" as const,
          tag: "Example",
          message: "failure",
        },
      ],
      readAt: new Date().toISOString(),
    }));
    const service = new LocalTestExecutionService({
      paths,
      store: new SqliteTestExecutionStore(database.sqlite),
      projectStore: projectStore(),
      deviceService: readyDeviceService(),
      deviceControlService: {
        captureScreenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        readUiTree,
        execute: async () => ({
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        }),
      } satisfies DeviceControlService,
      deviceManagementService: {
        listFiles: async () => {
          throw new Error("not used");
        },
        listApplications: async () => {
          throw new Error("not used");
        },
        readLogcat,
      } satisfies DeviceManagementService,
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
        uninstall: async () => {},
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
    expect(readUiTree).toHaveBeenCalledWith("device-1");
    expect(readLogcat).toHaveBeenCalledWith("device-1", 500);
    const evidenceDirectory = join(paths.reports, started.id, "evidence");
    expect(existsSync(join(evidenceDirectory, "step-001.xml"))).toBe(true);
    expect(existsSync(join(evidenceDirectory, "step-001-logcat.log"))).toBe(true);
    expect(existsSync(join(evidenceDirectory, "appium.log"))).toBe(true);
    await service.dispose();
    database.close();
  });

  it("installs staged APKs before starting Appium and clearing the target application data", async () => {
    const root = createTemporaryRoot();
    const paths = resolveAgentPaths(root);
    const database = openDatabase(paths.database);
    const order: string[] = [];
    const install = vi.fn(async () => {
      order.push("install");
      return {
        status: "installed" as const,
        serial: "device-1",
        artifactId: "223e4567-e89b-12d3-a456-426614174000",
        packageName: "com.any.application",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
    });
    const service = new LocalTestExecutionService({
      paths,
      store: new SqliteTestExecutionStore(database.sqlite),
      projectStore: projectStore(),
      deviceService: readyDeviceService(),
      deviceControlService: {
        captureScreenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        readUiTree: async () => ({
          serial: "device-1",
          xml: "<hierarchy />",
          capturedAt: new Date().toISOString(),
        }),
        execute: async () => ({
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        }),
      } satisfies DeviceControlService,
      apkArtifactService: { install } as never,
      appiumRuntimeService: {
        start: async () => {
          order.push("appium");
          return { server: { state: "running" } };
        },
      } as never,
      transport: transport(),
      applicationDataService: {
        uninstall: async () => {},
        clear: async () => {
          order.push("clear");
        },
        setPermission: async () => {},
      },
    });

    const started = await service.start({
      plan: {
        id: "plan-install",
        projectId: project().id,
        actions: [
          {
            action: "app.install",
            artifactId: "223e4567-e89b-12d3-a456-426614174000",
            replaceExisting: true,
            allowTestPackage: true,
          },
          { action: "ui.wait", durationMs: 1 },
        ],
        requiresApproval: true,
      },
      deviceSerial: "device-1",
      appId: "com.example.app",
      approved: true,
    });
    const finished = await waitForFinished(service, started.id);

    expect(finished.steps).toMatchObject([
      {
        action: { action: "app.install" },
        status: "succeeded",
        message: "已安装 com.any.application。",
      },
      { action: { action: "ui.wait" }, status: "succeeded" },
    ]);
    expect(install).toHaveBeenCalledWith("device-1", "223e4567-e89b-12d3-a456-426614174000", {
      replaceExisting: true,
      allowTestPackage: true,
      uninstallExisting: false,
    });
    expect(order).toEqual(["install", "appium", "clear"]);
    await service.dispose();
    database.close();
  });

  it("runs live UI lifecycle preparation in uninstall-install order", async () => {
    const root = createTemporaryRoot();
    const paths = resolveAgentPaths(root);
    const database = openDatabase(paths.database);
    const order: string[] = [];
    const service = new LocalTestExecutionService({
      paths,
      store: new SqliteTestExecutionStore(database.sqlite),
      projectStore: projectStore(),
      deviceService: readyDeviceService(),
      deviceControlService: {
        captureScreenshot: async () => pngScreenshot(1_080, 2_160),
        readUiTree: async () => ({
          serial: "device-1",
          xml: '<hierarchy><node text="主页" bounds="[20,400][240,480]" /></hierarchy>',
          capturedAt: new Date().toISOString(),
        }),
        execute: async (_serial, action) => {
          if (action.action === "device.unlock") {
            order.push("unlock");
          }
          return {
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          };
        },
      } satisfies DeviceControlService,
      aiPlanService: {
        decideRuntimeStep: async () => ({
          status: "completed" as const,
          assertion: { action: "assert.visible" as const, target: { text: "主页" } },
          reason: "当前页面已显示主页面标识。",
        }),
      } as never,
      apkArtifactService: {
        install: async () => {
          order.push("install");
          return {
            status: "installed" as const,
            serial: "device-1",
            artifactId: "223e4567-e89b-12d3-a456-426614174000",
            packageName: "com.example.app",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          };
        },
      } as never,
      appiumRuntimeService: {
        start: async () => {
          order.push("appium");
          return { server: { state: "running" } };
        },
      } as never,
      transport: transport((path) => {
        if (path === "/session") {
          return { value: { sessionId: "session-1" } };
        }
        if (path.endsWith("/element")) {
          return { value: { ELEMENT: "element-1" } };
        }
        if (path.endsWith("/displayed")) {
          return { value: true };
        }
        return undefined;
      }),
      applicationDataService: {
        uninstall: async () => {
          order.push("uninstall");
        },
        clear: async () => {
          order.push("clear");
        },
        setPermission: async () => {},
      },
    });

    const started = await service.start({
      plan: {
        id: "plan-live-ui-reinstall",
        projectId: project().id,
        liveUiExecution: { goal: "从启动页进入主页面", maxSteps: 1 },
        actions: [
          { action: "device.unlock" },
          { action: "app.uninstall", appId: "com.example.app", keepData: false },
          {
            action: "app.install",
            artifactId: "223e4567-e89b-12d3-a456-426614174000",
            replaceExisting: true,
            allowTestPackage: true,
          },
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
      steps: [
        { action: { action: "device.unlock" }, status: "succeeded" },
        { action: { action: "app.uninstall" }, status: "succeeded" },
        { action: { action: "app.install" }, status: "succeeded" },
        { action: { action: "assert.visible" }, status: "succeeded" },
      ],
    });
    expect(order).toEqual(["unlock", "uninstall", "install", "appium", "clear"]);
    await service.dispose();
    database.close();
  });

  it("uses the live UI to execute AI-selected steps before asserting the target result", async () => {
    const root = createTemporaryRoot();
    const paths = resolveAgentPaths(root);
    const database = openDatabase(paths.database);
    const decideRuntimeStep = vi
      .fn()
      .mockResolvedValueOnce({
        status: "continue",
        action: { action: "ui.tap", target: { text: "继续" } },
        reason: "继续按钮是当前页面唯一可见的导航入口。",
      })
      .mockResolvedValueOnce({
        status: "completed",
        assertion: { action: "assert.visible", target: { text: "首页" } },
        reason: "当前页面已出现首页标题。",
      });
    const screenshot = pngScreenshot(1_080, 2_160);
    const readUiTree = vi.fn(async () => ({
      serial: "device-1",
      xml: '<hierarchy><node text="继续" resource-id="com.example.app:id/continue" class="android.widget.Button" clickable="true" enabled="true" bounds="[20,400][240,480]" /></hierarchy>',
      capturedAt: new Date().toISOString(),
    }));
    const service = new LocalTestExecutionService({
      paths,
      store: new SqliteTestExecutionStore(database.sqlite),
      projectStore: projectStore(),
      deviceService: readyDeviceService(),
      deviceControlService: {
        captureScreenshot: async () => screenshot,
        readUiTree,
        execute: async () => ({
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        }),
      } satisfies DeviceControlService,
      aiPlanService: { decideRuntimeStep } as never,
      appiumRuntimeService: {
        start: async () => ({ server: { state: "running" } }),
      } as never,
      transport: transport((path) => {
        if (path === "/session") {
          return { value: { sessionId: "session-1" } };
        }
        if (path.endsWith("/source")) {
          return {
            value:
              '<hierarchy><android.widget.Button text="继续" resource-id="com.example.app:id/continue" clickable="true" enabled="true" bounds="[20,400][240,480]" /></hierarchy>',
          };
        }
        if (path.endsWith("/element")) {
          return { value: { "element-6066-11e4-a52e-4f735466cecf": "element-1" } };
        }
        if (path.endsWith("/displayed")) {
          return { value: true };
        }
        return undefined;
      }),
      applicationDataService: {
        uninstall: async () => {},
        clear: async () => {},
        setPermission: async () => {},
      },
    });

    const started = await service.start({
      plan: {
        id: "plan-live-ui",
        projectId: project().id,
        liveUiExecution: { goal: "从启动页进入首页", maxSteps: 2 },
        actions: [{ action: "app.launch", appId: "com.example.app" }],
        requiresApproval: true,
      },
      deviceSerial: "device-1",
      appId: "com.example.app",
      approved: true,
    });
    const finished = await waitForFinished(service, started.id);

    expect(finished).toMatchObject({
      status: "succeeded",
      steps: [
        { action: { action: "ui.tap" }, status: "succeeded" },
        { action: { action: "assert.visible" }, status: "succeeded" },
      ],
    });
    expect(decideRuntimeStep).toHaveBeenCalledTimes(2);
    expect(decideRuntimeStep.mock.calls[0]?.[0]).toMatchObject({
      goal: "从启动页进入首页",
      uiContext: expect.stringContaining('text="继续"'),
      screenshot: {
        width: 1_080,
        height: 2_160,
        dataUrl: expect.stringMatching(/^data:image\/png;base64,/u),
      },
    });
    expect(readUiTree).not.toHaveBeenCalled();
    expect(finished.steps[0]).toMatchObject({ message: "继续按钮是当前页面唯一可见的导航入口。" });
    await service.dispose();
    database.close();
  });

  it("waits once and retries when the AI identifies a transient Splash startup page", async () => {
    const root = createTemporaryRoot();
    const paths = resolveAgentPaths(root);
    const database = openDatabase(paths.database);
    const decideRuntimeStep = vi
      .fn()
      .mockResolvedValueOnce({
        status: "blocked",
        reason: "当前处于 SplashActivity，尚未出现可交互控件。",
      })
      .mockResolvedValueOnce({
        status: "completed",
        assertion: { action: "assert.activity", expected: "MainActivity" },
        reason: "当前页面已显示首页。",
      });
    const service = new LocalTestExecutionService({
      paths,
      store: new SqliteTestExecutionStore(database.sqlite),
      projectStore: projectStore(),
      deviceService: readyDeviceService(),
      deviceControlService: {
        captureScreenshot: async () => pngScreenshot(1_080, 2_160),
        readUiTree: async () => ({
          serial: "device-1",
          xml: '<hierarchy><node text="首页" class="android.widget.TextView" bounds="[20,400][240,480]" /></hierarchy>',
          capturedAt: new Date().toISOString(),
        }),
        execute: async () => ({
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        }),
      } satisfies DeviceControlService,
      aiPlanService: { decideRuntimeStep } as never,
      appiumRuntimeService: {
        start: async () => ({ server: { state: "running" } }),
      } as never,
      transport: transport((path) => {
        if (path === "/session") {
          return { value: { sessionId: "session-1" } };
        }
        if (path.endsWith("/element")) {
          return { value: { ELEMENT: "element-1" } };
        }
        if (path.endsWith("/appium/device/current_activity")) {
          return { value: "com.example.MainActivity" };
        }
        if (path.endsWith("/displayed")) {
          return { value: true };
        }
        return undefined;
      }),
      applicationDataService: {
        uninstall: async () => {},
        clear: async () => {},
        setPermission: async () => {},
      },
    });

    const started = await service.start({
      plan: {
        id: "plan-live-ui-startup-recovery",
        projectId: project().id,
        liveUiExecution: { goal: "验证首次启动进入首页", maxSteps: 3 },
        actions: [{ action: "app.launch", appId: "com.example.app" }],
        requiresApproval: true,
      },
      deviceSerial: "device-1",
      appId: "com.example.app",
      approved: true,
    });
    const recovered = await waitForFinished(service, started.id);

    expect(recovered).toMatchObject({
      status: "succeeded",
      steps: [
        { action: { action: "ui.wait", durationMs: 1_200 }, status: "succeeded" },
        { action: { action: "assert.activity", expected: "MainActivity" }, status: "succeeded" },
      ],
    });
    expect(decideRuntimeStep).toHaveBeenCalledTimes(2);
    await service.dispose();
    database.close();
  });

  it("asks the runtime model to decide again when its locator is absent from the real UI", async () => {
    const root = createTemporaryRoot();
    const paths = resolveAgentPaths(root);
    const database = openDatabase(paths.database);
    const decideRuntimeStep = vi
      .fn()
      .mockResolvedValueOnce({
        status: "continue",
        action: { action: "ui.tap", target: { resourceId: "com.example.app:id/missing" } },
        reason: "点击不存在的控件。",
      })
      .mockResolvedValueOnce({
        status: "completed",
        assertion: { action: "assert.activity", expected: "MainActivity" },
        reason: "已进入主页面。",
      });
    const service = new LocalTestExecutionService({
      paths,
      store: new SqliteTestExecutionStore(database.sqlite),
      projectStore: projectStore(),
      deviceService: readyDeviceService(),
      deviceControlService: {
        captureScreenshot: async () => pngScreenshot(1_080, 2_160),
        readUiTree: async () => ({
          serial: "device-1",
          xml: '<hierarchy><node text="继续" resource-id="com.example.app:id/continue" clickable="true" bounds="[20,400][240,480]" /></hierarchy>',
          capturedAt: new Date().toISOString(),
        }),
        execute: async () => ({
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        }),
      } satisfies DeviceControlService,
      aiPlanService: { decideRuntimeStep } as never,
      appiumRuntimeService: { start: async () => ({ server: { state: "running" } }) } as never,
      transport: transport((path) => {
        if (path === "/session") {
          return { value: { sessionId: "session-1" } };
        }
        if (path.endsWith("/appium/device/current_activity")) {
          return { value: "com.example.MainActivity" };
        }
        return undefined;
      }),
      applicationDataService: {
        uninstall: async () => {},
        clear: async () => {},
        setPermission: async () => {},
      },
    });

    const started = await service.start({
      plan: {
        id: "plan-live-ui-invalid-locator",
        projectId: project().id,
        liveUiExecution: { goal: "进入主页面", maxSteps: 3 },
        actions: [{ action: "app.launch", appId: "com.example.app" }],
        requiresApproval: true,
      },
      deviceSerial: "device-1",
      appId: "com.example.app",
      approved: true,
    });
    const finished = await waitForFinished(service, started.id);

    expect(finished).toMatchObject({
      status: "succeeded",
      steps: [{ action: { action: "assert.activity", expected: "MainActivity" } }],
    });
    expect(decideRuntimeStep).toHaveBeenCalledTimes(2);
    expect(decideRuntimeStep.mock.calls[1]?.[0]?.runtimeHistory).toEqual(
      expect.arrayContaining([expect.stringMatching(/ui\.tap/u)]),
    );
    await service.dispose();
    database.close();
  });
});
