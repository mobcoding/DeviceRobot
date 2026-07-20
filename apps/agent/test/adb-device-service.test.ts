import { describe, expect, it, vi } from "vitest";

import { AdbDeviceService, type AdbClientAdapter } from "../src/devices/adb-device-service.js";

function createClient(overrides: Partial<AdbClientAdapter> = {}): AdbClientAdapter {
  return {
    listDevicesWithPaths: vi.fn().mockResolvedValue([]),
    getProperties: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

describe("ADB device discovery", () => {
  it("returns a structured diagnostic when ADB is unavailable", async () => {
    const client = createClient();
    const service = new AdbDeviceService({
      client,
      probe: vi.fn().mockResolvedValue({
        available: false,
        executable: "adb",
        error: "adb was not found",
      }),
    });

    const result = await service.listDevices();

    expect(result).toMatchObject({ devices: [], error: "adb was not found" });
    expect(client.listDevicesWithPaths).not.toHaveBeenCalled();
  });

  it("enriches an authorized USB device with Android properties", async () => {
    const service = new AdbDeviceService({
      client: createClient({
        listDevicesWithPaths: vi.fn().mockResolvedValue([
          {
            id: "8B3Y0THX0",
            type: "device",
            path: "product:crosshatch",
            product: "model:Pixel_3_XL",
            model: "device:crosshatch",
            device: "transport_id:1",
          },
        ]),
        getProperties: vi.fn().mockResolvedValue({
          "ro.product.manufacturer": "Google",
          "ro.product.model": "Pixel 3 XL",
          "ro.product.name": "crosshatch",
          "ro.product.device": "crosshatch",
          "ro.build.version.release": "12",
          "ro.build.version.sdk": "31",
        }),
      }),
      probe: vi.fn().mockResolvedValue({
        available: true,
        executable: "adb",
        version: "37.0.0-14910828",
      }),
    });

    const result = await service.listDevices();

    expect(result.devices).toEqual([
      {
        serial: "8B3Y0THX0",
        state: "device",
        connection: "usb",
        product: "crosshatch",
        model: "Pixel 3 XL",
        deviceName: "crosshatch",
        transportId: "1",
        manufacturer: "Google",
        androidVersion: "12",
        apiLevel: 31,
      },
    ]);
  });

  it("preserves unauthorized devices without querying protected properties", async () => {
    const client = createClient({
      listDevicesWithPaths: vi
        .fn()
        .mockResolvedValue([
          { id: "pending-device", type: "unauthorized", path: "transport_id:2" },
        ]),
    });
    const service = new AdbDeviceService({
      client,
      probe: vi.fn().mockResolvedValue({ available: true, executable: "adb" }),
    });

    const result = await service.listDevices();

    expect(result.devices[0]).toMatchObject({
      serial: "pending-device",
      state: "unauthorized",
      connection: "usb",
      transportId: "2",
    });
    expect(client.getProperties).not.toHaveBeenCalled();
  });
});
