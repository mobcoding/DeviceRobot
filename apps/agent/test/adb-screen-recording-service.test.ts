import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceListResponse, ScreenRecordingConfiguration } from "@device-robot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdbScreenRecordingService,
  type ScreenRecordingCommandRunner,
} from "../src/devices/adb-screen-recording-service.js";
import type { DeviceDiscoveryService } from "../src/devices/adb-device-service.js";

const temporaryDirectories: string[] = [];
const connectedDevice: DeviceListResponse = {
  adb: { available: true, executable: "adb" },
  devices: [{ serial: "device-1", state: "device", connection: "usb" }],
  refreshedAt: "2026-07-31T10:00:00.000Z",
};

function createOutputDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "device-robot-recording-"));
  temporaryDirectories.push(directory);
  return directory;
}

function deviceService(): DeviceDiscoveryService {
  return { listDevices: vi.fn().mockResolvedValue(connectedDevice) };
}

function configuration(outputDirectory: string): ScreenRecordingConfiguration {
  return {
    bitRateMbps: 4,
    resolutionPercent: 50,
    showTouches: true,
    outputDirectory,
  };
}

function recordingRunner(originalShowTouches = "0"): ScreenRecordingCommandRunner {
  return {
    runText: vi.fn(async (args: readonly string[]) => {
      if (args[2] === "pull") {
        const savedPath = args[4];
        if (savedPath === undefined) {
          throw new Error("Missing local recording path");
        }
        writeFileSync(savedPath, "mp4-data");
        return "1 file pulled";
      }
      if (args[3] === "wm" && args[4] === "size") {
        return "Physical size: 1080x2400";
      }
      if (args[3] === "settings" && args[4] === "get") {
        return originalShowTouches;
      }
      if (args[3] === "sh") {
        return "4271\n";
      }
      return "";
    }),
    start: vi.fn(async () => ({ processId: "4271", terminate: vi.fn() })),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("ADB screen recording", () => {
  it("starts with the configured video settings and saves a non-empty MP4 locally", async () => {
    const outputDirectory = createOutputDirectory();
    const runner = recordingRunner();
    const service = new AdbScreenRecordingService({
      deviceService: deviceService(),
      runner,
      wait: async () => {},
    });

    const started = await service.start("device-1", configuration(outputDirectory));
    const result = await service.stop("device-1");

    expect(started).toMatchObject({
      serial: "device-1",
      recording: true,
      configuration: { bitRateMbps: 4, resolutionPercent: 50, showTouches: true },
      maxDurationSeconds: 1_800,
    });
    expect(runner.start).toHaveBeenCalledWith([
      "-s",
      "device-1",
      "shell",
      expect.stringContaining(
        "exec screenrecord --size 540x1200 --bit-rate 4000000 --time-limit 1800 /sdcard/Download/DeviceRobot-",
      ),
    ]);
    expect(runner.runText).toHaveBeenCalledWith(["-s", "device-1", "shell", "kill", "-0", "4271"]);
    expect(runner.runText).toHaveBeenCalledWith([
      "-s",
      "device-1",
      "shell",
      "kill",
      "-INT",
      "4271",
    ]);
    expect(result.savedPath).toMatch(/\.mp4$/u);
    expect(result.savedPath).toContain(outputDirectory);
    expect(runner.runText).toHaveBeenCalledWith([
      "-s",
      "device-1",
      "shell",
      "settings",
      "put",
      "system",
      "show_touches",
      "0",
    ]);
  });

  it("disables touch indicators after recording even when they were already enabled", async () => {
    const outputDirectory = createOutputDirectory();
    const runner = recordingRunner("1");
    const service = new AdbScreenRecordingService({
      deviceService: deviceService(),
      runner,
      wait: async () => {},
    });

    await service.start("device-1", configuration(outputDirectory));
    await service.stop("device-1");

    expect(runner.runText).toHaveBeenCalledWith([
      "-s",
      "device-1",
      "shell",
      "settings",
      "put",
      "system",
      "show_touches",
      "0",
    ]);
  });

  it("fails fast and restores the touch-display setting when the recorder exits at startup", async () => {
    const outputDirectory = createOutputDirectory();
    const terminate = vi.fn();
    const runner: ScreenRecordingCommandRunner = {
      runText: vi.fn(async (args: readonly string[]) => {
        if (args[3] === "wm" && args[4] === "size") {
          return "Physical size: 1080x2400";
        }
        if (args[3] === "settings" && args[4] === "get") {
          return "0";
        }
        if (args[3] === "kill" && args[4] === "-0") {
          throw new Error("recorder process exited");
        }
        return "";
      }),
      start: vi.fn(async () => ({ processId: "4271", terminate })),
    };
    const service = new AdbScreenRecordingService({
      deviceService: deviceService(),
      runner,
      wait: async () => {},
    });

    await expect(service.start("device-1", configuration(outputDirectory))).rejects.toMatchObject({
      statusCode: 502,
      message: expect.stringContaining("启动录屏失败"),
    });
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(runner.runText).toHaveBeenCalledWith([
      "-s",
      "device-1",
      "shell",
      "settings",
      "put",
      "system",
      "show_touches",
      "0",
    ]);
  });

  it("rejects a stop request when no recording is active", async () => {
    const service = new AdbScreenRecordingService({
      deviceService: deviceService(),
      runner: recordingRunner(),
    });

    await expect(service.stop("device-1")).rejects.toMatchObject({
      statusCode: 409,
      message: "当前设备没有进行中的录屏。",
    });
  });
});
