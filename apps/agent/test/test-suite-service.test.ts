import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StartTestExecutionRequest, TestExecutionRun } from "@device-robot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../src/db/database.js";
import { SqliteTestSuiteStore } from "../src/test-suites/test-suite-store.js";
import { LocalTestSuiteService, TestSuiteError } from "../src/test-suites/test-suite-service.js";
import type { ProjectStore } from "../src/projects/project-store.js";
import type { TestExecutionService } from "../src/test-execution/test-execution-service.js";

const temporaryDirectories: string[] = [];
const projectId = "123e4567-e89b-12d3-a456-426614174000";

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "device-robot-test-suite-"));
  temporaryDirectories.push(root);
  return root;
}

function projectStore(): ProjectStore {
  const project = {
    id: projectId,
    name: "Example",
    source: "local" as const,
    rootPath: "C:\\Github\\Example",
    gradleWrapper: true,
    modules: [],
    createdAt: "2026-07-23T10:00:00.000Z",
    updatedAt: "2026-07-23T10:00:00.000Z",
  };
  return {
    list: () => [project],
    findById: (id) => (id === projectId ? project : undefined),
    findByRootPath: () => undefined,
    create: () => {},
    delete: () => {},
    updateName: () => {},
    updateSourceIndex: () => {},
  };
}

function runningRun(request: StartTestExecutionRequest): TestExecutionRun {
  return {
    id: randomUUID(),
    projectId: request.plan.projectId,
    planId: request.plan.id,
    name: request.name ?? "测试",
    deviceSerial: request.deviceSerial,
    appId: request.appId,
    status: "running",
    steps: request.plan.actions.map((action, index) => ({
      index,
      action,
      status: "pending",
      screenshotAvailable: false,
    })),
    startedAt: new Date().toISOString(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("test suite service", () => {
  it("imports a YAML suite, persists it, and starts a selected case through the executor", async () => {
    const database = openDatabase(join(createTemporaryRoot(), "test.db"));
    const start = vi.fn(async (request: StartTestExecutionRequest) => runningRun(request));
    const service = new LocalTestSuiteService({
      store: new SqliteTestSuiteStore(database.sqlite),
      projectStore: projectStore(),
      testExecutionService: {
        start,
      } as unknown as TestExecutionService,
    });

    const imported = await service.import(
      projectId,
      "smoke.yaml",
      Buffer.from(
        [
          "schemaVersion: 1",
          "appId: com.example.app",
          "suite:",
          "  id: smoke",
          "  name: Smoke suite",
          "  sourceRevision: main",
          "cases:",
          "  - id: opens-home",
          "    name: Opens home",
          "    priority: P0",
          "    steps:",
          "      - id: launch",
          "        action:",
          "          action: app.launch",
          "          appId: com.example.app",
          "      - id: wait-home",
          "        action:",
          "          action: assert.visible",
          "          target:",
          "            text: Home",
        ].join("\n"),
      ),
    );

    expect(imported).toMatchObject({
      projectId,
      fileName: "smoke.yaml",
      suite: { appId: "com.example.app", cases: [{ id: "opens-home" }] },
    });
    await expect(service.list(projectId)).resolves.toMatchObject({ suites: [imported] });

    await service.startCase(projectId, imported.id, "opens-home", {
      deviceSerial: "device-1",
      approved: true,
    });
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceSerial: "device-1",
        appId: "com.example.app",
        name: "Opens home",
        plan: expect.objectContaining({
          id: `dsl:${imported.id}:opens-home`,
          actions: [
            { action: "app.launch", appId: "com.example.app" },
            { action: "assert.visible", target: { text: "Home" } },
          ],
        }),
      }),
    );
    database.close();
  });

  it("rejects unsupported uploads and missing test cases", async () => {
    const database = openDatabase(join(createTemporaryRoot(), "test.db"));
    const service = new LocalTestSuiteService({
      store: new SqliteTestSuiteStore(database.sqlite),
      projectStore: projectStore(),
      testExecutionService: {} as TestExecutionService,
    });

    await expect(service.import(projectId, "suite.txt", Buffer.from("{}"))).rejects.toBeInstanceOf(
      TestSuiteError,
    );
    const imported = await service.import(
      projectId,
      "suite.json",
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          appId: "com.example.app",
          suite: { id: "suite", name: "Suite", sourceRevision: "main" },
          cases: [
            {
              id: "case-1",
              name: "Case 1",
              steps: [{ id: "wait", action: { action: "ui.wait", durationMs: 1 } }],
            },
          ],
        }),
      ),
    );
    await expect(
      service.startCase(projectId, imported.id, "missing", {
        deviceSerial: "device-1",
        approved: true,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    database.close();
  });
});
