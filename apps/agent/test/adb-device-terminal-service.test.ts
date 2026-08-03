import { describe, expect, it, vi } from "vitest";
import type { DeviceListResponse } from "@device-robot/contracts";

import {
  AdbDeviceTerminalService,
  type DeviceTerminalCommandRunner,
} from "../src/devices/adb-device-terminal-service.js";
import type { DeviceDiscoveryService } from "../src/devices/adb-device-service.js";

const connectedDevice: DeviceListResponse = {
  adb: { available: true, executable: "adb" },
  devices: [{ serial: "device-1", state: "device", connection: "usb" }],
  refreshedAt: "2026-08-03T10:00:00.000Z",
};

function createDiscoveryService(response = connectedDevice): DeviceDiscoveryService {
  return { listDevices: vi.fn().mockResolvedValue(response) };
}

describe("ADB device terminal", () => {
  it("executes only through the selected device shell and preserves exit codes", async () => {
    const runner: DeviceTerminalCommandRunner = {
      run: vi.fn().mockResolvedValue({ output: "Pixel 6\n", exitCode: 0 }),
    };
    const service = new AdbDeviceTerminalService({
      deviceService: createDiscoveryService(),
      runner,
    });

    const response = await service.execute("device-1", "getprop ro.product.model");

    expect(runner.run).toHaveBeenCalledWith([
      "-s",
      "device-1",
      "shell",
      "getprop ro.product.model",
    ]);
    expect(response).toMatchObject({ output: "Pixel 6\n", exitCode: 0 });
  });

  it("rejects commands before invoking ADB when the selected device is unavailable", async () => {
    const runner: DeviceTerminalCommandRunner = { run: vi.fn() };
    const service = new AdbDeviceTerminalService({
      deviceService: createDiscoveryService({ ...connectedDevice, devices: [] }),
      runner,
    });

    await expect(service.execute("device-1", "id")).rejects.toMatchObject({ statusCode: 404 });
    expect(runner.run).not.toHaveBeenCalled();
  });
});
