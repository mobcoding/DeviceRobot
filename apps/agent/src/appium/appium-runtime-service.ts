import { createRequire } from "node:module";
import { createConnection, createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { AgentPaths } from "@device-robot/config";
import type { AppiumRuntime } from "@device-robot/contracts";

import { inspectAndroidSdk } from "../android/android-sdk-service.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const APPIUM_HOST = "127.0.0.1" as const;
const APPIUM_PORT = 4_723;
const UIAUTOMATOR2_PACKAGE = "appium-uiautomator2-driver" as const;

type CommandResult = {
  stdout: string;
  stderr: string;
};

type CommandOptions = {
  env?: NodeJS.ProcessEnv;
};

export interface AppiumCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options?: CommandOptions,
  ): Promise<CommandResult>;
}

export interface AppiumProcessSpawner {
  spawn(
    executable: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv },
  ): ChildProcess;
}

export class AppiumRuntimeError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: 409 | 503,
  ) {
    super(message);
  }
}

export type AppiumRuntimeServiceOptions = {
  paths: AgentPaths;
  appiumPath?: string;
  commandRunner?: AppiumCommandRunner;
  processSpawner?: AppiumProcessSpawner;
  environment?: NodeJS.ProcessEnv;
};

type AppiumCommand = {
  executable: string;
  args: readonly string[];
  path?: string;
};

type ServerState = AppiumRuntime["server"];

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandOutput(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function firstLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function defaultCommandRunner(): AppiumCommandRunner {
  return {
    run: async (executable, args, options) => {
      const { stdout, stderr } = await execFileAsync(executable, [...args], {
        encoding: "utf8",
        env: options?.env,
        timeout: 10_000,
        windowsHide: true,
      });
      return { stdout: String(stdout), stderr: String(stderr) };
    },
  };
}

function defaultProcessSpawner(): AppiumProcessSpawner {
  return {
    spawn: (executable, args, options) =>
      spawn(executable, [...args], {
        detached: false,
        env: options.env,
        stdio: "ignore",
        windowsHide: true,
      }),
  };
}

function resolveBundledAppium(): AppiumCommand | undefined {
  try {
    const packagePath = require.resolve("appium/package.json");
    const packageDirectory = dirname(packagePath);
    const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const bin =
      typeof packageMetadata.bin === "string" ? packageMetadata.bin : packageMetadata.bin?.appium;

    if (bin === undefined) {
      return undefined;
    }

    const cli = resolve(packageDirectory, bin);
    return { executable: process.execPath, args: [cli], path: cli };
  } catch {
    return undefined;
  }
}

function parseInstalledDriver(output: string): string | undefined {
  try {
    const data: unknown = JSON.parse(output);
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return undefined;
    }

    const driver = (data as Record<string, unknown>).uiautomator2;
    if (typeof driver !== "object" || driver === null || Array.isArray(driver)) {
      return undefined;
    }

    const version = (driver as Record<string, unknown>).version;
    return typeof version === "string" && version.trim().length > 0 ? version.trim() : "installed";
  } catch {
    return undefined;
  }
}

function parseAndroidSdkRoot(adbOutput: string): string | undefined {
  const installedPath = /^Installed as\s+(.+)$/im.exec(adbOutput)?.[1]?.trim();
  if (installedPath === undefined || basename(installedPath).toLowerCase() !== "adb.exe") {
    return undefined;
  }

  return dirname(dirname(installedPath));
}

function isSdkDirectory(path: string): boolean {
  return existsSync(join(path, "platform-tools", "adb.exe"));
}

async function isPortAvailable(): Promise<boolean> {
  return await new Promise((resolveAvailability) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", () => resolveAvailability(false));
    probe.listen(APPIUM_PORT, APPIUM_HOST, () => {
      probe.close(() => resolveAvailability(true));
    });
  });
}

async function canConnect(): Promise<boolean> {
  return await new Promise((resolveConnection) => {
    const socket = createConnection({ host: APPIUM_HOST, port: APPIUM_PORT });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolveConnection(true);
    });
    socket.once("error", () => resolveConnection(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolveConnection(false);
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export class AppiumRuntimeService {
  readonly #paths: AgentPaths;
  readonly #appiumPath: string | undefined;
  readonly #runner: AppiumCommandRunner;
  readonly #spawner: AppiumProcessSpawner;
  readonly #environment: NodeJS.ProcessEnv;
  #process: ChildProcess | undefined;
  #server: ServerState;

  public constructor(options: AppiumRuntimeServiceOptions) {
    this.#paths = options.paths;
    this.#appiumPath = options.appiumPath ?? process.env.APPIUM_PATH;
    this.#runner = options.commandRunner ?? defaultCommandRunner();
    this.#spawner = options.processSpawner ?? defaultProcessSpawner();
    this.#environment = options.environment ?? process.env;
    this.#server = {
      state: "stopped",
      host: APPIUM_HOST,
      port: APPIUM_PORT,
      logFile: join(this.#paths.logs, "appium.log"),
    };
  }

  public async inspect(): Promise<AppiumRuntime> {
    const appiumCommand = this.#resolveAppiumCommand();
    const [appium, java, androidSdk] = await Promise.all([
      this.#inspectAppium(appiumCommand),
      this.#inspectJava(),
      this.#inspectAndroidSdk(),
    ]);
    const uiautomator2 = await this.#inspectUiAutomator2(appiumCommand, androidSdk.path);
    const issues = [
      ...(appium.available ? [] : ["未找到项目内 Appium 运行时。"]),
      ...(uiautomator2.available ? [] : ["未安装 UiAutomator2 driver。"]),
      ...(java.available ? [] : ["未找到可用的 Java 运行时。"]),
      ...(androidSdk.available ? [] : ["未找到 Android SDK 或 platform-tools。"]),
      ...(this.#server.state === "failed" && this.#server.error !== undefined
        ? [this.#server.error]
        : []),
    ];

    return {
      status: issues.length === 0 ? "ready" : "degraded",
      checkedAt: new Date().toISOString(),
      appium,
      uiautomator2,
      java,
      androidSdk,
      server: this.#server,
      issues,
    };
  }

  public async start(): Promise<AppiumRuntime> {
    if (this.#server.state === "running" || this.#server.state === "starting") {
      return await this.inspect();
    }

    const runtime = await this.inspect();
    if (runtime.status !== "ready") {
      throw new AppiumRuntimeError("Appium 运行环境尚未就绪，无法启动服务", 503);
    }

    if (!(await isPortAvailable())) {
      const error = `Appium 端口 ${APPIUM_PORT} 已被占用`;
      this.#server = {
        ...this.#server,
        state: "failed",
        error,
      };
      throw new AppiumRuntimeError(error, 409);
    }

    const command = this.#resolveAppiumCommand();
    if (command === undefined) {
      throw new AppiumRuntimeError("未找到项目内 Appium 运行时", 503);
    }

    const sdkRoot = runtime.androidSdk.path;
    const env = {
      ...this.#environment,
      APPIUM_HOME: this.#paths.appiumHome,
      ...(sdkRoot === undefined ? {} : { ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot }),
    };
    const child = this.#spawner.spawn(
      command.executable,
      [
        ...command.args,
        "server",
        "--address",
        APPIUM_HOST,
        "--port",
        String(APPIUM_PORT),
        "--log",
        this.#server.logFile,
        "--log-level",
        "info",
        "--use-drivers",
        "uiautomator2",
      ],
      { env },
    );
    this.#process = child;
    this.#server = {
      ...this.#server,
      state: "starting",
      startedAt: new Date().toISOString(),
      error: undefined,
    };
    child.once("error", (error) => this.#recordProcessFailure(toErrorMessage(error)));
    child.once("exit", (code, signal) => {
      if (this.#server.state !== "stopped") {
        this.#recordProcessFailure(
          `Appium 已退出（code ${code ?? "null"}, signal ${signal ?? "none"}）`,
        );
      }
    });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (await canConnect()) {
        this.#server = { ...this.#server, state: "running" };
        return await this.inspect();
      }

      if (this.#server.state === "failed") {
        break;
      }
      await delay(250);
    }

    await this.stop();
    const error = "Appium 在 8 秒内没有开始监听本地端口";
    this.#server = {
      ...this.#server,
      state: "failed",
      error,
    };
    throw new AppiumRuntimeError(error, 503);
  }

  public async stop(): Promise<AppiumRuntime> {
    this.#stopProcess();
    return await this.inspect();
  }

  public async dispose(): Promise<void> {
    this.#stopProcess();
  }

  #stopProcess(): void {
    const child = this.#process;
    this.#process = undefined;
    this.#server = { ...this.#server, state: "stopped", startedAt: undefined, error: undefined };

    if (child !== undefined && child.exitCode === null && !child.killed) {
      child.kill();
    }
  }

  #resolveAppiumCommand(): AppiumCommand | undefined {
    if (this.#appiumPath !== undefined && this.#appiumPath.trim().length > 0) {
      return { executable: this.#appiumPath.trim(), args: [], path: this.#appiumPath.trim() };
    }

    return resolveBundledAppium();
  }

  async #inspectAppium(command: AppiumCommand | undefined): Promise<AppiumRuntime["appium"]> {
    if (command === undefined) {
      return { available: false, error: "项目依赖中不存在 appium" };
    }

    try {
      const result = await this.#runner.run(command.executable, [...command.args, "--version"]);
      const version = firstLine(commandOutput(result));
      return {
        available: true,
        ...(version === undefined ? {} : { version }),
        ...(command.path === undefined ? {} : { path: command.path }),
      };
    } catch (error) {
      return {
        available: false,
        ...(command.path === undefined ? {} : { path: command.path }),
        error: toErrorMessage(error),
      };
    }
  }

  async #inspectUiAutomator2(
    command: AppiumCommand | undefined,
    androidSdkPath: string | undefined,
  ): Promise<AppiumRuntime["uiautomator2"]> {
    if (command === undefined) {
      return { available: false, packageName: UIAUTOMATOR2_PACKAGE, error: "Appium 不可用" };
    }

    try {
      const result = await this.#runner.run(
        command.executable,
        [...command.args, "driver", "list", "--installed", "--json"],
        {
          env: {
            ...this.#environment,
            APPIUM_HOME: this.#paths.appiumHome,
            ...(androidSdkPath === undefined
              ? {}
              : { ANDROID_HOME: androidSdkPath, ANDROID_SDK_ROOT: androidSdkPath }),
          },
        },
      );
      const version = parseInstalledDriver(result.stdout);
      return {
        available: version !== undefined,
        packageName: UIAUTOMATOR2_PACKAGE,
        ...(version === undefined ? { error: "Appium 未注册 UiAutomator2 driver" } : { version }),
      };
    } catch (error) {
      return { available: false, packageName: UIAUTOMATOR2_PACKAGE, error: toErrorMessage(error) };
    }
  }

  async #inspectJava(): Promise<AppiumRuntime["java"]> {
    try {
      const result = await this.#runner.run("java", ["-version"]);
      const version = firstLine(commandOutput(result));
      return { available: true, ...(version === undefined ? {} : { version }) };
    } catch (error) {
      return { available: false, error: toErrorMessage(error) };
    }
  }

  async #inspectAndroidSdk(): Promise<AppiumRuntime["androidSdk"]> {
    const configured = await inspectAndroidSdk({
      paths: this.#paths,
      environment: this.#environment,
      requiredPackages: ["platform-tools"],
    });
    if (
      configured.available &&
      configured.path !== undefined &&
      configured.missingPackages.length === 0
    ) {
      return { available: true, path: configured.path };
    }

    try {
      const result = await this.#runner.run("adb", ["version"]);
      const path = parseAndroidSdkRoot(commandOutput(result));
      if (path !== undefined && isSdkDirectory(path)) {
        return { available: true, path };
      }
      return { available: false, error: "ADB 未报告可用的 Android SDK 路径" };
    } catch (error) {
      return { available: false, error: toErrorMessage(error) };
    }
  }

  #recordProcessFailure(error: string): void {
    this.#process = undefined;
    this.#server = { ...this.#server, state: "failed", error };
  }
}
