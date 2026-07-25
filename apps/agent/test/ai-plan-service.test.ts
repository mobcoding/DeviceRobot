import type {
  AgentAction,
  AiContextSnapshot,
  AiConversation,
  AiModelStatus,
  AndroidProject,
} from "@device-robot/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  AiPlanError,
  LocalAiPlanService,
  OpenAiCompatiblePlanProvider,
  type AiPlanModelProvider,
} from "../src/ai/ai-plan-service.js";
import type { ProjectStore } from "../src/projects/project-store.js";
import type {
  AiConversationStore,
  AppendConversationMessage,
  CreateConversationRecord,
  StoredAiConversationMessage,
} from "../src/ai/ai-conversation-store.js";

class InMemoryProjectStore implements ProjectStore {
  readonly #projects: AndroidProject[];

  public constructor(projects: AndroidProject | AndroidProject[]) {
    this.#projects = Array.isArray(projects) ? projects : [projects];
  }

  public list(): AndroidProject[] {
    return this.#projects;
  }

  public findById(id: string): AndroidProject | undefined {
    return this.#projects.find((project) => project.id === id);
  }

  public findByRootPath(rootPath: string): AndroidProject | undefined {
    return this.#projects.find((project) => project.rootPath === rootPath);
  }

  public create(): void {}

  public delete(): void {}

  public updateName(): void {}

  public updateSourceIndex(): void {}
}

class InMemoryAiConversationStore implements AiConversationStore {
  readonly #conversations = new Map<string, AiConversation>();
  readonly #messages = new Map<string, StoredAiConversationMessage[]>();
  readonly #snapshots = new Map<string, AiContextSnapshot[]>();

  public listByProject(projectId: string): AiConversation[] {
    return [...this.#conversations.values()]
      .filter((conversation) => conversation.projectId === projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  public find(id: string): AiConversation | undefined {
    return this.#conversations.get(id);
  }

  public create(conversation: CreateConversationRecord): AiConversation {
    const created: AiConversation = { ...conversation, contextStatus: "current" };
    this.#conversations.set(created.id, created);
    return created;
  }

  public updateContext(
    id: string,
    values: Pick<AiConversation, "sourceRevision" | "updatedAt">,
  ): void {
    const conversation = this.#conversations.get(id);
    if (conversation === undefined) {
      return;
    }
    this.#conversations.set(id, {
      ...conversation,
      ...(values.sourceRevision === undefined ? {} : { sourceRevision: values.sourceRevision }),
      updatedAt: values.updatedAt,
    });
  }

  public listMessages(conversationId: string): StoredAiConversationMessage[] {
    return this.#messages.get(conversationId) ?? [];
  }

  public appendMessage(message: AppendConversationMessage): void {
    const messages = this.#messages.get(message.conversationId) ?? [];
    this.#messages.set(message.conversationId, [
      ...messages,
      {
        ...message,
        ...(message.planId === undefined ? {} : { planId: message.planId }),
      },
    ]);
  }

  public createSnapshot(snapshot: AiContextSnapshot): void {
    const snapshots = this.#snapshots.get(snapshot.conversationId) ?? [];
    this.#snapshots.set(snapshot.conversationId, [...snapshots, snapshot]);
  }

  public latestSnapshot(conversationId: string): AiContextSnapshot | undefined {
    return this.#snapshots.get(conversationId)?.at(-1);
  }
}

class InMemoryAiConfigurationStore {
  public configuration:
    | {
        provider: "openai-compatible";
        baseUrl: string;
        model: string;
        protectedApiKey: string;
        updatedAt: string;
      }
    | undefined;

  public load() {
    return this.configuration;
  }

  public save(configuration: NonNullable<InMemoryAiConfigurationStore["configuration"]>): void {
    this.configuration = configuration;
  }
}

class PrefixSecretProtector {
  public async protect(secret: string): Promise<string> {
    return `protected:${secret}`;
  }

  public async reveal(protectedSecret: string): Promise<string> {
    return protectedSecret.replace(/^protected:/u, "");
  }
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

  it("automatically treats a current project's APK installation as a workspace operation", async () => {
    const project = createProject();
    const buildId = "223e4567-e89b-12d3-a456-426614174000";
    const provider = new FakeModelProvider({
      reply: "不应调用模型。",
      actions: [{ action: "ui.wait", durationMs: 500 }],
    });
    const listRuns = vi.fn(async () => ({
      projectId: project.id,
      runs: [
        {
          id: buildId,
          projectId: project.id,
          modulePath: "app",
          variant: "debug",
          taskName: ":app:assembleDebug",
          status: "succeeded" as const,
          logPath: "C:\\logs\\build.log",
          artifactPaths: ["app/build/outputs/apk/debug/app-debug.apk"],
          artifactNames: ["Example_20260725_100000_debug.apk"],
          startedAt: "2026-07-25T10:00:00.000Z",
          finishedAt: "2026-07-25T10:01:00.000Z",
        },
      ],
    }));
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(project),
      modelProvider: provider,
      projectBuildService: { listRuns } as never,
    });

    await expect(
      service.generate({
        projectId: project.id,
        deviceSerial: "device-1",
        liveUiExecution: true,
        goal: "安装当前项目下的 APK 到当前设备",
      }),
    ).resolves.toMatchObject({
      plan: {
        workspaceExecution: true,
        requiresApproval: false,
        actions: [
          {
            action: "project.installArtifact",
            buildId,
            artifactIndex: 0,
            uninstallExisting: true,
          },
        ],
      },
    });
    expect(listRuns).toHaveBeenCalledWith(project.id);
    expect(provider.user).toBe("");
    expect(provider.system).toBe("");
  });

  it("automatically treats device unlock as a deterministic workspace operation", async () => {
    const project = createProject();
    const provider = new FakeModelProvider({
      reply: "不应调用模型。",
      actions: [{ action: "ui.wait", durationMs: 500 }],
    });
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(project),
      modelProvider: provider,
    });

    await expect(
      service.generate({
        projectId: project.id,
        deviceSerial: "device-1",
        liveUiExecution: true,
        goal: "解锁当前设备",
      }),
    ).resolves.toMatchObject({
      reply: expect.stringContaining("唤醒设备"),
      plan: {
        workspaceExecution: true,
        requiresApproval: false,
        actions: [{ action: "device.unlock" }],
      },
    });
    expect(provider.user).toBe("");
    expect(provider.system).toBe("");
  });

  it("allows a plan to install any APK explicitly staged for the current conversation", async () => {
    const project = createProject();
    const artifactId = "223e4567-e89b-12d3-a456-426614174000";
    const provider = new FakeModelProvider({
      reply: "先安装用户添加的 APK，再验证启动页面。",
      actions: [
        {
          action: "app.install",
          artifactId,
          replaceExisting: true,
          allowTestPackage: true,
        },
        { action: "ui.wait", durationMs: 500 },
      ],
    });
    const find = vi.fn(async (id: string) => ({
      id,
      fileName: "any-application.apk",
      sizeBytes: 128,
      sha256: "a".repeat(64),
      uploadedAt: "2026-07-24T10:00:00.000Z",
      metadata: { packageName: "com.any.application", versionCode: "1" },
    }));
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(project),
      modelProvider: provider,
      apkArtifactService: { find } as never,
    });

    const response = await service.generate({
      projectId: project.id,
      appId: "com.example.app",
      installableArtifactIds: [artifactId],
      goal: "安装 APK 后验证应用启动",
    });

    expect(response.plan.actions[0]).toMatchObject({ action: "app.install", artifactId });
    expect(find).toHaveBeenCalledWith(artifactId);
    expect(provider.user).toContain(`artifactId: ${artifactId}`);
  });

  it("allows live UI plans to uninstall and reinstall the selected test application", async () => {
    const project = createProject();
    const artifactId = "223e4567-e89b-12d3-a456-426614174000";
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(project),
      modelProvider: new FakeModelProvider({
        reply: "先卸载旧版本，再安装已暂存 APK，随后由实时页面执行器完成启动流程。",
        actions: [
          { action: "app.uninstall", appId: "com.unrelated.application", keepData: false },
          {
            action: "app.install",
            artifactId,
            replaceExisting: true,
            allowTestPackage: true,
          },
          { action: "ui.wait", durationMs: 500 },
        ],
      }),
      apkArtifactService: {
        find: async () => ({
          id: artifactId,
          fileName: "sample.apk",
          sizeBytes: 128,
          sha256: "a".repeat(64),
          uploadedAt: "2026-07-25T10:00:00.000Z",
          metadata: { packageName: "com.example.app", versionCode: "1" },
        }),
      } as never,
    });

    await expect(
      service.generate({
        projectId: project.id,
        appId: "com.example.app",
        installableArtifactIds: [artifactId],
        liveUiExecution: true,
        goal: "每轮测试前卸载重装并验证启动流程。",
      }),
    ).resolves.toMatchObject({
      plan: {
        liveUiExecution: expect.any(Object),
        actions: expect.arrayContaining([
          expect.objectContaining({ action: "app.uninstall", appId: "com.example.app" }),
          expect.objectContaining({ action: "app.install", artifactId }),
        ]),
      },
    });
  });

  it("keeps a wake, reinstall, and startup-flow request in live UI execution mode", async () => {
    const project = createProject();
    const artifactId = "223e4567-e89b-12d3-a456-426614174000";
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(project),
      modelProvider: new FakeModelProvider({
        reply: "准备完成后执行真实启动流程。",
        actions: [
          { action: "device.unlock" },
          { action: "app.uninstall", appId: "com.example.app", keepData: false },
          {
            action: "app.install",
            artifactId,
            replaceExisting: true,
            allowTestPackage: true,
          },
          { action: "ui.wait", durationMs: 500 },
        ],
      }),
      apkArtifactService: {
        find: async () => ({
          id: artifactId,
          fileName: "sample.apk",
          sizeBytes: 128,
          sha256: "a".repeat(64),
          uploadedAt: "2026-07-25T10:00:00.000Z",
          metadata: { packageName: "com.example.app", versionCode: "1" },
        }),
      } as never,
    });

    await expect(
      service.generate({
        projectId: project.id,
        appId: "com.example.app",
        installableArtifactIds: [artifactId],
        liveUiExecution: true,
        goal: "唤醒设备后每轮卸载重装，并测试首次启动页面流程到主页面。",
      }),
    ).resolves.toMatchObject({
      plan: {
        liveUiExecution: expect.any(Object),
        actions: expect.arrayContaining([
          expect.objectContaining({ action: "device.unlock" }),
          expect.objectContaining({ action: "app.uninstall", appId: "com.example.app" }),
          expect.objectContaining({ action: "app.install", artifactId }),
        ]),
      },
    });
  });

  it("normalizes live UI preparation actions before the page flow", async () => {
    const project = createProject();
    const artifactId = "223e4567-e89b-12d3-a456-426614174000";
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(project),
      modelProvider: new FakeModelProvider({
        reply: "准备测试。",
        actions: [
          { action: "ui.wait", durationMs: 500 },
          {
            action: "app.install",
            artifactId,
            replaceExisting: true,
            allowTestPackage: true,
          },
          { action: "app.uninstall", appId: "com.example.app", keepData: false },
          { action: "device.unlock" },
        ],
      }),
      apkArtifactService: {
        find: async () => ({
          id: artifactId,
          fileName: "sample.apk",
          sizeBytes: 128,
          sha256: "a".repeat(64),
          uploadedAt: "2026-07-25T10:00:00.000Z",
          metadata: { packageName: "com.example.app", versionCode: "1" },
        }),
      } as never,
    });

    const response = await service.generate({
      projectId: project.id,
      appId: "com.example.app",
      installableArtifactIds: [artifactId],
      liveUiExecution: true,
      goal: "重新安装后验证启动流程。",
    });

    expect(response.plan.actions.map((action) => action.action)).toEqual([
      "device.unlock",
      "app.uninstall",
      "app.install",
      "ui.wait",
    ]);
    expect(response.policy.warnings).toContain(
      "已将自主测试的准备动作归位为唤醒、卸载、安装、清数据后再执行页面流程。",
    );
  });

  it("rejects a plan that places APK installation after another operation", async () => {
    const project = createProject();
    const artifactId = "223e4567-e89b-12d3-a456-426614174000";
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(project),
      modelProvider: new FakeModelProvider({
        reply: "顺序错误。",
        actions: [
          { action: "ui.wait", durationMs: 500 },
          {
            action: "app.install",
            artifactId,
            replaceExisting: true,
            allowTestPackage: true,
          },
        ],
      }),
      apkArtifactService: {
        find: async () => ({
          id: artifactId,
          fileName: "sample.apk",
          sizeBytes: 128,
          sha256: "a".repeat(64),
          uploadedAt: "2026-07-24T10:00:00.000Z",
          metadata: { packageName: "com.example.app", versionCode: "1" },
        }),
      } as never,
    });

    await expect(
      service.generate({
        projectId: project.id,
        installableArtifactIds: [artifactId],
        goal: "安装 APK",
      }),
    ).rejects.toMatchObject({ statusCode: 422, message: "APK 安装必须位于测试计划的开头。" });
  });

  it("binds app actions to the selected testing application", async () => {
    const project = createProject();
    const provider = new FakeModelProvider({
      reply: "启动并检查首页。",
      actions: [
        { action: "app.launch", appId: "com.unrelated.application" },
        {
          action: "device.permission",
          appId: "com.unrelated.application",
          permission: "android.permission.CAMERA",
          mode: "grant",
        },
      ],
    });
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(project),
      modelProvider: provider,
    });

    const response = await service.generate({
      projectId: project.id,
      appId: "com.example.app",
      goal: "验证启动流程",
    });

    expect(response.plan).toMatchObject({
      targetAppId: "com.example.app",
      actions: [
        { action: "app.launch", appId: "com.example.app" },
        { action: "device.permission", appId: "com.example.app" },
      ],
    });
    expect(provider.user).toContain("测试应用包名：com.example.app");
  });

  it("uses one shared conversation for every testing application in a project", async () => {
    const project = createProject();
    const conversationStore = new InMemoryAiConversationStore();
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(project),
      modelProvider: new FakeModelProvider({
        reply: "不应生成计划。",
        actions: [{ action: "ui.wait", durationMs: 500 }],
      }),
      conversationStore,
    });

    const first = await service.createConversation(project.id, { appId: "com.example.app" });
    const second = await service.createConversation(project.id, {
      appId: "com.example.another",
      title: "不应创建第二个会话",
    });
    const list = await service.listConversations(project.id);

    expect(second.id).toBe(first.id);
    expect(second.appId).toBeUndefined();
    expect(list.conversations).toHaveLength(1);
    expect(list.conversations[0]?.id).toBe(first.id);
  });

  it("only supplies the selected project's conversation history to the model", async () => {
    const project = createProject();
    const otherProject: AndroidProject = {
      ...project,
      id: "223e4567-e89b-12d3-a456-426614174000",
      name: "Other",
      rootPath: "C:\\Github\\Other",
    };
    const conversationStore = new InMemoryAiConversationStore();
    const provider = new FakeModelProvider({
      reply: "继续验证当前项目流程。",
      actions: [{ action: "ui.wait", durationMs: 500 }],
    });
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore([project, otherProject]),
      modelProvider: provider,
      conversationStore,
    });
    const currentConversation = await service.createConversation(project.id, {
      appId: "com.example.app",
    });
    const otherConversation = await service.createConversation(otherProject.id, {
      appId: "com.example.app",
    });
    conversationStore.appendMessage({
      id: "323e4567-e89b-12d3-a456-426614174000",
      conversationId: currentConversation.id,
      role: "user",
      content: "只属于 Example 项目的历史目标",
      createdAt: "2026-07-21T10:01:00.000Z",
    });
    conversationStore.appendMessage({
      id: "423e4567-e89b-12d3-a456-426614174000",
      conversationId: otherConversation.id,
      role: "user",
      content: "绝不能混入当前项目的其他项目历史",
      createdAt: "2026-07-21T10:01:00.000Z",
    });

    await service.generate({
      projectId: project.id,
      conversationId: currentConversation.id,
      appId: "com.example.app",
      goal: "验证首页可见",
    });

    expect(provider.user).toContain("只属于 Example 项目的历史目标");
    expect(provider.user).not.toContain("绝不能混入当前项目的其他项目历史");
  });

  it("rejects a conversation from another project", async () => {
    const project = createProject();
    const otherProject: AndroidProject = {
      ...project,
      id: "223e4567-e89b-12d3-a456-426614174000",
      name: "Other",
      rootPath: "C:\\Github\\Other",
    };
    const conversationStore = new InMemoryAiConversationStore();
    const provider = new FakeModelProvider({
      reply: "不应生成计划。",
      actions: [{ action: "ui.wait", durationMs: 500 }],
    });
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore([project, otherProject]),
      modelProvider: provider,
      conversationStore,
    });
    const otherConversation = await service.createConversation(otherProject.id, {
      appId: "com.example.app",
    });

    await expect(
      service.generate({
        projectId: project.id,
        conversationId: otherConversation.id,
        appId: "com.example.app",
        goal: "验证首页可见",
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(provider.user).toBe("");
  });

  it("将实时页面执行标记写入需审批的计划", async () => {
    const project = createProject();
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(project),
      modelProvider: new FakeModelProvider({
        reply: "运行时将根据当前页面推进测试目标。",
        actions: [{ action: "ui.wait", durationMs: 500 }],
      }),
    });

    await expect(
      service.generate({
        projectId: project.id,
        appId: "com.example.app",
        goal: "从启动页进入首页",
        liveUiExecution: true,
      }),
    ).resolves.toMatchObject({
      plan: {
        targetAppId: "com.example.app",
        liveUiExecution: { goal: "从启动页进入首页", maxSteps: 20 },
        requiresApproval: true,
      },
    });
  });

  it("拒绝 AI 在实时页面流程中返回原始 ADB 操作", async () => {
    const project = createProject();
    const provider: AiPlanModelProvider = {
      status: () => ({
        configured: true,
        provider: "openai-compatible",
        baseUrl: "https://model.example/v1",
        model: "test-model",
      }),
      createPlan: async () => ({
        reply: "不应被调用",
        actions: [{ action: "ui.wait", durationMs: 500 }],
      }),
      createRuntimeDecision: async () => ({
        status: "continue",
        action: { action: "adb.shell", command: "getprop", args: [] },
        reason: "不安全的操作",
      }),
    };
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(project),
      modelProvider: provider,
    });

    await expect(
      service.decideRuntimeStep({
        projectId: project.id,
        appId: "com.example.app",
        deviceSerial: "device-1",
        goal: "验证首页显示",
        stepNumber: 1,
        uiContext: 'text="首页"; resourceId="com.example.app:id/home"; clickable=true; x=100,y=100',
      }),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it("sends runtime screenshots as an OpenAI-compatible multimodal message", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void url;
      void init;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  status: "completed",
                  assertion: { action: "assert.visible", target: { text: "首页" } },
                  reason: "截图中已出现首页标题。",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const project = createProject();
    const service = new LocalAiPlanService({
      projectStore: new InMemoryProjectStore(project),
      modelProvider: new OpenAiCompatiblePlanProvider({
        baseUrl: "https://model.example/v1",
        apiKey: "test-key",
        model: "vision-model",
      }),
    });

    try {
      await expect(
        service.decideRuntimeStep({
          projectId: project.id,
          appId: "com.example.app",
          deviceSerial: "device-1",
          goal: "检索启动页面顺序",
          stepNumber: 1,
          uiContext: 'text="继续"; x=100,y=200',
          runtimeHistory: ["1. ui.tap：已观察到首次启动引导页。"],
          screenshot: {
            width: 1_080,
            height: 2_160,
            dataUrl: "data:image/png;base64,c2NyZWVuc2hvdA==",
          },
        }),
      ).resolves.toMatchObject({ status: "completed" });
      const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
        messages: Array<{ content: unknown }>;
      };
      expect(request.messages[1]?.content).toEqual([
        expect.objectContaining({ type: "text" }),
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,c2NyZWVuc2hvdA==" },
        },
      ]);
      expect((request.messages[1]?.content as Array<{ text?: string }>)[0]?.text).toContain(
        "已观察到首次启动引导页",
      );
    } finally {
      vi.unstubAllGlobals();
    }
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

  it("restores a protected configuration after Agent restart and allows model switching", async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      void _init;
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "连接成功" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = new InMemoryAiConfigurationStore();
    const secretProtector = new PrefixSecretProtector();

    try {
      const firstAgent = new LocalAiPlanService({
        projectStore: new InMemoryProjectStore(createProject()),
        configurationStore: store,
        secretProtector,
      });
      await expect(
        firstAgent.testConfiguration({
          baseUrl: "https://model.example/v1",
          apiKey: "test-key",
          model: "model-a",
        }),
      ).resolves.toMatchObject({ model: "model-a" });
      expect(store.configuration).toMatchObject({
        baseUrl: "https://model.example/v1",
        model: "model-a",
        protectedApiKey: "protected:test-key",
      });

      const restartedAgent = new LocalAiPlanService({
        projectStore: new InMemoryProjectStore(createProject()),
        configurationStore: store,
        secretProtector,
      });
      await expect(restartedAgent.status()).resolves.toMatchObject({
        configured: true,
        baseUrl: "https://model.example/v1",
        model: "model-a",
      });
      await expect(restartedAgent.listModels({})).resolves.toMatchObject({
        models: ["model-a", "model-b"],
      });
      await expect(restartedAgent.testConfiguration({ model: "model-b" })).resolves.toMatchObject({
        model: "model-b",
      });
      expect(store.configuration).toMatchObject({ model: "model-b" });
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("repairs invalid model plans with validation feedback and accepts wrapped JSON", async () => {
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
      if (fetchMock.mock.calls.length === 2) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"reply":"继续验证启动流程。","actions":[{"action":"ui.tap","text":"首页"}]}',
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
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        max_tokens: 2048,
      });
      expect(
        String(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).messages[1].content),
      ).toContain("actions.0");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("repairs a runtime decision whose action was returned as a string", async () => {
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
                    '{"status":"continue","action":"ui.tap","target":{"text":"Next"},"reason":"点击下一步"}',
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
                  '{"status":"continue","action":{"action":"ui.tap","target":{"text":"Next"}},"reason":"当前语言页显示 Next，点击后继续验证主页面。"}',
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAiCompatiblePlanProvider({
      baseUrl: "https://model.example/v1",
      apiKey: "test-key",
      model: "test-model",
    });

    try {
      await expect(
        provider.createRuntimeDecision({
          system: "运行时页面决策",
          user: "当前 UI 树包含 Next 按钮。",
        }),
      ).resolves.toMatchObject({
        status: "continue",
        action: { action: "ui.tap", target: { text: "Next" } },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(
        String(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)).messages[0].content),
      ).toContain("continue.action 必须是完整的动作对象");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
