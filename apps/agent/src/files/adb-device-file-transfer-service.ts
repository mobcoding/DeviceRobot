import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join, posix } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { AgentPaths } from "@device-robot/config";
import type { DeviceFileTransferResponse, DeviceListResponse } from "@device-robot/contracts";

import type { DeviceDiscoveryService } from "../devices/adb-device-service.js";

const execFileAsync = promisify(execFile);
const MAX_FILE_TRANSFER_SIZE_BYTES = 1_024 * 1_024 * 1_024;
const FILE_TRANSFER_TIMEOUT_MS = 5 * 60_000;
const unsafeDevicePathCharacters = new Set([
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

export class FileTransferError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 413 | 502 | 503,
  ) {
    super(message);
  }
}

export interface FileTransferCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }>;
}

export type DownloadedDeviceFile = {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  dispose(): Promise<void>;
};

export interface DeviceFileTransferService {
  upload(
    serial: string,
    directory: string | undefined,
    fileName: string,
    stream: Readable,
  ): Promise<DeviceFileTransferResponse>;
  download(serial: string, path: string): Promise<DownloadedDeviceFile>;
}

export type AdbDeviceFileTransferServiceOptions = {
  paths: AgentPaths;
  deviceService: DeviceDiscoveryService;
  executable?: string;
  runner?: FileTransferCommandRunner;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createDefaultRunner(): FileTransferCommandRunner {
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

function containsUnsafeDevicePathCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 || unsafeDevicePathCharacters.has(character);
  });
}

function normalizeDeviceDirectory(value: string | undefined): string {
  const directory = value?.trim() || "/storage/emulated/0";
  if (
    directory.length > 1_024 ||
    !directory.startsWith("/") ||
    containsUnsafeDevicePathCharacter(directory)
  ) {
    throw new FileTransferError("目标设备目录无效。", 400);
  }

  const normalized = posix.normalize(directory);
  if (!normalized.startsWith("/")) {
    throw new FileTransferError("目标设备目录无效。", 400);
  }
  return normalized;
}

function normalizeDeviceFilePath(value: string): string {
  if (value.trim().length === 0) {
    throw new FileTransferError("请选择要下载的设备文件。", 400);
  }
  const path = normalizeDeviceDirectory(value);
  const fileName = posix.basename(path);
  if (path === "/" || fileName === "." || fileName === "..") {
    throw new FileTransferError("请选择要下载的设备文件。", 400);
  }
  return path;
}

function normalizeUploadFileName(value: string): string {
  const fileName = value.trim();
  if (
    fileName.length === 0 ||
    fileName.length > 255 ||
    fileName === "." ||
    fileName === ".." ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    [...fileName].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    })
  ) {
    throw new FileTransferError("上传文件名无效。", 400);
  }
  return fileName;
}

export class AdbDeviceFileTransferService implements DeviceFileTransferService {
  readonly #transferDirectory: string;
  readonly #deviceService: DeviceDiscoveryService;
  readonly #adbExecutable: string;
  readonly #runner: FileTransferCommandRunner;

  public constructor(options: AdbDeviceFileTransferServiceOptions) {
    this.#transferDirectory = join(options.paths.artifacts, "file-transfers");
    this.#deviceService = options.deviceService;
    this.#adbExecutable = options.executable ?? process.env.ADB_PATH ?? "adb";
    this.#runner = options.runner ?? createDefaultRunner();
  }

  public async upload(
    serial: string,
    directoryValue: string | undefined,
    fileNameValue: string,
    stream: Readable,
  ): Promise<DeviceFileTransferResponse> {
    await this.#requireReadyDevice(serial);
    const directory = normalizeDeviceDirectory(directoryValue);
    const fileName = normalizeUploadFileName(fileNameValue);
    const targetPath = posix.join(directory, fileName);
    await mkdir(this.#transferDirectory, { recursive: true });
    const temporaryPath = join(this.#transferDirectory, `${randomUUID()}.upload`);
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        if (sizeBytes > MAX_FILE_TRANSFER_SIZE_BYTES) {
          callback(new FileTransferError("上传文件不能超过 1 GB。", 413));
          return;
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(stream, meter, createWriteStream(temporaryPath, { flags: "wx" }));
      await this.#runner.run(
        this.#adbExecutable,
        ["-s", serial, "push", temporaryPath, targetPath],
        FILE_TRANSFER_TIMEOUT_MS,
      );
      return {
        serial,
        fileName,
        path: targetPath,
        sizeBytes,
        transferredAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof FileTransferError) {
        throw error;
      }
      throw new FileTransferError(`上传设备文件失败：${toErrorMessage(error)}`, 502);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  public async download(serial: string, pathValue: string): Promise<DownloadedDeviceFile> {
    await this.#requireReadyDevice(serial);
    const path = normalizeDeviceFilePath(pathValue);
    const fileName = posix.basename(path);
    await mkdir(this.#transferDirectory, { recursive: true });
    const temporaryPath = join(this.#transferDirectory, `${randomUUID()}.download`);

    try {
      const inspection = await this.#runner.run(
        this.#adbExecutable,
        ["-s", serial, "shell", "ls", "-ld", path],
        20_000,
      );
      if (/^d/u.test(inspection.stdout.trimStart())) {
        throw new FileTransferError("仅支持下载普通设备文件。", 400);
      }
      await this.#runner.run(
        this.#adbExecutable,
        ["-s", serial, "pull", path, temporaryPath],
        FILE_TRANSFER_TIMEOUT_MS,
      );
      const metadata = await stat(temporaryPath);
      if (!metadata.isFile()) {
        throw new FileTransferError("仅支持下载普通设备文件。", 400);
      }
      if (metadata.size > MAX_FILE_TRANSFER_SIZE_BYTES) {
        throw new FileTransferError("下载文件不能超过 1 GB。", 413);
      }

      return {
        fileName,
        filePath: temporaryPath,
        sizeBytes: metadata.size,
        dispose: async () => await rm(temporaryPath, { force: true, recursive: true }),
      };
    } catch (error) {
      await rm(temporaryPath, { force: true, recursive: true });
      if (error instanceof FileTransferError) {
        throw error;
      }
      throw new FileTransferError(`下载设备文件失败：${toErrorMessage(error)}`, 502);
    }
  }

  async #requireReadyDevice(serial: string): Promise<void> {
    let response: DeviceListResponse;
    try {
      response = await this.#deviceService.listDevices();
    } catch (error) {
      throw new FileTransferError(`设备发现失败：${toErrorMessage(error)}`, 503);
    }

    if (!response.adb.available) {
      throw new FileTransferError(response.adb.error ?? "ADB 不可用。", 503);
    }
    if (response.error !== undefined) {
      throw new FileTransferError(response.error, 503);
    }

    const device = response.devices.find((candidate) => candidate.serial === serial);
    if (device === undefined) {
      throw new FileTransferError("目标设备已断开连接。", 404);
    }
    if (device.state !== "device" && device.state !== "emulator") {
      throw new FileTransferError(`目标设备当前不可用（${device.state}）。`, 409);
    }
  }
}

export const fileTransferLimits = { maxFileSizeBytes: MAX_FILE_TRANSFER_SIZE_BYTES } as const;
