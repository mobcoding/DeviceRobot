import {
  aiModelConnectionTestResponseSchema,
  aiModelListResponseSchema,
  aiModelStatusSchema,
  aiConversationDetailResponseSchema,
  aiConversationListResponseSchema,
  aiConversationSchema,
  aiPlanListResponseSchema,
  aiPlanResponseSchema,
  type AiModelConnectionTestRequest,
  type AiModelConnectionTestResponse,
  type AiModelListRequest,
  type AiModelListResponse,
  type AiModelStatus,
  type AiConversation,
  type AiConversationDetailResponse,
  type AiConversationListResponse,
  type CreateAiConversationRequest,
  type AiPlanListResponse,
  type AiPlanResponse,
  type GenerateAiPlanRequest,
} from "@device-robot/contracts";

import { requestJson } from "./client";

export async function fetchAiModelStatus(signal?: AbortSignal): Promise<AiModelStatus> {
  return await requestJson(
    "/api/v1/ai/status",
    {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    },
    aiModelStatusSchema,
    "AI 状态请求失败。",
  );
}

export async function fetchAiPlans(signal?: AbortSignal): Promise<AiPlanListResponse> {
  return await requestJson(
    "/api/v1/ai/plans",
    {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    },
    aiPlanListResponseSchema,
    "AI 计划读取失败。",
  );
}

export async function fetchAiConversations(
  projectId: string,
  signal?: AbortSignal,
): Promise<AiConversationListResponse> {
  return await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/ai-conversations`,
    {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    },
    aiConversationListResponseSchema,
    "AI 会话读取失败。",
  );
}

export async function createAiConversation(
  projectId: string,
  request: CreateAiConversationRequest,
): Promise<AiConversation> {
  return await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/ai-conversations`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
    },
    aiConversationSchema,
    "创建 AI 会话失败。",
  );
}

export async function fetchAiConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<AiConversationDetailResponse> {
  return await requestJson(
    `/api/v1/ai-conversations/${encodeURIComponent(conversationId)}`,
    {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    },
    aiConversationDetailResponseSchema,
    "AI 会话详情读取失败。",
  );
}

export async function fetchAiModels(request: AiModelListRequest): Promise<AiModelListResponse> {
  return await requestJson(
    "/api/v1/ai/models",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
    },
    aiModelListResponseSchema,
    "AI 模型列表请求失败。",
  );
}

export async function testAiModelConfiguration(
  request: AiModelConnectionTestRequest,
): Promise<AiModelConnectionTestResponse> {
  return await requestJson(
    "/api/v1/ai/config/test",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
    },
    aiModelConnectionTestResponseSchema,
    "AI 模型连接测试失败。",
  );
}

export async function generateAiPlan(request: GenerateAiPlanRequest): Promise<AiPlanResponse> {
  return await requestJson(
    "/api/v1/ai/plans",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
    },
    aiPlanResponseSchema,
    "AI 计划生成失败。",
  );
}
