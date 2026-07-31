import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import {
  actionPlanSchema,
  testSuiteListResponseSchema,
  testSuiteRecordSchema,
  type AgentAction,
  type SaveExplorationAsTestSuiteRequest,
  type StartTestSuiteCaseRequest,
  type TestCase,
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
  saveExploration(
    projectId: string,
    request: SaveExplorationAsTestSuiteRequest,
  ): Promise<TestSuiteRecord>;
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

function explorationSuiteId(appId: string): string {
  return `ai-exploration-${appId.replaceAll(/[^A-Za-z0-9]+/gu, "-")}`.slice(0, 256);
}

function replayableExplorationAction(action: AgentAction): boolean {
  // Uploaded APK IDs are short-lived, while a saved DSL needs to be replayable later without
  // depending on the original AI session or a temporary artifact cache.
  return (
    action.action !== "app.install" &&
    action.action !== "app.uninstall" &&
    action.action !== "adb.shell" &&
    action.action !== "project.build" &&
    action.action !== "project.installArtifact"
  );
}

function caseFromExploration(run: TestExecutionRun, name: string | undefined): TestCase {
  const steps = run.steps
    .filter((step) => step.status === "succeeded" && replayableExplorationAction(step.action))
    .map((step, index) => ({
      id: `step-${index + 1}`,
      action: step.action,
      healingEnabled: false,
    }));
  if (steps.length === 0) {
    throw new TestSuiteError("探索运行没有可离线复用的成功步骤。", 422);
  }
  return {
    id: `exploration-${run.id}`,
    name: name ?? run.name,
    priority: "P1",
    tags: ["ai-exploration", "offline"],
    sourceEvidence: [],
    data: {},
    steps,
  };
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

  public async saveExploration(
    projectId: string,
    request: SaveExplorationAsTestSuiteRequest,
  ): Promise<TestSuiteRecord> {
    const project = this.#requireProject(projectId);
    const run = await this.#testExecutionService.find(request.runId);
    if (run.projectId !== projectId) {
      throw new TestSuiteError("探索运行不属于当前测试项目。", 404);
    }
    if (run.status !== "succeeded") {
      throw new TestSuiteError("仅可保存已成功完成的 AI 探索运行。", 409);
    }
    if (run.executionMode !== "ai-exploration") {
      throw new TestSuiteError("仅 AI 自主探索运行可以保存为离线 DSL 用例。", 422);
    }

    const existing = this.#store
      .listByProject(projectId)
      .find(
        (record) =>
          record.suite.appId === run.appId && record.suite.suite.origin === "ai-exploration",
      );
    if (existing?.suite.suite.sourceRunIds.includes(run.id) === true) {
      return existing;
    }

    const testCase = caseFromExploration(run, request.name);
    const savedAt = new Date().toISOString();
    if (existing !== undefined) {
      const record = testSuiteRecordSchema.parse({
        ...existing,
        suite: {
          ...existing.suite,
          suite: {
            ...existing.suite.suite,
            version: existing.suite.suite.version + 1,
            sourceRunIds: [...existing.suite.suite.sourceRunIds, run.id],
          },
          cases: [...existing.suite.cases, testCase],
        },
        importedAt: savedAt,
      });
      this.#store.update(record);
      return record;
    }

    const record = testSuiteRecordSchema.parse({
      id: randomUUID(),
      projectId,
      fileName: `${explorationSuiteId(run.appId)}.json`,
      suite: {
        schemaVersion: 1,
        appId: run.appId,
        suite: {
          id: explorationSuiteId(run.appId),
          name: "AI 探索离线用例",
          sourceRevision: project.revision ?? "local",
          origin: "ai-exploration",
          version: 1,
          sourceRunIds: [run.id],
        },
        cases: [testCase],
      },
      importedAt: savedAt,
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

  #requireProject(projectId: string) {
    const project = this.#projectStore.findById(projectId);
    if (project === undefined) {
      throw new TestSuiteError("未找到测试项目。", 404);
    }
    return project;
  }
}
