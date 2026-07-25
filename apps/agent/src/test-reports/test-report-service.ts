import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import archiver from "archiver";
import type { AgentPaths } from "@device-robot/config";
import {
  testExecutionReportSchema,
  type TestExecutionReport,
  type TestExecutionRun,
  type TestStepExecution,
} from "@device-robot/contracts";

import type { TestExecutionService } from "../test-execution/test-execution-service.js";

const MAX_EVIDENCE_TEXT_BYTES = 1_048_576;

export class TestReportError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: 404 | 409 | 500,
  ) {
    super(message);
  }
}

export interface TestReportService {
  generate(runId: string): Promise<TestExecutionReport>;
  htmlPath(runId: string): Promise<string>;
  zipPath(runId: string): Promise<string>;
}

export type LocalTestReportServiceOptions = {
  paths: AgentPaths;
  testExecutionService: TestExecutionService;
};

type ReportAsset = {
  relativePath: string;
  text: string;
};

type ScreenshotAsset = {
  index: number;
  dataUrl: string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDateTime(value: string | undefined): string {
  if (value === undefined) {
    return "-";
  }
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function statusLabel(status: TestExecutionRun["status"] | TestStepExecution["status"]): string {
  switch (status) {
    case "succeeded":
      return "通过";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "running":
      return "执行中";
    case "pending":
      return "等待中";
  }
}

function reportDirectory(paths: AgentPaths, runId: string): string {
  return join(paths.reports, runId);
}

function reportHtmlPath(paths: AgentPaths, runId: string): string {
  return join(reportDirectory(paths, runId), "report.html");
}

function reportZipPath(paths: AgentPaths, runId: string): string {
  return join(reportDirectory(paths, runId), "report.zip");
}

async function readBoundedText(path: string): Promise<string | undefined> {
  try {
    const data = await readFile(path);
    const truncated = data.byteLength > MAX_EVIDENCE_TEXT_BYTES;
    const value = data
      .subarray(Math.max(0, data.byteLength - MAX_EVIDENCE_TEXT_BYTES))
      .toString("utf8");
    return truncated ? `[仅保留末尾 ${MAX_EVIDENCE_TEXT_BYTES / 1_024} KB]\n${value}` : value;
  } catch {
    return undefined;
  }
}

async function readEvidence(directory: string): Promise<ReportAsset[]> {
  try {
    const names = await readdir(directory);
    const assets = await Promise.all(
      names
        .filter((name) => name.endsWith(".xml") || name.endsWith(".log"))
        .sort((left, right) => left.localeCompare(right))
        .map(async (name) => {
          const text = await readBoundedText(join(directory, name));
          return text === undefined ? undefined : { relativePath: `evidence/${name}`, text };
        }),
    );
    return assets.filter((asset): asset is ReportAsset => asset !== undefined);
  } catch {
    return [];
  }
}

async function createZip(
  sourceDirectory: string,
  htmlPath: string,
  zipPath: string,
): Promise<void> {
  const temporaryPath = `${zipPath}.tmp`;
  await rm(temporaryPath, { force: true });
  await new Promise<void>((resolveArchive, rejectArchive) => {
    const output = createWriteStream(temporaryPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    let settled = false;
    const resolveOnce = (): void => {
      if (!settled) {
        settled = true;
        resolveArchive();
      }
    };
    const rejectOnce = (error: Error): void => {
      if (!settled) {
        settled = true;
        rejectArchive(error);
      }
    };

    output.once("close", resolveOnce);
    output.once("error", rejectOnce);
    archive.once("error", rejectOnce);
    archive.pipe(output);
    archive.file(htmlPath, { name: "report.html" });
    if (existsSync(join(sourceDirectory, "steps"))) {
      archive.directory(join(sourceDirectory, "steps"), "steps");
    }
    if (existsSync(join(sourceDirectory, "evidence"))) {
      archive.directory(join(sourceDirectory, "evidence"), "evidence");
    }
    void archive.finalize();
  });
  await rename(temporaryPath, zipPath);
}

export class LocalTestReportService implements TestReportService {
  readonly #paths: AgentPaths;
  readonly #testExecutionService: TestExecutionService;
  readonly #generations = new Map<string, Promise<TestExecutionReport>>();

  public constructor(options: LocalTestReportServiceOptions) {
    this.#paths = options.paths;
    this.#testExecutionService = options.testExecutionService;
  }

  public async generate(runId: string): Promise<TestExecutionReport> {
    const existing = this.#generations.get(runId);
    if (existing !== undefined) {
      return await existing;
    }
    const generation = this.#generate(runId).finally(() => this.#generations.delete(runId));
    this.#generations.set(runId, generation);
    return await generation;
  }

  public async htmlPath(runId: string): Promise<string> {
    await this.generate(runId);
    return reportHtmlPath(this.#paths, runId);
  }

  public async zipPath(runId: string): Promise<string> {
    await this.generate(runId);
    return reportZipPath(this.#paths, runId);
  }

  async #generate(runId: string): Promise<TestExecutionReport> {
    let run: TestExecutionRun;
    try {
      run = await this.#testExecutionService.find(runId);
    } catch (error) {
      if (error instanceof Error && "statusCode" in error && error.statusCode === 404) {
        throw new TestReportError("未找到测试运行记录。", 404);
      }
      throw error;
    }
    if (run.status === "running") {
      throw new TestReportError("测试运行尚未结束，暂时无法生成报告。", 409);
    }

    const directory = reportDirectory(this.#paths, run.id);
    await mkdir(directory, { recursive: true });
    const screenshots = await this.#readScreenshots(run);
    const evidence = await readEvidence(join(directory, "evidence"));
    const htmlPath = reportHtmlPath(this.#paths, run.id);
    await writeFile(htmlPath, this.#renderHtml(run, screenshots, evidence), "utf8");
    const zipPath = reportZipPath(this.#paths, run.id);
    await createZip(directory, htmlPath, zipPath);

    const evidencePaths = new Set(evidence.map((asset) => asset.relativePath));
    return testExecutionReportSchema.parse({
      run,
      generatedAt: new Date().toISOString(),
      htmlFileName: "report.html",
      zipFileName: "report.zip",
      screenshotCount: screenshots.length,
      evidence: {
        uiXml: [...evidencePaths].some((path) => path.endsWith(".xml")),
        logcat: [...evidencePaths].some((path) => path.includes("logcat")),
        appiumLog: evidencePaths.has("evidence/appium.log"),
      },
    });
  }

  async #readScreenshots(run: TestExecutionRun): Promise<ScreenshotAsset[]> {
    const assets = await Promise.all(
      run.steps.map(async (step) => {
        if (!step.screenshotAvailable) {
          return undefined;
        }
        try {
          const path = await this.#testExecutionService.screenshotPath(run.id, step.index);
          const image = await readFile(path);
          return {
            index: step.index,
            dataUrl: `data:image/png;base64,${image.toString("base64")}`,
          };
        } catch {
          return undefined;
        }
      }),
    );
    return assets.filter((asset): asset is ScreenshotAsset => asset !== undefined);
  }

  #renderHtml(
    run: TestExecutionRun,
    screenshots: ScreenshotAsset[],
    evidence: ReportAsset[],
  ): string {
    const screenshotsByIndex = new Map(screenshots.map((asset) => [asset.index, asset]));
    const stepRows = run.steps
      .map((step) => {
        const screenshot = screenshotsByIndex.get(step.index);
        return `<article class="step step-${step.status}">
  <header><span class="step-index">${step.index + 1}</span><strong>${escapeHtml(step.action.action)}</strong><span class="status">${statusLabel(step.status)}</span></header>
  <dl><div><dt>开始</dt><dd>${escapeHtml(formatDateTime(step.startedAt))}</dd></div><div><dt>结束</dt><dd>${escapeHtml(formatDateTime(step.finishedAt))}</dd></div></dl>
  ${step.message === undefined ? "" : `<p class="message">${escapeHtml(step.message)}</p>`}
  ${screenshot === undefined ? "" : `<img src="${screenshot.dataUrl}" alt="步骤 ${step.index + 1} 设备截图" />`}
</article>`;
      })
      .join("\n");
    const evidenceSections = evidence
      .map(
        (asset) =>
          `<details><summary>${escapeHtml(asset.relativePath)}</summary><pre>${escapeHtml(asset.text)}</pre></details>`,
      )
      .join("\n");
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(run.name)} - DeviceRobot 测试报告</title>
  <style>
    :root { color-scheme: light; font-family: "Microsoft YaHei UI", "Noto Sans SC", sans-serif; color: #172033; background: #f4f6fa; }
    body { margin: 0; padding: 28px; }
    main { max-width: 1080px; margin: 0 auto; }
    header.report { border-bottom: 1px solid #d9dfeb; padding-bottom: 20px; margin-bottom: 20px; }
    h1 { margin: 0 0 8px; font-size: 24px; } p { line-height: 1.6; } .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-top: 18px; }
    .meta div, .step, details { background: #fff; border: 1px solid #d9dfeb; border-radius: 6px; padding: 12px; } .meta span { display: block; color: #65718a; font-size: 12px; margin-bottom: 4px; }
    h2 { margin: 28px 0 12px; font-size: 18px; } .steps { display: grid; gap: 12px; }.step header { display: flex; align-items: center; gap: 10px; }.step-index { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: #eef2f8; font-size: 12px; }.status { margin-left: auto; color: #2f6a48; }.step-failed .status { color: #b42318; }.step-cancelled .status { color: #795c1a; }.step dl { display: flex; gap: 24px; margin: 12px 0 0; font-size: 13px; }.step dl div { display: grid; gap: 2px; }.step dt { color: #65718a; }.step dd { margin: 0; }.message { white-space: pre-wrap; color: #b42318; }.step img { display: block; max-width: min(100%, 420px); height: auto; margin-top: 14px; border: 1px solid #d9dfeb; }.evidence { display: grid; gap: 8px; } details { padding: 0; overflow: hidden; } summary { cursor: pointer; padding: 12px; font-weight: 600; } pre { overflow: auto; max-height: 420px; margin: 0; padding: 12px; border-top: 1px solid #d9dfeb; white-space: pre-wrap; word-break: break-word; font: 12px/1.55 Consolas, monospace; }
  </style>
</head>
<body><main>
  <header class="report"><h1>${escapeHtml(run.name)}</h1><p>DeviceRobot 测试执行报告</p><section class="meta"><div><span>运行状态</span><strong>${statusLabel(run.status)}</strong></div><div><span>设备</span><strong>${escapeHtml(run.deviceSerial)}</strong></div><div><span>应用包名</span><strong>${escapeHtml(run.appId)}</strong></div><div><span>开始时间</span><strong>${escapeHtml(formatDateTime(run.startedAt))}</strong></div><div><span>结束时间</span><strong>${escapeHtml(formatDateTime(run.finishedAt))}</strong></div></section>${run.message === undefined ? "" : `<p>${escapeHtml(run.message)}</p>`}</header>
  <section><h2>执行步骤</h2><div class="steps">${stepRows}</div></section>
  <section><h2>失败证据</h2><div class="evidence">${evidenceSections || "<p>本次运行未收集额外失败证据。</p>"}</div></section>
</main></body></html>`;
  }
}
