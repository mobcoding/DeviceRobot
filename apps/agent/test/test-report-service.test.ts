import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentPaths, type AgentPaths } from "@device-robot/config";
import type { TestExecutionRun } from "@device-robot/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  LocalTestReportService,
  TestReportError,
} from "../src/test-reports/test-report-service.js";
import type { TestExecutionService } from "../src/test-execution/test-execution-service.js";

const temporaryDirectories: string[] = [];
const runId = "123e4567-e89b-12d3-a456-426614174000";

function createTemporaryPaths(): AgentPaths {
  const root = mkdtempSync(join(tmpdir(), "device-robot-test-report-"));
  temporaryDirectories.push(root);
  return resolveAgentPaths(root);
}

function completedRun(status: "succeeded" | "failed" = "failed"): TestExecutionRun {
  return {
    id: runId,
    projectId: "223e4567-e89b-12d3-a456-426614174000",
    planId: "dsl:smoke:opens-home",
    name: "首页冒烟测试",
    deviceSerial: "device-1",
    appId: "com.example.app",
    status,
    message: status === "failed" ? "找不到首页元素。" : "测试运行完成。",
    steps: [
      {
        index: 0,
        action: { action: "assert.visible", target: { text: "首页" } },
        status,
        ...(status === "failed" ? { message: "找不到首页元素。" } : {}),
        screenshotAvailable: true,
        startedAt: "2026-07-23T10:00:00.000Z",
        finishedAt: "2026-07-23T10:00:01.000Z",
      },
    ],
    startedAt: "2026-07-23T10:00:00.000Z",
    finishedAt: "2026-07-23T10:00:01.000Z",
  };
}

function executionService(run: TestExecutionRun, screenshot: string): TestExecutionService {
  return {
    list: async () => ({ runs: [run] }),
    find: async (id) => {
      if (id !== run.id) {
        throw Object.assign(new Error("未找到测试运行记录。"), { statusCode: 404 });
      }
      return run;
    },
    start: async () => run,
    cancel: async () => run,
    screenshotPath: async () => screenshot,
    dispose: async () => {},
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("test report service", () => {
  it("creates a standalone HTML report and ZIP with screenshots and failure evidence", async () => {
    const paths = createTemporaryPaths();
    const reportDirectory = join(paths.reports, runId);
    const screenshotPath = join(reportDirectory, "steps", "001.png");
    await mkdir(join(reportDirectory, "steps"), { recursive: true });
    await mkdir(join(reportDirectory, "evidence"), { recursive: true });
    await writeFile(screenshotPath, Buffer.from("png-data"));
    await writeFile(join(reportDirectory, "evidence", "step-001.xml"), "<hierarchy />");
    await writeFile(join(reportDirectory, "evidence", "step-001-logcat.log"), "E App: failure");
    await writeFile(join(reportDirectory, "evidence", "appium.log"), "[Appium] failure");

    const service = new LocalTestReportService({
      paths,
      testExecutionService: executionService(completedRun(), screenshotPath),
    });

    const report = await service.generate(runId);
    expect(report).toMatchObject({
      run: { id: runId, status: "failed" },
      screenshotCount: 1,
      evidence: { uiXml: true, logcat: true, appiumLog: true },
    });
    const html = await readFile(await service.htmlPath(runId), "utf8");
    expect(html).toContain("DeviceRobot 测试执行报告");
    expect(html).toContain("data:image/png;base64");
    expect(html).toContain("step-001.xml");
    const zip = await readFile(await service.zipPath(runId));
    expect(zip.subarray(0, 2).toString("utf8")).toBe("PK");
  });

  it("does not generate a mutable report for a running test", async () => {
    const paths = createTemporaryPaths();
    const unfinishedRun = completedRun();
    delete unfinishedRun.finishedAt;
    const running = { ...unfinishedRun, status: "running" as const };
    const service = new LocalTestReportService({
      paths,
      testExecutionService: executionService(running, join(paths.reports, "missing.png")),
    });

    await expect(service.generate(runId)).rejects.toBeInstanceOf(TestReportError);
  });
});
