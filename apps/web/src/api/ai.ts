import {
  aiModelConnectionTestResponseSchema,
  aiModelListResponseSchema,
  aiModelStatusSchema,
  aiPlanResponseSchema,
  type AiModelConnectionTestRequest,
  type AiModelConnectionTestResponse,
  type AiModelListRequest,
  type AiModelListResponse,
  type AiModelStatus,
  type AiPlanResponse,
  type GenerateAiPlanRequest,
} from "@device-robot/contracts";

async function aiRequest<T>(
  url: string,
  init: RequestInit | undefined,
  schema: { parse(value: unknown): T },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error("无法连接本地 Agent。请确认 Agent 正在运行。");
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { error?: unknown } | undefined;
    throw new Error(typeof payload?.error === "string" ? payload.error : "AI 请求失败。");
  }
  return schema.parse(await response.json());
}

export async function fetchAiModelStatus(signal?: AbortSignal): Promise<AiModelStatus> {
  return await aiRequest(
    "/api/v1/ai/status",
    {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    },
    aiModelStatusSchema,
  );
}

export async function fetchAiModels(request: AiModelListRequest): Promise<AiModelListResponse> {
  return await aiRequest(
    "/api/v1/ai/models",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
    },
    aiModelListResponseSchema,
  );
}

export async function testAiModelConfiguration(
  request: AiModelConnectionTestRequest,
): Promise<AiModelConnectionTestResponse> {
  return await aiRequest(
    "/api/v1/ai/config/test",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
    },
    aiModelConnectionTestResponseSchema,
  );
}

export async function generateAiPlan(request: GenerateAiPlanRequest): Promise<AiPlanResponse> {
  return await aiRequest(
    "/api/v1/ai/plans",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
    },
    aiPlanResponseSchema,
  );
}
