import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { AgentPaths } from "@device-robot/config";
import {
  apkArtifactSchema,
  apkInstallResponseSchema,
  apkMetadataSchema,
  type ApkArtifact,
  type ApkInstallRequest,
  type ApkInstallResponse,
  type ApkMetadata,
  type DeviceListResponse,
} from "@device-robot/contracts";

import type { DeviceDiscoveryService } from "../devices/adb-device-service.js";
import type { ApkInstallAuditStore } from "./apk-install-audit-store.js";

const execFileAsync = promisify(execFile);
const MAX_APK_SIZE_BYTES = 1_024 * 1_024 * 1_024;
const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1_000;
const APK_ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export class ApkArtifactError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 413 | 422 | 502 | 503,
  ) {
    super(message);
  }
}

export interface ApkCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface ApkArtifactService {
  stage(fileName: string, stream: Readable): Promise<ApkArtifact>;
  discard(artifactId: string): Promise<void>;
  install(
    serial: string,
    artifactId: string,
    options: ApkInstallRequest,
  ): Promise<ApkInstallResponse>;
}

export type LocalApkArtifactServiceOptions = {
  paths: AgentPaths;
  deviceService: DeviceDiscoveryService;
  auditStore: ApkInstallAuditStore;
  adbExecutable?: string;
  aaptPath?: string;
  environment?: NodeJS.ProcessEnv;
  runner?: ApkCommandRunner;
};

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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandOutput(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function safeFileName(value: string): string {
  const fileName = basename(value).trim();
  if (
    fileName.length === 0 ||
    fileName.length > 255 ||
    !fileName.toLocaleLowerCase().endsWith(".apk")
  ) {
    throw new ApkArtifactError("请选择有效的 APK 文件。", 400);
  }
  return fileName;
}

function quotedValue(line: string | undefined, key: string): string | undefined {
  if (line === undefined) {
    return undefined;
  }
  const value = new RegExp(`${key}='([^']*)'`, "u").exec(line)?.[1]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function lineValue(line: string | undefined): string | undefined {
  const value = /^[^:]+:'([^']*)'/u.exec(line ?? "")?.[1]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

export function parseAaptBadging(output: string): ApkMetadata {
  const lines = output.split(/\r?\n/u).map((line) => line.trim());
  const packageLine = lines.find((line) => line.startsWith("package:"));
  const minSdkLine = lines.find((line) => line.startsWith("sdkVersion:"));
  const targetSdkLine = lines.find((line) => line.startsWith("targetSdkVersion:"));
  const labelLine = lines.find((line) => line.startsWith("application-label:"));
  const packageName = quotedValue(packageLine, "name");
  const versionCode = quotedValue(packageLine, "versionCode");

  if (packageName === undefined || versionCode === undefined) {
    throw new ApkArtifactError("无法从文件中读取有效的 APK 包信息。", 422);
  }

  const versionName = quotedValue(packageLine, "versionName");
  const applicationLabel = lineValue(labelLine);
  const minSdkVersion = lineValue(minSdkLine);
  const targetSdkVersion = lineValue(targetSdkLine);

  const parsed = apkMetadataSchema.safeParse({
    packageName,
    versionCode,
    ...(versionName === undefined ? {} : { versionName }),
    ...(applicationLabel === undefined ? {} : { applicationLabel }),
    ...(minSdkVersion === undefined ? {} : { minSdkVersion }),
    ...(targetSdkVersion === undefined ? {} : { targetSdkVersion }),
  });
  if (!parsed.success) {
    throw new ApkArtifactError("APK 包信息不符合 Android 应用格式。", 422);
  }
  return parsed.data;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function versionParts(value: string): number[] {
  return value.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersionsDescending(left: string, right: string): number {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (rightParts[index] ?? 0) - (leftParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return right.localeCompare(left, "en");
}

async function findAaptInSdk(sdkRoot: string): Promise<string | undefined> {
  const buildTools = join(sdkRoot, "build-tools");
  try {
    const versions = (await readdir(buildTools, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(compareVersionsDescending);
    for (const version of versions) {
      for (const executable of ["aapt.exe", "aapt"]) {
        const candidate = join(buildTools, version, executable);
        if (await isFile(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export class LocalApkArtifactService implements ApkArtifactService {
  readonly #paths: AgentPaths;
  readonly #artifactDirectory: string;
  readonly #deviceService: DeviceDiscoveryService;
  readonly #auditStore: ApkInstallAuditStore;
  readonly #adbExecutable: string;
  readonly #configuredAaptPath: string | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #runner: ApkCommandRunner;

  public constructor(options: LocalApkArtifactServiceOptions) {
    this.#paths = options.paths;
    this.#artifactDirectory = join(options.paths.artifacts, "apks");
    this.#deviceService = options.deviceService;
    this.#auditStore = options.auditStore;
    this.#adbExecutable = options.adbExecutable ?? process.env.ADB_PATH ?? "adb";
    this.#configuredAaptPath = options.aaptPath ?? process.env.AAPT_PATH;
    this.#environment = options.environment ?? process.env;
    this.#runner = options.runner ?? createDefaultRunner();
  }

  public async stage(fileNameValue: string, stream: Readable): Promise<ApkArtifact> {
    const fileName = safeFileName(fileNameValue);
    const artifactId = randomUUID();
    await mkdir(this.#artifactDirectory, { recursive: true });
    const temporaryPath = this.#temporaryPath(artifactId);
    const apkPath = this.#apkPath(artifactId);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        if (sizeBytes > MAX_APK_SIZE_BYTES) {
          callback(new ApkArtifactError("APK 文件不能超过 1 GB。", 413));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(stream, meter, createWriteStream(temporaryPath, { flags: "wx" }));
      if (sizeBytes === 0) {
        throw new ApkArtifactError("APK 文件不能为空。", 400);
      }

      const handle = await open(temporaryPath, "r");
      try {
        const signature = Buffer.alloc(APK_ZIP_SIGNATURE.length);
        await handle.read(signature, 0, signature.length, 0);
        if (!signature.equals(APK_ZIP_SIGNATURE)) {
          throw new ApkArtifactError("文件不是有效的 APK 压缩包。", 422);
        }
      } finally {
        await handle.close();
      }

      await rename(temporaryPath, apkPath);
      const aaptPath = await this.#resolveAaptPath();
      const metadataResult = await this.#runner.run(aaptPath, ["dump", "badging", apkPath], 30_000);
      const metadata = parseAaptBadging(commandOutput(metadataResult));
      const artifact = apkArtifactSchema.parse({
        id: artifactId,
        fileName,
        sizeBytes,
        sha256: hash.digest("hex"),
        uploadedAt: new Date().toISOString(),
        metadata,
      });
      await writeFile(this.#metadataPath(artifactId), JSON.stringify(artifact), "utf8");
      return artifact;
    } catch (error) {
      await Promise.all([
        rm(temporaryPath, { force: true }),
        rm(apkPath, { force: true }),
        rm(this.#metadataPath(artifactId), { force: true }),
      ]);
      if (error instanceof ApkArtifactError) {
        throw error;
      }
      if ((error as { code?: unknown }).code === "FST_REQ_FILE_TOO_LARGE") {
        throw new ApkArtifactError("APK 文件不能超过 1 GB。", 413);
      }
      throw new ApkArtifactError(`APK 上传或解析失败：${toErrorMessage(error)}`, 502);
    }
  }

  public async discard(artifactId: string): Promise<void> {
    await Promise.all([
      rm(this.#apkPath(artifactId), { force: true }),
      rm(this.#metadataPath(artifactId), { force: true }),
      rm(this.#temporaryPath(artifactId), { force: true }),
    ]);
  }

  public async install(
    serial: string,
    artifactId: string,
    options: ApkInstallRequest,
  ): Promise<ApkInstallResponse> {
    await this.#requireReadyDevice(serial);
    const artifact = await this.#loadArtifact(artifactId);
    const startedAt = new Date().toISOString();

    try {
      const args = ["-s", serial, "install"];
      if (options.replaceExisting) {
        args.push("-r");
      }
      if (options.allowTestPackage) {
        args.push("-t");
      }
      args.push(this.#apkPath(artifactId));
      const result = await this.#runner.run(this.#adbExecutable, args, 5 * 60_000);
      const message = commandOutput(result);
      if (!/(?:^|\s)Success(?:\s|$)/u.test(message)) {
        throw new ApkArtifactError(message || "ADB 未返回安装成功状态。", 502);
      }

      const finishedAt = new Date().toISOString();
      this.#auditStore.record({
        artifactId,
        serial,
        fileName: artifact.fileName,
        packageName: artifact.metadata.packageName,
        sha256: artifact.sha256,
        success: true,
        message,
        startedAt,
        finishedAt,
      });
      await this.discard(artifactId);
      return apkInstallResponseSchema.parse({
        status: "installed",
        serial,
        artifactId,
        packageName: artifact.metadata.packageName,
        startedAt,
        finishedAt,
        ...(message.length === 0 ? {} : { message }),
      });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const message = toErrorMessage(error);
      this.#auditStore.record({
        artifactId,
        serial,
        fileName: artifact.fileName,
        packageName: artifact.metadata.packageName,
        sha256: artifact.sha256,
        success: false,
        message,
        startedAt,
        finishedAt,
      });
      if (error instanceof ApkArtifactError) {
        throw error;
      }
      throw new ApkArtifactError(`APK 安装失败：${message}`, 502);
    }
  }

  async #loadArtifact(artifactId: string): Promise<ApkArtifact> {
    try {
      const artifact = apkArtifactSchema.parse(
        JSON.parse(await readFile(this.#metadataPath(artifactId), "utf8")),
      );
      if (artifact.id !== artifactId) {
        throw new ApkArtifactError("APK 上传记录无效，请重新选择文件。", 404);
      }
      if (Date.now() - new Date(artifact.uploadedAt).getTime() > ARTIFACT_TTL_MS) {
        await this.discard(artifactId);
        throw new ApkArtifactError("APK 上传记录已过期，请重新选择文件。", 404);
      }
      if (!existsSync(this.#apkPath(artifactId))) {
        throw new ApkArtifactError("APK 上传文件不存在，请重新选择文件。", 404);
      }
      return artifact;
    } catch (error) {
      if (error instanceof ApkArtifactError) {
        throw error;
      }
      throw new ApkArtifactError("APK 上传记录不存在，请重新选择文件。", 404);
    }
  }

  async #resolveAaptPath(): Promise<string> {
    if (this.#configuredAaptPath !== undefined && (await isFile(this.#configuredAaptPath))) {
      return this.#configuredAaptPath;
    }

    const sdkRoots = new Set<string>();
    for (const configured of [this.#environment.ANDROID_HOME, this.#environment.ANDROID_SDK_ROOT]) {
      if (configured !== undefined && configured.trim().length > 0) {
        sdkRoots.add(configured.trim());
      }
    }
    sdkRoots.add(this.#paths.androidSdk);
    if (isAbsolute(this.#adbExecutable)) {
      sdkRoots.add(dirname(dirname(this.#adbExecutable)));
    }

    try {
      const adbVersion = await this.#runner.run(this.#adbExecutable, ["version"], 10_000);
      const installedPath = /^Installed as\s+(.+)$/imu.exec(commandOutput(adbVersion))?.[1]?.trim();
      if (installedPath !== undefined && isAbsolute(installedPath)) {
        sdkRoots.add(dirname(dirname(installedPath)));
      }
    } catch {
      // Installation can still proceed when an SDK path was configured explicitly.
    }

    for (const sdkRoot of sdkRoots) {
      const aaptPath = await findAaptInSdk(sdkRoot);
      if (aaptPath !== undefined) {
        return aaptPath;
      }
    }
    throw new ApkArtifactError("未找到 Android build-tools 中的 aapt，无法解析 APK。", 503);
  }

  async #requireReadyDevice(serial: string): Promise<void> {
    let response: DeviceListResponse;
    try {
      response = await this.#deviceService.listDevices();
    } catch (error) {
      throw new ApkArtifactError(`设备发现失败：${toErrorMessage(error)}`, 503);
    }
    if (!response.adb.available || response.error !== undefined) {
      throw new ApkArtifactError(response.error ?? response.adb.error ?? "ADB 不可用。", 503);
    }
    const device = response.devices.find((candidate) => candidate.serial === serial);
    if (device === undefined) {
      throw new ApkArtifactError("目标设备已断开连接。", 404);
    }
    if (device.state !== "device" && device.state !== "emulator") {
      throw new ApkArtifactError(`目标设备当前不可安装应用（${device.state}）。`, 409);
    }
  }

  #apkPath(artifactId: string): string {
    return join(this.#artifactDirectory, `${artifactId}.apk`);
  }

  #metadataPath(artifactId: string): string {
    return join(this.#artifactDirectory, `${artifactId}.json`);
  }

  #temporaryPath(artifactId: string): string {
    return join(this.#artifactDirectory, `${artifactId}.uploading`);
  }
}

export const apkArtifactLimits = { maxFileSizeBytes: MAX_APK_SIZE_BYTES } as const;
