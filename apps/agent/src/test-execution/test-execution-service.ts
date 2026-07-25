import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentPaths } from "@device-robot/config";
import {
  type AgentAction,
  type StartTestExecutionRequest,
  type TestExecutionRun,
  type TestExecutionRunListResponse,
  type TestStepExecution,
} from "@device-robot/contracts";

import type { AppiumRuntimeService } from "../appium/appium-runtime-service.js";
import type { AiPlanService } from "../ai/ai-plan-service.js";
import type { ApkArtifactService } from "../apks/apk-artifact-service.js";
import type { DeviceControlService } from "../devices/adb-device-control-service.js";
import type { DeviceDiscoveryService } from "../devices/adb-device-service.js";
import type { DeviceManagementService } from "../devices/adb-device-management-service.js";
import type { ProjectStore } from "../projects/project-store.js";
import type { TestExecutionStore } from "./test-execution-store.js";

const execFileAsync = promisify(execFile);
const APPIUM_BASE_URL = "http://127.0.0.1:4723";
const DEFAULT_ACTION_TIMEOUT_MS = 8_000;
const MAX_ACTION_TIMEOUT_MS = 120_000;
const MAX_TEST_RUN_STEPS = 20;
const POLL_INTERVAL_MS = 250;
const WEB_DRIVER_ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const MAX_RUNTIME_SCREENSHOT_BYTES = 12 * 1_024 * 1_024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class TestExecutionError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 422 | 502 | 503,
  ) {
    super(message);
  }
}

export interface TestExecutionService {
  list(): Promise<TestExecutionRunListResponse>;
  find(runId: string): Promise<TestExecutionRun>;
  start(request: StartTestExecutionRequest): Promise<TestExecutionRun>;
  cancel(runId: string): Promise<TestExecutionRun>;
  screenshotPath(runId: string, stepIndex: number): Promise<string>;
  dispose(): Promise<void>;
}

export interface WebDriverTransport {
  request(
    method: "DELETE" | "GET" | "POST",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface ApplicationDataService {
  clear(serial: string, appId: string): Promise<void>;
  setPermission(
    serial: string,
    appId: string,
    permission: string,
    mode: "grant" | "revoke",
  ): Promise<void>;
}

export type LocalTestExecutionServiceOptions = {
  paths: AgentPaths;
  store: TestExecutionStore;
  projectStore: ProjectStore;
  deviceService: DeviceDiscoveryService;
  deviceControlService: DeviceControlService;
  deviceManagementService?: DeviceManagementService;
  aiPlanService?: AiPlanService;
  apkArtifactService?: ApkArtifactService;
  appiumRuntimeService: AppiumRuntimeService;
  transport?: WebDriverTransport;
  applicationDataService?: ApplicationDataService;
};

type ActiveRun = {
  controller: AbortController;
  completion: Promise<void>;
};

type WebDriverSession = {
  id: string;
  transport: WebDriverTransport;
  signal: AbortSignal;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function now(): string {
  return new Date().toISOString();
}

function asResponseValue(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || !("value" in payload)) {
    throw new TestExecutionError("Appium 返回了无效响应。", 502);
  }
  return (payload as { value: unknown }).value;
}

function asObject(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TestExecutionError(message, 502);
  }
  return value as Record<string, unknown>;
}

function webDriverErrorMessage(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const value = (payload as { value?: unknown }).value;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0 ? message.trim() : undefined;
}

class WebDriverRequestError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

function defaultTransport(): WebDriverTransport {
  return {
    request: async (method, path, body, signal) => {
      const response = await fetch(new URL(path, APPIUM_BASE_URL), {
        method,
        ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" } }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      });
      const payload = (await response.json().catch(() => undefined)) as unknown;
      if (!response.ok) {
        throw new WebDriverRequestError(
          webDriverErrorMessage(payload) ?? `Appium 请求失败（HTTP ${response.status}）。`,
          response.status,
        );
      }
      return payload;
    },
  };
}

function packageNameIsValid(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(value);
}

function defaultApplicationDataService(): ApplicationDataService {
  const executable = process.env.ADB_PATH ?? "adb";
  const execute = async (args: string[]): Promise<string> => {
    const { stdout, stderr } = await execFileAsync(executable, args, {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    return `${stdout}\n${stderr}`.trim();
  };
  const validateAppId = (appId: string): void => {
    if (!packageNameIsValid(appId)) {
      throw new TestExecutionError("测试目标包名无效。", 422);
    }
  };
  return {
    clear: async (serial, appId) => {
      validateAppId(appId);
      const output = await execute(["-s", serial, "shell", "pm", "clear", appId]);
      if (!/^Success\b/imu.test(output)) {
        throw new TestExecutionError(`无法清除应用数据：${output || "设备未返回 Success。"}`, 502);
      }
    },
    setPermission: async (serial, appId, permission, mode) => {
      validateAppId(appId);
      if (!/^android\.permission\.[A-Za-z0-9_.]+$/u.test(permission)) {
        throw new TestExecutionError("权限名称无效。", 422);
      }
      await execute(["-s", serial, "shell", "pm", mode, appId, permission]);
    },
  };
}

function escapeXpathText(value: string): string {
  if (!value.includes("'")) {
    return `'${value}'`;
  }
  if (!value.includes('"')) {
    return `"${value}"`;
  }
  return `concat(${value
    .split("'")
    .map((part) => `'${part}'`)
    .join(', "\'", ')})`;
}

function locatorFor(
  action: Extract<AgentAction, { target: unknown }>["target"],
): { using: string; value: string } | undefined {
  if (action.accessibilityId !== undefined) {
    return { using: "accessibility id", value: action.accessibilityId };
  }
  if (action.resourceId !== undefined) {
    return { using: "id", value: action.resourceId };
  }
  if (action.text !== undefined) {
    return { using: "xpath", value: `//*[@text=${escapeXpathText(action.text)}]` };
  }
  if (action.className !== undefined) {
    return { using: "class name", value: action.className };
  }
  return undefined;
}

function coordinateFor(
  action: Extract<AgentAction, { target: unknown }>["target"],
): { x: number; y: number } | undefined {
  return action.x === undefined || action.y === undefined
    ? undefined
    : { x: action.x, y: action.y };
}

function actionTimeout(action: AgentAction): number {
  if ("timeoutMs" in action && action.timeoutMs !== undefined) {
    return Math.min(MAX_ACTION_TIMEOUT_MS, action.timeoutMs);
  }
  return DEFAULT_ACTION_TIMEOUT_MS;
}

function isNoSuchElement(error: unknown): boolean {
  return (
    error instanceof WebDriverRequestError &&
    (error.statusCode === 404 || /no such element|element.*not found/iu.test(error.message))
  );
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, rejectSleep) => {
    const timer = setTimeout(resolveSleep, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      rejectSleep(new TestExecutionError("测试运行已取消。", 409));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new TestExecutionError("测试运行已取消。", 409);
  }
}

async function createSession(
  transport: WebDriverTransport,
  serial: string,
  signal: AbortSignal,
): Promise<WebDriverSession> {
  const payload = await transport.request(
    "POST",
    "/session",
    {
      capabilities: {
        alwaysMatch: {
          platformName: "Android",
          "appium:automationName": "UiAutomator2",
          "appium:udid": serial,
          "appium:noReset": true,
          "appium:newCommandTimeout": 120,
        },
      },
    },
    signal,
  );
  const value = asObject(asResponseValue(payload), "Appium 未返回会话信息。");
  const sessionId = value.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TestExecutionError("Appium 未返回有效会话编号。", 502);
  }
  return { id: sessionId, transport, signal };
}

async function deleteSession(session: WebDriverSession): Promise<void> {
  await session.transport
    .request("DELETE", `/session/${encodeURIComponent(session.id)}`)
    .catch(() => {});
}

async function sessionRequest(
  session: WebDriverSession,
  method: "DELETE" | "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  assertNotCancelled(session.signal);
  return asResponseValue(
    await session.transport.request(
      method,
      `/session/${encodeURIComponent(session.id)}${path}`,
      body,
      session.signal,
    ),
  );
}

async function findElement(
  session: WebDriverSession,
  locator: { using: string; value: string },
): Promise<string> {
  const value = asObject(
    await sessionRequest(session, "POST", "/element", locator),
    "Appium 未返回元素信息。",
  );
  const id = value[WEB_DRIVER_ELEMENT_KEY] ?? value.ELEMENT;
  if (typeof id !== "string" || id.length === 0) {
    throw new TestExecutionError("Appium 未返回有效元素编号。", 502);
  }
  return id;
}

async function waitForElement(
  session: WebDriverSession,
  selector: Extract<AgentAction, { target: unknown }>["target"],
  timeoutMs: number,
): Promise<string> {
  const locator = locatorFor(selector);
  if (locator === undefined) {
    throw new TestExecutionError("当前操作需要语义定位器。", 422);
  }
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    assertNotCancelled(session.signal);
    try {
      return await findElement(session, locator);
    } catch (error) {
      if (!isNoSuchElement(error)) {
        throw error;
      }
      lastError = error;
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())), session.signal);
    }
  }
  throw new TestExecutionError(
    `未找到目标元素：${locator.value}${lastError === undefined ? "" : "。"}`,
    422,
  );
}

async function elementIsDisplayed(session: WebDriverSession, elementId: string): Promise<boolean> {
  const value = await sessionRequest(
    session,
    "GET",
    `/element/${encodeURIComponent(elementId)}/displayed`,
  );
  return value === true;
}

async function waitForVisible(
  session: WebDriverSession,
  selector: Extract<AgentAction, { target: unknown }>["target"],
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const elementId = await waitForElement(
        session,
        selector,
        Math.min(POLL_INTERVAL_MS, timeoutMs),
      );
      if (await elementIsDisplayed(session, elementId)) {
        return elementId;
      }
    } catch (error) {
      if (!(error instanceof TestExecutionError) || error.statusCode !== 422) {
        throw error;
      }
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())), session.signal);
  }
  throw new TestExecutionError("目标元素在超时时间内不可见。", 422);
}

async function waitForNotVisible(
  session: WebDriverSession,
  selector: Extract<AgentAction, { target: unknown }>["target"],
  timeoutMs: number,
): Promise<void> {
  const locator = locatorFor(selector);
  if (locator === undefined) {
    throw new TestExecutionError("断言需要语义定位器。", 422);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const elementId = await findElement(session, locator);
      if (!(await elementIsDisplayed(session, elementId))) {
        return;
      }
    } catch (error) {
      if (isNoSuchElement(error)) {
        return;
      }
      throw error;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())), session.signal);
  }
  throw new TestExecutionError("目标元素仍然可见。", 422);
}

async function touch(
  session: WebDriverSession,
  start: { x: number; y: number },
  end: { x: number; y: number },
  durationMs: number,
): Promise<void> {
  await sessionRequest(session, "POST", "/actions", {
    actions: [
      {
        type: "pointer",
        id: "device-robot-finger",
        parameters: { pointerType: "touch" },
        actions: [
          { type: "pointerMove", duration: 0, x: start.x, y: start.y },
          { type: "pointerDown", button: 0 },
          ...(durationMs > 0 ? [{ type: "pause", duration: durationMs }] : []),
          { type: "pointerMove", duration: durationMs > 0 ? durationMs : 120, x: end.x, y: end.y },
          { type: "pointerUp", button: 0 },
        ],
      },
    ],
  });
}

function ensureActionScope(action: AgentAction, appId: string): void {
  if (
    (action.action === "app.launch" ||
      action.action === "app.stop" ||
      action.action === "device.permission") &&
    action.appId !== appId
  ) {
    throw new TestExecutionError("测试计划包含当前用例范围外的应用包名。", 422);
  }
}

function xmlAttribute(source: string, name: string): string | undefined {
  const expression = new RegExp(`\\b${name}="([^"]*)"`, "u");
  return expression.exec(source)?.[1]?.trim();
}

function boundsCenter(bounds: string | undefined): { x: number; y: number } | undefined {
  const match = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/u.exec(bounds ?? "");
  if (match === null) {
    return undefined;
  }
  const values = match.slice(1).map(Number);
  if (!values.every(Number.isFinite)) {
    return undefined;
  }
  const [left, top, right, bottom] = values as [number, number, number, number];
  return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
}

function conciseUiContext(xml: string): string {
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<node\b[^>]*>/gu)) {
    const node = match[0];
    const enabled = xmlAttribute(node, "enabled");
    if (enabled === "false") {
      continue;
    }
    const password = xmlAttribute(node, "password") === "true";
    const text = password ? undefined : xmlAttribute(node, "text");
    const resourceId = xmlAttribute(node, "resource-id");
    const accessibilityId = xmlAttribute(node, "content-desc");
    const className = xmlAttribute(node, "class");
    const clickable = xmlAttribute(node, "clickable") === "true";
    const center = boundsCenter(xmlAttribute(node, "bounds"));
    if (
      !clickable &&
      text === undefined &&
      resourceId === undefined &&
      accessibilityId === undefined
    ) {
      continue;
    }
    const parts = [
      text === undefined ? undefined : `text=${JSON.stringify(text.slice(0, 160))}`,
      resourceId === undefined ? undefined : `resourceId=${JSON.stringify(resourceId)}`,
      accessibilityId === undefined
        ? undefined
        : `accessibilityId=${JSON.stringify(accessibilityId.slice(0, 160))}`,
      className === undefined ? undefined : `className=${JSON.stringify(className)}`,
      clickable ? "clickable=true" : undefined,
      center === undefined ? undefined : `x=${center.x},y=${center.y}`,
    ].filter((part): part is string => part !== undefined);
    const candidate = parts.join("; ");
    if (candidate.length === 0 || seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    candidates.push(candidate);
    if (candidates.length >= 80) {
      break;
    }
  }
  return candidates.length === 0
    ? "未发现可安全定位的可见控件。"
    : candidates.map((candidate, index) => `${index + 1}. ${candidate}`).join("\n");
}

function runtimeScreenshot(
  buffer: Buffer,
): { dataUrl: string; width: number; height: number } | undefined {
  if (
    buffer.byteLength > MAX_RUNTIME_SCREENSHOT_BYTES ||
    buffer.byteLength < 24 ||
    !buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return undefined;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) {
    return undefined;
  }
  return {
    dataUrl: `data:image/png;base64,${buffer.toString("base64")}`,
    width,
    height,
  };
}

function testName(request: StartTestExecutionRequest): string {
  return request.name?.trim() || "AI 操作计划";
}

export class LocalTestExecutionService implements TestExecutionService {
  readonly #paths: AgentPaths;
  readonly #store: TestExecutionStore;
  readonly #projectStore: ProjectStore;
  readonly #deviceService: DeviceDiscoveryService;
  readonly #deviceControlService: DeviceControlService;
  readonly #deviceManagementService: DeviceManagementService | undefined;
  readonly #aiPlanService: AiPlanService | undefined;
  readonly #apkArtifactService: ApkArtifactService | undefined;
  readonly #appiumRuntimeService: AppiumRuntimeService;
  readonly #transport: WebDriverTransport;
  readonly #applicationDataService: ApplicationDataService;
  readonly #activeRuns = new Map<string, ActiveRun>();

  public constructor(options: LocalTestExecutionServiceOptions) {
    this.#paths = options.paths;
    this.#store = options.store;
    this.#projectStore = options.projectStore;
    this.#deviceService = options.deviceService;
    this.#deviceControlService = options.deviceControlService;
    this.#deviceManagementService = options.deviceManagementService;
    this.#aiPlanService = options.aiPlanService;
    this.#apkArtifactService = options.apkArtifactService;
    this.#appiumRuntimeService = options.appiumRuntimeService;
    this.#transport = options.transport ?? defaultTransport();
    this.#applicationDataService =
      options.applicationDataService ?? defaultApplicationDataService();
  }

  public async list(): Promise<TestExecutionRunListResponse> {
    return { runs: this.#store.list() };
  }

  public async find(runId: string): Promise<TestExecutionRun> {
    const run = this.#store.findById(runId);
    if (run === undefined) {
      throw new TestExecutionError("未找到测试运行记录。", 404);
    }
    return run;
  }

  public async start(request: StartTestExecutionRequest): Promise<TestExecutionRun> {
    if (this.#projectStore.findById(request.plan.projectId) === undefined) {
      throw new TestExecutionError("未找到测试项目。", 404);
    }
    if (!packageNameIsValid(request.appId)) {
      throw new TestExecutionError("测试目标包名无效。", 422);
    }
    if (
      request.plan.liveUiExecution !== undefined &&
      this.#aiPlanService?.decideRuntimeStep === undefined
    ) {
      throw new TestExecutionError("当前 Agent 未配置支持实时页面执行的 AI 服务。", 503);
    }
    let reachedNonInstallAction = false;
    for (const action of request.plan.actions) {
      ensureActionScope(action, request.appId);
      if (action.action === "adb.shell") {
        throw new TestExecutionError("测试执行不接受 adb.shell 操作。", 422);
      }
      if (action.action === "app.install") {
        if (reachedNonInstallAction) {
          throw new TestExecutionError("APK 安装必须位于测试计划的开头。", 422);
        }
        if (this.#apkArtifactService === undefined) {
          throw new TestExecutionError("当前 Agent 未启用本地 APK 暂存服务。", 503);
        }
      } else {
        reachedNonInstallAction = true;
      }
    }
    const deviceList = await this.#deviceService.listDevices();
    if (!deviceList.adb.available) {
      throw new TestExecutionError(deviceList.adb.error ?? "ADB 不可用。", 503);
    }
    const device = deviceList.devices.find(
      (candidate) => candidate.serial === request.deviceSerial,
    );
    if (device === undefined) {
      throw new TestExecutionError("测试设备已断开连接。", 404);
    }
    if (device.state !== "device" && device.state !== "emulator") {
      throw new TestExecutionError(`测试设备当前不可自动化：${device.state}。`, 409);
    }
    if ([...this.#activeRuns.values()].length > 0) {
      throw new TestExecutionError("已有测试正在运行，请等待完成或取消后再启动。", 409);
    }

    const startedAt = now();
    const run: TestExecutionRun = {
      id: randomUUID(),
      projectId: request.plan.projectId,
      planId: request.plan.id,
      name: testName(request),
      deviceSerial: request.deviceSerial,
      appId: request.appId,
      status: "running",
      steps: (request.plan.liveUiExecution === undefined
        ? request.plan.actions
        : request.plan.actions.filter((action) => action.action === "app.install")
      ).map((action, index) => ({
        index,
        action,
        status: "pending",
        screenshotAvailable: false,
      })),
      startedAt,
    };
    this.#store.create(run);
    const controller = new AbortController();
    const active: ActiveRun = {
      controller,
      completion: Promise.resolve(),
    };
    active.completion = this.#execute(run, controller.signal, request.plan.liveUiExecution).finally(
      () => {
        this.#activeRuns.delete(run.id);
      },
    );
    this.#activeRuns.set(run.id, active);
    return run;
  }

  public async cancel(runId: string): Promise<TestExecutionRun> {
    const run = await this.find(runId);
    if (run.status !== "running") {
      return run;
    }
    const active = this.#activeRuns.get(runId);
    if (active === undefined) {
      throw new TestExecutionError("测试运行已不在当前 Agent 中执行。", 409);
    }
    active.controller.abort();
    return {
      ...run,
      message: "正在取消测试运行。",
    };
  }

  public async screenshotPath(runId: string, stepIndex: number): Promise<string> {
    await this.find(runId);
    const path = this.#store.screenshotPath(runId, stepIndex);
    if (path === undefined) {
      throw new TestExecutionError("该步骤没有可用截图。", 404);
    }
    return path;
  }

  public async dispose(): Promise<void> {
    for (const active of this.#activeRuns.values()) {
      active.controller.abort();
    }
    await Promise.allSettled(
      [...this.#activeRuns.values()].map(async (active) => await active.completion),
    );
  }

  async #execute(
    run: TestExecutionRun,
    signal: AbortSignal,
    liveUiExecution: StartTestExecutionRequest["plan"]["liveUiExecution"],
  ): Promise<void> {
    let session: WebDriverSession | undefined;
    try {
      for (const step of run.steps.filter(
        (candidate) => candidate.action.action === "app.install",
      )) {
        assertNotCancelled(signal);
        await this.#executeInstallStep(run, step, signal);
      }
      const runtime = await this.#appiumRuntimeService.start();
      if (runtime.server.state !== "running") {
        throw new TestExecutionError(runtime.server.error ?? "Appium 服务未能启动。", 503);
      }
      assertNotCancelled(signal);
      await this.#applicationDataService.clear(run.deviceSerial, run.appId);
      assertNotCancelled(signal);
      session = await createSession(this.#transport, run.deviceSerial, signal);
      // The harness owns the clean launch boundary; reviewed steps then describe the flow under test.
      await sessionRequest(session, "POST", "/execute/sync", {
        script: "mobile: activateApp",
        args: [{ appId: run.appId }],
      });
      const completionMessage =
        liveUiExecution === undefined
          ? "测试运行完成。"
          : await this.#executeLiveUiFlow(
              run,
              session,
              signal,
              liveUiExecution.goal,
              liveUiExecution.maxSteps,
            );
      if (liveUiExecution === undefined) {
        for (const step of run.steps.filter(
          (candidate) => candidate.action.action !== "app.install",
        )) {
          assertNotCancelled(signal);
          await this.#executeStep(run, step, session, signal);
        }
      }
      this.#finishRun(run.id, "succeeded", completionMessage);
    } catch (error) {
      const cancelled = signal.aborted;
      const message = cancelled ? "测试运行已取消。" : errorMessage(error);
      const current = this.#store.findById(run.id);
      if (current !== undefined) {
        for (const step of current.steps.filter(
          (candidate) => candidate.status === "pending" || candidate.status === "running",
        )) {
          this.#store.updateStep(run.id, {
            ...step,
            status: "cancelled",
            message: cancelled ? "测试运行已取消。" : "由于前序步骤失败，未执行。",
            finishedAt: now(),
          });
        }
      }
      this.#finishRun(run.id, cancelled ? "cancelled" : "failed", message);
    } finally {
      if (session !== undefined) {
        await deleteSession(session);
      }
    }
  }

  #nextStepIndex(runId: string): number {
    return this.#store.findById(runId)?.steps.length ?? 0;
  }

  async #appendAndExecuteStep(
    run: TestExecutionRun,
    action: AgentAction,
    session: WebDriverSession,
    signal: AbortSignal,
    message?: string,
  ): Promise<void> {
    const index = this.#nextStepIndex(run.id);
    if (index >= MAX_TEST_RUN_STEPS) {
      throw new TestExecutionError(`实时页面执行已达到 ${MAX_TEST_RUN_STEPS} 步上限。`, 422);
    }
    const step: TestStepExecution = {
      index,
      action,
      status: "pending",
      screenshotAvailable: false,
      ...(message === undefined ? {} : { message }),
    };
    this.#store.appendStep(run.id, step);
    await this.#executeStep(run, step, session, signal);
  }

  async #executeLiveUiFlow(
    run: TestExecutionRun,
    session: WebDriverSession,
    signal: AbortSignal,
    goal: string,
    maxSteps: number,
  ): Promise<string> {
    const aiPlanService = this.#aiPlanService;
    if (aiPlanService?.decideRuntimeStep === undefined) {
      throw new TestExecutionError("当前 Agent 未配置支持实时页面执行的 AI 服务。", 503);
    }

    await sleep(800, signal);
    const runtimeHistory: string[] = [];
    for (let stepNumber = 1; stepNumber <= maxSteps; stepNumber += 1) {
      assertNotCancelled(signal);
      const [tree, screenshot] = await Promise.all([
        this.#deviceControlService.readUiTree(run.deviceSerial),
        this.#deviceControlService.captureScreenshot(run.deviceSerial),
      ]);
      const vision = runtimeScreenshot(screenshot);
      const decision = await aiPlanService.decideRuntimeStep({
        projectId: run.projectId,
        appId: run.appId,
        deviceSerial: run.deviceSerial,
        goal,
        stepNumber,
        uiContext: conciseUiContext(tree.xml),
        ...(runtimeHistory.length === 0 ? {} : { runtimeHistory }),
        ...(vision === undefined ? {} : { screenshot: vision }),
      });
      if (decision.status === "blocked") {
        await this.#captureFailureEvidence(run.id, this.#nextStepIndex(run.id), run.deviceSerial);
        throw new TestExecutionError(`AI 无法继续当前页面流程：${decision.reason}`, 422);
      }
      if (decision.status === "completed") {
        await this.#appendAndExecuteStep(run, decision.assertion, session, signal, decision.reason);
        return `自主执行完成：${decision.reason}`;
      }
      await this.#appendAndExecuteStep(run, decision.action, session, signal, decision.reason);
      runtimeHistory.push(
        `${stepNumber}. ${decision.action.action}：${decision.reason.slice(0, 500)}`,
      );
    }
    await this.#captureFailureEvidence(run.id, this.#nextStepIndex(run.id), run.deviceSerial);
    throw new TestExecutionError(`AI 未能在 ${maxSteps} 步内完成测试目标。`, 422);
  }

  async #executeStep(
    run: TestExecutionRun,
    originalStep: TestStepExecution,
    session: WebDriverSession,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = now();
    const runningStep = { ...originalStep, status: "running" as const, startedAt };
    this.#store.updateStep(run.id, runningStep);
    let screenshotPath: string | undefined;
    try {
      await this.#performAction(session, run, originalStep.action, signal);
      screenshotPath = await this.#captureStepScreenshot(
        run.id,
        originalStep.index,
        run.deviceSerial,
      );
      this.#store.updateStep(
        run.id,
        {
          ...runningStep,
          status: "succeeded",
          screenshotAvailable: screenshotPath !== undefined,
          finishedAt: now(),
        },
        screenshotPath,
      );
    } catch (error) {
      screenshotPath = await this.#captureStepScreenshot(
        run.id,
        originalStep.index,
        run.deviceSerial,
      ).catch(() => undefined);
      if (!signal.aborted) {
        await this.#captureFailureEvidence(run.id, originalStep.index, run.deviceSerial);
      }
      const message = signal.aborted ? "测试运行已取消。" : errorMessage(error);
      this.#store.updateStep(
        run.id,
        {
          ...runningStep,
          status: signal.aborted ? "cancelled" : "failed",
          message,
          screenshotAvailable: screenshotPath !== undefined,
          finishedAt: now(),
        },
        screenshotPath,
      );
      throw error;
    }
  }

  async #executeInstallStep(
    run: TestExecutionRun,
    originalStep: TestStepExecution,
    signal: AbortSignal,
  ): Promise<void> {
    if (originalStep.action.action !== "app.install" || this.#apkArtifactService === undefined) {
      throw new TestExecutionError("当前 Agent 未启用本地 APK 暂存服务。", 503);
    }
    const startedAt = now();
    const runningStep = { ...originalStep, status: "running" as const, startedAt };
    this.#store.updateStep(run.id, runningStep);
    try {
      assertNotCancelled(signal);
      const installed = await this.#apkArtifactService.install(
        run.deviceSerial,
        originalStep.action.artifactId,
        {
          replaceExisting: originalStep.action.replaceExisting,
          allowTestPackage: originalStep.action.allowTestPackage,
          uninstallExisting: false,
        },
      );
      this.#store.updateStep(run.id, {
        ...runningStep,
        status: "succeeded",
        message: `已安装 ${installed.packageName}。`,
        finishedAt: now(),
      });
    } catch (error) {
      if (!signal.aborted) {
        await this.#captureFailureEvidence(run.id, originalStep.index, run.deviceSerial);
      }
      this.#store.updateStep(run.id, {
        ...runningStep,
        status: signal.aborted ? "cancelled" : "failed",
        message: signal.aborted ? "测试运行已取消。" : errorMessage(error),
        finishedAt: now(),
      });
      throw error;
    }
  }

  #finishRun(runId: string, status: TestExecutionRun["status"], message: string): void {
    const current = this.#store.findById(runId);
    if (current === undefined) {
      return;
    }
    this.#store.updateRun({ ...current, status, message, finishedAt: now() });
  }

  async #captureStepScreenshot(runId: string, stepIndex: number, serial: string): Promise<string> {
    const directory = join(this.#paths.reports, runId, "steps");
    await mkdir(directory, { recursive: true });
    const screenshot = await this.#deviceControlService.captureScreenshot(serial);
    const path = join(directory, `${String(stepIndex + 1).padStart(3, "0")}.png`);
    await writeFile(path, screenshot);
    return path;
  }

  async #captureFailureEvidence(runId: string, stepIndex: number, serial: string): Promise<void> {
    const directory = join(this.#paths.reports, runId, "evidence");
    const filePrefix = `step-${String(stepIndex + 1).padStart(3, "0")}`;
    await mkdir(directory, { recursive: true });
    const tasks: Promise<void>[] = [
      this.#deviceControlService
        .readUiTree(serial)
        .then(
          async (tree) => await writeFile(join(directory, `${filePrefix}.xml`), tree.xml, "utf8"),
        ),
      this.#captureFailureLogcat(directory, filePrefix, serial),
      this.#captureAppiumLog(directory),
    ];
    await Promise.allSettled(tasks);
  }

  async #captureFailureLogcat(
    directory: string,
    filePrefix: string,
    serial: string,
  ): Promise<void> {
    if (this.#deviceManagementService === undefined) {
      return;
    }
    const response = await this.#deviceManagementService.readLogcat(serial, 500);
    const text = response.entries
      .map(
        (entry) =>
          `${entry.timestamp} ${entry.processId} ${entry.threadId} ${entry.level} ${entry.tag}: ${entry.message}`,
      )
      .join("\n");
    await writeFile(join(directory, `${filePrefix}-logcat.log`), text, "utf8");
  }

  async #captureAppiumLog(directory: string): Promise<void> {
    try {
      const contents = await readFile(join(this.#paths.logs, "appium.log"));
      const maximumBytes = 1_048_576;
      const tail = contents.subarray(Math.max(0, contents.byteLength - maximumBytes));
      await writeFile(join(directory, "appium.log"), tail);
    } catch {
      // The Appium process may fail before it has produced a log file.
    }
  }

  async #performAction(
    session: WebDriverSession,
    run: TestExecutionRun,
    action: AgentAction,
    signal: AbortSignal,
  ): Promise<void> {
    ensureActionScope(action, run.appId);
    switch (action.action) {
      case "app.launch":
        await sessionRequest(session, "POST", "/execute/sync", {
          script: "mobile: activateApp",
          args: [{ appId: action.appId }],
        });
        return;
      case "app.stop":
        await sessionRequest(session, "POST", "/execute/sync", {
          script: "mobile: terminateApp",
          args: [{ appId: action.appId }],
        });
        return;
      case "ui.tap": {
        const coordinate = coordinateFor(action.target);
        if (coordinate !== undefined && locatorFor(action.target) === undefined) {
          await touch(session, coordinate, coordinate, 0);
          return;
        }
        const elementId = await waitForVisible(session, action.target, actionTimeout(action));
        await sessionRequest(session, "POST", `/element/${encodeURIComponent(elementId)}/click`);
        return;
      }
      case "ui.longPress": {
        const coordinate = coordinateFor(action.target);
        if (coordinate !== undefined && locatorFor(action.target) === undefined) {
          await touch(session, coordinate, coordinate, action.durationMs ?? 650);
          return;
        }
        const elementId = await waitForVisible(session, action.target, DEFAULT_ACTION_TIMEOUT_MS);
        const rect = asObject(
          await sessionRequest(session, "GET", `/element/${encodeURIComponent(elementId)}/rect`),
          "Appium 未返回元素尺寸。",
        );
        const x = Number(rect.x);
        const y = Number(rect.y);
        const width = Number(rect.width);
        const height = Number(rect.height);
        if (![x, y, width, height].every(Number.isFinite)) {
          throw new TestExecutionError("Appium 返回的元素尺寸无效。", 502);
        }
        const center = { x: Math.round(x + width / 2), y: Math.round(y + height / 2) };
        await touch(session, center, center, action.durationMs ?? 650);
        return;
      }
      case "ui.input": {
        const elementId =
          action.target === undefined
            ? await sessionRequest(session, "GET", "/element/active")
            : await waitForVisible(session, action.target, DEFAULT_ACTION_TIMEOUT_MS);
        const resolvedId =
          typeof elementId === "string"
            ? elementId
            : (() => {
                const object = asObject(elementId, "Appium 未返回当前输入元素。");
                const id = object[WEB_DRIVER_ELEMENT_KEY] ?? object.ELEMENT;
                if (typeof id !== "string") {
                  throw new TestExecutionError("Appium 未返回当前输入元素。", 502);
                }
                return id;
              })();
        await sessionRequest(session, "POST", `/element/${encodeURIComponent(resolvedId)}/value`, {
          text: action.value,
          value: [...action.value],
        });
        return;
      }
      case "ui.swipe":
        await touch(session, action.start, action.end, action.durationMs ?? 300);
        return;
      case "ui.back":
        await sessionRequest(session, "POST", "/execute/sync", {
          script: "mobile: pressKey",
          args: [{ keycode: 4 }],
        });
        return;
      case "ui.wait":
        await sleep(action.durationMs, signal);
        return;
      case "assert.visible":
        await waitForVisible(session, action.target, actionTimeout(action));
        return;
      case "assert.notVisible":
        await waitForNotVisible(session, action.target, actionTimeout(action));
        return;
      case "assert.text": {
        const elementId = await waitForVisible(session, action.target, actionTimeout(action));
        const text = await sessionRequest(
          session,
          "GET",
          `/element/${encodeURIComponent(elementId)}/text`,
        );
        if (text !== action.expected) {
          throw new TestExecutionError(
            `文本断言失败，期望“${action.expected}”，实际“${String(text)}”。`,
            422,
          );
        }
        return;
      }
      case "assert.activity": {
        const activity = await sessionRequest(session, "GET", "/appium/device/current_activity");
        if (activity !== action.expected) {
          throw new TestExecutionError(
            `Activity 断言失败，期望“${action.expected}”，实际“${String(activity)}”。`,
            422,
          );
        }
        return;
      }
      case "device.permission":
        await this.#applicationDataService.setPermission(
          run.deviceSerial,
          action.appId,
          action.permission,
          action.mode,
        );
        return;
      case "device.orientation":
        await sessionRequest(session, "POST", "/orientation", {
          orientation: action.orientation.toUpperCase(),
        });
        return;
      case "device.screenshot":
        return;
      case "app.install":
        throw new TestExecutionError("APK 安装仅能作为测试计划的第一个步骤执行。", 422);
      case "adb.shell":
        throw new TestExecutionError(`暂不支持执行 ${action.action} 操作。`, 422);
    }
  }
}
