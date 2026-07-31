import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  testExecutionRunSchema,
  testSuiteRecordSchema,
  type AiPlanResponse,
} from "@device-robot/contracts";

import { App } from "../src/App";

const scrcpyConfiguration = JSON.stringify({
  type: "configuration",
  codec: "avc1.42001e",
  description: "AA==",
  width: 1080,
  height: 2160,
});

class MockWebSocket {
  public static readonly instances: MockWebSocket[] = [];
  public static readonly OPEN = 1;
  public readonly OPEN = MockWebSocket.OPEN;
  public readonly url: string;
  public readyState = MockWebSocket.OPEN;
  public binaryType = "";
  public readonly sent: string[] = [];
  public onclose: (() => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;

  public constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.onmessage?.({ data: scrcpyConfiguration } as MessageEvent);
    });
  }

  public close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  public send(data: string): void {
    this.sent.push(data);
  }
}

class MockVideoDecoder {
  public state: "unconfigured" | "configured" | "closed" = "unconfigured";
  public decodeQueueSize = 0;

  public constructor(callbacks: Pick<VideoDecoderInit, "output" | "error">) {
    void callbacks;
  }

  public configure(config: VideoDecoderConfig): void {
    void config;
    this.state = "configured";
  }

  public decode(chunk: EncodedVideoChunk): void {
    void chunk;
  }

  public close(): void {
    this.state = "closed";
  }
}

beforeEach(() => {
  globalThis.location.hash = "#devices";
  globalThis.localStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  MockWebSocket.instances.splice(0);
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("VideoDecoder", MockVideoDecoder);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderApp(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

const healthResponse = {
  status: "ok",
  version: "0.1.0",
  startedAt: "2026-07-20T10:00:00.000Z",
  dataDirectory: "C:\\Users\\tester\\AppData\\Local\\AIMobileTester",
};

const appiumRuntimeResponse = {
  status: "ready",
  checkedAt: "2026-07-20T10:00:00.000Z",
  appium: { available: true, version: "3.5.2" },
  uiautomator2: {
    available: true,
    packageName: "appium-uiautomator2-driver",
    version: "8.1.0",
  },
  java: { available: true, version: "21" },
  androidSdk: { available: true, path: "D:\\Android\\Sdk" },
  server: {
    state: "stopped",
    host: "127.0.0.1",
    port: 4723,
    logFile: "C:\\logs\\appium.log",
  },
  issues: [],
};

const devicesResponse = {
  adb: {
    available: true,
    executable: "adb",
    version: "37.0.0-14910828",
    installedPath: "D:\\Android\\Sdk\\platform-tools\\adb.exe",
  },
  devices: [
    {
      serial: "8B3Y0THX0",
      state: "device",
      connection: "usb",
      product: "crosshatch",
      model: "Pixel 3 XL",
      manufacturer: "Google",
      androidVersion: "12",
      apiLevel: 31,
      transportId: "1",
      network: { transport: "wifi", connected: true },
      battery: { level: 86, state: "charging" },
    },
  ],
  refreshedAt: "2026-07-20T10:00:00.000Z",
};

const uiTreeResponse = {
  serial: "8B3Y0THX0",
  xml: '<?xml version="1.0"?><hierarchy rotation="0" />',
  capturedAt: "2026-07-20T10:00:00.000Z",
};

const fileListResponse = {
  serial: "8B3Y0THX0",
  path: "/storage/emulated/0",
  parentPath: "/storage/emulated",
  entries: [
    {
      name: "Download",
      path: "/storage/emulated/0/Download",
      kind: "directory",
    },
    {
      name: "notes.txt",
      path: "/storage/emulated/0/notes.txt",
      kind: "file",
    },
  ],
  readAt: "2026-07-20T10:00:00.000Z",
};

const fileTransferResponse = {
  serial: "8B3Y0THX0",
  fileName: "upload.txt",
  path: "/storage/emulated/0/upload.txt",
  sizeBytes: 12,
  transferredAt: "2026-07-21T10:00:00.000Z",
};

const applicationsResponse = {
  serial: "8B3Y0THX0",
  filter: "all",
  applications: [
    {
      packageName: "com.example.app",
      source: "user",
      apkPath: "/data/app/com.example.app/base.apk",
      versionName: "2.5.16",
      versionCode: "42",
      sizeBytes: 92739482,
      lastUsedAt: "2026-07-22T10:30:00.000Z",
    },
    {
      packageName: "com.android.settings",
      source: "system",
      apkPath: "/system/priv-app/Settings/Settings.apk",
      versionName: "14",
      versionCode: "33",
      sizeBytes: 12345678,
    },
  ],
  readAt: "2026-07-20T10:00:00.000Z",
};

const logcatResponse = {
  serial: "8B3Y0THX0",
  entries: [
    {
      timestamp: "07-21 10:00:00.123",
      processId: 1234,
      threadId: 1235,
      level: "info",
      tag: "ActivityManager",
      message: "Displayed com.example.app",
    },
    {
      timestamp: "07-21 10:00:01.000",
      processId: 1234,
      threadId: 1235,
      level: "error",
      tag: "AndroidRuntime",
      message: "FATAL EXCEPTION",
    },
  ],
  readAt: "2026-07-21T10:00:00.000Z",
};

const projectsResponse = {
  projects: [
    {
      id: "123e4567-e89b-12d3-a456-426614174000",
      name: "Example",
      source: "local",
      rootPath: "C:\\Github\\Example",
      gradleWrapper: true,
      modules: [
        {
          name: "app",
          path: "app",
          buildFile: "app/build.gradle.kts",
          manifestPath: "app/src/main/AndroidManifest.xml",
          packageName: "com.example.app",
          variants: ["debug", "release"],
        },
      ],
      createdAt: "2026-07-21T10:00:00.000Z",
      updatedAt: "2026-07-21T10:00:00.000Z",
    },
  ],
};
const exampleProject = projectsResponse.projects[0]!;

const indexedProjectResponse = {
  ...exampleProject,
  sourceIndex: {
    schemaVersion: 1,
    scannedAt: "2026-07-21T10:01:00.000Z",
    summary: {
      filesScanned: 4,
      kotlinJavaFileCount: 2,
      xmlViewCount: 2,
      composeScreenCount: 1,
      navigationDestinationCount: 2,
      typeCount: 2,
    },
    modules: [
      {
        path: "app",
        sourceFileCount: 2,
        xmlViewCount: 2,
        composeScreenCount: 1,
        navigationDestinationCount: 2,
        typeCount: 2,
      },
    ],
    evidence: [
      {
        kind: "compose-screen",
        name: "HomeScreen",
        filePath: "app/src/main/java/com/example/app/HomeScreen.kt",
        line: 1,
        modulePath: "app",
      },
    ],
  },
};

const projectBuildTargetResponse = {
  projectId: exampleProject.id,
  gradleWrapper: true,
  androidSdk: { available: true, path: "D:\\Android\\Sdk", source: "environment" },
  targets: [
    {
      modulePath: "app",
      moduleName: "app",
      variant: "debug",
      taskName: ":app:assembleDebug",
    },
    {
      modulePath: "app",
      moduleName: "app",
      variant: "release",
      taskName: ":app:assembleRelease",
    },
  ],
};

const runningProjectBuildResponse = {
  id: "223e4567-e89b-12d3-a456-426614174000",
  projectId: exampleProject.id,
  modulePath: "app",
  variant: "debug",
  taskName: ":app:assembleDebug",
  status: "running",
  logPath: "C:\\Users\\tester\\AppData\\Local\\AIMobileTester\\logs\\builds\\build.log",
  artifactPaths: [],
  message: "Gradle 构建正在执行。",
  startedAt: "2026-07-21T10:01:00.000Z",
};

const completedProjectBuildResponse = {
  ...runningProjectBuildResponse,
  status: "succeeded",
  artifactPaths: ["app/build/outputs/apk/debug/app-debug.apk"],
  artifactNames: ["Example_20260721_180200_debug.apk"],
  message: "构建完成，发现 1 个 APK 输出。",
  exitCode: 0,
  finishedAt: "2026-07-21T10:02:00.000Z",
};

const failedProjectBuildResponse = {
  ...runningProjectBuildResponse,
  status: "failed",
  message:
    "Execution failed for task ':app:mergeDebugResources'.\n> Android resource linking failed",
  exitCode: 1,
  finishedAt: "2026-07-21T10:02:00.000Z",
};

const detailedBuildLog = [
  "# DeviceRobot Gradle build",
  "> Task :app:mergeDebugResources FAILED",
  "",
  "FAILURE: Build failed with an exception.",
  "",
  "* What went wrong:",
  "Execution failed for task ':app:mergeDebugResources'.",
  "> Android resource linking failed",
].join("\n");

const aiModelStatusResponse = {
  configured: true,
  provider: "openai-compatible",
  baseUrl: "https://model.example/v1",
  model: "test-model",
};

const aiPlanResponse: AiPlanResponse = {
  reply: "已生成首页可见性检查计划。",
  plan: {
    id: "423e4567-e89b-12d3-a456-426614174000",
    projectId: exampleProject.id,
    actions: [{ action: "assert.visible", target: { text: "首页" } }],
    requiresApproval: true,
  },
  policy: {
    allowed: true,
    requiresApproval: true,
    reason: "AI 生成的计划仅供预览，执行前必须获得明确确认。",
    warnings: [],
  },
  context: { projectName: "Example", sourceIndexAvailable: false, evidence: [] },
  generatedAt: "2026-07-21T10:02:00.000Z",
};

const testExecutionRunResponse = {
  id: "523e4567-e89b-12d3-a456-426614174000",
  projectId: exampleProject.id,
  planId: aiPlanResponse.plan.id,
  name: "首页可见性检查",
  deviceSerial: "8B3Y0THX0",
  appId: "com.example.app",
  status: "running",
  steps: [
    {
      index: 0,
      action: { action: "assert.visible", target: { text: "首页" } },
      status: "pending",
      screenshotAvailable: false,
    },
  ],
  startedAt: "2026-07-23T10:02:00.000Z",
};

const testSuiteRecordResponse = {
  id: "623e4567-e89b-12d3-a456-426614174000",
  projectId: exampleProject.id,
  fileName: "smoke.yaml",
  suite: {
    schemaVersion: 1,
    appId: "com.example.app",
    suite: {
      id: "smoke",
      name: "示例冒烟测试",
      sourceRevision: "main",
    },
    cases: [
      {
        id: "launch-home",
        name: "启动后显示首页",
        priority: "P0",
        tags: ["smoke"],
        sourceEvidence: [],
        data: {},
        steps: [
          {
            id: "home-visible",
            action: { action: "assert.visible", target: { text: "首页" } },
            healingEnabled: true,
          },
        ],
      },
    ],
  },
  importedAt: "2026-07-23T10:00:00.000Z",
};

const aiExplorationPlanResponse: AiPlanResponse = {
  ...aiPlanResponse,
  plan: {
    ...aiPlanResponse.plan,
    liveUiExecution: { goal: "进入首页", maxSteps: 8 },
  },
};

const completedAiExplorationRun = testExecutionRunSchema.parse({
  ...testExecutionRunResponse,
  planId: aiExplorationPlanResponse.plan.id,
  executionMode: "ai-exploration",
  status: "succeeded",
  finishedAt: "2026-07-23T10:03:00.000Z",
});

const savedExplorationCase = testSuiteRecordResponse.suite.cases[0]!;
const savedExplorationSuiteResponse = testSuiteRecordSchema.parse({
  ...testSuiteRecordResponse,
  id: "723e4567-e89b-12d3-a456-426614174000",
  fileName: "ai-exploration-com-example-app.json",
  suite: {
    ...testSuiteRecordResponse.suite,
    suite: {
      id: "ai-exploration-com-example-app",
      name: "AI 探索离线用例",
      sourceRevision: "local",
      origin: "ai-exploration" as const,
      version: 1,
      sourceRunIds: [completedAiExplorationRun.id],
    },
    cases: [
      {
        ...savedExplorationCase,
        id: `exploration-${completedAiExplorationRun.id}`,
        steps: savedExplorationCase.steps.map((step) => ({
          ...step,
          healingEnabled: false,
        })),
      },
    ],
  },
});

const apkArtifactResponse = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  fileName: "sample.apk",
  sizeBytes: 132,
  sha256: "a".repeat(64),
  uploadedAt: "2026-07-20T10:00:00.000Z",
  metadata: {
    packageName: "com.example.app",
    applicationLabel: "示例应用",
    versionName: "1.2.3",
    versionCode: "42",
    minSdkVersion: "23",
    targetSdkVersion: "35",
  },
};

function mockApis(
  options: {
    healthError?: Error;
    aiModelStatus?: {
      configured: boolean;
      provider: "openai-compatible";
      baseUrl?: string;
      model?: string;
      reason?: string;
    };
    aiPlan?: AiPlanResponse;
    delayAiPlan?: boolean;
    completedProjectBuild?: boolean;
    failedProjectBuild?: boolean;
    projectBuildRuns?: Array<typeof completedProjectBuildResponse>;
    testRuns?: readonly unknown[];
  } = {},
): {
  getDeviceRequests: () => number;
  getActionRequests: () => number;
  getLastAction: () => unknown;
  getInstallRequests: () => number;
  getFileUploadRequests: () => number;
  getProjectCreateRequests: () => number;
  getProjectDeleteRequests: () => number;
  getProjectReindexRequests: () => number;
  getProjectBuildRequests: () => number;
  getProjectArtifactInstallRequests: () => number;
  getAiPlanRequests: () => number;
  getAiPlanAbortRequests: () => number;
  getLastAiPlanRequest: () => unknown;
  getAiModelListRequests: () => number;
  getAiConfigurationTestRequests: () => number;
  getTestExecutionRequests: () => number;
  getLastTestExecutionRequest: () => unknown;
  getWorkspaceExecutionRequests: () => number;
  getLastWorkspaceExecutionRequest: () => unknown;
  getTestSuiteImportRequests: () => number;
  getTestSuiteRunRequests: () => number;
  getLastTestSuiteRunRequest: () => unknown;
  getExplorationSaveRequests: () => number;
} {
  let deviceRequests = 0;
  let actionRequests = 0;
  let lastAction: unknown;
  let installRequests = 0;
  let fileUploadRequests = 0;
  let projectCreateRequests = 0;
  let projectDeleteRequests = 0;
  let projectDeleted = false;
  let projectReindexRequests = 0;
  let projectSourceIndexed = false;
  let projectBuildRequests = 0;
  let projectBuildStarted = options.completedProjectBuild ?? options.failedProjectBuild ?? false;
  let currentProjectBuildRun = runningProjectBuildResponse;
  let projectArtifactInstallRequests = 0;
  let aiPlanRequests = 0;
  let aiPlanAbortRequests = 0;
  let lastAiPlanRequest: unknown;
  let aiModelListRequests = 0;
  let aiConfigurationTestRequests = 0;
  let testExecutionRequests = 0;
  let lastTestExecutionRequest: unknown;
  let workspaceExecutionRequests = 0;
  let lastWorkspaceExecutionRequest: unknown;
  let testSuiteImportRequests = 0;
  let testSuiteRunRequests = 0;
  let lastTestSuiteRunRequest: unknown;
  let explorationSaveRequests = 0;
  let importedTestSuites: unknown[] = [];
  const aiConversation = {
    id: "723e4567-e89b-12d3-a456-426614174000",
    projectId: exampleProject.id,
    appId: "com.example.app",
    title: "com.example.app 测试会话",
    sourceRevision: "2026-07-20T10:00:00.000Z",
    contextStatus: "current" as const,
    createdAt: "2026-07-20T10:00:00.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
  };
  let aiConversations = [aiConversation];
  let aiConversationMessages: Array<{
    id: string;
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    plan?: AiPlanResponse;
    createdAt: string;
  }> = [];
  let currentAiModelStatus = options.aiModelStatus ?? aiModelStatusResponse;
  const actionHistory = {
    serial: "8B3Y0THX0",
    actions: [] as Array<{
      id: string;
      serial: string;
      action: { action: "ui.back" };
      success: true;
      startedAt: string;
      finishedAt: string;
    }>,
  };

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");

    if (url.endsWith("/api/v1/system/health")) {
      if (options.healthError !== undefined) {
        throw options.healthError;
      }

      return new Response(JSON.stringify(healthResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/api/v1/appium/runtime")) {
      return new Response(JSON.stringify(appiumRuntimeResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "/api/v1/ai/status") {
      return new Response(JSON.stringify(currentAiModelStatus), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "/api/v1/ai/models" && method === "POST") {
      aiModelListRequests += 1;
      return new Response(
        JSON.stringify({ provider: "openai-compatible", models: ["gpt-4.1-mini", "gpt-4.1"] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "/api/v1/ai/config/test" && method === "POST") {
      aiConfigurationTestRequests += 1;
      const request = JSON.parse(String(init?.body ?? "{}")) as {
        baseUrl?: string;
        model: string;
      };
      const baseUrl = request.baseUrl ?? currentAiModelStatus.baseUrl ?? "https://model.example/v1";
      currentAiModelStatus = {
        configured: true,
        provider: "openai-compatible",
        baseUrl,
        model: request.model,
      };
      return new Response(
        JSON.stringify({
          provider: "openai-compatible",
          baseUrl,
          model: request.model,
          message: "模型连接成功，已应用到当前本地 Agent。",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "/api/v1/ai/plans" && method === "POST") {
      aiPlanRequests += 1;
      lastAiPlanRequest = JSON.parse(String(init?.body ?? "{}"));
      if (options.delayAiPlan === true) {
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aiPlanAbortRequests += 1;
              reject(new DOMException("The operation was aborted.", "AbortError"));
            },
            { once: true },
          );
        });
      }
      const request = lastAiPlanRequest as { conversationId?: string; goal?: string };
      const response = options.aiPlan ?? aiPlanResponse;
      const conversationId = request.conversationId ?? aiConversation.id;
      aiConversationMessages = [
        ...aiConversationMessages,
        {
          id: "623e4567-e89b-12d3-a456-426614174000",
          conversationId,
          role: "user",
          content: request.goal ?? "测试目标",
          createdAt: response.generatedAt,
        },
        {
          id: "723e4567-e89b-12d3-a456-426614174001",
          conversationId,
          role: "assistant",
          content: response.reply,
          plan: response,
          createdAt: response.generatedAt,
        },
      ];
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "/api/v1/ai/plans") {
      return new Response(JSON.stringify({ plans: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "/api/v1/workspace-executions" && method === "POST") {
      workspaceExecutionRequests += 1;
      lastWorkspaceExecutionRequest = JSON.parse(String(init?.body ?? "{}"));
      const request = lastWorkspaceExecutionRequest as {
        deviceSerial: string;
        plan: AiPlanResponse["plan"];
      };
      const action = request.plan.actions[0];
      if (action === undefined) {
        throw new Error("workspace execution requires an action");
      }
      return new Response(
        JSON.stringify({
          id: "823e4567-e89b-12d3-a456-426614174000",
          projectId: request.plan.projectId,
          deviceSerial: request.deviceSerial,
          status: "succeeded",
          results: [
            {
              index: 0,
              action,
              status: "succeeded",
              startedAt: "2026-07-25T10:00:00.000Z",
              finishedAt: "2026-07-25T10:00:01.000Z",
            },
          ],
          startedAt: "2026-07-25T10:00:00.000Z",
          finishedAt: "2026-07-25T10:00:01.000Z",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const conversationListUrl = `/api/v1/projects/${exampleProject.id}/ai-conversations`;
    if (url === conversationListUrl) {
      if (method === "POST") {
        const request = JSON.parse(String(init?.body ?? "{}")) as { appId?: string };
        const created = {
          ...aiConversation,
          id: `823e4567-e89b-12d3-a456-42661417400${aiConversations.length}`,
          ...(request.appId === undefined ? {} : { appId: request.appId }),
          title: request.appId === undefined ? "新建测试会话" : `${request.appId} 测试会话`,
        };
        aiConversations = [created, ...aiConversations];
        return new Response(JSON.stringify(created), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ projectId: exampleProject.id, conversations: aiConversations }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    const conversationDetailPrefix = "/api/v1/ai-conversations/";
    if (url.startsWith(conversationDetailPrefix)) {
      const conversationId = url.slice(conversationDetailPrefix.length);
      const conversation = aiConversations.find((candidate) => candidate.id === conversationId);
      return new Response(
        JSON.stringify({
          conversation: conversation ?? aiConversation,
          messages: aiConversationMessages.filter(
            (message) => message.conversationId === conversationId,
          ),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "/api/v1/test-runs" || url.startsWith("/api/v1/test-runs?projectId=")) {
      if (method === "POST") {
        testExecutionRequests += 1;
        lastTestExecutionRequest = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify(testExecutionRunResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ runs: options.testRuns ?? [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const testSuiteBaseUrl = `/api/v1/projects/${exampleProject.id}/test-suites`;
    if (url === testSuiteBaseUrl) {
      if (method === "POST") {
        testSuiteImportRequests += 1;
        importedTestSuites = [testSuiteRecordResponse, ...importedTestSuites];
        return new Response(JSON.stringify(testSuiteRecordResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ projectId: exampleProject.id, suites: importedTestSuites }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === `${testSuiteBaseUrl}/from-exploration` && method === "POST") {
      explorationSaveRequests += 1;
      importedTestSuites = [savedExplorationSuiteResponse, ...importedTestSuites];
      return new Response(JSON.stringify(savedExplorationSuiteResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      url === `${testSuiteBaseUrl}/${testSuiteRecordResponse.id}/cases/launch-home/runs` &&
      method === "POST"
    ) {
      testSuiteRunRequests += 1;
      lastTestSuiteRunRequest = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({ ...testExecutionRunResponse, planId: "dsl:smoke:launch-home" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (
      url ===
        `${testSuiteBaseUrl}/${savedExplorationSuiteResponse.id}/cases/exploration-${completedAiExplorationRun.id}/runs` &&
      method === "POST"
    ) {
      testSuiteRunRequests += 1;
      lastTestSuiteRunRequest = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          ...testExecutionRunResponse,
          planId: `dsl:${savedExplorationSuiteResponse.id}:exploration-${completedAiExplorationRun.id}`,
          executionMode: "local-dsl",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.endsWith(`/projects/${indexedProjectResponse.id}/index`) && method === "POST") {
      projectReindexRequests += 1;
      projectSourceIndexed = true;
      return new Response(JSON.stringify(indexedProjectResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.endsWith(`/projects/${projectBuildTargetResponse.projectId}/builds/targets`)) {
      return new Response(JSON.stringify(projectBuildTargetResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (
      url.includes(`/projects/${projectBuildTargetResponse.projectId}/builds/`) &&
      url.endsWith("/log")
    ) {
      return new Response(
        JSON.stringify({
          projectId: projectBuildTargetResponse.projectId,
          buildId: failedProjectBuildResponse.id,
          content: detailedBuildLog,
          truncated: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.endsWith(`/projects/${projectBuildTargetResponse.projectId}/builds`)) {
      if (method === "POST") {
        projectBuildRequests += 1;
        projectBuildStarted = true;
        const request = JSON.parse(String(init?.body ?? "{}")) as {
          modulePath?: string;
          variant?: string;
        };
        const target = projectBuildTargetResponse.targets.find(
          (candidate) =>
            candidate.modulePath === request.modulePath && candidate.variant === request.variant,
        );
        currentProjectBuildRun = {
          ...runningProjectBuildResponse,
          ...(target === undefined
            ? {}
            : {
                modulePath: target.modulePath,
                variant: target.variant,
                taskName: target.taskName,
              }),
        };
        return new Response(JSON.stringify(currentProjectBuildRun), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          projectId: projectBuildTargetResponse.projectId,
          runs: projectBuildStarted
            ? (options.projectBuildRuns ?? [
                options.completedProjectBuild
                  ? completedProjectBuildResponse
                  : options.failedProjectBuild
                    ? failedProjectBuildResponse
                    : currentProjectBuildRun,
              ])
            : [],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (
      url.includes(`/projects/${projectBuildTargetResponse.projectId}/builds/`) &&
      url.endsWith("/install") &&
      method === "POST"
    ) {
      projectArtifactInstallRequests += 1;
      return new Response(
        JSON.stringify({
          status: "installed",
          serial: "8B3Y0THX0",
          artifactId: apkArtifactResponse.id,
          packageName: "com.example.app",
          startedAt: "2026-07-22T10:01:00.000Z",
          finishedAt: "2026-07-22T10:01:02.000Z",
          message: "Success",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "/api/v1/projects") {
      if (method === "POST") {
        projectCreateRequests += 1;
      }
      return new Response(
        JSON.stringify(
          method === "POST"
            ? projectsResponse.projects[0]
            : {
                projects: projectDeleted
                  ? []
                  : [projectSourceIndexed ? indexedProjectResponse : projectsResponse.projects[0]],
              },
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (url === `/api/v1/projects/${exampleProject.id}` && method === "DELETE") {
      projectDeleteRequests += 1;
      projectDeleted = true;
      return new Response(null, { status: 204 });
    }

    if (url === "/api/v1/apks" && method === "POST") {
      return new Response(JSON.stringify(apkArtifactResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/apks/") && url.endsWith("/install")) {
      installRequests += 1;
      return new Response(
        JSON.stringify({
          status: "installed",
          serial: "8B3Y0THX0",
          artifactId: apkArtifactResponse.id,
          packageName: "com.example.app",
          startedAt: "2026-07-20T10:01:00.000Z",
          finishedAt: "2026-07-20T10:01:02.000Z",
          message: "Success",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url.includes("/api/v1/apks/") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }

    if (url.includes("/files/upload") && method === "POST") {
      fileUploadRequests += 1;
      return new Response(JSON.stringify(fileTransferResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/files")) {
      return new Response(JSON.stringify(fileListResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/applications")) {
      return new Response(JSON.stringify(applicationsResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/logcat")) {
      return new Response(JSON.stringify(logcatResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.includes("/api/v1/devices")) {
      deviceRequests += 1;

      if (url.includes("/ui-tree")) {
        return new Response(JSON.stringify(uiTreeResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/actions")) {
        if (method === "POST") {
          actionRequests += 1;
          lastAction = JSON.parse(String(init?.body ?? "{}"));
          const recordedAction = {
            id: "123e4567-e89b-12d3-a456-426614174000",
            serial: "8B3Y0THX0",
            action: { action: "ui.back" as const },
            success: true as const,
            startedAt: "2026-07-20T10:00:00.000Z",
            finishedAt: "2026-07-20T10:00:01.000Z",
          };
          actionHistory.actions = [recordedAction, ...actionHistory.actions];
          return new Response(JSON.stringify(recordedAction), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify(actionHistory), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(JSON.stringify(devicesResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify(healthResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  return {
    getDeviceRequests: () => deviceRequests,
    getActionRequests: () => actionRequests,
    getLastAction: () => lastAction,
    getInstallRequests: () => installRequests,
    getFileUploadRequests: () => fileUploadRequests,
    getProjectCreateRequests: () => projectCreateRequests,
    getProjectDeleteRequests: () => projectDeleteRequests,
    getProjectReindexRequests: () => projectReindexRequests,
    getProjectBuildRequests: () => projectBuildRequests,
    getProjectArtifactInstallRequests: () => projectArtifactInstallRequests,
    getAiPlanRequests: () => aiPlanRequests,
    getAiPlanAbortRequests: () => aiPlanAbortRequests,
    getLastAiPlanRequest: () => lastAiPlanRequest,
    getAiModelListRequests: () => aiModelListRequests,
    getAiConfigurationTestRequests: () => aiConfigurationTestRequests,
    getTestExecutionRequests: () => testExecutionRequests,
    getLastTestExecutionRequest: () => lastTestExecutionRequest,
    getWorkspaceExecutionRequests: () => workspaceExecutionRequests,
    getLastWorkspaceExecutionRequest: () => lastWorkspaceExecutionRequest,
    getTestSuiteImportRequests: () => testSuiteImportRequests,
    getTestSuiteRunRequests: () => testSuiteRunRequests,
    getLastTestSuiteRunRequest: () => lastTestSuiteRunRequest,
    getExplorationSaveRequests: () => explorationSaveRequests,
  };
}

describe("DeviceRobot Web UI", () => {
  it("opens directly into the selected device overview", async () => {
    mockApis();
    renderApp();

    expect(await screen.findByRole("heading", { level: 1, name: "概览" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "设备工作台" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启动" })).toBeInTheDocument();
    expect(screen.getByText("ADB 就绪")).toBeInTheDocument();
    expect(screen.getAllByText("Wi-Fi 已连接")).toHaveLength(2);
    expect(screen.getByText("电量 86% 充电中")).toBeInTheDocument();
  });

  it("restores the most recent mirror width while devices are still being scanned", () => {
    globalThis.localStorage.setItem("device-robot:mirror-width:last", "366");
    globalThis.localStorage.setItem("device-robot:mirror-aspect-ratio:last", "0.5");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => undefined)),
    );
    renderApp();

    const layout = screen.getByRole("separator", { name: "调整左右区域宽度" }).parentElement;
    const shell = layout?.parentElement;
    expect(shell?.style.getPropertyValue("--device-sidebar-width")).toBe("366px");
    expect(shell?.style.getPropertyValue("--last-mirror-aspect-ratio")).toBe("0.5");
    expect(screen.getByRole("status", { name: "正在扫描设备" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "设备连接状态" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("region", { name: "设备连接状态" }).parentElement).toHaveClass(
      "is-empty",
    );
  });

  it("remembers the live screen aspect ratio for the no-device placeholder", async () => {
    mockApis();
    renderApp();

    await screen.findByRole("img", { name: "设备实时画面：Pixel 3 XL" });
    await vi.waitFor(() =>
      expect(globalThis.localStorage.getItem("device-robot:mirror-aspect-ratio:8B3Y0THX0")).toBe(
        "0.5",
      ),
    );
    expect(globalThis.localStorage.getItem("device-robot:mirror-aspect-ratio:last")).toBe("0.5");
  });

  it("shows Agent unavailability only in the top status bar", async () => {
    mockApis({ healthError: new Error("Connection refused") });
    renderApp();

    const indicator = await screen.findByText("Agent 不可用", {}, { timeout: 3_000 });
    expect(indicator).toHaveClass("runtime-indicator", "unavailable");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows primary workspace tabs in order and adds secondary tabs from the menu", async () => {
    mockApis();
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole("heading", { level: 1, name: "概览" });
    const tabBar = screen.getByRole("navigation", { name: "设备工作页签" });
    const tabLabels = within(tabBar)
      .getAllByRole("button")
      .filter((button) => button.getAttribute("aria-label") !== "添加工作页签")
      .map((button) => button.textContent);
    expect(tabLabels).toEqual(["概览", "项目", "AI", "文件管理器", "应用管理器"]);
    expect(screen.queryByRole("button", { name: "设备日志" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "添加工作页签" }));
    const addMenu = screen.getByLabelText("可添加的工作页签");
    expect(within(addMenu).getByRole("button", { name: "设备日志" })).toBeInTheDocument();
    expect(within(addMenu).getByRole("button", { name: "终端" })).toBeInTheDocument();
    expect(within(addMenu).getByRole("button", { name: "测试报告" })).toBeInTheDocument();
    await user.click(within(addMenu).getByRole("button", { name: "终端" }));

    expect(screen.getByRole("heading", { level: 1, name: "终端" })).toBeInTheDocument();
    expect(globalThis.location.hash).toBe("#terminal");
    expect(screen.getByRole("button", { name: "终端" })).toBeInTheDocument();
  });

  it("creates a project from the project-management form", async () => {
    const { getProjectCreateRequests } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "项目" }));
    await user.type(screen.getByRole("textbox", { name: "本地项目目录" }), "C:\\Github\\Example");
    await user.click(screen.getByRole("button", { name: "接入项目" }));

    await vi.waitFor(() => expect(getProjectCreateRequests()).toBe(1));
  });

  it("opens the project operation menu and deletes only the project registration after confirmation", async () => {
    const { getProjectDeleteRequests } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "项目" }));
    await user.click(await screen.findByRole("button", { name: "Example 的更多项目操作" }));
    const menu = screen.getByRole("menu", { name: "Example 的项目操作" });
    await user.click(within(menu).getByRole("menuitem", { name: "删除项目" }));

    const dialog = screen.getByRole("dialog", { name: "确认删除项目" });
    expect(
      within(dialog).getByText("项目源码、Git 克隆目录和已生成的 APK 文件都会保留。"),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "删除项目" }));

    await vi.waitFor(() => expect(getProjectDeleteRequests()).toBe(1));
    expect(await screen.findByText("尚未接入 Android 项目。")).toBeInTheDocument();
  });

  it("requires an explicit confirmation before starting a discovered Gradle Variant", async () => {
    const { getProjectBuildRequests } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "项目" }));
    const variantSelector = await screen.findByRole("combobox", { name: "app 构建变体" });
    expect(within(variantSelector).getByRole("option", { name: "debug" })).toBeInTheDocument();
    expect(within(variantSelector).getByRole("option", { name: "release" })).toBeInTheDocument();
    await user.selectOptions(variantSelector, ":app:assembleRelease");
    await user.click(screen.getByRole("button", { name: "构建 app release" }));

    const dialog = await screen.findByRole("dialog", { name: "确认构建" });
    expect(within(dialog).getByText(":app:assembleRelease")).toBeInTheDocument();
    expect(getProjectBuildRequests()).toBe(0);
    await user.click(within(dialog).getByRole("button", { name: "确认构建" }));

    await vi.waitFor(() => expect(getProjectBuildRequests()).toBe(1));
    expect(
      await screen.findByText("构建任务正在执行，完成后 APK 会出现在此处。"),
    ).toBeInTheDocument();
    const buildButton = screen.getByRole("button", { name: "构建 app release" });
    expect(buildButton).toBeDisabled();
    expect(buildButton).toHaveTextContent("构建中");
  });

  it("exports and installs an APK from a completed project build", async () => {
    const { getProjectArtifactInstallRequests } = mockApis({ completedProjectBuild: true });
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "项目" }));
    const output = await screen.findByText("Example_20260721_180200_debug.apk");
    const artifact = output.closest(".project-build-artifact");
    expect(artifact).not.toBeNull();
    expect(
      within(artifact as HTMLElement).getByRole("link", {
        name: "导出 Example_20260721_180200_debug.apk",
      }),
    ).toHaveAttribute(
      "href",
      `/api/v1/projects/${projectBuildTargetResponse.projectId}/builds/${completedProjectBuildResponse.id}/artifacts/0/download`,
    );

    await user.click(
      within(artifact as HTMLElement).getByRole("button", {
        name: "安装 Example_20260721_180200_debug.apk 到当前设备",
      }),
    );

    await vi.waitFor(() => expect(getProjectArtifactInstallRequests()).toBe(1));
    expect(
      await within(artifact as HTMLElement).findByText("已安装 com.example.app"),
    ).toBeInTheDocument();
  });

  it("shows a failed build's detailed Gradle log in a dialog", async () => {
    mockApis({ failedProjectBuild: true });
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "项目" }));

    expect(
      await screen.findByText("Execution failed for task ':app:mergeDebugResources'.", {
        exact: false,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "展开" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看详情" }));

    const dialog = await screen.findByRole("dialog", { name: "构建失败详情" });
    const log = dialog.querySelector(".project-build-log");
    expect(log).toHaveTextContent("# DeviceRobot Gradle build");
    expect(log).toHaveTextContent("Android resource linking failed");
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "构建失败详情" })).not.toBeInTheDocument();
  });

  it("only displays the two most recent project build records", async () => {
    const latest = {
      ...completedProjectBuildResponse,
      id: "323e4567-e89b-12d3-a456-426614174000",
      artifactNames: ["Example_20260722_100200_release.apk"],
      variant: "release",
      taskName: ":app:assembleRelease",
      startedAt: "2026-07-22T10:01:00.000Z",
      finishedAt: "2026-07-22T10:02:00.000Z",
    };
    const previous = {
      ...completedProjectBuildResponse,
      id: "423e4567-e89b-12d3-a456-426614174000",
      artifactNames: ["Example_20260721_100200_debug.apk"],
    };
    const older = {
      ...completedProjectBuildResponse,
      id: "523e4567-e89b-12d3-a456-426614174000",
      artifactNames: ["Example_20260720_100200_debug.apk"],
      startedAt: "2026-07-20T10:01:00.000Z",
      finishedAt: "2026-07-20T10:02:00.000Z",
    };
    mockApis({ completedProjectBuild: true, projectBuildRuns: [older, previous, latest] });
    renderApp();

    await userEvent.click(await screen.findByRole("button", { name: "项目" }));

    expect(await screen.findByText("Example_20260722_100200_release.apk")).toBeInTheDocument();
    expect(screen.getByText("Example_20260721_100200_debug.apk")).toBeInTheDocument();
    expect(screen.queryByText("Example_20260720_100200_debug.apk")).not.toBeInTheDocument();
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();
    expect(screen.queryByText("构建时间")).not.toBeInTheDocument();
  });

  it("uses the configured model to generate a preview-only AI ActionPlan", async () => {
    const { getAiPlanRequests, getLastAiPlanRequest } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "AI" }));
    expect(await screen.findByRole("combobox", { name: "选择 AI 模型" })).toHaveValue("test-model");
    const projectButton = screen.getByRole("button", { name: "Example" });
    expect(projectButton.querySelector(".lucide-folder")).not.toBeNull();
    expect(document.querySelector(".ai-test-project-title")).toBeNull();
    expect(
      screen.queryByText("com.example.app", { selector: ".ai-test-project-list small" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "测试应用包名" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "当前测试设备" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "项目 AI 会话" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "测试目标" }), "验证首页可见");
    await user.click(screen.getByRole("button", { name: "生成操作计划" }));

    await vi.waitFor(() => expect(getAiPlanRequests()).toBe(1));
    expect(getLastAiPlanRequest()).toMatchObject({
      appId: "com.example.app",
      conversationId: "723e4567-e89b-12d3-a456-426614174000",
    });
    expect(await screen.findByText("已生成首页可见性检查计划。")).toBeInTheDocument();
    expect(document.querySelector(".ai-test-message header")).toBeNull();
    expect(screen.queryByText("查看计划")).not.toBeInTheDocument();
    const messageTimes = [...document.querySelectorAll<HTMLTimeElement>(".ai-test-message-time")];
    expect(messageTimes).toHaveLength(2);
    expect(
      messageTimes.every((messageTime) => messageTime.dateTime === aiPlanResponse.generatedAt),
    ).toBe(true);
    expect(
      document.querySelector(".ai-test-message.assistant .ai-test-message-time"),
    ).not.toBeNull();
    expect(screen.queryByRole("status", { name: "AI 正在思考" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "当前计划" })).toBeInTheDocument();
    expect(screen.getByText("assert.visible")).toBeInTheDocument();
    expect(screen.getByText("执行前必须确认")).toBeInTheDocument();
  });

  it("shows a loading indicator on AI projects with a running test task", async () => {
    mockApis({ testRuns: [testExecutionRunResponse] });
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "AI" }));
    expect(await screen.findByRole("status", { name: "Example 测试正在执行" })).toBeInTheDocument();
  });

  it("sends an AI test goal when Enter is pressed in the composer", async () => {
    const { getAiPlanRequests, getLastAiPlanRequest } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "AI" }));
    await user.type(screen.getByRole("textbox", { name: "测试目标" }), "验证首页可见");
    await user.keyboard("{Enter}");

    await vi.waitFor(() => expect(getAiPlanRequests()).toBe(1));
    expect(getLastAiPlanRequest()).toMatchObject({ goal: "验证首页可见" });
  });

  it("shows the submitted message and thinking state before the AI reply arrives", async () => {
    const { getAiPlanRequests, getAiPlanAbortRequests } = mockApis({ delayAiPlan: true });
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "AI" }));
    await user.type(screen.getByRole("textbox", { name: "测试目标" }), "验证搜索结果");
    await user.click(screen.getByRole("button", { name: "生成操作计划" }));

    expect(await screen.findByText("验证搜索结果")).toBeInTheDocument();
    expect(await screen.findByRole("status", { name: "AI 正在思考" })).toHaveTextContent(
      "已处理 0s",
    );
    expect(getAiPlanRequests()).toBe(1);

    await user.click(screen.getByRole("button", { name: "停止生成" }));
    await vi.waitFor(() => expect(getAiPlanAbortRequests()).toBe(1));
    expect(screen.queryByRole("status", { name: "AI 正在思考" })).not.toBeInTheDocument();
  });

  it("stops an in-progress AI reply from the circular composer button", async () => {
    const { getAiPlanAbortRequests, getAiPlanRequests } = mockApis({ delayAiPlan: true });
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "AI" }));
    await user.type(screen.getByRole("textbox", { name: "测试目标" }), "验证首页可见");
    await user.click(screen.getByRole("button", { name: "生成操作计划" }));

    expect(await screen.findByRole("button", { name: "停止生成" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "停止生成" }));

    await vi.waitFor(() => expect(getAiPlanAbortRequests()).toBe(1));
    expect(getAiPlanRequests()).toBe(1);
    expect(await screen.findByRole("button", { name: "生成操作计划" })).toBeEnabled();
  });

  it("starts an approved AI plan only after explicit confirmation", async () => {
    const { getLastTestExecutionRequest, getTestExecutionRequests } = mockApis();
    const user = userEvent.setup();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    renderApp();

    await user.click(await screen.findByRole("button", { name: "AI" }));
    await user.type(screen.getByRole("textbox", { name: "测试目标" }), "验证首页可见");
    await user.click(screen.getByRole("button", { name: "生成操作计划" }));
    await screen.findByRole("heading", { level: 2, name: "当前计划" });
    await user.click(screen.getByRole("button", { name: "执行计划" }));

    await vi.waitFor(() => expect(getTestExecutionRequests()).toBe(1));
    expect(getLastTestExecutionRequest()).toMatchObject({
      deviceSerial: "8B3Y0THX0",
      appId: "com.example.app",
      approved: true,
      plan: { id: aiPlanResponse.plan.id },
    });
    expect(screen.getByRole("region", { name: "AI 会话" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "最近测试运行" })).toBeInTheDocument();
    const execution = await screen.findByRole("region", { name: "当前测试执行" });
    expect(within(execution).getByText("assert.visible")).toBeInTheDocument();
    expect(within(execution).getByText("等待中")).toBeInTheDocument();
  });

  it("saves a completed AI exploration and starts its local DSL regression without a new AI request", async () => {
    const {
      getAiPlanRequests,
      getExplorationSaveRequests,
      getLastTestSuiteRunRequest,
      getTestSuiteRunRequests,
    } = mockApis({
      aiPlan: aiExplorationPlanResponse,
      testRuns: [completedAiExplorationRun],
    });
    const user = userEvent.setup();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    renderApp();

    await user.click(await screen.findByRole("button", { name: "AI" }));
    await user.type(screen.getByRole("textbox", { name: "测试目标" }), "验证启动进入首页");
    await user.click(screen.getByRole("button", { name: "生成操作计划" }));
    await screen.findByRole("heading", { level: 2, name: "当前计划" });
    await user.click(screen.getByRole("button", { name: "保存为 DSL 用例" }));

    await vi.waitFor(() => expect(getExplorationSaveRequests()).toBe(1));
    expect(await screen.findByText(/后续执行仅使用本地 DSL，不会调用 AI/u)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "本地回归" }));

    await vi.waitFor(() => expect(getTestSuiteRunRequests()).toBe(1));
    expect(getLastTestSuiteRunRequest()).toEqual({ deviceSerial: "8B3Y0THX0", approved: true });
    expect(getAiPlanRequests()).toBe(1);
  });

  it("binds legacy AI app actions to the selected testing application before execution", async () => {
    const foreignApplicationPlan = {
      ...aiPlanResponse,
      plan: {
        ...aiPlanResponse.plan,
        actions: [{ action: "app.launch" as const, appId: "com.tracker.anywhere" }],
      },
    };
    const { getLastTestExecutionRequest, getTestExecutionRequests } = mockApis({
      aiPlan: foreignApplicationPlan,
    });
    const user = userEvent.setup();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    renderApp();

    await user.click(await screen.findByRole("button", { name: "AI" }));
    await user.type(screen.getByRole("textbox", { name: "测试目标" }), "验证启动流程");
    await user.click(screen.getByRole("button", { name: "生成操作计划" }));
    await screen.findByRole("heading", { level: 2, name: "当前计划" });
    expect(screen.getByText("com.example.app", { selector: "code" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "执行计划" }));

    await vi.waitFor(() => expect(getTestExecutionRequests()).toBe(1));
    expect(getLastTestExecutionRequest()).toMatchObject({
      appId: "com.example.app",
      plan: { actions: [{ action: "app.launch", appId: "com.example.app" }] },
    });
  });

  it("keeps AI chat in autonomous mode when an authorized workspace plan is returned", async () => {
    const workspacePlan: AiPlanResponse = {
      ...aiPlanResponse,
      plan: {
        ...aiPlanResponse.plan,
        workspaceExecution: true,
        requiresApproval: false,
        actions: [{ action: "app.uninstall", appId: "com.example.other", keepData: false }],
      },
      policy: {
        ...aiPlanResponse.policy,
        requiresApproval: false,
        reason: "工作区操作已按当前会话授权执行。",
      },
    };
    const {
      getAiPlanRequests,
      getLastAiPlanRequest,
      getLastWorkspaceExecutionRequest,
      getWorkspaceExecutionRequests,
    } = mockApis({ aiPlan: workspacePlan });
    const user = userEvent.setup();
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    renderApp();

    await user.click(await screen.findByRole("button", { name: "AI" }));
    expect(screen.queryByRole("menu", { name: "测试方案" })).not.toBeInTheDocument();
    expect(screen.queryByText("方案")).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "测试目标" }), "卸载旧应用");
    await user.click(screen.getByRole("button", { name: "生成操作计划" }));

    await vi.waitFor(() => expect(getAiPlanRequests()).toBe(1));
    expect(getLastAiPlanRequest()).toMatchObject({
      liveUiExecution: true,
      workspaceExecution: false,
    });
    await vi.waitFor(() => expect(getWorkspaceExecutionRequests()).toBe(1));
    expect(getLastWorkspaceExecutionRequest()).toMatchObject({
      deviceSerial: "8B3Y0THX0",
      plan: { actions: [{ action: "app.uninstall", appId: "com.example.other" }] },
    });
    expect(confirm).not.toHaveBeenCalled();
    const execution = await screen.findByRole("region", { name: "测试执行结果" });
    expect(within(execution).getByText("卸载应用")).toBeInTheDocument();
    expect(within(execution).getAllByText("通过")).toHaveLength(2);
    expect(await screen.findByText("工作区操作完成：1 个动作。")).toBeInTheDocument();
  });

  it("shows complete test-run details in the AI workspace", async () => {
    const completedRun = {
      ...testExecutionRunResponse,
      status: "failed",
      finishedAt: "2026-07-23T10:03:00.000Z",
      message: "首页未出现。",
      steps: [
        {
          index: 0,
          action: { action: "assert.visible", target: { text: "首页" } },
          status: "failed",
          message: "找不到文本：首页",
          screenshotAvailable: true,
        },
      ],
    };
    mockApis({ testRuns: [completedRun] });
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "AI" }));
    await user.type(screen.getByRole("textbox", { name: "测试目标" }), "验证首页可见");
    await user.click(screen.getByRole("button", { name: "生成操作计划" }));
    const result = await screen.findByRole("region", { name: "测试执行结果" });
    expect(within(result).getByText("首页未出现。")).toBeInTheDocument();
    expect(within(result).getByText("找不到文本：首页")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "查看 首页可见性检查 的运行详情" }));

    const dialog = await screen.findByRole("dialog", { name: "测试运行详情" });
    expect(within(dialog).getByText("首页未出现。")).toBeInTheDocument();
    expect(within(dialog).getByText("找不到文本：首页")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "查看报告" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "查看步骤截图" }));
    expect(within(dialog).getByAltText("步骤 1 的设备截图")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog", { name: "测试运行详情" })).not.toBeInTheDocument();
  });

  it("imports a DSL suite and starts its selected case only after confirmation", async () => {
    const { getLastTestSuiteRunRequest, getTestSuiteImportRequests, getTestSuiteRunRequests } =
      mockApis();
    const user = userEvent.setup();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    renderApp();

    await user.click(await screen.findByRole("button", { name: "AI" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "DSL 测试用例" }),
    ).toBeInTheDocument();

    await user.upload(
      screen.getByLabelText("导入 DSL 文件"),
      new File(["schemaVersion: 1"], "smoke.yaml", { type: "application/yaml" }),
    );
    await vi.waitFor(() => expect(getTestSuiteImportRequests()).toBe(1));
    expect(await screen.findByText("示例冒烟测试")).toBeInTheDocument();
    expect(screen.getByText("启动后显示首页")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "执行" }));
    await vi.waitFor(() => expect(getTestSuiteRunRequests()).toBe(1));
    expect(getLastTestSuiteRunRequest()).toEqual({ deviceSerial: "8B3Y0THX0", approved: true });
  });

  it("fetches, selects, and tests an OpenAI-compatible model before enabling AI plans", async () => {
    const { getAiConfigurationTestRequests, getAiModelListRequests } = mockApis({
      aiModelStatus: {
        configured: false,
        provider: "openai-compatible",
        reason: "请先配置本地 AI 服务。",
      },
    });
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "AI" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "连接 OpenAI 兼容服务" }),
    ).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Base URL" }), "https://model.example/v1");
    await user.type(screen.getByLabelText("API Key"), "test-key");
    await user.click(screen.getByRole("button", { name: "拉取模型" }));

    await vi.waitFor(() => expect(getAiModelListRequests()).toBe(1));
    expect(screen.getByRole("option", { name: "gpt-4.1-mini" })).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "AI 模型" }), "gpt-4.1");
    await user.click(
      screen.getByRole("checkbox", {
        name: "我理解：生成操作计划时，测试目标、项目模块和源码索引证据会发送至所配置的 AI 服务。",
      }),
    );
    await user.click(screen.getByRole("button", { name: "测试并应用配置" }));

    await vi.waitFor(() => expect(getAiConfigurationTestRequests()).toBe(1));
    expect(await screen.findByRole("combobox", { name: "选择 AI 模型" })).toHaveValue("gpt-4.1");
    expect(screen.getByRole("region", { name: "AI 会话" })).toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
  });

  it("switches an already configured model without asking the user to re-enter its API key", async () => {
    const { getAiConfigurationTestRequests, getAiModelListRequests } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "AI" }));
    await vi.waitFor(() => expect(getAiModelListRequests()).toBe(1));
    await user.click(await screen.findByRole("button", { name: "更换模型" }));
    expect(screen.getByRole("textbox", { name: "Base URL" })).toHaveValue(
      "https://model.example/v1",
    );
    expect(screen.getByLabelText("API Key")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "拉取模型" }));
    await vi.waitFor(() => expect(getAiModelListRequests()).toBe(2));
    await user.selectOptions(screen.getByRole("combobox", { name: "AI 模型" }), "gpt-4.1");
    await user.click(screen.getByRole("button", { name: "测试并应用配置" }));

    await vi.waitFor(() => expect(getAiConfigurationTestRequests()).toBe(1));
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(await screen.findByRole("combobox", { name: "选择 AI 模型" })).toHaveValue("gpt-4.1");
  });

  it("selects an existing model from the AI workspace without exposing the provider name", async () => {
    const { getAiConfigurationTestRequests, getAiModelListRequests } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "AI" }));
    const modelSelector = await screen.findByRole("combobox", { name: "选择 AI 模型" });
    await vi.waitFor(() => expect(getAiModelListRequests()).toBe(1));

    expect(screen.queryByText("openai-compatible")).not.toBeInTheDocument();
    await user.selectOptions(modelSelector, "gpt-4.1");

    await vi.waitFor(() => expect(getAiConfigurationTestRequests()).toBe(1));
    expect(modelSelector).toHaveValue("gpt-4.1");
    expect(screen.getByRole("button", { name: "更换模型" })).toBeInTheDocument();
  });

  it("opens device files from the default file manager tab", async () => {
    mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "文件管理器" }));
    expect(screen.getByRole("heading", { level: 1, name: "文件管理器" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /内部共享存储空间/ }));

    expect(await screen.findByRole("button", { name: /Download/ })).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "下载 notes.txt" })).toHaveAttribute(
      "href",
      "/api/v1/devices/8B3Y0THX0/files/download?path=%2Fstorage%2Femulated%2F0%2Fnotes.txt",
    );
  });

  it("confirms and uploads a file to the current device directory", async () => {
    const { getFileUploadRequests } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "文件管理器" }));
    await user.click(screen.getByRole("button", { name: /内部共享存储空间/ }));
    await screen.findByText("notes.txt");
    await user.click(screen.getByRole("button", { name: "上传文件" }));
    await user.upload(
      screen.getByLabelText("选择要上传的文件"),
      new File(["device file"], "upload.txt", { type: "text/plain" }),
    );

    const dialog = await screen.findByRole("dialog", { name: "上传文件" });
    expect(within(dialog).getByText("/storage/emulated/0")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "确认上传" }));

    expect(await within(dialog).findByText("上传完成")).toBeInTheDocument();
    expect(getFileUploadRequests()).toBe(1);
  });

  it("adds the device Logcat view and filters actual log entries", async () => {
    mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "添加工作页签" }));
    await user.click(screen.getByRole("button", { name: "设备日志" }));

    expect(await screen.findByRole("heading", { level: 1, name: "设备日志" })).toBeInTheDocument();
    expect(await screen.findByText("Displayed com.example.app")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "筛选日志级别" }), "error");

    expect(screen.queryByText("Displayed com.example.app")).not.toBeInTheDocument();
    expect(screen.getByText("FATAL EXCEPTION")).toBeInTheDocument();
  });

  it("filters applications and sends only structured app actions", async () => {
    const { getActionRequests, getLastAction } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "应用管理器" }));
    expect(await screen.findByText("com.example.app")).toBeInTheDocument();
    const applicationIcon = screen.getByRole("img", { name: "app 图标" });
    expect(applicationIcon).toHaveAttribute(
      "src",
      "/api/v1/devices/8B3Y0THX0/applications/com.example.app/icon",
    );
    expect(screen.getByText(/版本 2\.5\.16/u)).toBeInTheDocument();
    expect(screen.getByText("88 MB")).toBeInTheDocument();
    expect(screen.getByText("2026年7月22日")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "搜索应用包名" }), "settings");
    expect(screen.queryByText("com.example.app")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "启动 com.android.settings" }));
    await vi.waitFor(() => expect(getActionRequests()).toBe(1));
    expect(getLastAction()).toEqual({ action: "app.launch", appId: "com.android.settings" });
  });

  it("uploads and installs an APK from the application manager", async () => {
    const { getInstallRequests } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "应用管理器" }));
    await user.click(screen.getByRole("button", { name: "安装 APK" }));
    await user.upload(
      screen.getByLabelText("APK 文件"),
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "sample.apk", {
        type: "application/vnd.android.package-archive",
      }),
    );

    const dialog = await screen.findByRole("dialog", { name: "安装 APK" });
    expect(within(dialog).getByText("com.example.app")).toBeInTheDocument();
    expect(within(dialog).getByText("Pixel 3 XL")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "安装" }));

    expect(await within(dialog).findByText("安装完成")).toBeInTheDocument();
    expect(getInstallRequests()).toBe(1);
  });

  it("accepts an APK dropped on the live device screen", async () => {
    mockApis();
    renderApp();

    const canvas = await screen.findByRole("img", { name: "设备实时画面：Pixel 3 XL" });
    const frame = canvas.parentElement;
    expect(frame).not.toBeNull();
    const file = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "sample.apk", {
      type: "application/vnd.android.package-archive",
    });
    const dataTransfer = {
      types: ["Files"],
      files: { item: (index: number) => (index === 0 ? file : null) },
    };

    fireEvent.dragEnter(frame as HTMLDivElement, { dataTransfer });
    expect(screen.getByText("释放以安装 APK")).toBeInTheDocument();
    fireEvent.drop(frame as HTMLDivElement, { dataTransfer });

    expect(await screen.findByRole("dialog", { name: "安装 APK" })).toBeInTheDocument();
  });

  it("attaches an arbitrary uploaded APK to an AI plan request", async () => {
    const { getLastAiPlanRequest } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "AI" }));
    const goal = await screen.findByRole("textbox", { name: "测试目标" });
    const apkInput = document.querySelector<HTMLInputElement>(".ai-test-apk-input");
    expect(apkInput).not.toBeNull();
    await user.upload(
      apkInput!,
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "any-application.apk", {
        type: "application/vnd.android.package-archive",
      }),
    );
    expect(await screen.findByText("sample.apk")).toBeInTheDocument();
    await user.type(goal, "安装 APK 后验证应用启动");
    await user.keyboard("{Enter}");

    await vi.waitFor(() =>
      expect(getLastAiPlanRequest()).toMatchObject({
        installableArtifactIds: [apkArtifactResponse.id],
      }),
    );
  });

  it("shows a real authorized Android device in the selector", async () => {
    mockApis();
    renderApp();

    const selector = await screen.findByRole("combobox", { name: "当前设备" });
    await vi.waitFor(() => expect(selector).toHaveValue("8B3Y0THX0"));
    expect(within(selector).getByRole("option", { name: "Pixel 3 XL" })).toBeInTheDocument();
    expect(screen.getAllByText("8B3Y0THX0")).toHaveLength(1);
    expect(screen.getByText("USB")).toBeInTheDocument();
  });

  it("connects the selected device mirror through a scrcpy WebSocket", async () => {
    mockApis();
    renderApp();

    await screen.findByRole("heading", { level: 1, name: "概览" });
    expect(
      await screen.findByRole("img", { name: "设备实时画面：Pixel 3 XL" }),
    ).toBeInTheDocument();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]?.url).toContain("/api/v1/devices/8B3Y0THX0/scrcpy/stream");
    expect(screen.queryByAltText("设备截图：Pixel 3 XL")).not.toBeInTheDocument();
  });

  it("automatically reconnects a closed device stream with backoff", async () => {
    mockApis();
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "概览" });
    const canvas = await screen.findByRole("img", { name: "设备实时画面：Pixel 3 XL" });
    await vi.waitFor(() => expect(canvas).toHaveAttribute("aria-busy", "false"));
    const firstSocket = MockWebSocket.instances[0];
    expect(firstSocket).toBeDefined();

    vi.useFakeTimers();
    try {
      firstSocket?.onclose?.();
      expect(canvas).toHaveAttribute("aria-busy", "false");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(749);
      });
      expect(MockWebSocket.instances).toHaveLength(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(MockWebSocket.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects the device stream when a backgrounded page becomes visible again", async () => {
    mockApis();
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "概览" });
    await screen.findByRole("img", { name: "设备实时画面：Pixel 3 XL" });
    const firstSocket = MockWebSocket.instances[0];
    expect(firstSocket).toBeDefined();

    vi.useFakeTimers();
    try {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      firstSocket!.readyState = 3;
      firstSocket?.onclose?.();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(MockWebSocket.instances).toHaveLength(1);

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(MockWebSocket.instances).toHaveLength(2);
    } finally {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      vi.useRealTimers();
    }
  });

  it("keeps a healthy device stream when the page regains focus", async () => {
    mockApis();
    renderApp();
    await screen.findByRole("heading", { level: 1, name: "概览" });
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.useFakeTimers();
    try {
      globalThis.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(MockWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the selected device mirror and collapsed evidence controls", async () => {
    mockApis();
    renderApp();

    expect(await screen.findByRole("region", { name: "屏幕镜像" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "设备实时画面：Pixel 3 XL" })).toBeInTheDocument();
    expect(screen.getByText("设备控制")).toBeInTheDocument();
    expect(screen.getByText("UI 层级与操作审计")).toBeInTheDocument();
  });

  it("shows device quick controls by default and can collapse them", async () => {
    mockApis();
    const user = userEvent.setup();
    renderApp();

    const mirror = await screen.findByRole("region", { name: "屏幕镜像" });
    expect(within(mirror).getByRole("button", { name: "主页" })).toBeInTheDocument();
    expect(within(mirror).getByRole("button", { name: "返回" })).toBeInTheDocument();
    expect(within(mirror).getByRole("button", { name: "最近任务" })).toBeInTheDocument();
    expect(within(mirror).getByRole("button", { name: "音量增加" })).toBeInTheDocument();
    expect(within(mirror).getByRole("button", { name: "音量减小" })).toBeInTheDocument();
    expect(within(mirror).getByRole("button", { name: "电源（亮屏或息屏）" })).toBeInTheDocument();

    await user.click(within(mirror).getByRole("button", { name: "主页" }));
    await vi.waitFor(() =>
      expect(MockWebSocket.instances[0]?.sent).toContain('{"type":"key","key":"home"}'),
    );

    await user.click(within(mirror).getByRole("button", { name: "电源（亮屏或息屏）" }));
    await vi.waitFor(() =>
      expect(MockWebSocket.instances[0]?.sent).toContain('{"type":"key","key":"power"}'),
    );

    await user.click(within(mirror).getByRole("button", { name: "收起快捷操作" }));
    expect(within(mirror).queryByRole("button", { name: "主页" })).not.toBeInTheDocument();
    expect(within(mirror).getByRole("button", { name: "展开快捷操作" })).toBeInTheDocument();

    await user.click(within(mirror).getByRole("button", { name: "展开快捷操作" }));
    expect(within(mirror).getByRole("button", { name: "主页" })).toBeInTheDocument();
  });

  it("resizes the mirror area without exceeding the golden-ratio width", async () => {
    mockApis();
    renderApp();

    const divider = await screen.findByRole("separator", { name: "调整左右区域宽度" });
    const layout = divider.parentElement;
    expect(layout).not.toBeNull();
    vi.spyOn(layout as HTMLDivElement, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 1_000,
      height: 700,
      top: 0,
      right: 1_000,
      bottom: 700,
      left: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(divider, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(divider, { clientX: 800, pointerId: 1 });

    const shell = layout?.parentElement;
    expect(shell?.style.getPropertyValue("--device-sidebar-width")).toBe("382px");

    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(shell?.style.getPropertyValue("--device-sidebar-width")).toBe("366px");
    expect(globalThis.localStorage.getItem("device-robot:mirror-width:8B3Y0THX0")).toBe("366");
    expect(globalThis.localStorage.getItem("device-robot:mirror-width:last")).toBe("366");
  });

  it("maps a mirror click to immediate scrcpy pointer messages", async () => {
    const { getActionRequests } = mockApis();
    renderApp();

    await screen.findByRole("heading", { level: 1, name: "概览" });
    const canvas = await screen.findByRole("img", { name: "设备实时画面：Pixel 3 XL" });
    await vi.waitFor(() => expect(canvas).toHaveProperty("width", 1080));
    await vi.waitFor(() => expect(canvas).toHaveAttribute("aria-busy", "false"));
    Object.defineProperty(canvas, "setPointerCapture", { configurable: true, value: vi.fn() });
    Object.defineProperty(canvas, "hasPointerCapture", {
      configurable: true,
      value: vi.fn().mockReturnValue(true),
    });
    Object.defineProperty(canvas, "releasePointerCapture", {
      configurable: true,
      value: vi.fn(),
    });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      width: 180,
      height: 360,
      top: 0,
      right: 180,
      bottom: 360,
      left: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(canvas, { button: 0, clientX: 90, clientY: 180, pointerId: 1 });
    fireEvent.pointerUp(canvas, { button: 0, clientX: 90, clientY: 180, pointerId: 1 });

    await vi.waitFor(() => expect(MockWebSocket.instances[0]?.sent).toHaveLength(2));
    expect(MockWebSocket.instances[0]?.sent.map((message) => JSON.parse(message))).toEqual([
      {
        type: "pointer",
        action: "down",
        pointerId: 1,
        x: 540,
        y: 1080,
        videoWidth: 1080,
        videoHeight: 2160,
      },
      {
        type: "pointer",
        action: "up",
        pointerId: 1,
        x: 540,
        y: 1080,
        videoWidth: 1080,
        videoHeight: 2160,
      },
    ]);
    expect(getActionRequests()).toBe(0);
  });

  it("sends a structured back action from the device control accordion", async () => {
    const { getActionRequests } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole("heading", { level: 1, name: "概览" });
    const deviceControl = screen.getByText("设备控制").closest("details");
    expect(deviceControl).not.toBeNull();
    await user.click(within(deviceControl as HTMLDetailsElement).getByText("设备控制"));
    await user.click(
      within(deviceControl as HTMLDetailsElement).getByRole("button", { name: "返回" }),
    );

    await vi.waitFor(() => expect(getActionRequests()).toBe(1));
    expect(await screen.findByText("完成")).toBeInTheDocument();
  });
});
