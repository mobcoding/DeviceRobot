import { randomUUID } from "node:crypto";
import { evaluateActionPlanPolicy } from "@device-robot/ai-core";
import {
  actionPlanSchema,
  agentActionSchema,
  aiModelConnectionTestResponseSchema,
  aiModelListResponseSchema,
  aiModelStatusSchema,
  aiConversationDetailResponseSchema,
  aiConversationListResponseSchema,
  aiPlanListResponseSchema,
  aiPlanResponseSchema,
  type AgentAction,
  type AiModelConnectionTestRequest,
  type AiModelConnectionTestResponse,
  type AiModelListRequest,
  type AiModelListResponse,
  type AiModelStatus,
  type AiConversation,
  type AiConversationDetailResponse,
  type AiConversationListResponse,
  type AiPlanResponse,
  type AiPlanListResponse,
  type AndroidProject,
  type CreateAiConversationRequest,
  type GenerateAiPlanRequest,
  type ProjectBuildRun,
} from "@device-robot/contracts";
import { z } from "zod";

import type { AiConfigurationStore } from "./ai-configuration-store.js";
import type { AiConversationStore, StoredAiConversationMessage } from "./ai-conversation-store.js";
import type { AiPlanStore } from "./ai-plan-store.js";
import type { AiSecretProtector } from "./ai-secret-protector.js";
import type { ProjectStore } from "../projects/project-store.js";
import type { ApkArtifactService } from "../apks/apk-artifact-service.js";
import type { ProjectBuildService } from "../projects/project-build-service.js";

const MODEL_TIMEOUT_MS = 90_000;
const MODEL_CONFIGURATION_TIMEOUT_MS = 30_000;
const MAX_CONTEXT_EVIDENCE = 80;
const MAX_CONVERSATION_HISTORY_MESSAGES = 12;
const MAX_CONVERSATION_HISTORY_CHARACTERS = 12_000;

const modelPlanPayloadSchema = z.object({
  reply: z.string().min(1).max(8_000),
  actions: z.array(agentActionSchema).min(1).max(20),
});

type ModelPlanPayload = z.infer<typeof modelPlanPayloadSchema>;

const runtimeContinueDecisionSchema = z
  .object({
    status: z.literal("continue"),
    action: agentActionSchema,
    reason: z.string().min(1).max(2_000),
  })
  .strict();
const runtimeCompletedDecisionSchema = z
  .object({
    status: z.literal("completed"),
    assertion: agentActionSchema,
    reason: z.string().min(1).max(2_000),
  })
  .strict();
const runtimeBlockedDecisionSchema = z
  .object({ status: z.literal("blocked"), reason: z.string().min(1).max(2_000) })
  .strict();
const runtimeDecisionPayloadSchema = z.discriminatedUnion("status", [
  runtimeContinueDecisionSchema,
  runtimeCompletedDecisionSchema,
  runtimeBlockedDecisionSchema,
]);

type ModelRuntimeDecision = z.infer<typeof runtimeDecisionPayloadSchema>;

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
  createRuntimeDecision?(input: {
    system: string;
    user: string;
    screenshot?: AiRuntimeScreenshot;
  }): Promise<ModelRuntimeDecision>;
}

export type AiRuntimeScreenshot = {
  dataUrl: string;
  width: number;
  height: number;
};

export type AiRuntimeStepRequest = {
  projectId: string;
  appId: string;
  deviceSerial: string;
  goal: string;
  stepNumber: number;
  uiContext: string;
  runtimeHistory?: readonly string[];
  screenshot?: AiRuntimeScreenshot;
};

export type AiRuntimeStepDecision = ModelRuntimeDecision;

export interface AiPlanService {
  status(): Promise<AiModelStatus>;
  list(): Promise<AiPlanListResponse>;
  listModels(request: AiModelListRequest): Promise<AiModelListResponse>;
  testConfiguration(request: AiModelConnectionTestRequest): Promise<AiModelConnectionTestResponse>;
  generate(request: GenerateAiPlanRequest): Promise<AiPlanResponse>;
  listConversations?(projectId: string): Promise<AiConversationListResponse>;
  createConversation?(
    projectId: string,
    request: CreateAiConversationRequest,
  ): Promise<AiConversation>;
  getConversation?(conversationId: string): Promise<AiConversationDetailResponse>;
  decideRuntimeStep?(request: AiRuntimeStepRequest): Promise<AiRuntimeStepDecision>;
}

export type LocalAiPlanServiceOptions = {
  projectStore: ProjectStore;
  apkArtifactService?: ApkArtifactService;
  projectBuildService?: ProjectBuildService;
  modelProvider?: AiPlanModelProvider;
  configurationStore?: AiConfigurationStore;
  secretProtector?: AiSecretProtector;
  planStore?: AiPlanStore;
  conversationStore?: AiConversationStore;
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
  activeConfiguration?: CompleteOpenAiCompatibleConfiguration,
): CompleteOpenAiCompatibleConfiguration {
  const baseUrl = request.baseUrl?.trim() ?? activeConfiguration?.baseUrl;
  const apiKey = request.apiKey?.trim() ?? activeConfiguration?.apiKey;
  const model = "model" in request ? request.model.trim() : undefined;
  if (baseUrl === undefined || apiKey === undefined) {
    throw new AiPlanError("请填写有效的 Base URL 和 API Key。", 400);
  }
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
  activeConfiguration?: CompleteOpenAiCompatibleConfiguration,
): Pick<CompleteOpenAiCompatibleConfiguration, "baseUrl" | "apiKey"> {
  const baseUrl = request.baseUrl?.trim() ?? activeConfiguration?.baseUrl;
  const apiKey = request.apiKey?.trim() ?? activeConfiguration?.apiKey;
  if (baseUrl === undefined || apiKey === undefined) {
    throw new AiPlanError("请填写有效的 Base URL 和 API Key。", 400);
  }
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

function parseRuntimeDecision(content: string): ModelRuntimeDecision {
  let validationError: z.ZodError | undefined;
  for (const candidate of jsonCandidates(content)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const result = runtimeDecisionPayloadSchema.safeParse(parsed);
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
  throw new AiPlanError("模型未返回有效的实时页面决策。", 422);
}

function isRuntimeAction(action: AgentAction): boolean {
  return [
    "ui.tap",
    "ui.longPress",
    "ui.input",
    "ui.swipe",
    "ui.back",
    "ui.wait",
    "assert.visible",
    "assert.notVisible",
    "assert.text",
    "assert.activity",
    "device.screenshot",
  ].includes(action.action);
}

function isRuntimeCompletionAssertion(action: AgentAction): boolean {
  return ["assert.visible", "assert.notVisible", "assert.text", "assert.activity"].includes(
    action.action,
  );
}

function planPromptRules(workspaceExecution = false): string[] {
  return [
    "必须只输出 JSON 对象，格式为 {reply:string,actions:AgentAction[]}。reply 使用简体中文。",
    "actions 至少一项、最多二十项。只能使用 app.install、app.uninstall、app.clearData、app.launch、app.stop、ui.tap、ui.longPress、ui.input、ui.swipe、ui.back、ui.wait、assert.visible、assert.notVisible、assert.text、assert.activity、device.permission、device.orientation、device.screenshot、adb.shell、project.build、project.installArtifact。",
    '严格示例：{"reply":"先记录启动流程的可观察证据。","actions":[{"action":"ui.wait","durationMs":1500},{"action":"device.screenshot","name":"启动页"}]}。',
    "动作字段：app.launch/app.stop 必须有 appId；ui.tap、ui.longPress、assert.visible、assert.notVisible 必须有 target；assert.text 还必须有 expected；ui.input 必须有 value；ui.swipe 必须有 start 和 end，二者均为 {x:number,y:number}；ui.wait 必须有 durationMs:number；assert.activity 必须有 expected；device.screenshot 可选 name。",
    "target 必须是对象，且包含 text、resourceId、accessibilityId、className 之一，或同时包含 x:number 与 y:number；不得写成 selector、element、description、page、route 或字符串。",
    ...(workspaceExecution
      ? [
          "当前是工作区自主操作计划。可输出 adb.shell，但 action.command 和 args 必须是设备端 ADB shell 的逐项参数，不能包含 adb 前缀、Windows 命令、文件路径、管道、重定向或命令拼接。",
          "可使用 app.uninstall、app.clearData、app.launch、app.stop 和 device.permission 操作用户明确要求的应用包名。",
          "仅当请求明确提供“可安装的本地 APK”时才可输出 app.install；artifactId 必须逐字使用列表中的 ID，不得猜测、编造或使用文件路径。",
        ]
      : [
          "严禁输出 adb.shell、文件路径、命令行、未在证据中出现的 resourceId、accessibilityId、页面文案或路由。证据不足时使用 ui.wait、device.screenshot 或在 reply 中说明限制。",
          "仅当请求明确提供“可安装的本地 APK”时才可输出 app.install。app.install 必须是第一个动作，并且 artifactId 必须逐字使用列表中的 ID；不得猜测、编造或使用文件路径。",
        ]),
    "每个 ui.tap、ui.longPress、assert.visible、assert.notVisible、assert.text 都必须提供 target；优先使用 text、resourceId、accessibilityId 等语义定位器。",
    ...(workspaceExecution
      ? [
          "project.build 必须使用当前项目模块列表内的 modulePath 和 variant。project.installArtifact 必须逐字使用当前项目成功构建 APK 列表中的 buildId 与 artifactIndex；不得写入文件路径。",
        ]
      : ["普通测试计划禁止输出 project.build 和 project.installArtifact。"]),
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

  public configuration(): CompleteOpenAiCompatibleConfiguration | undefined {
    const { baseUrl, apiKey, model, invalidReason } = this.#configuration;
    if (
      invalidReason !== undefined ||
      baseUrl === undefined ||
      apiKey === undefined ||
      model === undefined
    ) {
      return undefined;
    }
    return { baseUrl, apiKey, model };
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

  public async createRuntimeDecision(input: {
    system: string;
    user: string;
    screenshot?: AiRuntimeScreenshot;
  }): Promise<ModelRuntimeDecision> {
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
          max_tokens: 1_024,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: input.system },
            {
              role: "user",
              content:
                input.screenshot === undefined
                  ? input.user
                  : [
                      { type: "text", text: input.user },
                      {
                        type: "image_url",
                        image_url: { url: input.screenshot.dataUrl },
                      },
                    ],
            },
          ],
        }),
      },
      MODEL_TIMEOUT_MS,
      "请求模型",
    );
    return parseRuntimeDecision(extractContent(payload));
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

type WorkspaceProjectArtifact = {
  buildId: string;
  artifactIndex: number;
  fileName: string;
};

function workspaceProjectArtifacts(runs: readonly ProjectBuildRun[]): WorkspaceProjectArtifact[] {
  return runs.flatMap((run) => {
    if (run.status !== "succeeded") {
      return [];
    }
    return run.artifactPaths.map((artifactPath, artifactIndex) => ({
      buildId: run.id,
      artifactIndex,
      fileName:
        run.artifactNames?.[artifactIndex] ?? artifactPath.split(/[\\/]/u).at(-1) ?? artifactPath,
    }));
  });
}

function projectArtifactKey(buildId: string, artifactIndex: number): string {
  return `${buildId}:${artifactIndex}`;
}

function requestsCurrentProjectArtifactInstall(goal: string): boolean {
  const value = goal.trim().toLocaleLowerCase();
  const requestsInstall = /安装|install/u.test(value);
  const referencesCurrentProject =
    /当前(?:项目|工程)|本(?:项目|工程)|该(?:项目|工程)|current\s+project|this\s+project/iu.test(
      value,
    );
  const referencesApk = /apk|安装包|构建(?:产物|包)?|artifact/iu.test(value);
  return requestsInstall && referencesCurrentProject && referencesApk;
}

function currentProjectArtifactInstallPlan(
  request: GenerateAiPlanRequest,
  projectArtifacts: readonly WorkspaceProjectArtifact[],
): ModelPlanPayload | undefined {
  if (request.workspaceExecution !== true || !requestsCurrentProjectArtifactInstall(request.goal)) {
    return undefined;
  }
  const artifact = projectArtifacts[0];
  if (artifact === undefined) {
    throw new AiPlanError("当前项目没有可安装的成功构建 APK，请先完成一次构建。", 422);
  }
  return {
    reply: `已选择当前项目最近成功构建的 APK：${artifact.fileName}。`,
    actions: [
      {
        action: "project.installArtifact",
        buildId: artifact.buildId,
        artifactIndex: artifact.artifactIndex,
        replaceExisting: true,
        allowTestPackage: true,
        // A signature mismatch is retried after removing only the conflicting package.
        uninstallExisting: true,
      },
    ],
  };
}

function systemPrompt(liveUiExecution = false, workspaceExecution = false): string {
  return [
    ...planPromptRules(workspaceExecution),
    workspaceExecution
      ? "你是 DeviceRobot 工作区 Agent。请根据用户目标生成可直接在当前设备执行的工作区操作计划。"
      : "你是 Android 自动化测试规划助手。只生成可审阅的测试操作计划，不执行设备操作。",
    "必须只输出 JSON 对象，格式为 {reply:string,actions:AgentAction[]}。reply 使用简体中文。",
    "actions 至少一项、最多二十项。只能使用 app.install、app.uninstall、app.clearData、app.launch、app.stop、ui.tap、ui.longPress、ui.input、ui.swipe、ui.back、ui.wait、assert.visible、assert.notVisible、assert.text、assert.activity、device.permission、device.orientation、device.screenshot、adb.shell、project.build、project.installArtifact。",
    ...(workspaceExecution
      ? [
          "工作区操作已获得用户授权：可执行设备侧 ADB shell 与应用生命周期操作；不得调用 Windows Shell、PowerShell、CMD 或访问任意本机文件路径。",
          "工作区直接操作的 ui.tap 和 ui.longPress 必须使用 x/y 坐标；语义断言只能通过测试运行执行。",
        ]
      : [
          "严禁输出 adb.shell、文件路径、命令行、未在证据中出现的 resourceId、accessibilityId、页面文案或路由。证据不足时使用 ui.wait、device.screenshot 或解释限制。",
          "若已提供测试应用包名，app.launch、app.stop 和 device.permission 必须且只能使用该包名；不得从其他源码证据猜测或替换测试应用。",
        ]),
    "仅当请求明确提供“可安装的本地 APK”时才可输出 app.install。artifactId 必须逐字使用列表中的 ID；不得猜测、编造或使用文件路径。",
    "每个 ui.tap、ui.longPress、assert.visible、assert.notVisible、assert.text 都必须提供 target；优先 text、resourceId、accessibilityId 等语义定位器。",
    ...(liveUiExecution
      ? [
          "当前请求已启用自主执行。此阶段的 ActionPlan 仅用于启动运行时 Agent；实际页面识别和操作将在执行后基于真实截图与 UI 树完成。不要因静态源码索引缺少页面文案或控件而声称无法执行；使用 ui.wait 或 device.screenshot 作为计划占位步骤即可。",
        ]
      : []),
  ].join("\n");
}

function projectContextRevision(project: AndroidProject): string {
  return project.revision ?? project.updatedAt;
}

function conversationHistoryText(messages: readonly StoredAiConversationMessage[]): string {
  const selected = messages.slice(-MAX_CONVERSATION_HISTORY_MESSAGES);
  const lines: string[] = [];
  let usedCharacters = 0;
  for (const message of selected) {
    const content = message.content.trim();
    if (content.length === 0) {
      continue;
    }
    const label = message.role === "user" ? "用户" : "助手";
    const remaining = MAX_CONVERSATION_HISTORY_CHARACTERS - usedCharacters;
    if (remaining <= 0) {
      break;
    }
    const rendered = `${label}：${content.slice(0, Math.max(0, remaining - label.length - 2))}`;
    lines.push(rendered);
    usedCharacters += rendered.length;
  }
  return lines.length === 0 ? "（这是该项目会话的第一轮对话。）" : lines.join("\n");
}

function userPrompt(
  project: AndroidProject,
  request: GenerateAiPlanRequest,
  history: readonly StoredAiConversationMessage[] = [],
  installableArtifacts: readonly {
    id: string;
    fileName: string;
    metadata: { packageName: string };
  }[] = [],
  projectArtifacts: readonly WorkspaceProjectArtifact[] = [],
): string {
  return [
    `项目：${project.name}`,
    `目标：${request.goal.trim()}`,
    `设备：${request.deviceSerial ?? "未指定"}`,
    `测试应用包名：${request.appId ?? "未指定"}`,
    `实时页面执行：${request.liveUiExecution === true ? "已启用" : "未启用"}`,
    `工作区自主操作：${request.workspaceExecution === true ? "已启用" : "未启用"}`,
    ...(request.workspaceExecution === true
      ? [
          "本计划会直接执行设备应用、坐标操作、截图和 ADB shell；不要使用测试断言动作。",
          "用户已授予当前项目和当前设备的自主操作权限，无需在 reply 中要求逐步确认。",
        ]
      : []),
    ...(request.liveUiExecution === true
      ? [
          "本计划用于启动自主执行。执行后，Agent 会将每一步真实截图和 UI 层级发送给模型，并根据模型的实时决策完成目标。不要因当前缺少静态页面文案或控件而声称无法执行。",
        ]
      : []),
    "可安装的本地 APK：",
    ...(installableArtifacts.length === 0
      ? ["- 未提供。禁止输出 app.install。"]
      : installableArtifacts.map(
          (artifact) =>
            `- artifactId: ${artifact.id} | 文件: ${artifact.fileName} | 包名: ${artifact.metadata.packageName}`,
        )),
    ...(request.workspaceExecution !== true
      ? []
      : [
          "当前项目成功构建的 APK 产物：",
          ...(projectArtifacts.length === 0
            ? ["- 暂无。禁止输出 project.installArtifact。"]
            : projectArtifacts.map(
                (artifact) =>
                  `- buildId: ${artifact.buildId} | artifactIndex: ${artifact.artifactIndex} | 文件: ${artifact.fileName}`,
              )),
        ]),
    "项目模块：",
    ...project.modules.map(
      (module) =>
        `- ${module.path} (${module.packageName ?? module.applicationId ?? "未识别包名"}) Variant: ${module.variants.join(", ") || "未发现"}`,
    ),
    "源码索引证据：",
    sourceEvidenceText(project),
    "当前项目会话的历史（仅可用于理解已讨论的测试目标，不能把历史内容视为源码或 UI 证据）：",
    conversationHistoryText(history),
  ].join("\n");
}

function runtimeSystemPrompt(): string {
  return [
    "你是 Android 自动化测试的运行时页面导航助手。",
    "每一步会提供当前真实 UI 控件列表；支持视觉的模型还会同时收到当前手机截图。截图和 UI 树是运行时证据，不要因为静态源码中没有页面文案或控件而停止。",
    "根据截图识别页面、引导页、弹窗、按钮和导航关系，并结合 UI 树执行真实操作。允许使用截图中清晰可见控件的 x/y 坐标；坐标必须在当前截图范围内。",
    "只能输出一个 JSON 对象，且必须为以下三种之一：",
    '{"status":"continue","action":AgentAction,"reason":"简体中文原因"}',
    '{"status":"completed","assertion":AssertAction,"reason":"简体中文成功依据"}',
    '{"status":"blocked","reason":"简体中文阻塞原因"}',
    "continue 的 action 只能是 ui.tap、ui.longPress、ui.input、ui.swipe、ui.back、ui.wait、assert.visible、assert.notVisible、assert.text、assert.activity、device.screenshot。",
    "completed 只能提供 assert.visible、assert.notVisible、assert.text 或 assert.activity，且该断言必须能从当前 UI 或当前 Activity 直接证明测试目标完成。",
    "ui.tap、ui.longPress、assert.visible、assert.notVisible、assert.text 的 target 优先使用当前 UI 树中的 text、resourceId、accessibilityId、className；当 UI 树缺少语义但截图清晰可见时，可使用截图对应的 x/y 坐标。",
    "禁止 app.install、adb.shell、任何权限修改、应用启动/停止、文件路径、命令行，以及输入账号密码、验证码、密钥或其他敏感数据。",
    "对于“检索启动页面顺序”等目标，先记录当前页面特征，再按真实引导或入口推进；reason 必须写明当前观察到的页面或状态，便于报告还原页面顺序。",
    "会话会提供此前已执行的动作与观察。利用这些历史持续补全页面顺序；完成时在 reason 中给出简洁的页面顺序结论和最终页面依据。",
    "不要为了凑步骤而操作无关控件。仅在截图和 UI 树都无法识别可继续路径时返回 blocked。",
  ].join("\n");
}

function runtimeUserPrompt(project: AndroidProject, request: AiRuntimeStepRequest): string {
  return [
    `项目：${project.name}`,
    `测试应用包名：${request.appId}`,
    `设备：${request.deviceSerial}`,
    `测试目标：${request.goal}`,
    `当前为第 ${request.stepNumber} 个实时决策步骤。`,
    request.screenshot === undefined
      ? "当前截图不可用，请依据 UI 树继续。"
      : `当前截图：${request.screenshot.width} x ${request.screenshot.height}，已作为本请求图片附件提供；使用坐标时以此分辨率为准。`,
    "当前真实 UI 控件：",
    request.uiContext,
    "已执行步骤与观察：",
    ...(request.runtimeHistory === undefined || request.runtimeHistory.length === 0
      ? ["- 尚未执行运行时操作。"]
      : request.runtimeHistory.map((entry) => `- ${entry}`)),
    "相关源码索引证据：",
    sourceEvidenceText(project),
  ].join("\n");
}

function containsRestrictedTestAction(action: AgentAction): boolean {
  return (
    action.action === "adb.shell" ||
    action.action === "app.uninstall" ||
    action.action === "app.clearData" ||
    action.action === "project.build" ||
    action.action === "project.installArtifact"
  );
}

function installsOnlyAtPlanStart(actions: readonly AgentAction[]): boolean {
  let reachedNonInstallAction = false;
  for (const action of actions) {
    if (action.action === "app.install") {
      if (reachedNonInstallAction) {
        return false;
      }
    } else {
      reachedNonInstallAction = true;
    }
  }
  return true;
}

function coordinateIsWithinScreenshot(
  point: { x: number; y: number },
  screenshot: AiRuntimeScreenshot,
): boolean {
  return point.x < screenshot.width && point.y < screenshot.height;
}

function runtimeDecisionUsesVisibleCoordinates(
  decision: AiRuntimeStepDecision,
  screenshot: AiRuntimeScreenshot | undefined,
): boolean {
  if (screenshot === undefined || decision.status !== "continue") {
    return true;
  }
  const { action } = decision;
  if (action.action === "ui.swipe") {
    return (
      coordinateIsWithinScreenshot(action.start, screenshot) &&
      coordinateIsWithinScreenshot(action.end, screenshot)
    );
  }
  if (
    (action.action === "ui.tap" || action.action === "ui.longPress") &&
    action.target.x !== undefined &&
    action.target.y !== undefined
  ) {
    return coordinateIsWithinScreenshot({ x: action.target.x, y: action.target.y }, screenshot);
  }
  return true;
}

function packageNameIsValid(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(value);
}

function bindActionsToTargetApplication(
  actions: readonly AgentAction[],
  appId: string | undefined,
): AgentAction[] {
  if (appId === undefined) {
    return [...actions];
  }

  return actions.map((action) => {
    if (
      action.action === "app.launch" ||
      action.action === "app.stop" ||
      action.action === "app.uninstall" ||
      action.action === "app.clearData" ||
      action.action === "device.permission"
    ) {
      return { ...action, appId };
    }
    return action;
  });
}

export class LocalAiPlanService implements AiPlanService {
  readonly #projectStore: ProjectStore;
  readonly #apkArtifactService: ApkArtifactService | undefined;
  readonly #projectBuildService: ProjectBuildService | undefined;
  readonly #configurationStore: AiConfigurationStore | undefined;
  readonly #secretProtector: AiSecretProtector | undefined;
  readonly #planStore: AiPlanStore | undefined;
  readonly #conversationStore: AiConversationStore | undefined;
  readonly #usesCustomProvider: boolean;
  #modelProvider: AiPlanModelProvider;
  #activeConfiguration: CompleteOpenAiCompatibleConfiguration | undefined;
  #configurationRestored = false;
  #restorePromise: Promise<void> | undefined;
  #restoreReason: string | undefined;

  public constructor(options: LocalAiPlanServiceOptions) {
    this.#projectStore = options.projectStore;
    this.#apkArtifactService = options.apkArtifactService;
    this.#projectBuildService = options.projectBuildService;
    this.#modelProvider = options.modelProvider ?? new OpenAiCompatiblePlanProvider();
    this.#configurationStore = options.configurationStore;
    this.#secretProtector = options.secretProtector;
    this.#planStore = options.planStore;
    this.#conversationStore = options.conversationStore;
    this.#usesCustomProvider = options.modelProvider !== undefined;
    if (this.#modelProvider instanceof OpenAiCompatiblePlanProvider) {
      this.#activeConfiguration = this.#modelProvider.configuration();
    }
  }

  public async status(): Promise<AiModelStatus> {
    await this.#ensureConfigurationRestored();
    if (this.#restoreReason !== undefined) {
      return unavailableStatus(this.#restoreReason);
    }
    return this.#modelProvider.status();
  }

  public async list(): Promise<AiPlanListResponse> {
    return aiPlanListResponseSchema.parse({ plans: this.#planStore?.list() ?? [] });
  }

  public async listConversations(projectId: string): Promise<AiConversationListResponse> {
    const project = this.#projectStore.findById(projectId);
    if (project === undefined) {
      throw new AiPlanError("未找到项目。", 404);
    }
    return aiConversationListResponseSchema.parse({
      projectId,
      conversations: [this.#withCurrentContextStatus(this.#projectConversation(project), project)],
    });
  }

  public async createConversation(
    projectId: string,
    request: CreateAiConversationRequest,
  ): Promise<AiConversation> {
    void request;
    const project = this.#projectStore.findById(projectId);
    if (project === undefined) {
      throw new AiPlanError("未找到项目。", 404);
    }
    return this.#withCurrentContextStatus(this.#projectConversation(project), project);
  }

  public async getConversation(conversationId: string): Promise<AiConversationDetailResponse> {
    const conversation = this.#conversationStore?.find(conversationId);
    if (conversation === undefined) {
      throw new AiPlanError("未找到 AI 会话。", 404);
    }
    const project = this.#projectStore.findById(conversation.projectId);
    if (project === undefined) {
      throw new AiPlanError("会话关联的项目不存在。", 404);
    }
    const messages = (this.#conversationStore?.listMessages(conversationId) ?? []).map(
      (message) => {
        const plan =
          message.planId === undefined ? undefined : this.#planStore?.find(message.planId);
        return {
          ...message,
          ...(plan === undefined
            ? {}
            : {
                plan: {
                  reply: plan.reply,
                  plan: plan.plan,
                  policy: plan.policy,
                  context: plan.context,
                  generatedAt: plan.generatedAt,
                },
              }),
        };
      },
    );
    return aiConversationDetailResponseSchema.parse({
      conversation: this.#withCurrentContextStatus(conversation, project),
      messages,
      ...(this.#conversationStore?.latestSnapshot(conversationId) === undefined
        ? {}
        : { latestContextSnapshot: this.#conversationStore.latestSnapshot(conversationId) }),
    });
  }

  async #ensureConfigurationRestored(): Promise<void> {
    if (this.#configurationRestored) {
      return;
    }
    if (this.#restorePromise === undefined) {
      this.#restorePromise = this.#restoreConfiguration().finally(() => {
        this.#configurationRestored = true;
        this.#restorePromise = undefined;
      });
    }
    await this.#restorePromise;
  }

  async #restoreConfiguration(): Promise<void> {
    if (
      this.#usesCustomProvider ||
      this.#modelProvider.status().configured ||
      this.#configurationStore === undefined ||
      this.#secretProtector === undefined
    ) {
      return;
    }
    const stored = this.#configurationStore.load();
    if (stored === undefined) {
      return;
    }
    try {
      const apiKey = await this.#secretProtector.reveal(stored.protectedApiKey);
      const configuration: CompleteOpenAiCompatibleConfiguration = {
        baseUrl: stored.baseUrl,
        apiKey,
        model: stored.model,
      };
      const provider = new OpenAiCompatiblePlanProvider(configuration);
      if (!provider.status().configured) {
        this.#restoreReason = "保存的 AI 配置无效，请重新配置。";
        return;
      }
      this.#modelProvider = provider;
      this.#activeConfiguration = configuration;
    } catch {
      this.#restoreReason = "无法读取已保存的 AI API Key，请重新配置。";
    }
  }

  public async listModels(request: AiModelListRequest): Promise<AiModelListResponse> {
    await this.#ensureConfigurationRestored();
    const configuration = configurationForModelList(request, this.#activeConfiguration);
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
    await this.#ensureConfigurationRestored();
    const configuration = configurationFromRequest(request, this.#activeConfiguration);
    const candidate = new OpenAiCompatiblePlanProvider(configuration);
    await candidate.testConnection();
    if (this.#configurationStore !== undefined && this.#secretProtector !== undefined) {
      const protectedApiKey = await this.#secretProtector.protect(configuration.apiKey);
      this.#configurationStore.save({
        provider: "openai-compatible",
        baseUrl: configuration.baseUrl,
        model: configuration.model,
        protectedApiKey,
        updatedAt: new Date().toISOString(),
      });
    }
    this.#modelProvider = candidate;
    this.#activeConfiguration = configuration;
    this.#restoreReason = undefined;
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
    const status = await this.status();
    if (!status.configured) {
      throw new AiPlanError(status.reason ?? "模型尚未配置。", 503);
    }
    if (request.appId !== undefined && !packageNameIsValid(request.appId)) {
      throw new AiPlanError("测试应用包名无效。", 422);
    }

    const artifactIds = [...new Set(request.installableArtifactIds ?? [])];
    if (artifactIds.length > 0 && this.#apkArtifactService === undefined) {
      throw new AiPlanError("当前 Agent 未启用本地 APK 暂存服务。", 503);
    }
    const installableArtifacts = await Promise.all(
      artifactIds.map(async (artifactId) => {
        try {
          return await this.#apkArtifactService!.find(artifactId);
        } catch (error) {
          throw new AiPlanError(
            `可安装 APK 不可用：${error instanceof Error ? error.message : String(error)}`,
            422,
          );
        }
      }),
    );

    const conversation = this.#resolveConversation(project, request);
    const history =
      conversation === undefined
        ? []
        : (this.#conversationStore?.listMessages(conversation.id) ?? []);

    const projectArtifacts =
      request.workspaceExecution === true && this.#projectBuildService !== undefined
        ? workspaceProjectArtifacts((await this.#projectBuildService.listRuns(project.id)).runs)
        : [];
    const modelPayload =
      currentProjectArtifactInstallPlan(request, projectArtifacts) ??
      (await this.#modelProvider.createPlan({
        system: systemPrompt(request.liveUiExecution === true, request.workspaceExecution === true),
        user: userPrompt(project, request, history, installableArtifacts, projectArtifacts),
      }));
    if (
      request.workspaceExecution !== true &&
      modelPayload.actions.some(containsRestrictedTestAction)
    ) {
      throw new AiPlanError("模型计划包含仅工作区模式支持的操作。", 422);
    }
    if (request.workspaceExecution !== true && !installsOnlyAtPlanStart(modelPayload.actions)) {
      throw new AiPlanError("APK 安装必须位于测试计划的开头。", 422);
    }
    const projectArtifactKeys = new Set(
      projectArtifacts.map((artifact) =>
        projectArtifactKey(artifact.buildId, artifact.artifactIndex),
      ),
    );
    if (
      request.workspaceExecution === true &&
      modelPayload.actions.some(
        (action) =>
          action.action === "project.installArtifact" &&
          !projectArtifactKeys.has(projectArtifactKey(action.buildId, action.artifactIndex)),
      )
    ) {
      throw new AiPlanError("模型计划引用了当前项目不可用的构建 APK。", 422);
    }

    const provisionalPlan = actionPlanSchema.parse({
      id: randomUUID(),
      projectId: project.id,
      ...(request.deviceSerial === undefined ? {} : { deviceSerial: request.deviceSerial }),
      ...(request.appId === undefined ? {} : { targetAppId: request.appId }),
      ...(request.liveUiExecution === true
        ? { liveUiExecution: { goal: request.goal.trim(), maxSteps: 20 } }
        : {}),
      ...(request.workspaceExecution === true ? { workspaceExecution: true } : {}),
      actions: bindActionsToTargetApplication(
        modelPayload.actions,
        request.workspaceExecution === true ? undefined : request.appId,
      ),
      requiresApproval: request.workspaceExecution !== true,
    });
    const policyDecision = evaluateActionPlanPolicy(provisionalPlan, "standard", {
      stagedArtifactIds: new Set(artifactIds),
    });
    if (!policyDecision.allowed) {
      throw new AiPlanError(`模型计划被本地策略拒绝：${policyDecision.reason}`, 422);
    }
    const warnings = policyDecision.actionDecisions
      .filter((decision) => decision.requiresApproval)
      .map((decision) => decision.reason);
    const plan = actionPlanSchema.parse({
      ...provisionalPlan,
      requiresApproval: request.workspaceExecution !== true,
    });
    const response = aiPlanResponseSchema.parse({
      reply: modelPayload.reply,
      plan,
      policy: {
        allowed: true,
        requiresApproval: plan.requiresApproval,
        reason:
          request.workspaceExecution === true
            ? "工作区操作已按当前会话授权执行。"
            : "AI 生成的计划仅供预览，执行前必须获得明确确认。",
        warnings,
      },
      context: contextFor(project),
      generatedAt: new Date().toISOString(),
    });
    const generatedAt = response.generatedAt;
    const contextSnapshotId = randomUUID();
    if (conversation !== undefined && this.#conversationStore !== undefined) {
      this.#conversationStore.createSnapshot({
        id: contextSnapshotId,
        conversationId: conversation.id,
        projectId: project.id,
        sourceRevision: projectContextRevision(project),
        context: response.context,
        createdAt: generatedAt,
      });
    }
    this.#planStore?.save({
      ...response,
      goal: request.goal.trim(),
      ...(conversation === undefined ? {} : { conversationId: conversation.id }),
    });
    if (conversation !== undefined && this.#conversationStore !== undefined) {
      this.#conversationStore.appendMessage({
        id: randomUUID(),
        conversationId: conversation.id,
        role: "user",
        content: request.goal.trim(),
        contextSnapshotId,
        createdAt: generatedAt,
      });
      this.#conversationStore.appendMessage({
        id: randomUUID(),
        conversationId: conversation.id,
        role: "assistant",
        content: response.reply,
        planId: response.plan.id,
        contextSnapshotId,
        createdAt: generatedAt,
      });
      this.#conversationStore.updateContext(conversation.id, {
        sourceRevision: projectContextRevision(project),
        updatedAt: generatedAt,
      });
    }
    return response;
  }

  #resolveConversation(
    project: AndroidProject,
    request: GenerateAiPlanRequest,
  ): AiConversation | undefined {
    if (this.#conversationStore === undefined) {
      if (request.conversationId !== undefined) {
        throw new AiPlanError("当前 Agent 未启用 AI 会话存储。", 503);
      }
      return undefined;
    }
    const conversation = this.#projectConversation(project);
    if (request.conversationId !== undefined && request.conversationId !== conversation.id) {
      const requestedConversation = this.#conversationStore.find(request.conversationId);
      if (requestedConversation === undefined) {
        throw new AiPlanError("未找到 AI 会话。", 404);
      }
      if (requestedConversation.projectId !== project.id) {
        throw new AiPlanError("AI 会话不属于当前项目。", 422);
      }
      throw new AiPlanError("当前项目仅保留一个 AI 会话。", 422);
    }
    return conversation;
  }

  #projectConversation(project: AndroidProject): AiConversation {
    if (this.#conversationStore === undefined) {
      throw new AiPlanError("当前 Agent 未启用 AI 会话存储。", 503);
    }
    const existing = this.#conversationStore.listByProject(project.id)[0];
    if (existing !== undefined) {
      return existing;
    }
    const now = new Date().toISOString();
    return this.#conversationStore.create({
      id: randomUUID(),
      projectId: project.id,
      title: `${project.name} 测试会话`,
      sourceRevision: projectContextRevision(project),
      createdAt: now,
      updatedAt: now,
    });
  }

  #withCurrentContextStatus(conversation: AiConversation, project: AndroidProject): AiConversation {
    const contextStatus =
      project.sourceIndex === undefined
        ? "unavailable"
        : conversation.sourceRevision === projectContextRevision(project)
          ? "current"
          : "outdated";
    return { ...conversation, contextStatus };
  }

  public async decideRuntimeStep(request: AiRuntimeStepRequest): Promise<AiRuntimeStepDecision> {
    const project = this.#projectStore.findById(request.projectId);
    if (project === undefined) {
      throw new AiPlanError("未找到项目。", 404);
    }
    if (!packageNameIsValid(request.appId)) {
      throw new AiPlanError("测试应用包名无效。", 422);
    }
    if (request.goal.trim().length === 0 || request.uiContext.trim().length === 0) {
      throw new AiPlanError("实时页面上下文不完整。", 422);
    }
    const status = await this.status();
    if (!status.configured) {
      throw new AiPlanError(status.reason ?? "模型尚未配置。", 503);
    }
    if (this.#modelProvider.createRuntimeDecision === undefined) {
      throw new AiPlanError("当前 AI 模型提供方不支持实时页面执行。", 503);
    }

    const decision = await this.#modelProvider.createRuntimeDecision({
      system: runtimeSystemPrompt(),
      user: runtimeUserPrompt(project, request),
      ...(request.screenshot === undefined ? {} : { screenshot: request.screenshot }),
    });
    if (decision.status === "continue" && !isRuntimeAction(decision.action)) {
      throw new AiPlanError("模型返回了不允许的实时页面操作。", 422);
    }
    if (decision.status === "completed" && !isRuntimeCompletionAssertion(decision.assertion)) {
      throw new AiPlanError("模型必须使用断言确认测试目标完成。", 422);
    }
    if (!runtimeDecisionUsesVisibleCoordinates(decision, request.screenshot)) {
      throw new AiPlanError("模型返回了当前截图范围外的坐标操作。", 422);
    }
    return decision;
  }
}
