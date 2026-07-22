import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
import type { DeviceControlService } from "../devices/adb-device-control-service.js";
import type { DeviceDiscoveryService } from "../devices/adb-device-service.js";
import type { ProjectStore } from "../projects/project-store.js";
import type { TestExecutionStore } from "./test-execution-store.js";

const execFileAsync = promisify(execFile);
const APPIUM_BASE_URL = "http://127.0.0.1:4723";
const DEFAULT_ACTION_TIMEOUT_MS = 8_000;
const MAX_ACTION_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;
const WEB_DRIVER_ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

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

function testName(request: StartTestExecutionRequest): string {
  return request.name?.trim() || "AI 操作计划";
}

export class LocalTestExecutionService implements TestExecutionService {
  readonly #paths: AgentPaths;
  readonly #store: TestExecutionStore;
  readonly #projectStore: ProjectStore;
  readonly #deviceService: DeviceDiscoveryService;
  readonly #deviceControlService: DeviceControlService;
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
    for (const action of request.plan.actions) {
      ensureActionScope(action, request.appId);
      if (action.action === "adb.shell" || action.action === "app.install") {
        throw new TestExecutionError("测试执行不接受 adb.shell 或 app.install 操作。", 422);
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
      steps: request.plan.actions.map((action, index) => ({
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
    active.completion = this.#execute(run, controller.signal).finally(() => {
      this.#activeRuns.delete(run.id);
    });
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

  async #execute(run: TestExecutionRun, signal: AbortSignal): Promise<void> {
    let session: WebDriverSession | undefined;
    try {
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
      for (const step of run.steps) {
        assertNotCancelled(signal);
        await this.#executeStep(run, step, session, signal);
      }
      this.#finishRun(run.id, "succeeded", "测试运行完成。");
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

  #finishRun(
    runId: string,
    status: TestExecutionRun["status"],
    message: string,
  ): void {
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
      case "adb.shell":
        throw new TestExecutionError(`暂不支持执行 ${action.action} 操作。`, 422);
    }
  }
}
