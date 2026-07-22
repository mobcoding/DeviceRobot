import type Database from "better-sqlite3";
import {
  agentActionSchema,
  testExecutionRunSchema,
  testStepExecutionSchema,
  type TestExecutionRun,
  type TestStepExecution,
} from "@device-robot/contracts";

export interface TestExecutionStore {
  recoverInterruptedRuns(finishedAt: string): void;
  create(run: TestExecutionRun): void;
  findById(runId: string): TestExecutionRun | undefined;
  list(): TestExecutionRun[];
  updateRun(run: TestExecutionRun): void;
  updateStep(runId: string, step: TestStepExecution, screenshotPath?: string): void;
  screenshotPath(runId: string, stepIndex: number): string | undefined;
}

type TestExecutionRunRow = {
  id: string;
  project_id: string;
  plan_id: string;
  name: string;
  device_serial: string;
  app_id: string;
  status: string;
  message: string | null;
  started_at: string;
  finished_at: string | null;
};

type TestExecutionStepRow = {
  run_id: string;
  step_index: number;
  action_json: string;
  status: string;
  message: string | null;
  screenshot_path: string | null;
  started_at: string | null;
  finished_at: string | null;
};

function toStep(row: TestExecutionStepRow): TestStepExecution {
  return testStepExecutionSchema.parse({
    index: row.step_index,
    action: agentActionSchema.parse(JSON.parse(row.action_json) as unknown),
    status: row.status,
    ...(row.message === null ? {} : { message: row.message }),
    screenshotAvailable: row.screenshot_path !== null,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  });
}

export class SqliteTestExecutionStore implements TestExecutionStore {
  readonly #sqlite: Database.Database;

  public constructor(sqlite: Database.Database) {
    this.#sqlite = sqlite;
  }

  public recoverInterruptedRuns(finishedAt: string): void {
    this.#sqlite
      .prepare(
        `
          UPDATE test_execution_runs
          SET status = 'cancelled', message = 'Agent 重启前的测试运行已取消。', finished_at = ?
          WHERE status = 'running'
        `,
      )
      .run(finishedAt);
    this.#sqlite
      .prepare(
        `
          UPDATE test_execution_steps
          SET status = 'cancelled', message = '测试运行已取消。', finished_at = ?
          WHERE status IN ('pending', 'running')
            AND run_id IN (SELECT id FROM test_execution_runs WHERE finished_at = ?)
        `,
      )
      .run(finishedAt, finishedAt);
  }

  public create(run: TestExecutionRun): void {
    const insertRun = this.#sqlite.prepare(
      `
        INSERT INTO test_execution_runs (
          id, project_id, plan_id, name, device_serial, app_id, status, message, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    const insertStep = this.#sqlite.prepare(
      `
        INSERT INTO test_execution_steps (
          run_id, step_index, action_json, status, message, screenshot_path, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );
    this.#sqlite.transaction(() => {
      insertRun.run(
        run.id,
        run.projectId,
        run.planId,
        run.name,
        run.deviceSerial,
        run.appId,
        run.status,
        run.message ?? null,
        run.startedAt,
        run.finishedAt ?? null,
      );
      for (const step of run.steps) {
        insertStep.run(
          run.id,
          step.index,
          JSON.stringify(step.action),
          step.status,
          step.message ?? null,
          null,
          step.startedAt ?? null,
          step.finishedAt ?? null,
        );
      }
    })();
  }

  public findById(runId: string): TestExecutionRun | undefined {
    const row = this.#sqlite
      .prepare("SELECT * FROM test_execution_runs WHERE id = ?")
      .get(runId) as TestExecutionRunRow | undefined;
    return row === undefined ? undefined : this.#toRun(row);
  }

  public list(): TestExecutionRun[] {
    return (
      this.#sqlite
        .prepare("SELECT * FROM test_execution_runs ORDER BY started_at DESC LIMIT 100")
        .all() as TestExecutionRunRow[]
    ).map((row) => this.#toRun(row));
  }

  public updateRun(run: TestExecutionRun): void {
    this.#sqlite
      .prepare(
        `
          UPDATE test_execution_runs
          SET status = ?, message = ?, finished_at = ?
          WHERE id = ?
        `,
      )
      .run(run.status, run.message ?? null, run.finishedAt ?? null, run.id);
  }

  public updateStep(runId: string, step: TestStepExecution, screenshotPath?: string): void {
    this.#sqlite
      .prepare(
        `
          UPDATE test_execution_steps
          SET status = ?, message = ?, screenshot_path = COALESCE(?, screenshot_path),
              started_at = ?, finished_at = ?
          WHERE run_id = ? AND step_index = ?
        `,
      )
      .run(
        step.status,
        step.message ?? null,
        screenshotPath ?? null,
        step.startedAt ?? null,
        step.finishedAt ?? null,
        runId,
        step.index,
      );
  }

  public screenshotPath(runId: string, stepIndex: number): string | undefined {
    const row = this.#sqlite
      .prepare(
        "SELECT screenshot_path FROM test_execution_steps WHERE run_id = ? AND step_index = ?",
      )
      .get(runId, stepIndex) as { screenshot_path: string | null } | undefined;
    return row?.screenshot_path ?? undefined;
  }

  #toRun(row: TestExecutionRunRow): TestExecutionRun {
    const stepRows = this.#sqlite
      .prepare("SELECT * FROM test_execution_steps WHERE run_id = ? ORDER BY step_index ASC")
      .all(row.id) as TestExecutionStepRow[];
    return testExecutionRunSchema.parse({
      id: row.id,
      projectId: row.project_id,
      planId: row.plan_id,
      name: row.name,
      deviceSerial: row.device_serial,
      appId: row.app_id,
      status: row.status,
      ...(row.message === null ? {} : { message: row.message }),
      steps: stepRows.map(toStep),
      startedAt: row.started_at,
      ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    });
  }
}
