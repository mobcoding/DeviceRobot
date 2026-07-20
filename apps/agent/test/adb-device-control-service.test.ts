import { describe, expect, it, vi } from "vitest";

import {
  AdbDeviceControlService,
  type AdbCommandRunner,
  type DeviceControlError,
} from "../src/devices/adb-device-control-service.js";
import type { DeviceDiscoveryService } from "../src/devices/adb-device-service.js";
import type { DeviceListResponse } from "@device-robot/contracts";

const connectedDevice: DeviceListResponse = {
  adb: { available: true, executable: "adb" },
  devices: [{ serial: "device-1", state: "device", connection: "usb" }],
  refreshedAt: "2026-07-20T10:00:00.000Z",
};

function createDiscoveryService(response = connectedDevice): DeviceDiscoveryService {
  return { listDevices: vi.fn().mockResolvedValue(response) };
}

function createRunner(overrides: Partial<AdbCommandRunner> = {}): AdbCommandRunner {
  return {
    runText: vi.fn().mockResolvedValue(""),
    runBuffer: vi
      .fn()
      .mockResolvedValue(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ...overrides,
  };
}

describe("ADB device control", () => {
  it("captures a PNG screenshot from an authorized device", async () => {
    const runner = createRunner();
    const service = new AdbDeviceControlService({
      deviceService: createDiscoveryService(),
      runner,
    });

    const screenshot = await service.captureScreenshot("device-1");

    expect(screenshot.subarray(0, 4).toString("hex")).toBe("89504e47");
    expect(runner.runBuffer).toHaveBeenCalledWith([
      "-s",
      "device-1",
      "exec-out",
      "screencap",
      "-p",
    ]);
  });

  it("executes only fixed ADB arguments for a tap action", async () => {
    const runner = createRunner({ runText: vi.fn().mockResolvedValue("tap completed") });
    const service = new AdbDeviceControlService({
      deviceService: createDiscoveryService(),
      runner,
    });

    const result = await service.execute("device-1", { action: "ui.tap", x: 120, y: 450 });

    expect(result.message).toBe("tap completed");
    expect(runner.runText).toHaveBeenCalledWith([
      "-s",
      "device-1",
      "shell",
      "input",
      "tap",
      "120",
      "450",
    ]);
  });

  it("reads XML from the device and removes command preamble", async () => {
    const runner = createRunner({
      runText: vi
        .fn()
        .mockResolvedValue(
          'UI dump complete\n<?xml version="1.0"?><hierarchy></hierarchy>UI hierarchy dumped to: /dev/tty',
        ),
    });
    const service = new AdbDeviceControlService({
      deviceService: createDiscoveryService(),
      runner,
    });

    const result = await service.readUiTree("device-1");

    expect(result.xml).toBe('<?xml version="1.0"?><hierarchy></hierarchy>');
    expect(runner.runText).toHaveBeenCalledWith([
      "-s",
      "device-1",
      "exec-out",
      "uiautomator",
      "dump",
      "/dev/tty",
    ]);
  });

  it("refuses control when the requested device is offline", async () => {
    const runner = createRunner();
    const service = new AdbDeviceControlService({
      deviceService: createDiscoveryService({
        ...connectedDevice,
        devices: [{ serial: "device-1", state: "offline", connection: "usb" }],
      }),
      runner,
    });

    await expect(service.execute("device-1", { action: "ui.back" })).rejects.toMatchObject({
      statusCode: 409,
      message: "The requested device is not ready for automation (offline)",
    } satisfies Partial<DeviceControlError>);
    expect(runner.runText).not.toHaveBeenCalled();
  });
});
