import { healthResponseSchema, type HealthResponse } from "@device-robot/contracts";

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  let response: Response;
  try {
    response = await fetch("/api/v1/system/health", {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new Error("无法连接本地 Agent。请确认服务正在运行。");
  }

  if (!response.ok) {
    throw new Error(`本地 Agent 健康检查失败（HTTP ${response.status}）`);
  }

  return healthResponseSchema.parse(await response.json());
}
