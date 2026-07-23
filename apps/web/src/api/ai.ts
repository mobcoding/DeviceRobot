import {
  aiModelConnectionTestResponseSchema,
  aiModelListResponseSchema,
  aiModelStatusSchema,
  aiPlanListResponseSchema,
  aiPlanResponseSchema,
  type AiModelConnectionTestRequest,
  type AiModelConnectionTestResponse,
  type AiModelListRequest,
  type AiModelListResponse,
  type AiModelStatus,
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
