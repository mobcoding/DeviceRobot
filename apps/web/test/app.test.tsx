import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      versionCode: "42",
    },
    {
      packageName: "com.android.settings",
      source: "system",
      apkPath: "/system/priv-app/Settings/Settings.apk",
      versionCode: "33",
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
  message: "构建完成，发现 1 个 APK 输出。",
  exitCode: 0,
  finishedAt: "2026-07-21T10:02:00.000Z",
};

const aiModelStatusResponse = {
  configured: true,
  provider: "openai-compatible",
  baseUrl: "https://model.example/v1",
  model: "test-model",
};

const aiPlanResponse = {
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
    completedProjectBuild?: boolean;
  } = {},
): {
  getDeviceRequests: () => number;
  getActionRequests: () => number;
  getLastAction: () => unknown;
  getInstallRequests: () => number;
  getFileUploadRequests: () => number;
  getProjectCreateRequests: () => number;
  getProjectReindexRequests: () => number;
  getProjectBuildRequests: () => number;
  getProjectArtifactInstallRequests: () => number;
  getAiPlanRequests: () => number;
  getAiModelListRequests: () => number;
  getAiConfigurationTestRequests: () => number;
  getTestExecutionRequests: () => number;
  getLastTestExecutionRequest: () => unknown;
} {
  let deviceRequests = 0;
  let actionRequests = 0;
  let lastAction: unknown;
  let installRequests = 0;
  let fileUploadRequests = 0;
  let projectCreateRequests = 0;
  let projectReindexRequests = 0;
  let projectSourceIndexed = false;
  let projectBuildRequests = 0;
  let projectBuildStarted = options.completedProjectBuild ?? false;
  let currentProjectBuildRun = runningProjectBuildResponse;
  let projectArtifactInstallRequests = 0;
  let aiPlanRequests = 0;
  let aiModelListRequests = 0;
  let aiConfigurationTestRequests = 0;
  let testExecutionRequests = 0;
  let lastTestExecutionRequest: unknown;
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
        baseUrl: string;
        model: string;
      };
      currentAiModelStatus = {
        configured: true,
        provider: "openai-compatible",
        baseUrl: request.baseUrl,
        model: request.model,
      };
      return new Response(
        JSON.stringify({
          provider: "openai-compatible",
          baseUrl: request.baseUrl,
          model: request.model,
          message: "模型连接成功，已应用到当前本地 Agent。",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    if (url === "/api/v1/ai/plans" && method === "POST") {
      aiPlanRequests += 1;
      return new Response(JSON.stringify(aiPlanResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "/api/v1/test-runs") {
      if (method === "POST") {
        testExecutionRequests += 1;
        lastTestExecutionRequest = JSON.parse(String(init?.body ?? "{}"));
        return new Response(JSON.stringify(testExecutionRunResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ runs: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
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
            ? [
                options.completedProjectBuild
                  ? completedProjectBuildResponse
                  : currentProjectBuildRun,
              ]
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
                projects: [
                  projectSourceIndexed ? indexedProjectResponse : projectsResponse.projects[0],
                ],
              },
        ),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
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

    if (options.healthError !== undefined) {
      throw options.healthError;
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
    getProjectReindexRequests: () => projectReindexRequests,
    getProjectBuildRequests: () => projectBuildRequests,
    getProjectArtifactInstallRequests: () => projectArtifactInstallRequests,
    getAiPlanRequests: () => aiPlanRequests,
    getAiModelListRequests: () => aiModelListRequests,
    getAiConfigurationTestRequests: () => aiConfigurationTestRequests,
    getTestExecutionRequests: () => testExecutionRequests,
    getLastTestExecutionRequest: () => lastTestExecutionRequest,
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

  it("shows an actionable error when the Agent is unavailable", async () => {
    mockApis({ healthError: new Error("Connection refused") });
    renderApp();

    expect(await screen.findByRole("alert", {}, { timeout: 3_000 })).toHaveTextContent(
      "本地 Agent 不可用",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("无法连接本地 Agent");
  });

  it("adds a hidden workspace tab from the add-tab menu", async () => {
    mockApis();
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole("heading", { level: 1, name: "概览" });
    expect(screen.getByRole("button", { name: "文件管理器" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "应用管理器" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "项目" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "添加工作页签" }));
    await user.click(screen.getByRole("button", { name: "项目" }));

    expect(screen.getByRole("heading", { level: 1, name: "项目管理" })).toBeInTheDocument();
    expect(globalThis.location.hash).toBe("#projects");
    expect(screen.getByRole("button", { name: "项目" })).toBeInTheDocument();
    expect(await screen.findByText("Example")).toBeInTheDocument();
  });

  it("creates a project from the project-management form", async () => {
    const { getProjectCreateRequests } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "添加工作页签" }));
    await user.click(screen.getByRole("button", { name: "项目" }));
    await user.type(screen.getByRole("textbox", { name: "本地项目目录" }), "C:\\Github\\Example");
    await user.click(screen.getByRole("button", { name: "接入项目" }));

    await vi.waitFor(() => expect(getProjectCreateRequests()).toBe(1));
  });

  it("requires an explicit confirmation before starting a discovered Gradle Variant", async () => {
    const { getProjectBuildRequests } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "添加工作页签" }));
    await user.click(screen.getByRole("button", { name: "项目" }));
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
    expect(await screen.findByText("构建中")).toBeInTheDocument();
  });

  it("exports and installs an APK from a completed project build", async () => {
    const { getProjectArtifactInstallRequests } = mockApis({ completedProjectBuild: true });
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "添加工作页签" }));
    await user.click(screen.getByRole("button", { name: "项目" }));
    const output = await screen.findByText("app-debug.apk");
    const artifact = output.closest(".project-build-artifact");
    expect(artifact).not.toBeNull();
    expect(
      within(artifact as HTMLElement).getByRole("link", { name: "导出 app-debug.apk" }),
    ).toHaveAttribute(
      "href",
      `/api/v1/projects/${projectBuildTargetResponse.projectId}/builds/${completedProjectBuildResponse.id}/artifacts/0/download`,
    );

    await user.click(
      within(artifact as HTMLElement).getByRole("button", {
        name: "安装 app-debug.apk 到当前设备",
      }),
    );

    await vi.waitFor(() => expect(getProjectArtifactInstallRequests()).toBe(1));
    expect(
      await within(artifact as HTMLElement).findByText("已安装 com.example.app"),
    ).toBeInTheDocument();
  });

  it("uses the configured model to generate a preview-only AI ActionPlan", async () => {
    const { getAiPlanRequests } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "添加工作页签" }));
    await user.click(screen.getByRole("button", { name: "AI 与用例" }));
    expect(await screen.findByText("模型已配置")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "测试目标" }), "验证首页可见");
    await user.click(screen.getByRole("button", { name: "生成操作计划" }));

    await vi.waitFor(() => expect(getAiPlanRequests()).toBe(1));
    expect(await screen.findByText("已生成首页可见性检查计划。")).toBeInTheDocument();
    expect(screen.getByText("ActionPlan 预览")).toBeInTheDocument();
    expect(screen.getByText("assert.visible")).toBeInTheDocument();
    expect(screen.getByText("执行前必须确认")).toBeInTheDocument();
  });

  it("starts an approved AI plan only after explicit confirmation", async () => {
    const { getLastTestExecutionRequest, getTestExecutionRequests } = mockApis();
    const user = userEvent.setup();
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    renderApp();

    await user.click(await screen.findByRole("button", { name: "添加工作页签" }));
    await user.click(screen.getByRole("button", { name: "AI 与用例" }));
    await user.type(screen.getByRole("textbox", { name: "测试目标" }), "验证首页可见");
    await user.click(screen.getByRole("button", { name: "生成操作计划" }));
    await screen.findByText("ActionPlan 预览");
    await user.click(screen.getByRole("button", { name: "执行计划" }));

    await vi.waitFor(() => expect(getTestExecutionRequests()).toBe(1));
    expect(getLastTestExecutionRequest()).toMatchObject({
      deviceSerial: "8B3Y0THX0",
      appId: "com.example.app",
      approved: true,
      plan: { id: aiPlanResponse.plan.id },
    });
    expect(await screen.findByRole("heading", { level: 1, name: "测试运行" })).toBeInTheDocument();
  });

  it("shows the test run workspace from the tab menu", async () => {
    mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "添加工作页签" }));
    await user.click(screen.getByRole("button", { name: "测试运行" }));

    expect(await screen.findByRole("heading", { level: 1, name: "测试运行" })).toBeInTheDocument();
    expect(screen.getByText("暂无测试运行")).toBeInTheDocument();
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

    await user.click(await screen.findByRole("button", { name: "添加工作页签" }));
    await user.click(screen.getByRole("button", { name: "AI 与用例" }));
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
    expect(await screen.findByText("模型已配置")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "描述你想验证的测试目标" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
  });

  it("switches an already configured model without asking the user to re-enter its API key", async () => {
    const { getAiConfigurationTestRequests, getAiModelListRequests } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole("button", { name: "添加工作页签" }));
    await user.click(screen.getByRole("button", { name: "AI 与用例" }));
    await user.click(await screen.findByRole("button", { name: "更换模型" }));
    expect(screen.getByRole("textbox", { name: "Base URL" })).toHaveValue(
      "https://model.example/v1",
    );
    expect(screen.getByLabelText("API Key")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "拉取模型" }));
    await vi.waitFor(() => expect(getAiModelListRequests()).toBe(1));
    await user.selectOptions(screen.getByRole("combobox", { name: "AI 模型" }), "gpt-4.1");
    await user.click(screen.getByRole("button", { name: "测试并应用配置" }));

    await vi.waitFor(() => expect(getAiConfigurationTestRequests()).toBe(1));
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(await screen.findByText(/gpt-4\.1/)).toBeInTheDocument();
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
