import { randomUUID } from "node:crypto";
import { evaluateActionPlanPolicy } from "@device-robot/ai-core";
import {
  actionPlanSchema,
  agentActionSchema,
  aiModelStatusSchema,
  aiPlanResponseSchema,
  type AgentAction,
  type AiModelStatus,
  type AiPlanResponse,
  type AndroidProject,
  type GenerateAiPlanRequest,
} from "@device-robot/contracts";
import { z } from "zod";

import type { ProjectStore } from "../projects/project-store.js";

const MODEL_TIMEOUT_MS = 90_000;
const MAX_CONTEXT_EVIDENCE = 80;

const modelPlanPayloadSchema = z.object({
  reply: z.string().min(1).max(8_000),
  actions: z.array(agentActionSchema).min(1).max(20),
});

type ModelPlanPayload = z.infer<typeof modelPlanPayloadSchema>;

export class AiPlanError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 422 | 502 | 503,
  ) {
    super(message);
  }
}

export interface AiPlanModelProvider {
  status(): AiModelStatus;
  createPlan(input: { system: string; user: string }): Promise<ModelPlanPayload>;
}

export interface AiPlanService {
  status(): Promise<AiModelStatus>;
  generate(request: GenerateAiPlanRequest): Promise<AiPlanResponse>;
}

export type LocalAiPlanServiceOptions = {
  projectStore: ProjectStore;
  modelProvider?: AiPlanModelProvider;
};

type OpenAiCompatibleConfiguration = {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  invalidReason?: string;
};

function resolveConfiguration(): OpenAiCompatibleConfiguration {
  const baseUrl = process.env.AIMOBILETESTER_AI_BASE_URL?.trim();
  const apiKey = process.env.AIMOBILETESTER_AI_API_KEY?.trim();
  const model = process.env.AIMOBILETESTER_AI_MODEL?.trim();
  const configuration = {
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(model === undefined ? {} : { model }),
  };
  if (baseUrl === undefined || apiKey === undefined || model === undefined) {
    return configuration;
  }

  try {
    const parsed = new URL(baseUrl);
    if (
      !/^https?:$/u.test(parsed.protocol) ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      return { ...configuration, invalidReason: "模型地址必须是无凭据的 HTTP(S) 地址。" };
    }
  } catch {
    return { ...configuration, invalidReason: "模型地址格式无效。" };
  }
  return configuration;
}

function unavailableStatus(reason: string): AiModelStatus {
  return aiModelStatusSchema.parse({
    configured: false,
    provider: "openai-compatible",
    reason,
  });
}

function modelEndpoint(baseUrl: string): string {
  return new URL("chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function extractContent(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    throw new AiPlanError("模型响应格式无效。", 502);
  }
  const choices = (payload as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new AiPlanError("模型未返回可用结果。", 502);
  }
  const message = choices[0];
  if (typeof message !== "object" || message === null) {
    throw new AiPlanError("模型响应格式无效。", 502);
  }
  const content = (message as { message?: { content?: unknown } }).message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new AiPlanError("模型未返回文本计划。", 502);
  }
  return content.trim();
}

function parseModelPlan(content: string): ModelPlanPayload {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(content)?.[1] ?? content;
  try {
    return modelPlanPayloadSchema.parse(JSON.parse(fenced));
  } catch {
    throw new AiPlanError("模型返回的计划未通过结构化校验。", 422);
  }
}

export class OpenAiCompatiblePlanProvider implements AiPlanModelProvider {
  readonly #configuration: OpenAiCompatibleConfiguration;

  public constructor(configuration = resolveConfiguration()) {
    this.#configuration = configuration;
  }

  public status(): AiModelStatus {
    const { baseUrl, apiKey, model, invalidReason } = this.#configuration;
    if (invalidReason !== undefined) {
      return unavailableStatus(invalidReason);
    }
    if (baseUrl === undefined || apiKey === undefined || model === undefined) {
      return unavailableStatus(
        "请配置 AIMOBILETESTER_AI_BASE_URL、AIMOBILETESTER_AI_API_KEY 与 AIMOBILETESTER_AI_MODEL。",
      );
    }
    return aiModelStatusSchema.parse({
      configured: true,
      provider: "openai-compatible",
      baseUrl,
      model,
    });
  }

  public async createPlan(input: { system: string; user: string }): Promise<ModelPlanPayload> {
    const status = this.status();
    if (
      !status.configured ||
      this.#configuration.baseUrl === undefined ||
      this.#configuration.apiKey === undefined ||
      this.#configuration.model === undefined
    ) {
      throw new AiPlanError(status.reason ?? "模型尚未配置。", 503);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    try {
      const response = await fetch(modelEndpoint(this.#configuration.baseUrl), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#configuration.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model: this.#configuration.model,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
        }),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => undefined)) as unknown;
      if (!response.ok) {
        const remoteMessage =
          typeof payload === "object" &&
          payload !== null &&
          typeof (payload as { error?: { message?: unknown } }).error?.message === "string"
            ? (payload as { error: { message: string } }).error.message
            : "模型服务拒绝了请求。";
        throw new AiPlanError(`模型请求失败：${remoteMessage}`, 502);
      }
      return parseModelPlan(extractContent(payload));
    } catch (error) {
      if (error instanceof AiPlanError) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw new AiPlanError("模型请求超时。", 502);
      }
      throw new AiPlanError("无法连接模型服务。", 502);
    } finally {
      clearTimeout(timer);
    }
  }
}

function contextFor(project: AndroidProject): {
  projectName: string;
  sourceIndexAvailable: boolean;
  evidence: NonNullable<AndroidProject["sourceIndex"]>["evidence"];
} {
  return {
    projectName: project.name,
    sourceIndexAvailable: project.sourceIndex !== undefined,
    evidence: project.sourceIndex?.evidence.slice(0, MAX_CONTEXT_EVIDENCE) ?? [],
  };
}

function sourceEvidenceText(project: AndroidProject): string {
  const context = contextFor(project);
  if (context.evidence.length === 0) {
    return "当前项目尚无可用的源码索引证据；不得虚构界面、路由或资源标识。";
  }
  return context.evidence
    .map(
      (evidence) => `${evidence.kind} | ${evidence.name} | ${evidence.filePath}:${evidence.line}`,
    )
    .join("\n");
}

function systemPrompt(): string {
  return [
    "你是 Android 自动化测试规划助手。只生成可审阅的测试操作计划，不执行设备操作。",
    "必须只输出 JSON 对象，格式为 {reply:string,actions:AgentAction[]}。reply 使用简体中文。",
    "actions 至少一项、最多二十项。只能使用 app.launch、app.stop、ui.tap、ui.longPress、ui.input、ui.swipe、ui.back、ui.wait、assert.visible、assert.notVisible、assert.text、assert.activity、device.permission、device.orientation、device.screenshot。",
    "严禁输出 adb.shell、app.install、文件路径、命令行、未在证据中出现的 resourceId、accessibilityId、页面文案或路由。证据不足时使用 ui.wait、device.screenshot 或解释限制。",
    "每个 ui.tap、ui.longPress、assert.visible、assert.notVisible、assert.text 都必须提供 target；优先 text、resourceId、accessibilityId 等语义定位器。",
  ].join("\n");
}

function userPrompt(project: AndroidProject, request: GenerateAiPlanRequest): string {
  return [
    `项目：${project.name}`,
    `目标：${request.goal.trim()}`,
    `设备：${request.deviceSerial ?? "未指定"}`,
    "项目模块：",
    ...project.modules.map(
      (module) =>
        `- ${module.path} (${module.packageName ?? module.applicationId ?? "未识别包名"}) Variant: ${module.variants.join(", ") || "未发现"}`,
    ),
    "源码索引证据：",
    sourceEvidenceText(project),
  ].join("\n");
}

function containsRestrictedAction(action: AgentAction): boolean {
  return action.action === "adb.shell" || action.action === "app.install";
}

export class LocalAiPlanService implements AiPlanService {
  readonly #projectStore: ProjectStore;
  readonly #modelProvider: AiPlanModelProvider;

  public constructor(options: LocalAiPlanServiceOptions) {
    this.#projectStore = options.projectStore;
    this.#modelProvider = options.modelProvider ?? new OpenAiCompatiblePlanProvider();
  }

  public async status(): Promise<AiModelStatus> {
    return this.#modelProvider.status();
  }

  public async generate(request: GenerateAiPlanRequest): Promise<AiPlanResponse> {
    const project = this.#projectStore.findById(request.projectId);
    if (project === undefined) {
      throw new AiPlanError("未找到项目。", 404);
    }
    const status = this.#modelProvider.status();
    if (!status.configured) {
      throw new AiPlanError(status.reason ?? "模型尚未配置。", 503);
    }

    const modelPayload = await this.#modelProvider.createPlan({
      system: systemPrompt(),
      user: userPrompt(project, request),
    });
    if (modelPayload.actions.some(containsRestrictedAction)) {
      throw new AiPlanError("模型计划包含不允许的原始命令或 APK 安装操作。", 422);
    }

    const provisionalPlan = actionPlanSchema.parse({
      id: randomUUID(),
      projectId: project.id,
      ...(request.deviceSerial === undefined ? {} : { deviceSerial: request.deviceSerial }),
      actions: modelPayload.actions,
      requiresApproval: true,
    });
    const policyDecision = evaluateActionPlanPolicy(provisionalPlan, "standard");
    if (!policyDecision.allowed) {
      throw new AiPlanError(`模型计划被本地策略拒绝：${policyDecision.reason}`, 422);
    }
    const warnings = policyDecision.actionDecisions
      .filter((decision) => decision.requiresApproval)
      .map((decision) => decision.reason);
    const plan = actionPlanSchema.parse({ ...provisionalPlan, requiresApproval: true });
    return aiPlanResponseSchema.parse({
      reply: modelPayload.reply,
      plan,
      policy: {
        allowed: true,
        requiresApproval: true,
        reason: "AI 生成的计划仅供预览，执行前必须获得明确确认。",
        warnings,
      },
      context: contextFor(project),
      generatedAt: new Date().toISOString(),
    });
  }
}
