import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Adb } from "@devicefarmer/adbkit";
import type {
  AdbEnvironment,
  AndroidDevice,
  DeviceListResponse,
  DeviceNetwork,
} from "@device-robot/contracts";

const execFileAsync = promisify(execFile);

type AdbDeviceEntry = {
  id: string;
  type: "emulator" | "device" | "offline" | "unauthorized" | "unknown";
  path?: string;
  product?: string;
  model?: string;
  device?: string;
  transportId?: string;
};

export interface AdbClientAdapter {
  listDevicesWithPaths(): Promise<AdbDeviceEntry[]>;
  getProperties(serial: string): Promise<Record<string, string>>;
  getRuntimeStatus(serial: string): Promise<Pick<AndroidDevice, "battery" | "network">>;
}

export interface DeviceDiscoveryService {
  listDevices(): Promise<DeviceListResponse>;
}

export type AdbEnvironmentProbe = () => Promise<AdbEnvironment>;

export type AdbDeviceServiceOptions = {
  executable?: string;
  client?: AdbClientAdapter;
  probe?: AdbEnvironmentProbe;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function normalizeModel(value: string): string {
  return value.replaceAll("_", " ");
}

function connectionType(device: AdbDeviceEntry): AndroidDevice["connection"] {
  if (device.type === "emulator" || device.id.startsWith("emulator-")) {
    return "emulator";
  }

  return device.id.includes(":") ? "tcp" : "usb";
}

function optionalField<Key extends keyof AndroidDevice>(
  key: Key,
  value: AndroidDevice[Key] | undefined,
): Partial<AndroidDevice> {
  return value === undefined ? {} : ({ [key]: value } as Partial<AndroidDevice>);
}

function parseExtendedFields(entry: AdbDeviceEntry): Partial<AndroidDevice> {
  const fields: Partial<AndroidDevice> = {};

  const parse = (
    rawValue: string | undefined,
    fallback: "path" | "product" | "model" | "deviceName" | "transportId",
  ): void => {
    const token = nonEmpty(rawValue);
    if (token === undefined) {
      return;
    }

    const prefixedValue = (prefix: string): string | undefined =>
      token.startsWith(prefix) ? nonEmpty(token.slice(prefix.length)) : undefined;

    const product = prefixedValue("product:");
    const model = prefixedValue("model:");
    const deviceName = prefixedValue("device:");
    const transportId = prefixedValue("transport_id:");

    if (product !== undefined) {
      fields.product = product;
    } else if (model !== undefined) {
      fields.model = normalizeModel(model);
    } else if (deviceName !== undefined) {
      fields.deviceName = deviceName;
    } else if (transportId !== undefined) {
      fields.transportId = transportId;
    } else if (fallback === "model") {
      fields.model = normalizeModel(token);
    } else {
      fields[fallback] = token;
    }
  };

  // adbkit maps the space-separated host:devices-l tokens by position. Modern
  // ADB often omits the USB path, so parse token prefixes before using those positions.
  parse(entry.path, "path");
  parse(entry.product, "product");
  parse(entry.model, "model");
  parse(entry.device, "deviceName");
  parse(entry.transportId, "transportId");

  return fields;
}

function parseBatteryState(
  value: string | undefined,
): NonNullable<AndroidDevice["battery"]>["state"] {
  switch (value) {
    case "2":
      return "charging";
    case "3":
      return "discharging";
    case "4":
      return "not-charging";
    case "5":
      return "full";
    default:
      return "unknown";
  }
}

function parseNetwork(route: string): DeviceNetwork {
  const normalized = route.toLowerCase();
  const connected = !/unreachable|prohibit|not found/.test(normalized) && /\bdev\s+\S+/.test(route);

  if (!connected) {
    return { transport: "none", connected: false };
  }

  const interfaceName = /\bdev\s+(\S+)/.exec(route)?.[1]?.toLowerCase();
  if (interfaceName === undefined) {
    return { transport: "unknown", connected: true };
  }

  if (/^(wlan|wifi)/.test(interfaceName)) {
    return { transport: "wifi", connected: true };
  }

  if (/^(rmnet|ccmni|pdp|wwan)/.test(interfaceName)) {
    return { transport: "mobile", connected: true };
  }

  if (/^(eth|en)/.test(interfaceName)) {
    return { transport: "ethernet", connected: true };
  }

  return { transport: "unknown", connected: true };
}

export function parseDeviceRuntimeStatus(
  output: string,
): Pick<AndroidDevice, "battery" | "network"> {
  const [batteryOutput = "", routeOutput = ""] = output.split("__DEVICE_ROBOT_ROUTE__", 2);
  const batteryLevel = Number.parseInt(
    /^\s*level:\s*(\d+)\s*$/m.exec(batteryOutput)?.[1] ?? "",
    10,
  );
  const batteryStatus = /^\s*status:\s*(\d+)\s*$/m.exec(batteryOutput)?.[1];

  return {
    ...(Number.isNaN(batteryLevel)
      ? {}
      : {
          battery: {
            level: Math.min(100, Math.max(0, batteryLevel)),
            state: parseBatteryState(batteryStatus),
          },
        }),
    network: parseNetwork(routeOutput),
  };
}

export async function probeAdbEnvironment(executable = "adb"): Promise<AdbEnvironment> {
  try {
    const { stdout, stderr } = await execFileAsync(executable, ["version"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    const output = `${stdout}\n${stderr}`;
    const version = /^Version\s+(.+)$/m.exec(output)?.[1]?.trim();
    const installedPath = /^Installed as\s+(.+)$/m.exec(output)?.[1]?.trim();

    return {
      available: true,
      executable,
      ...(version === undefined ? {} : { version }),
      ...(installedPath === undefined ? {} : { installedPath }),
    };
  } catch (error) {
    return {
      available: false,
      executable,
      error: toErrorMessage(error),
    };
  }
}

function createDefaultClient(executable: string): AdbClientAdapter {
  const client = Adb.createClient({ bin: executable });

  return {
    listDevicesWithPaths: async () => await client.listDevicesWithPaths(),
    getProperties: async (serial) => await client.getDevice(serial).getProperties(),
    getRuntimeStatus: async (serial) => {
      const { stdout } = await execFileAsync(
        executable,
        [
          "-s",
          serial,
          "shell",
          "dumpsys battery; echo __DEVICE_ROBOT_ROUTE__; ip route get 1.1.1.1 || true",
        ],
        { encoding: "utf8", timeout: 5_000, windowsHide: true },
      );
      return parseDeviceRuntimeStatus(stdout);
    },
  };
}

export class AdbDeviceService implements DeviceDiscoveryService {
  readonly #client: AdbClientAdapter;
  readonly #probe: AdbEnvironmentProbe;

  public constructor(options: AdbDeviceServiceOptions = {}) {
    const executable = options.executable ?? process.env.ADB_PATH ?? "adb";
    this.#client = options.client ?? createDefaultClient(executable);
    this.#probe = options.probe ?? (() => probeAdbEnvironment(executable));
  }

  public async listDevices(): Promise<DeviceListResponse> {
    const adb = await this.#probe();
    const refreshedAt = new Date().toISOString();

    if (!adb.available) {
      return { adb, devices: [], refreshedAt, error: adb.error ?? "ADB is unavailable" };
    }

    try {
      const entries = await this.#client.listDevicesWithPaths();
      const devices = await Promise.all(entries.map(async (entry) => await this.#enrich(entry)));
      return { adb, devices, refreshedAt };
    } catch (error) {
      return { adb, devices: [], refreshedAt, error: toErrorMessage(error) };
    }
  }

  async #enrich(entry: AdbDeviceEntry): Promise<AndroidDevice> {
    const base: AndroidDevice = {
      serial: entry.id,
      state: entry.type,
      connection: connectionType(entry),
      ...parseExtendedFields(entry),
    };

    if (entry.type !== "device" && entry.type !== "emulator") {
      return base;
    }

    let device = base;

    try {
      const properties = await this.#client.getProperties(entry.id);
      const apiLevelValue = Number.parseInt(properties["ro.build.version.sdk"] ?? "", 10);

      device = {
        ...device,
        ...optionalField("manufacturer", nonEmpty(properties["ro.product.manufacturer"])),
        ...optionalField("androidVersion", nonEmpty(properties["ro.build.version.release"])),
        ...optionalField("apiLevel", Number.isNaN(apiLevelValue) ? undefined : apiLevelValue),
        ...optionalField("product", nonEmpty(properties["ro.product.name"])),
        ...optionalField("deviceName", nonEmpty(properties["ro.product.device"])),
        ...optionalField("model", nonEmpty(properties["ro.product.model"])),
      };
    } catch (error) {
      device = { ...device, detailsError: toErrorMessage(error) };
    }

    try {
      return { ...device, ...(await this.#client.getRuntimeStatus(entry.id)) };
    } catch (error) {
      const runtimeError = toErrorMessage(error);
      return {
        ...device,
        detailsError:
          device.detailsError === undefined
            ? runtimeError
            : `${device.detailsError}; ${runtimeError}`,
      };
    }
  }
}
