import type Database from "better-sqlite3";
import { projectBuildRunSchema, type ProjectBuildRun } from "@device-robot/contracts";

export interface ProjectBuildStore {
  recoverInterruptedRuns(finishedAt: string): void;
  listByProject(projectId: string): ProjectBuildRun[];
  findRunningByProject(projectId: string): ProjectBuildRun | undefined;
  create(run: ProjectBuildRun): void;
  finish(run: ProjectBuildRun): void;
}

type ProjectBuildRunRow = {
  id: string;
  project_id: string;
  module_path: string;
  variant: string;
  task_name: string;
  status: string;
  log_path: string;
  artifact_paths_json: string;
  message: string | null;
  exit_code: number | null;
  started_at: string;
  finished_at: string | null;
};

function toProjectBuildRun(row: ProjectBuildRunRow): ProjectBuildRun {
  return projectBuildRunSchema.parse({
    id: row.id,
    projectId: row.project_id,
    modulePath: row.module_path,
    variant: row.variant,
    taskName: row.task_name,
    status: row.status,
    logPath: row.log_path,
    artifactPaths: JSON.parse(row.artifact_paths_json) as string[],
    ...(row.message === null ? {} : { message: row.message }),
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
    startedAt: row.started_at,
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
  });
}

export class SqliteProjectBuildStore implements ProjectBuildStore {
  readonly #sqlite: Database.Database;

  public constructor(sqlite: Database.Database) {
    this.#sqlite = sqlite;
  }

  public recoverInterruptedRuns(finishedAt: string): void {
    this.#sqlite
      .prepare(
        `
          UPDATE project_build_runs
          SET status = 'cancelled', message = 'Agent 重启前的构建已取消。', finished_at = ?
          WHERE status = 'running'
        `,
      )
      .run(finishedAt);
  }

  public listByProject(projectId: string): ProjectBuildRun[] {
    return (
      this.#sqlite
        .prepare(
          "SELECT * FROM project_build_runs WHERE project_id = ? ORDER BY started_at DESC LIMIT 100",
        )
        .all(projectId) as ProjectBuildRunRow[]
    ).map(toProjectBuildRun);
  }

  public findRunningByProject(projectId: string): ProjectBuildRun | undefined {
    const row = this.#sqlite
      .prepare(
        "SELECT * FROM project_build_runs WHERE project_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1",
      )
      .get(projectId) as ProjectBuildRunRow | undefined;
    return row === undefined ? undefined : toProjectBuildRun(row);
  }

  public create(run: ProjectBuildRun): void {
    this.#sqlite
      .prepare(
        `
          INSERT INTO project_build_runs (
            id, project_id, module_path, variant, task_name, status, log_path,
            artifact_paths_json, message, exit_code, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        run.id,
        run.projectId,
        run.modulePath,
        run.variant,
        run.taskName,
        run.status,
        run.logPath,
        JSON.stringify(run.artifactPaths),
        run.message ?? null,
        run.exitCode ?? null,
        run.startedAt,
        run.finishedAt ?? null,
      );
  }

  public finish(run: ProjectBuildRun): void {
    this.#sqlite
      .prepare(
        `
          UPDATE project_build_runs
          SET status = ?, artifact_paths_json = ?, message = ?, exit_code = ?, finished_at = ?
          WHERE id = ?
        `,
      )
      .run(
        run.status,
        JSON.stringify(run.artifactPaths),
        run.message ?? null,
        run.exitCode ?? null,
        run.finishedAt ?? null,
        run.id,
      );
  }
}
