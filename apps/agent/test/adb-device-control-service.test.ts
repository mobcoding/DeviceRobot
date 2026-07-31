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

  it("wakes, dismisses an unsecured lockscreen, and closes the notification shade", async () => {
    const runner = createRunner({
      runText: vi
        .fn()
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("showing=true\nsecure=false")
        .mockResolvedValueOnce("Physical size: 1080x2400")
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("showing=false\nmIsShowing=false")
        .mockResolvedValueOnce("mCurrentFocus=Window{123 u0 NotificationShade}")
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("mCurrentFocus=Window{456 u0 com.example.app/.MainActivity}"),
    });
    const service = new AdbDeviceControlService({
      deviceService: createDiscoveryService(),
      runner,
    });

    await expect(service.execute("device-1", { action: "device.unlock" })).resolves.toMatchObject({
      message: "已唤醒设备并恢复到可交互界面。",
    });
    expect(runner.runText).toHaveBeenNthCalledWith(1, [
      "-s",
      "device-1",
      "shell",
      "input",
      "keyevent",
      "KEYCODE_WAKEUP",
    ]);
    expect(runner.runText).toHaveBeenNthCalledWith(4, [
      "-s",
      "device-1",
      "shell",
      "input",
      "swipe",
      "540",
      "1920",
      "540",
      "480",
      "300",
    ]);
    expect(runner.runText).toHaveBeenNthCalledWith(7, [
      "-s",
      "device-1",
      "shell",
      "input",
      "keyevent",
      "KEYCODE_BACK",
    ]);
  });

  it("refuses to bypass a secure lockscreen", async () => {
    const runner = createRunner({
      runText: vi.fn().mockResolvedValueOnce("").mockResolvedValueOnce("showing=true\nsecure=true"),
    });
    const service = new AdbDeviceControlService({
      deviceService: createDiscoveryService(),
      runner,
    });

    await expect(service.execute("device-1", { action: "device.unlock" })).rejects.toMatchObject({
      statusCode: 409,
      message: "设备处于安全锁屏状态，请在设备上完成 PIN、图案、密码或生物识别解锁后重试。",
    } satisfies Partial<DeviceControlError>);
    expect(runner.runText).toHaveBeenCalledTimes(2);
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

  it("retries a transient incomplete UI hierarchy before returning XML", async () => {
    const runner = createRunner({
      runText: vi
        .fn()
        .mockResolvedValueOnce("UI dump complete")
        .mockResolvedValueOnce('<hierarchy rotation="0"></hierarchy>'),
    });
    const service = new AdbDeviceControlService({
      deviceService: createDiscoveryService(),
      runner,
    });

    await expect(service.readUiTree("device-1")).resolves.toMatchObject({
      xml: '<hierarchy rotation="0"></hierarchy>',
    });
    expect(runner.runText).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying while Android transiently reports that uiautomator was killed", async () => {
    const runner = createRunner({
      runText: vi
        .fn()
        .mockResolvedValueOnce("Killed")
        .mockResolvedValueOnce("Killed")
        .mockResolvedValueOnce("Killed")
        .mockResolvedValueOnce("Killed")
        .mockResolvedValueOnce('<hierarchy rotation="0"></hierarchy>'),
    });
    const service = new AdbDeviceControlService({
      deviceService: createDiscoveryService(),
      runner,
    });

    await expect(service.readUiTree("device-1")).resolves.toMatchObject({
      xml: '<hierarchy rotation="0"></hierarchy>',
    });
    expect(runner.runText).toHaveBeenCalledTimes(5);
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
