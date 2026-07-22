import {
  startTestExecutionRequestSchema,
  testExecutionRunListResponseSchema,
  testExecutionRunSchema,
  type StartTestExecutionRequest,
  type TestExecutionRun,
  type TestExecutionRunListResponse,
} from "@device-robot/contracts";

async function requestJson<T>(
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T,
): Promise<T> {
  const response = await fetch(path, init);
  const payload = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : "测试运行请求失败。");
  }
  return parse(payload);
}

export async function fetchTestRuns(signal?: AbortSignal): Promise<TestExecutionRunListResponse> {
  return await requestJson(
    "/api/v1/test-runs",
    { headers: { Accept: "application/json" }, ...(signal === undefined ? {} : { signal }) },
    (payload) => testExecutionRunListResponseSchema.parse(payload),
  );
}

export async function startTestExecution(
  request: StartTestExecutionRequest,
): Promise<TestExecutionRun> {
  return await requestJson(
    "/api/v1/test-runs",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(startTestExecutionRequestSchema.parse(request)),
    },
    (payload) => testExecutionRunSchema.parse(payload),
  );
}

export async function cancelTestExecution(runId: string): Promise<TestExecutionRun> {
  return await requestJson(
    `/api/v1/test-runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST", headers: { Accept: "application/json" } },
    (payload) => testExecutionRunSchema.parse(payload),
  );
}

export function testStepScreenshotUrl(runId: string, stepIndex: number): string {
  return `/api/v1/test-runs/${encodeURIComponent(runId)}/steps/${stepIndex}/screenshot`;
}
