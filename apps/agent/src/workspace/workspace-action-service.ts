import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";
import {
  workspaceExecutionResponseSchema,
  type AgentAction,
  type StartWorkspaceExecutionRequest,
  type WorkspaceActionResult,
  type WorkspaceExecutionResponse,
} from "@device-robot/contracts";

import { ApkArtifactError, type ApkArtifactService } from "../apks/apk-artifact-service.js";
import type { DeviceControlService } from "../devices/adb-device-control-service.js";
import type { DeviceDiscoveryService } from "../devices/adb-device-service.js";
import type { ProjectBuildService } from "../projects/project-build-service.js";

const execFileAsync = promisify(execFile);
const ADB_TIMEOUT_MS = 120_000;

export class WorkspaceActionError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 422 | 502 | 503,
  ) {
    super(message);
  }
}

export interface WorkspaceActionService {
  execute(request: StartWorkspaceExecutionRequest): Promise<WorkspaceExecutionResponse>;
}

export type WorkspaceAdbRunner = {
  run(args: readonly string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }>;
};

export type LocalWorkspaceActionServiceOptions = {
  deviceService: DeviceDiscoveryService;
  deviceControlService: DeviceControlService;
  apkArtifactService: ApkArtifactService;
  projectBuildService: ProjectBuildService;
  adbExecutable?: string;
  runner?: WorkspaceAdbRunner;
};

function defaultRunner(adbExecutable: string): WorkspaceAdbRunner {
  return {
    run: async (args, timeoutMs) => {
      const { stdout, stderr } = await execFileAsync(adbExecutable, [...args], {
        encoding: "utf8",
        maxBuffer: 16 * 1_024 * 1_024,
        timeout: timeoutMs,
        windowsHide: true,
      });
      return { stdout: String(stdout), stderr: String(stderr) };
    },
  };
}

function commandOutput(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function succeededOutput(output: string): boolean {
  return /(?:^|\s)Success(?:\s|$)/u.test(output);
}

function coordinateTarget(action: AgentAction): { x: number; y: number } | undefined {
  if (
    (action.action === "ui.tap" || action.action === "ui.longPress") &&
    action.target.x !== undefined &&
    action.target.y !== undefined
  ) {
    return { x: action.target.x, y: action.target.y };
  }
  return undefined;
}

export class LocalWorkspaceActionService implements WorkspaceActionService {
  readonly #deviceService: DeviceDiscoveryService;
  readonly #deviceControlService: DeviceControlService;
  readonly #apkArtifactService: ApkArtifactService;
  readonly #projectBuildService: ProjectBuildService;
  readonly #runner: WorkspaceAdbRunner;

  public constructor(options: LocalWorkspaceActionServiceOptions) {
    this.#deviceService = options.deviceService;
    this.#deviceControlService = options.deviceControlService;
    this.#apkArtifactService = options.apkArtifactService;
    this.#projectBuildService = options.projectBuildService;
    this.#runner =
      options.runner ?? defaultRunner(options.adbExecutable ?? process.env.ADB_PATH ?? "adb");
  }

  public async execute(
    request: StartWorkspaceExecutionRequest,
  ): Promise<WorkspaceExecutionResponse> {
    if (request.plan.workspaceExecution !== true) {
      throw new WorkspaceActionError("该计划不是工作区操作计划。", 422);
    }
    await this.#requireReadyDevice(request.deviceSerial);
    const startedAt = new Date().toISOString();
    const results: WorkspaceActionResult[] = [];

    for (const [index, action] of request.plan.actions.entries()) {
      const actionStartedAt = new Date().toISOString();
      try {
        const message = await this.#executeAction(
          request.plan.projectId,
          request.deviceSerial,
          action,
        );
        results.push({
          index,
          action,
          status: "succeeded",
          ...(message === undefined ? {} : { message }),
          startedAt: actionStartedAt,
          finishedAt: new Date().toISOString(),
        });
      } catch (error) {
        results.push({
          index,
          action,
          status: "failed",
          message: errorMessage(error),
          startedAt: actionStartedAt,
          finishedAt: new Date().toISOString(),
        });
        return workspaceExecutionResponseSchema.parse({
          id: randomUUID(),
          projectId: request.plan.projectId,
          deviceSerial: request.deviceSerial,
          status: "failed",
          results,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }
    }

    return workspaceExecutionResponseSchema.parse({
      id: randomUUID(),
      projectId: request.plan.projectId,
      deviceSerial: request.deviceSerial,
      status: "succeeded",
      results,
      startedAt,
      finishedAt: new Date().toISOString(),
    });
  }

  async #executeAction(
    projectId: string,
    serial: string,
    action: AgentAction,
  ): Promise<string | undefined> {
    switch (action.action) {
      case "app.install": {
        const installed = await this.#apkArtifactService.install(serial, action.artifactId, {
          replaceExisting: action.replaceExisting,
          allowTestPackage: action.allowTestPackage,
          uninstallExisting: false,
        });
        return `已安装 ${installed.packageName}。`;
      }
      case "app.uninstall": {
        const output = commandOutput(
          await this.#runner.run(
            ["-s", serial, "uninstall", ...(action.keepData ? ["-k"] : []), action.appId],
            ADB_TIMEOUT_MS,
          ),
        );
        if (!succeededOutput(output)) {
          throw new WorkspaceActionError(output || "ADB 未返回卸载成功状态。", 502);
        }
        return `已卸载 ${action.appId}。`;
      }
      case "app.clearData": {
        const output = commandOutput(
          await this.#runner.run(
            ["-s", serial, "shell", "pm", "clear", action.appId],
            ADB_TIMEOUT_MS,
          ),
        );
        if (!succeededOutput(output)) {
          throw new WorkspaceActionError(output || "ADB 未返回清除数据成功状态。", 502);
        }
        return `已清除 ${action.appId} 的应用数据。`;
      }
      case "app.launch":
      case "app.stop": {
        const execution = await this.#deviceControlService.execute(serial, action);
        return execution.message;
      }
      case "ui.tap": {
        const target = coordinateTarget(action);
        if (target === undefined) {
          throw new WorkspaceActionError("工作区直接操作仅支持带 x/y 坐标的点击。", 422);
        }
        const execution = await this.#deviceControlService.execute(serial, {
          action: "ui.tap",
          x: target.x,
          y: target.y,
        });
        return execution.message;
      }
      case "ui.longPress": {
        const target = coordinateTarget(action);
        if (target === undefined) {
          throw new WorkspaceActionError("工作区直接操作仅支持带 x/y 坐标的长按。", 422);
        }
        const execution = await this.#deviceControlService.execute(serial, {
          action: "ui.longPress",
          x: target.x,
          y: target.y,
          ...(action.durationMs === undefined ? {} : { durationMs: action.durationMs }),
        });
        return execution.message;
      }
      case "ui.input": {
        const execution = await this.#deviceControlService.execute(serial, {
          action: "ui.input",
          value: action.value,
        });
        return execution.message;
      }
      case "ui.swipe": {
        const execution = await this.#deviceControlService.execute(serial, {
          action: "ui.swipe",
          startX: action.start.x,
          startY: action.start.y,
          endX: action.end.x,
          endY: action.end.y,
          ...(action.durationMs === undefined ? {} : { durationMs: action.durationMs }),
        });
        return execution.message;
      }
      case "ui.back": {
        const execution = await this.#deviceControlService.execute(serial, { action: "ui.back" });
        return execution.message;
      }
      case "ui.wait": {
        await new Promise<void>((resolve) => setTimeout(resolve, action.durationMs));
        return `已等待 ${action.durationMs} 毫秒。`;
      }
      case "device.permission": {
        const output = commandOutput(
          await this.#runner.run(
            ["-s", serial, "shell", "pm", action.mode, action.appId, action.permission],
            ADB_TIMEOUT_MS,
          ),
        );
        return output.length === 0
          ? `已${action.mode === "grant" ? "授予" : "撤销"}权限。`
          : output;
      }
      case "device.orientation": {
        const rotation = action.orientation === "portrait" ? "0" : "1";
        const output = commandOutput(
          await this.#runner.run(
            ["-s", serial, "shell", "settings", "put", "system", "user_rotation", rotation],
            ADB_TIMEOUT_MS,
          ),
        );
        return output.length === 0
          ? `已切换为${action.orientation === "portrait" ? "竖屏" : "横屏"}。`
          : output;
      }
      case "device.unlock": {
        const execution = await this.#deviceControlService.execute(serial, { action: "device.unlock" });
        return execution.message ?? "已唤醒设备并恢复到可交互界面。";
      }
      case "device.screenshot": {
        await this.#deviceControlService.captureScreenshot(serial);
        return action.name === undefined ? "已采集设备截图。" : `已采集截图：${action.name}。`;
      }
      case "adb.shell": {
        const output = commandOutput(
          await this.#runner.run(
            ["-s", serial, "shell", action.command, ...action.args],
            ADB_TIMEOUT_MS,
          ),
        );
        return output.length === 0 ? "ADB 指令执行完成。" : output.slice(0, 8_000);
      }
      case "project.build": {
        const run = await this.#projectBuildService.start(projectId, {
          modulePath: action.modulePath,
          variant: action.variant,
          approved: true,
        });
        return `已提交 ${run.taskName} 构建任务（${run.status === "queued" ? "排队中" : "构建中"}）。`;
      }
      case "project.installArtifact": {
        const artifact = await this.#projectBuildService.getArtifact(
          projectId,
          action.buildId,
          action.artifactIndex,
        );
        const staged = await this.#apkArtifactService.stage(
          artifact.fileName,
          createReadStream(artifact.filePath),
        );
        try {
          const options = {
            replaceExisting: action.replaceExisting,
            allowTestPackage: action.allowTestPackage,
            uninstallExisting: false,
          };
          let installed;
          try {
            installed = await this.#apkArtifactService.install(serial, staged.id, options);
          } catch (error) {
            if (
              !action.uninstallExisting ||
              !(error instanceof ApkArtifactError) ||
              error.statusCode !== 409
            ) {
              throw error;
            }
            const output = commandOutput(
              await this.#runner.run(
                ["-s", serial, "uninstall", staged.metadata.packageName],
                ADB_TIMEOUT_MS,
              ),
            );
            if (!succeededOutput(output)) {
              throw new WorkspaceActionError(output || "无法卸载签名冲突的已安装应用。", 502);
            }
            installed = await this.#apkArtifactService.install(serial, staged.id, options);
          }
          return `已安装项目构建产物：${installed.packageName}。`;
        } finally {
          await this.#apkArtifactService.discard(staged.id).catch(() => undefined);
        }
      }
      case "assert.visible":
      case "assert.notVisible":
      case "assert.text":
      case "assert.activity":
        throw new WorkspaceActionError("断言动作应通过测试运行执行。", 422);
    }
  }

  async #requireReadyDevice(serial: string): Promise<void> {
    const response = await this.#deviceService.listDevices();
    if (!response.adb.available) {
      throw new WorkspaceActionError(response.adb.error ?? "ADB 不可用。", 503);
    }
    const device = response.devices.find((candidate) => candidate.serial === serial);
    if (device === undefined) {
      throw new WorkspaceActionError("当前设备已断开连接。", 404);
    }
    if (device.state !== "device" && device.state !== "emulator") {
      throw new WorkspaceActionError(`当前设备不可操作：${device.state}。`, 409);
    }
  }
}
