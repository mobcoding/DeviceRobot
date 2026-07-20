import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import type {
  DeviceApplication,
  DeviceApplicationFilter,
  DeviceApplicationListResponse,
  DeviceApplicationSource,
  DeviceFileEntry,
  DeviceFileKind,
  DeviceFileListResponse,
  DeviceListResponse,
  DeviceLogcatEntry,
  DeviceLogcatLevel,
  DeviceLogcatResponse,
} from "@device-robot/contracts";

import { DeviceControlError } from "./adb-device-control-service.js";
import type { DeviceDiscoveryService } from "./adb-device-service.js";

const execFileAsync = promisify(execFile);
const shellMetaCharacters = new Set([
  "\\",
  "'",
  '"',
  "`",
  "$",
  "&",
  ";",
  "|",
  "<",
  ">",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  "*",
  "?",
  "!",
  "~",
]);
const DEFAULT_LOGCAT_LIMIT = 300;
const MINIMUM_LOGCAT_LIMIT = 10;
const MAXIMUM_LOGCAT_LIMIT = 1_000;
const logcatLevelByLetter: Record<string, DeviceLogcatLevel> = {
  V: "verbose",
  D: "debug",
  I: "info",
  W: "warn",
  E: "error",
  F: "fatal",
  A: "assert",
};
const logcatThreadtimePattern =
  /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+([^:]+):\s?(.*)$/u;

export interface DeviceManagementCommandRunner {
  runText(args: readonly string[]): Promise<string>;
}

export interface DeviceManagementService {
  listFiles(serial: string, path?: string): Promise<DeviceFileListResponse>;
  listApplications(
    serial: string,
    filter?: DeviceApplicationFilter,
  ): Promise<DeviceApplicationListResponse>;
  readLogcat(serial: string, limit?: number): Promise<DeviceLogcatResponse>;
}

export type AdbDeviceManagementServiceOptions = {
  deviceService: DeviceDiscoveryService;
  executable?: string;
  runner?: DeviceManagementCommandRunner;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createDefaultRunner(executable: string): DeviceManagementCommandRunner {
  return {
    runText: async (args) => {
      const { stdout } = await execFileAsync(executable, args, {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 20_000,
        windowsHide: true,
      });
      return stdout.toString();
    },
  };
}

function containsUnsafePathCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 || shellMetaCharacters.has(character);
  });
}

function normalizeDevicePath(value: string | undefined): string {
  const path = value?.trim() || "/storage/emulated/0";
  if (path.length > 1_024 || !path.startsWith("/") || containsUnsafePathCharacter(path)) {
    throw new DeviceControlError("The requested device path is invalid", 400);
  }

  const normalized = posix.normalize(path);
  if (!normalized.startsWith("/")) {
    throw new DeviceControlError("The requested device path is invalid", 400);
  }

  return normalized;
}

function parseFileEntry(path: string, line: string): DeviceFileEntry | undefined {
  const rawName = line.trim();
  if (rawName.length === 0 || rawName === "." || rawName === "..") {
    return undefined;
  }

  const suffix = rawName.at(-1);
  const kind: DeviceFileKind =
    suffix === "/"
      ? "directory"
      : suffix === "@"
        ? "link"
        : suffix === "|" || suffix === "="
          ? "other"
          : "file";
  const name = kind === "file" ? rawName : rawName.slice(0, -1);

  if (name.length === 0 || containsUnsafePathCharacter(name)) {
    return undefined;
  }

  return {
    name,
    path: posix.join(path, name),
    kind,
  };
}

function parseFileEntries(path: string, output: string): DeviceFileEntry[] {
  return output
    .split(/\r?\n/u)
    .map((line) => parseFileEntry(path, line))
    .filter((entry): entry is DeviceFileEntry => entry !== undefined)
    .sort((left, right) => {
      if (left.kind === "directory" && right.kind !== "directory") {
        return -1;
      }
      if (left.kind !== "directory" && right.kind === "directory") {
        return 1;
      }
      return left.name.localeCompare(right.name, "zh-CN");
    });
}

function parseApplications(output: string, source: DeviceApplicationSource): DeviceApplication[] {
  return output.split(/\r?\n/u).flatMap((line) => {
    const matched = /^package:(.+)=([^\s]+)(?:\s+versionCode:([^\s]+))?$/u.exec(line.trim());
    if (matched === null) {
      return [];
    }

    const apkPath = matched[1];
    const packageName = matched[2];
    const versionCode = matched[3];
    if (
      packageName === undefined ||
      apkPath === undefined ||
      packageName.length === 0 ||
      apkPath.length === 0
    ) {
      return [];
    }

    return [
      {
        packageName,
        source,
        apkPath,
        ...(versionCode === undefined ? {} : { versionCode }),
      },
    ];
  });
}

function normalizeLogcatLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_LOGCAT_LIMIT;
  if (!Number.isInteger(limit) || limit < MINIMUM_LOGCAT_LIMIT || limit > MAXIMUM_LOGCAT_LIMIT) {
    throw new DeviceControlError(
      `The logcat limit must be an integer between ${MINIMUM_LOGCAT_LIMIT} and ${MAXIMUM_LOGCAT_LIMIT}`,
      400,
    );
  }
  return limit;
}

export function parseLogcatEntries(output: string): DeviceLogcatEntry[] {
  return output.split(/\r?\n/u).flatMap((line): DeviceLogcatEntry[] => {
    if (line.trim().length === 0) {
      return [];
    }

    const match = logcatThreadtimePattern.exec(line);
    if (match === null) {
      return [{ level: "unknown", message: line }];
    }

    const [, timestamp, processIdValue, threadIdValue, levelLetter, tagValue, message] = match;
    const processId = Number.parseInt(processIdValue ?? "", 10);
    const threadId = Number.parseInt(threadIdValue ?? "", 10);
    const level = logcatLevelByLetter[levelLetter ?? ""];
    const tag = tagValue?.trim();

    if (
      Number.isNaN(processId) ||
      Number.isNaN(threadId) ||
      level === undefined ||
      tag === undefined ||
      tag.length === 0
    ) {
      return [{ level: "unknown", message: line }];
    }

    return [
      {
        timestamp,
        processId,
        threadId,
        level,
        tag,
        message: message ?? "",
      },
    ];
  });
}

export class AdbDeviceManagementService implements DeviceManagementService {
  readonly #deviceService: DeviceDiscoveryService;
  readonly #runner: DeviceManagementCommandRunner;

  public constructor(options: AdbDeviceManagementServiceOptions) {
    const executable = options.executable ?? process.env.ADB_PATH ?? "adb";
    this.#deviceService = options.deviceService;
    this.#runner = options.runner ?? createDefaultRunner(executable);
  }

  public async listFiles(serial: string, requestedPath?: string): Promise<DeviceFileListResponse> {
    await this.#requireReadyDevice(serial);
    const path = normalizeDevicePath(requestedPath);

    try {
      const output = await this.#runner.runText(["-s", serial, "shell", "ls", "-1Ap", path]);
      return {
        serial,
        path,
        ...(path === "/" ? {} : { parentPath: posix.dirname(path) }),
        entries: parseFileEntries(path, output),
        readAt: new Date().toISOString(),
      };
    } catch (error) {
      throw this.#asManagementError(error, "File listing failed");
    }
  }

  public async listApplications(
    serial: string,
    filter: DeviceApplicationFilter = "all",
  ): Promise<DeviceApplicationListResponse> {
    await this.#requireReadyDevice(serial);
    const sources: readonly DeviceApplicationSource[] =
      filter === "all" ? ["user", "system"] : [filter];

    try {
      const results = await Promise.all(
        sources.map(async (source) => ({
          source,
          output: await this.#runner.runText([
            "-s",
            serial,
            "shell",
            "pm",
            "list",
            "packages",
            "-f",
            "--show-versioncode",
            source === "user" ? "-3" : "-s",
          ]),
        })),
      );
      const byPackageName = new Map<string, DeviceApplication>();

      for (const result of results) {
        for (const application of parseApplications(result.output, result.source)) {
          const existing = byPackageName.get(application.packageName);
          if (existing === undefined || application.source === "user") {
            byPackageName.set(application.packageName, application);
          }
        }
      }

      return {
        serial,
        filter,
        applications: [...byPackageName.values()].sort((left, right) => {
          if (left.source !== right.source) {
            return left.source === "user" ? -1 : 1;
          }
          return left.packageName.localeCompare(right.packageName, "en");
        }),
        readAt: new Date().toISOString(),
      };
    } catch (error) {
      throw this.#asManagementError(error, "Application list failed");
    }
  }

  public async readLogcat(
    serial: string,
    requestedLimit: number = DEFAULT_LOGCAT_LIMIT,
  ): Promise<DeviceLogcatResponse> {
    await this.#requireReadyDevice(serial);
    const limit = normalizeLogcatLimit(requestedLimit);

    try {
      const output = await this.#runner.runText([
        "-s",
        serial,
        "logcat",
        "-d",
        "-v",
        "threadtime",
        "-t",
        String(limit),
      ]);
      return {
        serial,
        entries: parseLogcatEntries(output).slice(-limit),
        readAt: new Date().toISOString(),
      };
    } catch (error) {
      throw this.#asManagementError(error, "Logcat read failed");
    }
  }

  async #requireReadyDevice(serial: string): Promise<void> {
    let response: DeviceListResponse;
    try {
      response = await this.#deviceService.listDevices();
    } catch (error) {
      throw new DeviceControlError(`Device discovery failed: ${toErrorMessage(error)}`, 503);
    }

    if (!response.adb.available) {
      throw new DeviceControlError(response.adb.error ?? "ADB is unavailable", 503);
    }

    if (response.error !== undefined) {
      throw new DeviceControlError(response.error, 503);
    }

    const device = response.devices.find((candidate) => candidate.serial === serial);
    if (device === undefined) {
      throw new DeviceControlError("The requested device is no longer connected", 404);
    }

    if (device.state !== "device" && device.state !== "emulator") {
      throw new DeviceControlError(
        `The requested device is not ready for automation (${device.state})`,
        409,
      );
    }
  }

  #asManagementError(error: unknown, prefix: string): DeviceControlError {
    if (error instanceof DeviceControlError) {
      return error;
    }

    return new DeviceControlError(`${prefix}: ${toErrorMessage(error)}`, 502);
  }
}
