import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DeviceListResponse, DeviceTerminalResponse } from "@device-robot/contracts";

import { DeviceControlError } from "./adb-device-control-service.js";
import type { DeviceDiscoveryService } from "./adb-device-service.js";

const execFileAsync = promisify(execFile);
const TERMINAL_COMMAND_TIMEOUT_MS = 15_000;
const TERMINAL_COMMAND_MAX_OUTPUT_BYTES = 512 * 1_024;

export type DeviceTerminalCommandResult = {
  output: string;
  exitCode: number;
};

export interface DeviceTerminalCommandRunner {
  run(args: readonly string[]): Promise<DeviceTerminalCommandResult>;
}

export interface DeviceTerminalService {
  execute(serial: string, command: string): Promise<DeviceTerminalResponse>;
}

export type AdbDeviceTerminalServiceOptions = {
  deviceService: DeviceDiscoveryService;
  executable?: string;
  runner?: DeviceTerminalCommandRunner;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandOutput(stdout: unknown, stderr: unknown): string {
  return `${String(stdout ?? "")}${String(stderr ?? "")}`.slice(
    0,
    TERMINAL_COMMAND_MAX_OUTPUT_BYTES,
  );
}

function createDefaultRunner(executable: string): DeviceTerminalCommandRunner {
  return {
    run: async (args) => {
      try {
        const { stdout, stderr } = await execFileAsync(executable, args, {
          encoding: "utf8",
          maxBuffer: TERMINAL_COMMAND_MAX_OUTPUT_BYTES,
          timeout: TERMINAL_COMMAND_TIMEOUT_MS,
          windowsHide: true,
        });
        return { output: commandOutput(stdout, stderr), exitCode: 0 };
      } catch (error) {
        const result = error as {
          code?: unknown;
          stdout?: unknown;
          stderr?: unknown;
          killed?: unknown;
        };
        if (typeof result.code === "number" && Number.isInteger(result.code)) {
          return {
            output: commandOutput(result.stdout, result.stderr),
            exitCode: Math.min(255, Math.max(0, result.code)),
          };
        }
        if (result.killed === true) {
          throw new DeviceControlError("The device terminal command timed out", 502);
        }
        throw error;
      }
    },
  };
}

export class AdbDeviceTerminalService implements DeviceTerminalService {
  readonly #deviceService: DeviceDiscoveryService;
  readonly #runner: DeviceTerminalCommandRunner;

  public constructor(options: AdbDeviceTerminalServiceOptions) {
    this.#deviceService = options.deviceService;
    this.#runner = options.runner ?? createDefaultRunner(options.executable ?? "adb");
  }

  public async execute(serial: string, command: string): Promise<DeviceTerminalResponse> {
    await this.#requireReadyDevice(serial);
    const normalizedCommand = command.trim();
    if (normalizedCommand.length === 0 || normalizedCommand.length > 4_096) {
      throw new DeviceControlError("A device terminal command is required", 400);
    }

    try {
      const result = await this.#runner.run(["-s", serial, "shell", normalizedCommand]);
      return {
        serial,
        command: normalizedCommand,
        output: result.output.slice(0, TERMINAL_COMMAND_MAX_OUTPUT_BYTES),
        exitCode: result.exitCode,
        executedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof DeviceControlError) {
        throw error;
      }
      throw new DeviceControlError(`Device terminal command failed: ${toErrorMessage(error)}`, 502);
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
}
