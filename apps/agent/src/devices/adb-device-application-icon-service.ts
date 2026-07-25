import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import type { AgentPaths } from "@device-robot/config";
import type { DeviceListResponse } from "@device-robot/contracts";

import {
  ApkArtifactError,
  resolveAaptPath,
  type ApkCommandRunner,
} from "../apks/apk-artifact-service.js";
import type { DeviceDiscoveryService } from "./adb-device-service.js";

const execFileAsync = promisify(execFile);
const APPLICATION_ICON_TIMEOUT_MS = 60_000;
const MAX_APPLICATION_ICON_SIZE_BYTES = 5 * 1_024 * 1_024;
const MAX_CONCURRENT_ICON_EXTRACTIONS = 2;
const SUPPORTED_ICON_EXTENSIONS = new Map([
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
]);

export class DeviceApplicationIconError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 413 | 422 | 502 | 503,
  ) {
    super(message);
  }
}

export type DeviceApplicationIcon = {
  content: Buffer;
  contentType: string;
};

export interface DeviceApplicationIconService {
  readIcon(serial: string, packageName: string): Promise<DeviceApplicationIcon>;
}

export type AdbDeviceApplicationIconServiceOptions = {
  paths: AgentPaths;
  deviceService: DeviceDiscoveryService;
  adbExecutable?: string;
  aaptPath?: string;
  environment?: NodeJS.ProcessEnv;
  runner?: ApkCommandRunner;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandOutput(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function createDefaultRunner(): ApkCommandRunner {
  return {
    run: async (executable, args, timeoutMs) => {
      const { stdout, stderr } = await execFileAsync(executable, [...args], {
        encoding: "utf8",
        maxBuffer: 16 * 1_024 * 1_024,
        timeout: timeoutMs,
        windowsHide: true,
      });
      return { stdout: String(stdout), stderr: String(stderr) };
    },
  };
}

function parseInstalledApkPath(output: string): string | undefined {
  const paths = output
    .split(/\r?\n/u)
    .map((line) => /^package:(\/[^\s]+)$/u.exec(line.trim())?.[1])
    .filter((path): path is string => path !== undefined);
  return paths.find((path) => path.endsWith("/base.apk")) ?? paths[0];
}

export function parseAaptIconPath(output: string): string | undefined {
  const candidates = output.split(/\r?\n/u).flatMap((line) => {
    const densityMatch = /^application-icon-(\d+):'([^']+)'$/u.exec(line.trim());
    if (densityMatch !== null) {
      const density = Number.parseInt(densityMatch[1] ?? "", 10);
      const path = densityMatch[2];
      return Number.isSafeInteger(density) && path !== undefined ? [{ density, path }] : [];
    }

    const applicationIconMatch = /\bicon='([^']+)'/u.exec(line);
    return applicationIconMatch?.[1] === undefined
      ? []
      : [{ density: 0, path: applicationIconMatch[1] }];
  });

  return candidates.sort(
    (left, right) => Math.abs(left.density - 320) - Math.abs(right.density - 320),
  )[0]?.path;
}

function normalizeIconResourcePath(value: string): string {
  const normalized = posix.normalize(value);
  if (
    !normalized.startsWith("res/") ||
    value.split("/").includes("..") ||
    ![...SUPPORTED_ICON_EXTENSIONS.keys(), ".xml"].includes(posix.extname(normalized).toLowerCase())
  ) {
    throw new DeviceApplicationIconError("应用未提供可读取的位图图标。", 404);
  }
  return normalized;
}

function densityForResourcePath(path: string): number {
  if (/(?:^|-)xxxhdpi(?:-|\/)/u.test(path)) {
    return 640;
  }
  if (/(?:^|-)xxhdpi(?:-|\/)/u.test(path)) {
    return 480;
  }
  if (/(?:^|-)xhdpi(?:-|\/)/u.test(path)) {
    return 320;
  }
  if (/(?:^|-)hdpi(?:-|\/)/u.test(path)) {
    return 240;
  }
  if (/(?:^|-)mdpi(?:-|\/)/u.test(path)) {
    return 160;
  }
  if (/(?:^|-)ldpi(?:-|\/)/u.test(path)) {
    return 120;
  }
  return 0;
}

export function selectBitmapIconResource(
  iconResourcePath: string,
  archiveEntries: readonly string[],
): string | undefined {
  const normalized = normalizeIconResourcePath(iconResourcePath);
  if (SUPPORTED_ICON_EXTENSIONS.has(posix.extname(normalized).toLowerCase())) {
    return normalized;
  }

  const directory = posix.dirname(normalized);
  const resourceType = /^res\/([^/-]+)/u.exec(directory)?.[1];
  const resourceName = posix.basename(normalized, ".xml");
  if (resourceType === undefined || resourceName.length === 0) {
    return undefined;
  }

  const candidates = archiveEntries.flatMap((entry) => {
    const path = posix.normalize(entry.trim());
    const extension = posix.extname(path).toLowerCase();
    const candidateResourceType = /^res\/([^/-]+)(?:-[^/]+)?\//u.exec(path)?.[1];
    const candidateName = posix.basename(path, extension);
    return candidateResourceType === resourceType &&
      candidateName === resourceName &&
      SUPPORTED_ICON_EXTENSIONS.has(extension)
      ? [{ path, density: densityForResourcePath(path) }]
      : [];
  });
  return candidates.sort(
    (left, right) => Math.abs(left.density - 320) - Math.abs(right.density - 320),
  )[0]?.path;
}

function cacheFileName(
  serial: string,
  packageName: string,
  apkPath: string,
  extension: string,
): string {
  const key = createHash("sha256")
    .update(`${serial}\u0000${packageName}\u0000${apkPath}`)
    .digest("hex");
  return `${key}${extension}`;
}

export class AdbDeviceApplicationIconService implements DeviceApplicationIconService {
  readonly #paths: AgentPaths;
  readonly #iconDirectory: string;
  readonly #deviceService: DeviceDiscoveryService;
  readonly #adbExecutable: string;
  readonly #configuredAaptPath: string | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #runner: ApkCommandRunner;
  readonly #inFlightRequests = new Map<string, Promise<DeviceApplicationIcon>>();
  readonly #pendingIconJobs: Array<() => void> = [];
  #activeIconJobs = 0;

  public constructor(options: AdbDeviceApplicationIconServiceOptions) {
    this.#paths = options.paths;
    this.#iconDirectory = join(options.paths.artifacts, "application-icons");
    this.#deviceService = options.deviceService;
    this.#adbExecutable = options.adbExecutable ?? process.env.ADB_PATH ?? "adb";
    this.#configuredAaptPath = options.aaptPath ?? process.env.AAPT_PATH;
    this.#environment = options.environment ?? process.env;
    this.#runner = options.runner ?? createDefaultRunner();
  }

  public readIcon(serial: string, packageName: string): Promise<DeviceApplicationIcon> {
    const requestKey = `${serial}\u0000${packageName}`;
    const existing = this.#inFlightRequests.get(requestKey);
    if (existing !== undefined) {
      return existing;
    }

    const request = this.#enqueueIconJob(async () => await this.#readIcon(serial, packageName));
    this.#inFlightRequests.set(requestKey, request);
    void request.then(
      () => this.#inFlightRequests.delete(requestKey),
      () => this.#inFlightRequests.delete(requestKey),
    );
    return request;
  }

  async #readIcon(serial: string, packageName: string): Promise<DeviceApplicationIcon> {
    await this.#requireReadyDevice(serial);

    try {
      const packagePathResult = await this.#runner.run(
        this.#adbExecutable,
        ["-s", serial, "shell", "pm", "path", packageName],
        20_000,
      );
      const apkPath = parseInstalledApkPath(commandOutput(packagePathResult));
      if (apkPath === undefined) {
        throw new DeviceApplicationIconError("未找到应用的 APK 文件。", 404);
      }

      await mkdir(this.#iconDirectory, { recursive: true });
      const cachePrefix = createHash("sha256")
        .update(`${serial}\u0000${packageName}\u0000${apkPath}`)
        .digest("hex");
      const cached = await this.#readCachedIcon(cachePrefix);
      if (cached !== undefined) {
        return cached;
      }

      const workDirectory = join(this.#iconDirectory, randomUUID());
      const downloadedApk = join(workDirectory, "application.apk");
      try {
        await mkdir(workDirectory, { recursive: true });
        await this.#runner.run(
          this.#adbExecutable,
          ["-s", serial, "pull", apkPath, downloadedApk],
          APPLICATION_ICON_TIMEOUT_MS,
        );
        const aaptPath = await resolveAaptPath({
          paths: this.#paths,
          adbExecutable: this.#adbExecutable,
          ...(this.#configuredAaptPath === undefined ? {} : { aaptPath: this.#configuredAaptPath }),
          environment: this.#environment,
          runner: this.#runner,
        });
        const badging = await this.#runner.run(
          aaptPath,
          ["dump", "badging", downloadedApk],
          30_000,
        );
        const iconResourcePath = parseAaptIconPath(commandOutput(badging));
        if (iconResourcePath === undefined) {
          throw new DeviceApplicationIconError("应用未提供可读取的位图图标。", 404);
        }
        const archiveContents = await this.#runner.run("tar", ["-tf", downloadedApk], 30_000);
        const normalizedResourcePath = selectBitmapIconResource(
          iconResourcePath,
          commandOutput(archiveContents).split(/\r?\n/u),
        );
        if (normalizedResourcePath === undefined) {
          throw new DeviceApplicationIconError("应用未提供可读取的位图图标。", 404);
        }
        await this.#runner.run(
          "tar",
          ["-xf", downloadedApk, "-C", workDirectory, normalizedResourcePath],
          30_000,
        );
        const extractedIcon = join(workDirectory, ...normalizedResourcePath.split("/"));
        const metadata = await stat(extractedIcon);
        if (!metadata.isFile() || metadata.size === 0) {
          throw new DeviceApplicationIconError("应用图标文件不可用。", 404);
        }
        if (metadata.size > MAX_APPLICATION_ICON_SIZE_BYTES) {
          throw new DeviceApplicationIconError("应用图标文件过大。", 413);
        }

        const extension = posix.extname(normalizedResourcePath).toLowerCase();
        const contentType = SUPPORTED_ICON_EXTENSIONS.get(extension);
        if (contentType === undefined) {
          throw new DeviceApplicationIconError("应用图标格式不受支持。", 404);
        }
        const content = await readFile(extractedIcon);
        await writeFile(
          join(this.#iconDirectory, cacheFileName(serial, packageName, apkPath, extension)),
          content,
          {
            flag: "wx",
          },
        ).catch((error: unknown) => {
          if ((error as { code?: unknown }).code !== "EEXIST") {
            throw error;
          }
        });
        return { content, contentType };
      } finally {
        await rm(workDirectory, { force: true, recursive: true });
      }
    } catch (error) {
      if (error instanceof DeviceApplicationIconError) {
        throw error;
      }
      if (error instanceof ApkArtifactError) {
        throw new DeviceApplicationIconError(error.message, error.statusCode);
      }
      throw new DeviceApplicationIconError(`读取应用图标失败：${toErrorMessage(error)}`, 502);
    }
  }

  async #readCachedIcon(cachePrefix: string): Promise<DeviceApplicationIcon | undefined> {
    for (const [extension, contentType] of SUPPORTED_ICON_EXTENSIONS) {
      const filePath = join(this.#iconDirectory, `${cachePrefix}${extension}`);
      try {
        const metadata = await stat(filePath);
        if (
          !metadata.isFile() ||
          metadata.size === 0 ||
          metadata.size > MAX_APPLICATION_ICON_SIZE_BYTES
        ) {
          continue;
        }
        return { content: await readFile(filePath), contentType };
      } catch {
        // Try the next supported file extension.
      }
    }
    return undefined;
  }

  #enqueueIconJob<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#pendingIconJobs.push(() => {
        this.#activeIconJobs += 1;
        void job()
          .then(resolve, reject)
          .finally(() => {
            this.#activeIconJobs -= 1;
            this.#startPendingIconJobs();
          });
      });
      this.#startPendingIconJobs();
    });
  }

  #startPendingIconJobs(): void {
    while (
      this.#activeIconJobs < MAX_CONCURRENT_ICON_EXTRACTIONS &&
      this.#pendingIconJobs.length > 0
    ) {
      this.#pendingIconJobs.shift()?.();
    }
  }

  async #requireReadyDevice(serial: string): Promise<void> {
    let response: DeviceListResponse;
    try {
      response = await this.#deviceService.listDevices();
    } catch (error) {
      throw new DeviceApplicationIconError(`设备发现失败：${toErrorMessage(error)}`, 503);
    }

    if (!response.adb.available) {
      throw new DeviceApplicationIconError(response.adb.error ?? "ADB 不可用。", 503);
    }
    if (response.error !== undefined) {
      throw new DeviceApplicationIconError(response.error, 503);
    }
    const device = response.devices.find((candidate) => candidate.serial === serial);
    if (device === undefined) {
      throw new DeviceApplicationIconError("目标设备已断开连接。", 404);
    }
    if (device.state !== "device" && device.state !== "emulator") {
      throw new DeviceApplicationIconError(`目标设备当前不可用（${device.state}）。`, 409);
    }
  }
}
