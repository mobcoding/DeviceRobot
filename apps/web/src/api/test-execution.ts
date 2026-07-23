import {
  startTestExecutionRequestSchema,
  testExecutionRunListResponseSchema,
  testExecutionRunSchema,
  type StartTestExecutionRequest,
  type TestExecutionRun,
  type TestExecutionRunListResponse,
} from "@device-robot/contracts";

import { requestJson } from "./client";

export async function fetchTestRuns(signal?: AbortSignal): Promise<TestExecutionRunListResponse> {
  return await requestJson(
    "/api/v1/test-runs",
    { headers: { Accept: "application/json" }, ...(signal === undefined ? {} : { signal }) },
    testExecutionRunListResponseSchema,
    "测试运行读取失败。",
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
    testExecutionRunSchema,
    "测试启动失败。",
  );
}

export async function cancelTestExecution(runId: string): Promise<TestExecutionRun> {
  return await requestJson(
    `/api/v1/test-runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST", headers: { Accept: "application/json" } },
    testExecutionRunSchema,
    "测试取消失败。",
  );
}

export function testStepScreenshotUrl(runId: string, stepIndex: number): string {
  return `/api/v1/test-runs/${encodeURIComponent(runId)}/steps/${stepIndex}/screenshot`;
}
