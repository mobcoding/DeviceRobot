import type Database from "better-sqlite3";
import {
  androidProjectSchema,
  type AndroidProject,
  type AndroidProjectModule,
  type AndroidSourceIndex,
} from "@device-robot/contracts";

export interface ProjectStore {
  list(): AndroidProject[];
  findById(id: string): AndroidProject | undefined;
  findByRootPath(rootPath: string): AndroidProject | undefined;
  create(project: AndroidProject): void;
  updateSourceIndex(project: AndroidProject): void;
}

type ProjectRow = {
  id: string;
  name: string;
  source: string;
  root_path: string;
  remote_url: string | null;
  revision: string | null;
  gradle_wrapper: number;
  modules_json: string;
  source_index_json: string | null;
  created_at: string;
  updated_at: string;
};

function toProject(row: ProjectRow): AndroidProject {
  return androidProjectSchema.parse({
    id: row.id,
    name: row.name,
    source: row.source,
    rootPath: row.root_path,
    ...(row.remote_url === null ? {} : { remoteUrl: row.remote_url }),
    ...(row.revision === null ? {} : { revision: row.revision }),
    gradleWrapper: row.gradle_wrapper === 1,
    modules: JSON.parse(row.modules_json) as AndroidProjectModule[],
    ...(row.source_index_json === null
      ? {}
      : { sourceIndex: JSON.parse(row.source_index_json) as AndroidSourceIndex }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export class SqliteProjectStore implements ProjectStore {
  readonly #sqlite: Database.Database;

  public constructor(sqlite: Database.Database) {
    this.#sqlite = sqlite;
  }

  public list(): AndroidProject[] {
    return (
      this.#sqlite
        .prepare("SELECT * FROM projects ORDER BY updated_at DESC, name COLLATE NOCASE ASC")
        .all() as ProjectRow[]
    ).map(toProject);
  }

  public findByRootPath(rootPath: string): AndroidProject | undefined {
    const row = this.#sqlite.prepare("SELECT * FROM projects WHERE root_path = ?").get(rootPath) as
      ProjectRow | undefined;
    return row === undefined ? undefined : toProject(row);
  }

  public findById(id: string): AndroidProject | undefined {
    const row = this.#sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(id) as
      ProjectRow | undefined;
    return row === undefined ? undefined : toProject(row);
  }

  public create(project: AndroidProject): void {
    this.#sqlite
      .prepare(
        `
          INSERT INTO projects (
            id, name, source, root_path, remote_url, revision, gradle_wrapper,
            modules_json, source_index_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        project.id,
        project.name,
        project.source,
        project.rootPath,
        project.remoteUrl ?? null,
        project.revision ?? null,
        project.gradleWrapper ? 1 : 0,
        JSON.stringify(project.modules),
        project.sourceIndex === undefined ? null : JSON.stringify(project.sourceIndex),
        project.createdAt,
        project.updatedAt,
      );
  }

  public updateSourceIndex(project: AndroidProject): void {
    this.#sqlite
      .prepare("UPDATE projects SET source_index_json = ?, updated_at = ? WHERE id = ?")
      .run(
        project.sourceIndex === undefined ? null : JSON.stringify(project.sourceIndex),
        project.updatedAt,
        project.id,
      );
  }
}
