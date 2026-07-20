import { describe, expect, it, vi } from "vitest";
import type { DeviceListResponse } from "@device-robot/contracts";

import {
  AdbDeviceManagementService,
  parseLogcatEntries,
  type DeviceManagementCommandRunner,
} from "../src/devices/adb-device-management-service.js";
import type { DeviceDiscoveryService } from "../src/devices/adb-device-service.js";

const connectedDevice: DeviceListResponse = {
  adb: { available: true, executable: "adb" },
  devices: [{ serial: "device-1", state: "device", connection: "usb" }],
  refreshedAt: "2026-07-20T10:00:00.000Z",
};

function createDiscoveryService(response = connectedDevice): DeviceDiscoveryService {
  return { listDevices: vi.fn().mockResolvedValue(response) };
}

function createRunner(output = ""): DeviceManagementCommandRunner {
  return { runText: vi.fn().mockResolvedValue(output) };
}

describe("ADB device management", () => {
  it("lists a normalized directory with folders before files", async () => {
    const runner = createRunner("Download/\nnotes.txt\nshortcut@\n");
    const service = new AdbDeviceManagementService({
      deviceService: createDiscoveryService(),
      runner,
    });

    const result = await service.listFiles("device-1", "/storage/emulated/0/../0");

    expect(result).toMatchObject({
      path: "/storage/emulated/0",
      parentPath: "/storage/emulated",
      entries: [
        { name: "Download", kind: "directory" },
        { name: "notes.txt", kind: "file" },
        { name: "shortcut", kind: "link" },
      ],
    });
    expect(runner.runText).toHaveBeenCalledWith([
      "-s",
      "device-1",
      "shell",
      "ls",
      "-1Ap",
      "/storage/emulated/0",
    ]);
  });

  it("rejects paths containing shell metacharacters", async () => {
    const runner = createRunner();
    const service = new AdbDeviceManagementService({
      deviceService: createDiscoveryService(),
      runner,
    });

    await expect(service.listFiles("device-1", "/storage/emulated/0;id")).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(runner.runText).not.toHaveBeenCalled();
  });

  it("lists package metadata from fixed pm commands", async () => {
    const runner: DeviceManagementCommandRunner = {
      runText: vi
        .fn()
        .mockResolvedValueOnce(
          "package:/data/app/com.example.app/base.apk=com.example.app versionCode:42\n",
        )
        .mockResolvedValueOnce(
          "package:/system/app/Settings/Settings.apk=com.android.settings versionCode:33\n",
        ),
    };
    const service = new AdbDeviceManagementService({
      deviceService: createDiscoveryService(),
      runner,
    });

    const result = await service.listApplications("device-1");

    expect(result).toMatchObject({
      filter: "all",
      applications: [
        { packageName: "com.example.app", source: "user", versionCode: "42" },
        { packageName: "com.android.settings", source: "system", versionCode: "33" },
      ],
    });
    expect(runner.runText).toHaveBeenCalledWith([
      "-s",
      "device-1",
      "shell",
      "pm",
      "list",
      "packages",
      "-f",
      "--show-versioncode",
      "-3",
    ]);
    expect(runner.runText).toHaveBeenCalledWith([
      "-s",
      "device-1",
      "shell",
      "pm",
      "list",
      "packages",
      "-f",
      "--show-versioncode",
      "-s",
    ]);
  });

  it("reads a bounded Logcat snapshot using fixed ADB arguments", async () => {
    const runner = createRunner(
      [
        "07-21 10:00:00.123  1234  1235 I ActivityManager: Displayed com.example.app",
        "07-21 10:00:01.000  1234  1235 E AndroidRuntime: FATAL EXCEPTION",
      ].join("\n"),
    );
    const service = new AdbDeviceManagementService({
      deviceService: createDiscoveryService(),
      runner,
    });

    const result = await service.readLogcat("device-1", 120);

    expect(result.entries).toMatchObject([
      { level: "info", tag: "ActivityManager", processId: 1234 },
      { level: "error", tag: "AndroidRuntime", message: "FATAL EXCEPTION" },
    ]);
    expect(runner.runText).toHaveBeenCalledWith([
      "-s",
      "device-1",
      "logcat",
      "-d",
      "-v",
      "threadtime",
      "-t",
      "120",
    ]);
  });

  it("caps parsed Logcat entries at the requested limit", async () => {
    const runner = createRunner(
      Array.from(
        { length: 12 },
        (_value, index) =>
          `07-21 10:00:${String(index).padStart(2, "0")}.000  1234  1235 I TestTag: ${index}`,
      ).join("\n"),
    );
    const service = new AdbDeviceManagementService({
      deviceService: createDiscoveryService(),
      runner,
    });

    const result = await service.readLogcat("device-1", 10);

    expect(result.entries).toHaveLength(10);
    expect(result.entries[0]).toMatchObject({ message: "2" });
    expect(result.entries[9]).toMatchObject({ message: "11" });
  });

  it("keeps unexpected Logcat lines as unclassified entries", () => {
    expect(
      parseLogcatEntries("--------- beginning of main\njava.lang.IllegalStateException"),
    ).toEqual([
      { level: "unknown", message: "--------- beginning of main" },
      { level: "unknown", message: "java.lang.IllegalStateException" },
    ]);
  });
});
