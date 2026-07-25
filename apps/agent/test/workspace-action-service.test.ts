import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionPlan, DeviceListResponse } from "@device-robot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApkArtifactService } from "../src/apks/apk-artifact-service.js";
import type { DeviceControlService } from "../src/devices/adb-device-control-service.js";
import type { DeviceDiscoveryService } from "../src/devices/adb-device-service.js";
import type { ProjectBuildService } from "../src/projects/project-build-service.js";
import {
  LocalWorkspaceActionService,
  WorkspaceActionError,
  type WorkspaceAdbRunner,
} from "../src/workspace/workspace-action-service.js";

const PROJECT_ID = "123e4567-e89b-12d3-a456-426614174000";
const BUILD_ID = "223e4567-e89b-12d3-a456-426614174000";
const ARTIFACT_ID = "323e4567-e89b-12d3-a456-426614174000";
const temporaryDirectories: string[] = [];

function readyDeviceService(): DeviceDiscoveryService {
  return {
    listDevices: async () =>
      ({
        adb: { available: true, executable: "adb", version: "1.0.41" },
        devices: [
          {
            serial: "device-1",
            state: "device",
            connection: "usb",
          },
        ],
        refreshedAt: "2026-07-25T10:00:00.000Z",
      }) satisfies DeviceListResponse,
  };
}

function unavailableDeviceService(): DeviceDiscoveryService {
  return {
    listDevices: async () =>
      ({
        adb: { available: true, executable: "adb", version: "1.0.41" },
        devices: [],
        refreshedAt: "2026-07-25T10:00:00.000Z",
      }) satisfies DeviceListResponse,
  };
}

function deviceControlService(): DeviceControlService {
  return {
    execute: async () => ({
      startedAt: "2026-07-25T10:00:00.000Z",
      finishedAt: "2026-07-25T10:00:00.001Z",
    }),
    captureScreenshot: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    readUiTree: async () => ({
      serial: "device-1",
      xml: "<hierarchy/>",
      capturedAt: "2026-07-25T10:00:00.000Z",
    }),
  } as DeviceControlService;
}

function projectBuildService(): ProjectBuildService {
  return {
    listTargets: async () => {
      throw new Error("not used");
    },
    installSdk: async () => {
      throw new Error("not used");
    },
    listRuns: async () => ({ projectId: PROJECT_ID, runs: [] }),
    getLog: async () => {
      throw new Error("not used");
    },
    getArtifact: async () => {
      throw new Error("not used");
    },
    start: async () => {
      throw new Error("not used");
    },
    dispose: async () => {},
  };
}

function apkArtifactService(): ApkArtifactService {
  return {
    stage: async () => {
      throw new Error("not used");
    },
    find: async () => {
      throw new Error("not used");
    },
    discard: async () => {},
    install: async () => ({
      status: "installed" as const,
      serial: "device-1",
      artifactId: ARTIFACT_ID,
      packageName: "com.example.app",
      startedAt: "2026-07-25T10:00:00.000Z",
      finishedAt: "2026-07-25T10:00:00.001Z",
    }),
  };
}

function workspacePlan(actions: ActionPlan["actions"]): ActionPlan {
  return {
    id: "workspace-plan",
    projectId: PROJECT_ID,
    workspaceExecution: true,
    actions,
    requiresApproval: false,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("workspace action service", () => {
  it("runs structured application and ADB actions only against the selected device", async () => {
    const runner: WorkspaceAdbRunner = {
      run: vi.fn(async () => ({ stdout: "Success", stderr: "" })),
    };
    const service = new LocalWorkspaceActionService({
      deviceService: readyDeviceService(),
      deviceControlService: deviceControlService(),
      apkArtifactService: apkArtifactService(),
      projectBuildService: projectBuildService(),
      runner,
    });

    const result = await service.execute({
      deviceSerial: "device-1",
      plan: workspacePlan([
        { action: "app.uninstall", appId: "com.example.app", keepData: false },
        { action: "app.clearData", appId: "com.example.app" },
        { action: "adb.shell", command: "getprop", args: ["ro.product.model"] },
      ]),
    });

    expect(result.status).toBe("succeeded");
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ index: 0 }),
        expect.objectContaining({ index: 1 }),
      ]),
    );
    expect(runner.run).toHaveBeenNthCalledWith(
      1,
      ["-s", "device-1", "uninstall", "com.example.app"],
      120_000,
    );
    expect(runner.run).toHaveBeenNthCalledWith(
      2,
      ["-s", "device-1", "shell", "pm", "clear", "com.example.app"],
      120_000,
    );
    expect(runner.run).toHaveBeenNthCalledWith(
      3,
      ["-s", "device-1", "shell", "getprop", "ro.product.model"],
      120_000,
    );
  });

  it("delegates a workspace device unlock action to the structured device controller", async () => {
    const execute = vi.fn(async () => ({
      startedAt: "2026-07-25T10:00:00.000Z",
      finishedAt: "2026-07-25T10:00:00.001Z",
      message: "已唤醒设备并恢复到可交互界面。",
    }));
    const service = new LocalWorkspaceActionService({
      deviceService: readyDeviceService(),
      deviceControlService: { ...deviceControlService(), execute },
      apkArtifactService: apkArtifactService(),
      projectBuildService: projectBuildService(),
      runner: { run: async () => ({ stdout: "", stderr: "" }) },
    });

    await expect(
      service.execute({
        deviceSerial: "device-1",
        plan: workspacePlan([{ action: "device.unlock" }]),
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(execute).toHaveBeenCalledWith("device-1", { action: "device.unlock" });
  });

  it("rejects a non-workspace plan and disconnected devices before issuing commands", async () => {
    const runner: WorkspaceAdbRunner = { run: vi.fn() };
    const plan = workspacePlan([{ action: "ui.wait", durationMs: 1 }]);
    const service = new LocalWorkspaceActionService({
      deviceService: unavailableDeviceService(),
      deviceControlService: deviceControlService(),
      apkArtifactService: apkArtifactService(),
      projectBuildService: projectBuildService(),
      runner,
    });

    await expect(service.execute({ deviceSerial: "device-1", plan })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(
      service.execute({
        deviceSerial: "device-1",
        plan: { ...plan, workspaceExecution: false },
      }),
    ).rejects.toBeInstanceOf(WorkspaceActionError);
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("installs a resolved project artifact without exposing its path to the plan", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-workspace-action-"));
    temporaryDirectories.push(root);
    const artifactPath = join(root, "example.apk");
    writeFileSync(artifactPath, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const stage: ApkArtifactService["stage"] = vi.fn(async (_name, stream) => {
      for await (const _chunk of stream) {
        // Consume the source stream so the test verifies a readable artifact is provided.
        void _chunk;
      }
      return {
        id: ARTIFACT_ID,
        fileName: "example.apk",
        sizeBytes: 4,
        sha256: "a".repeat(64),
        metadata: { packageName: "com.example.app", versionCode: "1" },
        uploadedAt: "2026-07-25T10:00:00.000Z",
      };
    });
    const install: ApkArtifactService["install"] = vi.fn(async () => ({
      status: "installed" as const,
      serial: "device-1",
      artifactId: ARTIFACT_ID,
      packageName: "com.example.app",
      startedAt: "2026-07-25T10:00:00.000Z",
      finishedAt: "2026-07-25T10:00:00.001Z",
    }));
    const getArtifact = vi.fn(async () => ({
      fileName: "example.apk",
      filePath: artifactPath,
      sizeBytes: 4,
    }));
    const service = new LocalWorkspaceActionService({
      deviceService: readyDeviceService(),
      deviceControlService: deviceControlService(),
      apkArtifactService: {
        ...apkArtifactService(),
        stage,
        install,
      },
      projectBuildService: { ...projectBuildService(), getArtifact },
      runner: { run: async () => ({ stdout: "", stderr: "" }) },
    });

    await expect(
      service.execute({
        deviceSerial: "device-1",
        plan: workspacePlan([
          {
            action: "project.installArtifact",
            buildId: BUILD_ID,
            artifactIndex: 0,
            replaceExisting: true,
            allowTestPackage: true,
            uninstallExisting: false,
          },
        ]),
      }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(getArtifact).toHaveBeenCalledWith(PROJECT_ID, BUILD_ID, 0);
    expect(install).toHaveBeenCalledWith("device-1", ARTIFACT_ID, {
      replaceExisting: true,
      allowTestPackage: true,
      uninstallExisting: false,
    });
  });
});
