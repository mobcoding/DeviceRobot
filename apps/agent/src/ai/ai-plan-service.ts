import { randomUUID } from "node:crypto";
import { evaluateActionPlanPolicy } from "@device-robot/ai-core";
import {
  actionPlanSchema,
  agentActionSchema,
  aiModelConnectionTestResponseSchema,
  aiModelListResponseSchema,
  aiModelStatusSchema,
  aiPlanResponseSchema,
  type AgentAction,
  type AiModelConnectionTestRequest,
  type AiModelConnectionTestResponse,
  type AiModelListRequest,
  type AiModelListResponse,
  type AiModelStatus,
  type AiPlanResponse,
  type AndroidProject,
  type GenerateAiPlanRequest,
} from "@device-robot/contracts";
import { z } from "zod";

import type { ProjectStore } from "../projects/project-store.js";

const MODEL_TIMEOUT_MS = 90_000;
const MODEL_CONFIGURATION_TIMEOUT_MS = 30_000;
const MAX_CONTEXT_EVIDENCE = 80;

const modelPlanPayloadSchema = z.object({
  reply: z.string().min(1).max(8_000),
  actions: z.array(agentActionSchema).min(1).max(20),
});

type ModelPlanPayload = z.infer<typeof modelPlanPayloadSchema>;

type ChatMessage = {
  role: "system" | "user";
  content: string;
};

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
  listModels(request: AiModelListRequest): Promise<AiModelListResponse>;
  testConfiguration(request: AiModelConnectionTestRequest): Promise<AiModelConnectionTestResponse>;
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

type CompleteOpenAiCompatibleConfiguration = Required<
  Pick<OpenAiCompatibleConfiguration, "baseUrl" | "apiKey" | "model">
>;

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

function modelApiEndpoint(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function modelEndpoint(baseUrl: string): string {
  return modelApiEndpoint(baseUrl, "chat/completions");
}

function modelsEndpoint(baseUrl: string): string {
  return modelApiEndpoint(baseUrl, "models");
}

function configurationFromRequest(
  request: AiModelListRequest | AiModelConnectionTestRequest,
): CompleteOpenAiCompatibleConfiguration {
  const baseUrl = request.baseUrl.trim();
  const apiKey = request.apiKey.trim();
  const model = "model" in request ? request.model.trim() : undefined;
  try {
    const parsed = new URL(baseUrl);
    if (
      !/^https?:$/u.test(parsed.protocol) ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      throw new AiPlanError("模型地址必须是无凭据的 HTTP(S) 地址。", 400);
    }
  } catch (error) {
    if (error instanceof AiPlanError) {
      throw error;
    }
    throw new AiPlanError("模型地址格式无效。", 400);
  }

  if (model === undefined || model.length === 0) {
    throw new AiPlanError("请选择要测试的模型。", 400);
  }
  return { baseUrl, apiKey, model };
}

function configurationForModelList(
  request: AiModelListRequest,
): Pick<CompleteOpenAiCompatibleConfiguration, "baseUrl" | "apiKey"> {
  const baseUrl = request.baseUrl.trim();
  const apiKey = request.apiKey.trim();
  try {
    const parsed = new URL(baseUrl);
    if (
      !/^https?:$/u.test(parsed.protocol) ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      throw new AiPlanError("模型地址必须是无凭据的 HTTP(S) 地址。", 400);
    }
  } catch (error) {
    if (error instanceof AiPlanError) {
      throw error;
    }
    throw new AiPlanError("模型地址格式无效。", 400);
  }
  return { baseUrl, apiKey };
}

function remoteErrorMessage(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) {
    return undefined;
  }
  const error = (payload as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0 ? message.trim() : undefined;
}

async function callModelApi(
  url: string,
  apiKey: string,
  init: RequestInit,
  timeoutMs: number,
  action: "拉取模型列表" | "测试模型连接" | "请求模型",
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...init.headers,
      },
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok) {
      throw new AiPlanError(
        `${action}失败：${remoteErrorMessage(payload) ?? "模型服务拒绝了请求。"}`,
        502,
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof AiPlanError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new AiPlanError(`${action}超时。`, 502);
    }
    throw new AiPlanError(`无法连接模型服务，${action}失败。`, 502);
  } finally {
    clearTimeout(timer);
  }
}

function extractModelIds(payload: unknown): string[] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !Array.isArray((payload as { data?: unknown }).data)
  ) {
    throw new AiPlanError("模型服务未返回可识别的模型列表。", 502);
  }
  const models = new Set<string>();
  for (const entry of (payload as { data: unknown[] }).data) {
    const id =
      typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : undefined;
    if (typeof id === "string" && id.trim().length > 0 && id.trim().length <= 256) {
      models.add(id.trim());
    }
  }
  if (models.size === 0) {
    throw new AiPlanError("模型服务未返回可选择的模型。", 502);
  }
  return [...models].sort((left, right) => left.localeCompare(right, "en"));
}

function extractChoiceMessage(payload: unknown): Record<string, unknown> {
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
  const chatMessage = (message as { message?: unknown }).message;
  if (typeof chatMessage !== "object" || chatMessage === null) {
    throw new AiPlanError("模型响应格式无效。", 502);
  }
  return chatMessage as Record<string, unknown>;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content.trim().length > 0 ? content.trim() : undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (typeof part !== "object" || part === null) {
      continue;
    }
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string") {
      parts.push(text);
      continue;
    }
    if (typeof text === "object" && text !== null) {
      const value = (text as { value?: unknown }).value;
      if (typeof value === "string") {
        parts.push(value);
      }
    }
  }
  const combined = parts.join("").trim();
  return combined.length > 0 ? combined : undefined;
}

function extractContent(payload: unknown): string {
  const content = contentText(extractChoiceMessage(payload).content);
  if (content === undefined) {
    throw new AiPlanError("模型未返回可用于生成计划的最终文本。", 502);
  }
  return content;
}

function verifyChatCompletion(payload: unknown): void {
  extractChoiceMessage(payload);
}

function balancedJsonObjectAt(content: string, start: number): string | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < content.length; index += 1) {
    const character = content[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

function jsonCandidates(content: string): string[] {
  const candidates: string[] = [];
  const add = (candidate: string | undefined): void => {
    const normalized = candidate?.trim();
    if (normalized !== undefined && normalized.length > 0 && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  add(content);
  for (const match of content.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)) {
    add(match[1]);
  }
  for (let start = content.indexOf("{"); start >= 0; start = content.indexOf("{", start + 1)) {
    add(balancedJsonObjectAt(content, start));
  }
  return candidates;
}

function modelPlanValidationMessage(error: z.ZodError): string {
  const fields = [
    ...new Set(
      error.issues
        .map((issue) => issue.path.map(String).join("."))
        .filter((path) => path.length > 0),
    ),
  ].slice(0, 3);
  if (fields.length === 0) {
    return "模型返回的计划不符合操作计划格式。";
  }
  return `模型返回的计划字段不符合要求：${fields.join("、")}。`;
}

function parseModelPlan(content: string): ModelPlanPayload {
  let validationError: z.ZodError | undefined;
  for (const candidate of jsonCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const result = modelPlanPayloadSchema.safeParse(parsed);
      if (result.success) {
        return result.data;
      }
      validationError ??= result.error;
    } catch {
      // Continue with a fenced or embedded JSON object, if one was returned.
    }
  }
  if (validationError !== undefined) {
    throw new AiPlanError(modelPlanValidationMessage(validationError), 422);
  }
  throw new AiPlanError("模型未返回有效的 JSON 操作计划。", 422);
}

function planPromptRules(): string[] {
  return [
    "必须只输出 JSON 对象，格式为 {reply:string,actions:AgentAction[]}。reply 使用简体中文。",
    "actions 至少一项、最多二十项。只能使用 app.launch、app.stop、ui.tap、ui.longPress、ui.input、ui.swipe、ui.back、ui.wait、assert.visible、assert.notVisible、assert.text、assert.activity、device.permission、device.orientation、device.screenshot。",
    '严格示例：{"reply":"先记录启动流程的可观察证据。","actions":[{"action":"ui.wait","durationMs":1500},{"action":"device.screenshot","name":"启动页"}]}。',
    "动作字段：app.launch/app.stop 必须有 appId；ui.tap、ui.longPress、assert.visible、assert.notVisible 必须有 target；assert.text 还必须有 expected；ui.input 必须有 value；ui.swipe 必须有 start 和 end，二者均为 {x:number,y:number}；ui.wait 必须有 durationMs:number；assert.activity 必须有 expected；device.screenshot 可选 name。",
    "target 必须是对象，且包含 text、resourceId、accessibilityId、className 之一，或同时包含 x:number 与 y:number；不得写成 selector、element、description、page、route 或字符串。",
    "严禁输出 adb.shell、app.install、文件路径、命令行、未在证据中出现的 resourceId、accessibilityId、页面文案或路由。证据不足时使用 ui.wait、device.screenshot 或在 reply 中说明限制。",
    "每个 ui.tap、ui.longPress、assert.visible、assert.notVisible、assert.text 都必须提供 target；优先使用 text、resourceId、accessibilityId 等语义定位器。",
  ];
}

function repairPrompt(): string {
  return [
    "你是 Android 自动化测试操作计划的 JSON 修复器。",
    ...planPromptRules(),
    "上一次响应不能通过程序校验。请保留其安全意图，但修正为唯一、完整且可解析的 JSON 对象。不得输出 Markdown、解释或其他文本。",
  ].join("\n");
}

function repairUserPrompt(
  userPromptText: string,
  invalidContent: string,
  validationFeedback: string,
): string {
  return [
    "原始任务上下文：",
    userPromptText,
    "程序校验反馈：",
    validationFeedback,
    "需要修正的模型草稿：",
    invalidContent.slice(0, 16_000),
  ].join("\n");
}

async function requestStructuredPlan(
  configuration: CompleteOpenAiCompatibleConfiguration,
  messages: ChatMessage[],
): Promise<unknown> {
  return callModelApi(
    modelEndpoint(configuration.baseUrl),
    configuration.apiKey,
    {
      method: "POST",
      body: JSON.stringify({
        model: configuration.model,
        temperature: 0.2,
        max_tokens: 2048,
        response_format: { type: "json_object" },
        messages,
      }),
    },
    MODEL_TIMEOUT_MS,
    "请求模型",
  );
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
        "请在本页配置 OpenAI 兼容服务，或设置 AIMOBILETESTER_AI_BASE_URL、AIMOBILETESTER_AI_API_KEY 与 AIMOBILETESTER_AI_MODEL。",
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

    const payload = await callModelApi(
      modelEndpoint(this.#configuration.baseUrl),
      this.#configuration.apiKey,
      {
        method: "POST",
        body: JSON.stringify({
          model: this.#configuration.model,
          temperature: 0.2,
          max_tokens: 2048,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: input.system },
            { role: "user", content: input.user },
          ],
        }),
      },
      MODEL_TIMEOUT_MS,
      "请求模型",
    );
    const configuration: CompleteOpenAiCompatibleConfiguration = {
      baseUrl: this.#configuration.baseUrl,
      apiKey: this.#configuration.apiKey,
      model: this.#configuration.model,
    };
    let candidateContent = extractContent(payload);
    for (let repairAttempt = 0; repairAttempt < 3; repairAttempt += 1) {
      try {
        return parseModelPlan(candidateContent);
      } catch (error) {
        if (!(error instanceof AiPlanError) || error.statusCode !== 422 || repairAttempt === 2) {
          throw error;
        }
        const repairedPayload = await requestStructuredPlan(configuration, [
          { role: "system", content: repairPrompt() },
          { role: "user", content: repairUserPrompt(input.user, candidateContent, error.message) },
        ]);
        candidateContent = extractContent(repairedPayload);
      }
    }
    throw new AiPlanError("模型未返回可用的操作计划。", 422);
  }

  public async testConnection(): Promise<void> {
    const status = this.status();
    if (
      !status.configured ||
      this.#configuration.baseUrl === undefined ||
      this.#configuration.apiKey === undefined ||
      this.#configuration.model === undefined
    ) {
      throw new AiPlanError(status.reason ?? "模型尚未配置。", 503);
    }

    const payload = await callModelApi(
      modelEndpoint(this.#configuration.baseUrl),
      this.#configuration.apiKey,
      {
        method: "POST",
        body: JSON.stringify({
          model: this.#configuration.model,
          temperature: 0,
          max_tokens: 256,
          messages: [{ role: "user", content: "请仅回复：连接成功" }],
        }),
      },
      MODEL_CONFIGURATION_TIMEOUT_MS,
      "测试模型连接",
    );
    verifyChatCompletion(payload);
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
    ...planPromptRules(),
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
  #modelProvider: AiPlanModelProvider;

  public constructor(options: LocalAiPlanServiceOptions) {
    this.#projectStore = options.projectStore;
    this.#modelProvider = options.modelProvider ?? new OpenAiCompatiblePlanProvider();
  }

  public async status(): Promise<AiModelStatus> {
    return this.#modelProvider.status();
  }

  public async listModels(request: AiModelListRequest): Promise<AiModelListResponse> {
    const configuration = configurationForModelList(request);
    const payload = await callModelApi(
      modelsEndpoint(configuration.baseUrl),
      configuration.apiKey,
      { method: "GET" },
      MODEL_CONFIGURATION_TIMEOUT_MS,
      "拉取模型列表",
    );
    return aiModelListResponseSchema.parse({
      provider: "openai-compatible",
      models: extractModelIds(payload),
    });
  }

  public async testConfiguration(
    request: AiModelConnectionTestRequest,
  ): Promise<AiModelConnectionTestResponse> {
    const configuration = configurationFromRequest(request);
    const candidate = new OpenAiCompatiblePlanProvider(configuration);
    await candidate.testConnection();
    this.#modelProvider = candidate;
    return aiModelConnectionTestResponseSchema.parse({
      provider: "openai-compatible",
      baseUrl: configuration.baseUrl,
      model: configuration.model,
      message: "模型连接成功，已应用到当前本地 Agent。",
    });
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
