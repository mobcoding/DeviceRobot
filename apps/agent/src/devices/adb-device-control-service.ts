import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  DeviceControlAction,
  DeviceUiTreeResponse,
  DeviceListResponse,
} from "@device-robot/contracts";

import type { DeviceDiscoveryService } from "./adb-device-service.js";

const execFileAsync = promisify(execFile);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const inputTextSpecialCharacters = new Set([
  "\\",
  "'",
  '"',
  "`",
  "$",
  "&",
  "|",
  ";",
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

export class DeviceControlError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 502 | 503,
  ) {
    super(message);
  }
}

export type DeviceActionExecution = {
  startedAt: string;
  finishedAt: string;
  message?: string;
};

export interface AdbCommandRunner {
  runText(args: readonly string[]): Promise<string>;
  runBuffer(args: readonly string[]): Promise<Buffer>;
}

export interface DeviceControlService {
  captureScreenshot(serial: string): Promise<Buffer>;
  readUiTree(serial: string): Promise<DeviceUiTreeResponse>;
  execute(serial: string, action: DeviceControlAction): Promise<DeviceActionExecution>;
}

export type AdbDeviceControlServiceOptions = {
  deviceService: DeviceDiscoveryService;
  executable?: string;
  runner?: AdbCommandRunner;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createDefaultRunner(executable: string): AdbCommandRunner {
  return {
    runText: async (args) => {
      const { stdout } = await execFileAsync(executable, args, {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 15_000,
        windowsHide: true,
      });
      return stdout.toString();
    },
    runBuffer: async (args) => {
      const { stdout } = await execFileAsync(executable, args, {
        encoding: "buffer",
        maxBuffer: 20 * 1024 * 1024,
        timeout: 20_000,
        windowsHide: true,
      });
      return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    },
  };
}

function encodeInputText(value: string): string {
  return [...value]
    .map((character) => {
      if (character === " ") {
        return "%s";
      }

      if (character === "%") {
        return "\\%";
      }

      return inputTextSpecialCharacters.has(character) ? `\\${character}` : character;
    })
    .join("");
}

function displaySize(output: string): { width: number; height: number } {
  const matches = [...output.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/gu)];
  const latest = matches.at(-1);
  const width = Number(latest?.[1]);
  const height = Number(latest?.[2]);

  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    ? { width, height }
    : { width: 1_080, height: 1_920 };
}

function keyguardShowing(output: string): boolean {
  return /(?:\bmIsShowing|\bmKeyguardShowing|\bshowing|\bmShowingLockscreen)=true\b/u.test(
    output,
  );
}

function secureKeyguardShowing(output: string): boolean {
  return (
    keyguardShowing(output) &&
    /(?:\bmKeyguardSecure|\bmIsSecure|\bisSecure|\bsecure)=true\b/u.test(output)
  );
}

function notificationShadeFocused(output: string): boolean {
  return /mCurrentFocus=Window\{[^}]*\bNotificationShade\b/u.test(output);
}

function actionToAdbArgs(serial: string, action: DeviceControlAction): string[] {
  const prefix = ["-s", serial, "shell"];

  switch (action.action) {
    case "ui.tap":
      return [...prefix, "input", "tap", String(action.x), String(action.y)];
    case "ui.longPress":
      return [
        ...prefix,
        "input",
        "swipe",
        String(action.x),
        String(action.y),
        String(action.x),
        String(action.y),
        String(action.durationMs ?? 600),
      ];
    case "ui.input":
      return [...prefix, "input", "text", encodeInputText(action.value)];
    case "ui.swipe":
      return [
        ...prefix,
        "input",
        "swipe",
        String(action.startX),
        String(action.startY),
        String(action.endX),
        String(action.endY),
        String(action.durationMs ?? 300),
      ];
    case "ui.back":
      return [...prefix, "input", "keyevent", "KEYCODE_BACK"];
    case "device.unlock":
      throw new Error("Device unlock must use the controlled unlock flow");
    case "app.launch":
      return [
        ...prefix,
        "monkey",
        "-p",
        action.appId,
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
      ];
    case "app.stop":
      return [...prefix, "am", "force-stop", action.appId];
  }
}

function trimUiXml(output: string): string {
  const xmlStart = output.indexOf("<");
  const xml = xmlStart >= 0 ? output.slice(xmlStart) : "";
  const hierarchyEnd = xml.indexOf("</hierarchy>");

  if (hierarchyEnd >= 0) {
    return xml.slice(0, hierarchyEnd + "</hierarchy>".length).trim();
  }

  const selfClosingHierarchy = /<hierarchy\b[^>]*\/>/.exec(xml);
  if (selfClosingHierarchy !== null && selfClosingHierarchy.index !== undefined) {
    return xml.slice(0, selfClosingHierarchy.index + selfClosingHierarchy[0].length).trim();
  }

  throw new DeviceControlError("The device did not return a complete UI hierarchy", 502);
}

export class AdbDeviceControlService implements DeviceControlService {
  readonly #deviceService: DeviceDiscoveryService;
  readonly #runner: AdbCommandRunner;

  public constructor(options: AdbDeviceControlServiceOptions) {
    const executable = options.executable ?? process.env.ADB_PATH ?? "adb";
    this.#deviceService = options.deviceService;
    this.#runner = options.runner ?? createDefaultRunner(executable);
  }

  public async captureScreenshot(serial: string): Promise<Buffer> {
    await this.#requireReadyDevice(serial);

    try {
      const screenshot = await this.#runner.runBuffer([
        "-s",
        serial,
        "exec-out",
        "screencap",
        "-p",
      ]);
      if (!screenshot.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new DeviceControlError("The device did not return a PNG screenshot", 502);
      }
      return screenshot;
    } catch (error) {
      throw this.#asControlError(error, "Screenshot capture failed");
    }
  }

  public async readUiTree(serial: string): Promise<DeviceUiTreeResponse> {
    await this.#requireReadyDevice(serial);

    try {
      const output = await this.#runner.runText([
        "-s",
        serial,
        "exec-out",
        "uiautomator",
        "dump",
        "/dev/tty",
      ]);
      return {
        serial,
        xml: trimUiXml(output),
        capturedAt: new Date().toISOString(),
      };
    } catch (error) {
      throw this.#asControlError(error, "UI hierarchy capture failed");
    }
  }

  public async execute(
    serial: string,
    action: DeviceControlAction,
  ): Promise<DeviceActionExecution> {
    await this.#requireReadyDevice(serial);
    const startedAt = new Date().toISOString();

    if (action.action === "device.unlock") {
      return await this.#unlock(serial, startedAt);
    }

    try {
      const output = await this.#runner.runText(actionToAdbArgs(serial, action));
      const message = output.trim();
      return {
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(message.length === 0 ? {} : { message }),
      };
    } catch (error) {
      throw this.#asControlError(error, `Device action '${action.action}' failed`);
    }
  }

  async #unlock(serial: string, startedAt: string): Promise<DeviceActionExecution> {
    const shell = async (...args: string[]): Promise<string> =>
      await this.#runner.runText(["-s", serial, "shell", ...args]);

    try {
      await shell("input", "keyevent", "KEYCODE_WAKEUP");
      let policy = await shell("dumpsys", "window", "policy");
      if (secureKeyguardShowing(policy)) {
        throw new DeviceControlError(
          "设备处于安全锁屏状态，请在设备上完成 PIN、图案、密码或生物识别解锁后重试。",
          409,
        );
      }
      if (keyguardShowing(policy)) {
        const { width, height } = displaySize(await shell("wm", "size"));
        await shell(
          "input",
          "swipe",
          String(Math.round(width / 2)),
          String(Math.round(height * 0.8)),
          String(Math.round(width / 2)),
          String(Math.round(height * 0.2)),
          "300",
        );
        policy = await shell("dumpsys", "window", "policy");
        if (keyguardShowing(policy)) {
          throw new DeviceControlError(
            "设备仍处于锁屏状态，请在设备上完成 PIN、图案、密码或生物识别解锁后重试。",
            409,
          );
        }
      }

      let windows = await shell("dumpsys", "window", "windows");
      if (notificationShadeFocused(windows)) {
        await shell("input", "keyevent", "KEYCODE_BACK");
        windows = await shell("dumpsys", "window", "windows");
        if (notificationShadeFocused(windows)) {
          throw new DeviceControlError("通知栏未能收起，请在设备上手动恢复到应用或桌面。", 409);
        }
      }

      return {
        startedAt,
        finishedAt: new Date().toISOString(),
        message: "已唤醒设备并恢复到可交互界面。",
      };
    } catch (error) {
      throw this.#asControlError(error, "Device unlock failed");
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

  #asControlError(error: unknown, prefix: string): DeviceControlError {
    if (error instanceof DeviceControlError) {
      return error;
    }

    return new DeviceControlError(`${prefix}: ${toErrorMessage(error)}`, 502);
  }
}
