import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Adb } from "@devicefarmer/adbkit";
import type { AdbEnvironment, AndroidDevice, DeviceListResponse } from "@device-robot/contracts";

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

    try {
      const properties = await this.#client.getProperties(entry.id);
      const apiLevelValue = Number.parseInt(properties["ro.build.version.sdk"] ?? "", 10);

      return {
        ...base,
        ...optionalField("manufacturer", nonEmpty(properties["ro.product.manufacturer"])),
        ...optionalField("androidVersion", nonEmpty(properties["ro.build.version.release"])),
        ...optionalField("apiLevel", Number.isNaN(apiLevelValue) ? undefined : apiLevelValue),
        ...optionalField("product", nonEmpty(properties["ro.product.name"])),
        ...optionalField("deviceName", nonEmpty(properties["ro.product.device"])),
        ...optionalField("model", nonEmpty(properties["ro.product.model"])),
      };
    } catch (error) {
      return { ...base, detailsError: toErrorMessage(error) };
    }
  }
}
