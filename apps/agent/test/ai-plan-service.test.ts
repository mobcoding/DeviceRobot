import type { AgentAction, AiModelStatus, AndroidProject } from "@device-robot/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  AiPlanError,
  LocalAiPlanService,
  OpenAiCompatiblePlanProvider,
  type AiPlanModelProvider,
} from "../src/ai/ai-plan-service.js";
import type { ProjectStore } from "../src/projects/project-store.js";

class InMemoryProjectStore implements ProjectStore {
  public constructor(private readonly project: AndroidProject) {}

  public list(): AndroidProject[] {
    return [this.project];
  }

  public findById(id: string): AndroidProject | undefined {
    return id === this.project.id ? this.project : undefined;
  }

  public findByRootPath(rootPath: string): AndroidProject | undefined {
    return rootPath === this.project.rootPath ? this.project : undefined;
  }

  public create(): void {}

  public updateSourceIndex(): void {}
}

class FakeModelProvider implements AiPlanModelProvider {
  public system = "";
  public user = "";

  public constructor(
    private readonly payload: { reply: string; actions: AgentAction[] },
    private readonly modelStatus: AiModelStatus = {
      configured: true,
      provider: "openai-compatible",
      baseUrl: "https://model.example/v1",
      model: "test-model",
    },
  ) {}

  public status(): AiModelStatus {
    return this.modelStatus;
  }

  public async createPlan(input: { system: string; user: string }): Promise<{
    reply: string;
    actions: AgentAction[];
  }> {
    this.system = input.system;
    this.user = input.user;
    return this.payload;
  }
}

function createProject(): AndroidProject {
  return {
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
        packageName: "com.example.app",
        variants: ["debug", "release"],
      },
    ],
    sourceIndex: {
      schemaVersion: 1,
      scannedAt: "2026-07-21T10:00:00.000Z",
      summary: {
        filesScanned: 1,
        kotlinJavaFileCount: 1,
        xmlViewCount: 0,
        composeScreenCount: 1,
        navigationDestinationCount: 0,
        typeCount: 0,
      },
      modules: [
        {
          path: "app",
          sourceFileCount: 1,
          xmlViewCount: 0,
          composeScreenCount: 1,
          navigationDestinationCount: 0,
          typeCount: 0,
        },
      ],
      evidence: [
        {
          kind: "compose-screen",
          name: "HomeScreen",
          filePath: "app/src/main/java/com/example/app/HomeScreen.kt",
          line: 10,
          modulePath: "app",
        },
      ],
    },
    createdAt: "2026-07-21T10:00:00.000Z",
    updatedAt: "2026-07-21T10:00:00.000Z",
  };
}

describe("AI action plan service", () => {
  it("uses bounded source-index evidence and forces generated plans into preview approval", async () => {
    const provider = new FakeModelProvider({
      reply: "将先确认首页已显示，再保留截图作为证据。",
      actions: [
        { action: "assert.visible", target: { text: "首页" } },
        { action: "device.screenshot", name: "home" },
      ],
    });
    const project = createProject();
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(project),
      modelProvider: provider,
    });

    const response = await service.generate({
      projectId: project.id,
      deviceSerial: "device-1",
      goal: "验证首页可以打开",
    });

    expect(response).toMatchObject({
      reply: "将先确认首页已显示，再保留截图作为证据。",
      plan: {
        projectId: project.id,
        deviceSerial: "device-1",
        requiresApproval: true,
        actions: [{ action: "assert.visible" }, { action: "device.screenshot" }],
      },
      policy: { allowed: true, requiresApproval: true },
      context: {
        sourceIndexAvailable: true,
        evidence: [expect.objectContaining({ name: "HomeScreen", line: 10 })],
      },
    });
    expect(provider.system).toContain("严禁输出 adb.shell");
    expect(provider.user).toContain("HomeScreen");
    expect(provider.user).toContain("验证首页可以打开");
  });

  it("rejects raw ADB and APK installation actions even if a model returns them", async () => {
    const project = createProject();
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(project),
      modelProvider: new FakeModelProvider({
        reply: "不安全的计划",
        actions: [{ action: "adb.shell", command: "shell", args: ["getprop"] }],
      }),
    });

    await expect(
      service.generate({ projectId: project.id, goal: "获取设备信息" }),
    ).rejects.toMatchObject({
      statusCode: 422,
    });
  });

  it("does not contact a model when it is not configured", async () => {
    const project = createProject();
    const provider = new FakeModelProvider(
      { reply: "不会被调用", actions: [{ action: "ui.wait", durationMs: 500 }] },
      {
        configured: false,
        provider: "openai-compatible",
        reason: "模型尚未配置。",
      },
    );
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(project),
      modelProvider: provider,
    });

    await expect(
      service.generate({ projectId: project.id, goal: "生成计划" }),
    ).rejects.toBeInstanceOf(AiPlanError);
    expect(provider.system).toBe("");
  });

  it("lists models and applies a tested local configuration without exposing its API key", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      void _init;
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: null,
                reasoning_content: "正在推理",
              },
              finish_reason: "length",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(createProject()),
    });

    try {
      await expect(
        service.listModels({ baseUrl: "https://model.example/v1", apiKey: "test-key" }),
      ).resolves.toEqual({ provider: "openai-compatible", models: ["model-a", "model-b"] });
      await expect(
        service.testConfiguration({
          baseUrl: "https://model.example/v1",
          apiKey: "test-key",
          model: "model-a",
        }),
      ).resolves.toMatchObject({
        provider: "openai-compatible",
        baseUrl: "https://model.example/v1",
        model: "model-a",
      });
      await expect(service.status()).resolves.toMatchObject({
        configured: true,
        baseUrl: "https://model.example/v1",
        model: "model-a",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      });
      expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
        max_tokens: 256,
        model: "model-a",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("repairs one invalid model plan and accepts JSON wrapped in explanatory text", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      void _url;
      void _init;
      if (fetchMock.mock.calls.length === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '计划草稿：\n```json\n{"reply":"验证启动流程。","actions":[{"action":"navigate","to":"主页"}]}\n```',
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '已修正：\n```json\n{"reply":"等待启动流程稳定并保留截图证据。","actions":[{"action":"ui.wait","durationMs":1500},{"action":"device.screenshot","name":"启动页"}]}\n```',
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(createProject()),
      modelProvider: new OpenAiCompatiblePlanProvider({
        baseUrl: "https://model.example/v1",
        apiKey: "test-key",
        model: "test-model",
      }),
    });

    try {
      await expect(
        service.generate({
          projectId: "123e4567-e89b-12d3-a456-426614174000",
          goal: "验证启动页进入主页的流程",
        }),
      ).resolves.toMatchObject({
        reply: "等待启动流程稳定并保留截图证据。",
        plan: {
          actions: [{ action: "ui.wait", durationMs: 1500 }, { action: "device.screenshot" }],
        },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        max_tokens: 2048,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
