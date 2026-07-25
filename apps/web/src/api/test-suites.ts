import {
  startTestSuiteCaseRequestSchema,
  testExecutionRunSchema,
  testSuiteListResponseSchema,
  testSuiteRecordSchema,
  type StartTestSuiteCaseRequest,
  type TestExecutionRun,
  type TestSuiteListResponse,
  type TestSuiteRecord,
} from "@device-robot/contracts";

import { requestJson } from "./client";

export async function fetchTestSuites(
  projectId: string,
  signal?: AbortSignal,
): Promise<TestSuiteListResponse> {
  return await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/test-suites`,
    {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    },
    testSuiteListResponseSchema,
    "测试用例读取失败。",
  );
}

export async function importTestSuite(projectId: string, file: File): Promise<TestSuiteRecord> {
  const form = new FormData();
  form.set("file", file, file.name);
  return await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/test-suites`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
      body: form,
    },
    testSuiteRecordSchema,
    "测试用例导入失败。",
  );
}

export async function startTestSuiteCase(
  projectId: string,
  suiteId: string,
  caseId: string,
  request: StartTestSuiteCaseRequest,
): Promise<TestExecutionRun> {
  return await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/test-suites/${encodeURIComponent(
      suiteId,
    )}/cases/${encodeURIComponent(caseId)}/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(startTestSuiteCaseRequestSchema.parse(request)),
    },
    testExecutionRunSchema,
    "测试用例启动失败。",
  );
}
