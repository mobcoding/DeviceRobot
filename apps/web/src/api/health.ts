import { healthResponseSchema, type HealthResponse } from "@device-robot/contracts";

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch("/api/v1/system/health", {
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });

  if (!response.ok) {
    throw new Error(`Agent health request failed with status ${response.status}`);
  }

  return healthResponseSchema.parse(await response.json());
}
