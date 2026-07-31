import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type {
  ScreenRecordingConfiguration,
  ScreenRecordingResult,
  ScreenRecordingStatus,
} from "@device-robot/contracts";

import { DeviceControlError } from "./adb-device-control-service.js";
import type { DeviceDiscoveryService } from "./adb-device-service.js";

const execFileAsync = promisify(execFile);
export const SCREEN_RECORDING_MAX_DURATION_SECONDS = 1_800;
const SCREEN_RECORDING_FINALIZE_TIMEOUT_MS = 10_000;
const SCREEN_RECORDING_FINALIZE_POLL_MS = 250;
const DEFAULT_CONFIGURATION = {
  bitRateMbps: 4,
  resolutionPercent: 100,
  showTouches: true,
} as const;

type RecordingSession = {
  serial: string;
  configuration: ScreenRecordingConfiguration;
  remotePath: string;
  processId: string;
  deviceProcess: ScreenRecordingProcess;
  startedAt: string;
  originalShowTouches: string | undefined;
  restoreShowTouches: boolean;
};

export interface ScreenRecordingCommandRunner {
  runText(args: readonly string[]): Promise<string>;
  start(args: readonly string[]): Promise<ScreenRecordingProcess>;
}

export interface ScreenRecordingProcess {
  processId: string;
  terminate(): void;
}

export interface ScreenRecordingService {
  status(serial: string): Promise<ScreenRecordingStatus>;
  start(
    serial: string,
    configuration: ScreenRecordingConfiguration,
  ): Promise<ScreenRecordingStatus>;
  stop(serial: string): Promise<ScreenRecordingResult>;
  dispose(): Promise<void>;
}

export type AdbScreenRecordingServiceOptions = {
  deviceService: DeviceDiscoveryService;
  executable?: string;
  runner?: ScreenRecordingCommandRunner;
  desktopDirectory?: string;
  wait?: (milliseconds: number) => Promise<void>;
};

function defaultRunner(executable: string): ScreenRecordingCommandRunner {
  return {
    runText: async (args) => {
      const { stdout } = await execFileAsync(executable, args, {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 20_000,
        windowsHide: true,
      });
      return stdout.toString();
    },
    start: async (args) =>
      await new Promise<ScreenRecordingProcess>((resolve, reject) => {
        const child = spawn(executable, args, {
          stdio: ["ignore", "pipe", "ignore"],
          windowsHide: true,
        });
        let output = "";
        let settled = false;

        const fail = (error: Error): void => {
          if (!settled) {
            settled = true;
            reject(error);
          }
        };

        child.once("error", fail);
        child.once("exit", (code) => {
          if (!settled) {
            fail(
              new Error(`ADB screen recording exited before start (code ${code ?? "unknown"}).`),
            );
          }
        });
        child.stdout.on("data", (chunk: Buffer) => {
          if (settled) {
            return;
          }
          output += chunk.toString("utf8");
          const lineEnd = output.indexOf("\n");
          if (lineEnd < 0) {
            return;
          }

          const startedProcessId = output.slice(0, lineEnd).trim();
          if (!/^[1-9]\d*$/u.test(startedProcessId)) {
            child.kill();
            fail(new Error("ADB did not return a screen recording process ID."));
            return;
          }

          settled = true;
          resolve({
            processId: startedProcessId,
            terminate: () => {
              if (!child.killed) {
                child.kill();
              }
            },
          });
        });
      }),
  };
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validConfiguration(
  configuration: ScreenRecordingConfiguration,
): ScreenRecordingConfiguration {
  if (
    !Number.isInteger(configuration.bitRateMbps) ||
    configuration.bitRateMbps < 1 ||
    configuration.bitRateMbps > 20 ||
    ![50, 75, 100].includes(configuration.resolutionPercent) ||
    typeof configuration.showTouches !== "boolean" ||
    configuration.outputDirectory.trim().length === 0 ||
    configuration.outputDirectory.length > 1_024
  ) {
    throw new DeviceControlError("录屏配置无效。", 400);
  }

  return { ...configuration, outputDirectory: configuration.outputDirectory.trim() };
}

function parseDisplaySize(output: string): { width: number; height: number } {
  const matches = [...output.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/gu)];
  const latest = matches.at(-1);
  const width = Number(latest?.[1]);
  const height = Number(latest?.[2]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) {
    throw new DeviceControlError("无法读取设备原生分辨率。", 502);
  }
  return { width, height };
}

function scaledSize(size: { width: number; height: number }, percent: number): string {
  const even = (value: number): number => Math.max(2, Math.floor(value / 2) * 2);
  return `${even((size.width * percent) / 100)}x${even((size.height * percent) / 100)}`;
}

function processId(output: string): string {
  const value = output.trim().split(/\s+/u).at(-1) ?? "";
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new DeviceControlError("无法启动设备录屏进程。", 502);
  }
  return value;
}

function safeSerial(serial: string): string {
  return serial.replaceAll(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64) || "device";
}

function timestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

export class AdbScreenRecordingService implements ScreenRecordingService {
  readonly #deviceService: DeviceDiscoveryService;
  readonly #runner: ScreenRecordingCommandRunner;
  readonly #desktopDirectory: string;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #sessions = new Map<string, RecordingSession>();

  public constructor(options: AdbScreenRecordingServiceOptions) {
    const executable = options.executable ?? process.env.ADB_PATH ?? "adb";
    this.#deviceService = options.deviceService;
    this.#runner = options.runner ?? defaultRunner(executable);
    this.#desktopDirectory = options.desktopDirectory ?? join(homedir(), "Desktop");
    this.#wait = options.wait ?? sleep;
  }

  public async status(serial: string): Promise<ScreenRecordingStatus> {
    const session = this.#sessions.get(serial);
    return {
      serial,
      recording: session !== undefined,
      configuration: session?.configuration ?? this.#defaultConfiguration(),
      maxDurationSeconds: SCREEN_RECORDING_MAX_DURATION_SECONDS,
      ...(session === undefined ? {} : { startedAt: session.startedAt }),
    };
  }

  public async start(
    serial: string,
    configuration: ScreenRecordingConfiguration,
  ): Promise<ScreenRecordingStatus> {
    const existing = this.#sessions.get(serial);
    if (existing !== undefined) {
      throw new DeviceControlError("当前设备正在录屏。", 409);
    }

    const requestedConfiguration = validConfiguration(configuration);
    await this.#requireReadyDevice(serial);
    await this.#requireOutputDirectory(requestedConfiguration.outputDirectory);

    const screenSize = parseDisplaySize(
      await this.#runner.runText(["-s", serial, "shell", "wm", "size"]),
    );
    const originalShowTouches = this.#readSetting(
      await this.#runner.runText([
        "-s",
        serial,
        "shell",
        "settings",
        "get",
        "system",
        "show_touches",
      ]),
    );
    const desiredShowTouches = requestedConfiguration.showTouches ? "1" : "0";
    let showTouchesChanged = false;
    let deviceProcess: ScreenRecordingProcess | undefined;

    try {
      if (originalShowTouches !== desiredShowTouches) {
        await this.#runner.runText([
          "-s",
          serial,
          "shell",
          "settings",
          "put",
          "system",
          "show_touches",
          desiredShowTouches,
        ]);
        showTouchesChanged = true;
      }

      const remotePath = `/sdcard/Download/DeviceRobot-${Date.now()}-${safeSerial(serial)}.mp4`;
      const screenrecordCommand = [
        "screenrecord",
        "--size",
        scaledSize(screenSize, requestedConfiguration.resolutionPercent),
        "--bit-rate",
        String(requestedConfiguration.bitRateMbps * 1_000_000),
        "--time-limit",
        String(SCREEN_RECORDING_MAX_DURATION_SECONDS),
        remotePath,
      ].join(" ");
      // Keep the ADB transport open for the entire recording. Android's shell
      // otherwise terminates background children when the original shell exits.
      deviceProcess = await this.#runner.start([
        "-s",
        serial,
        "shell",
        `echo $$; exec ${screenrecordCommand} >/dev/null 2>&1`,
      ]);
      const process = processId(deviceProcess.processId);
      await this.#wait(250);
      await this.#runner.runText(["-s", serial, "shell", "kill", "-0", process]);
      const session: RecordingSession = {
        serial,
        configuration: requestedConfiguration,
        remotePath,
        processId: process,
        deviceProcess,
        startedAt: new Date().toISOString(),
        originalShowTouches,
        restoreShowTouches: showTouchesChanged,
      };
      this.#sessions.set(serial, session);
      return await this.status(serial);
    } catch (error) {
      deviceProcess?.terminate();
      if (showTouchesChanged) {
        await this.#restoreShowTouches(serial, originalShowTouches);
      }
      throw this.#asControlError(error, "启动录屏失败");
    }
  }

  public async stop(serial: string): Promise<ScreenRecordingResult> {
    const session = this.#sessions.get(serial);
    if (session === undefined) {
      throw new DeviceControlError("当前设备没有进行中的录屏。", 409);
    }

    const savedPath = join(
      session.configuration.outputDirectory,
      `DeviceRobot-${timestamp(new Date())}-${safeSerial(serial)}.mp4`,
    );
    const finishedAt = new Date().toISOString();

    try {
      await this.#runner.runText(["-s", serial, "shell", "kill", "-INT", session.processId]);
      await this.#wait(500);
      await this.#waitForRecordingFile(serial, session.remotePath);
      await this.#runner.runText(["-s", serial, "pull", session.remotePath, savedPath]);
      const output = await stat(savedPath);
      if (!output.isFile() || output.size === 0) {
        throw new DeviceControlError("录屏文件为空或未生成。", 502);
      }
      return { serial, savedPath, startedAt: session.startedAt, finishedAt };
    } catch (error) {
      throw this.#asControlError(error, "保存录屏失败");
    } finally {
      this.#sessions.delete(serial);
      session.deviceProcess.terminate();
      await this.#runner
        .runText(["-s", serial, "shell", "rm", "-f", session.remotePath])
        .catch(() => undefined);
      if (session.restoreShowTouches) {
        await this.#restoreShowTouches(serial, session.originalShowTouches);
      }
    }
  }

  public async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.#sessions.keys()].map(async (serial) => await this.stop(serial)),
    );
  }

  #defaultConfiguration(): ScreenRecordingConfiguration {
    return { ...DEFAULT_CONFIGURATION, outputDirectory: this.#desktopDirectory };
  }

  async #requireReadyDevice(serial: string): Promise<void> {
    let devices;
    try {
      devices = await this.#deviceService.listDevices();
    } catch (error) {
      throw new DeviceControlError(`设备发现失败：${toErrorMessage(error)}`, 503);
    }
    if (!devices.adb.available) {
      throw new DeviceControlError(devices.adb.error ?? "ADB 不可用。", 503);
    }
    if (devices.error !== undefined) {
      throw new DeviceControlError(devices.error, 503);
    }
    const device = devices.devices.find((candidate) => candidate.serial === serial);
    if (device === undefined) {
      throw new DeviceControlError("目标设备已断开连接。", 404);
    }
    if (device.state !== "device" && device.state !== "emulator") {
      throw new DeviceControlError(`目标设备当前不可用：${device.state}。`, 409);
    }
  }

  async #requireOutputDirectory(directory: string): Promise<void> {
    if (!isAbsolute(directory) || !existsSync(directory)) {
      throw new DeviceControlError("保存目录必须是已存在的绝对路径。", 400);
    }
    const details = await stat(directory);
    if (!details.isDirectory()) {
      throw new DeviceControlError("保存位置不是目录。", 400);
    }
  }

  #readSetting(value: string): string | undefined {
    const normalized = value.trim();
    return normalized.length === 0 || normalized === "null" ? undefined : normalized;
  }

  async #restoreShowTouches(serial: string, value: string | undefined): Promise<void> {
    if (value === undefined) {
      await this.#runner
        .runText(["-s", serial, "shell", "settings", "delete", "system", "show_touches"])
        .catch(() => undefined);
      return;
    }
    await this.#runner
      .runText(["-s", serial, "shell", "settings", "put", "system", "show_touches", value])
      .catch(() => undefined);
  }

  async #waitForRecordingFile(serial: string, remotePath: string): Promise<void> {
    const deadline = Date.now() + SCREEN_RECORDING_FINALIZE_TIMEOUT_MS;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        await this.#runner.runText(["-s", serial, "shell", "test", "-s", remotePath]);
        return;
      } catch (error) {
        lastError = error;
        await this.#wait(SCREEN_RECORDING_FINALIZE_POLL_MS);
      }
    }

    throw new DeviceControlError(
      `设备未在 ${Math.round(SCREEN_RECORDING_FINALIZE_TIMEOUT_MS / 1_000)} 秒内生成录屏文件：${toErrorMessage(lastError)}`,
      502,
    );
  }

  #asControlError(error: unknown, prefix: string): DeviceControlError {
    if (error instanceof DeviceControlError) {
      return error;
    }
    return new DeviceControlError(`${prefix}：${toErrorMessage(error)}`, 502);
  }
}
