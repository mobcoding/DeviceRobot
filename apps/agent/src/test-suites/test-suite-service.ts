import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import {
  actionPlanSchema,
  testSuiteListResponseSchema,
  testSuiteRecordSchema,
  type StartTestSuiteCaseRequest,
  type TestExecutionRun,
  type TestSuiteListResponse,
  type TestSuiteRecord,
} from "@device-robot/contracts";
import { TestDslParseError, parseTestSuiteDocument } from "@device-robot/test-dsl";

import type { ProjectStore } from "../projects/project-store.js";
import type { TestExecutionService } from "../test-execution/test-execution-service.js";
import type { TestSuiteStore } from "./test-suite-store.js";

const MAX_TEST_SUITE_BYTES = 1_048_576;
const supportedExtensions = new Set([".json", ".yaml", ".yml"]);

export class TestSuiteError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 422,
  ) {
    super(message);
  }
}

export interface TestSuiteService {
  list(projectId: string): Promise<TestSuiteListResponse>;
  import(projectId: string, fileName: string, contents: Buffer): Promise<TestSuiteRecord>;
  startCase(
    projectId: string,
    suiteId: string,
    caseId: string,
    request: StartTestSuiteCaseRequest,
  ): Promise<TestExecutionRun>;
}

export type LocalTestSuiteServiceOptions = {
  store: TestSuiteStore;
  projectStore: ProjectStore;
  testExecutionService: TestExecutionService;
};

function normalizedFileName(fileName: string): string {
  const name = basename(fileName).trim();
  if (
    name.length === 0 ||
    name.length > 255 ||
    !supportedExtensions.has(extname(name).toLowerCase())
  ) {
    throw new TestSuiteError("仅支持导入 .json、.yaml 或 .yml 测试用例文件。", 422);
  }
  return name;
}

export class LocalTestSuiteService implements TestSuiteService {
  readonly #store: TestSuiteStore;
  readonly #projectStore: ProjectStore;
  readonly #testExecutionService: TestExecutionService;

  public constructor(options: LocalTestSuiteServiceOptions) {
    this.#store = options.store;
    this.#projectStore = options.projectStore;
    this.#testExecutionService = options.testExecutionService;
  }

  public async list(projectId: string): Promise<TestSuiteListResponse> {
    this.#requireProject(projectId);
    return testSuiteListResponseSchema.parse({
      projectId,
      suites: this.#store.listByProject(projectId),
    });
  }

  public async import(
    projectId: string,
    fileName: string,
    contents: Buffer,
  ): Promise<TestSuiteRecord> {
    this.#requireProject(projectId);
    const safeFileName = normalizedFileName(fileName);
    if (contents.byteLength === 0) {
      throw new TestSuiteError("测试用例文件为空。", 422);
    }
    if (contents.byteLength > MAX_TEST_SUITE_BYTES) {
      throw new TestSuiteError("测试用例文件不能超过 1 MB。", 422);
    }

    let suite;
    try {
      suite = parseTestSuiteDocument(contents.toString("utf8"), safeFileName);
    } catch (error) {
      if (error instanceof TestDslParseError) {
        throw new TestSuiteError(error.message, 422);
      }
      throw error;
    }

    const record = testSuiteRecordSchema.parse({
      id: randomUUID(),
      projectId,
      fileName: safeFileName,
      suite,
      importedAt: new Date().toISOString(),
    });
    this.#store.create(record);
    return record;
  }

  public async startCase(
    projectId: string,
    suiteId: string,
    caseId: string,
    request: StartTestSuiteCaseRequest,
  ): Promise<TestExecutionRun> {
    this.#requireProject(projectId);
    const record = this.#store.findById(projectId, suiteId);
    if (record === undefined) {
      throw new TestSuiteError("未找到测试用例集。", 404);
    }
    const testCase = record.suite.cases.find((candidate) => candidate.id === caseId);
    if (testCase === undefined) {
      throw new TestSuiteError("未找到测试用例。", 404);
    }

    const plan = actionPlanSchema.parse({
      id: `dsl:${record.id}:${testCase.id}`,
      projectId,
      actions: testCase.steps.map((step) => step.action),
      requiresApproval: true,
    });
    return await this.#testExecutionService.start({
      plan,
      deviceSerial: request.deviceSerial,
      appId: record.suite.appId,
      name: testCase.name,
      approved: request.approved,
    });
  }

  #requireProject(projectId: string): void {
    if (this.#projectStore.findById(projectId) === undefined) {
      throw new TestSuiteError("未找到测试项目。", 404);
    }
  }
}
