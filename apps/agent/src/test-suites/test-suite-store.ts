import type Database from "better-sqlite3";
import {
  testSuiteListResponseSchema,
  testSuiteRecordSchema,
  type TestSuiteRecord,
} from "@device-robot/contracts";

export interface TestSuiteStore {
  create(record: TestSuiteRecord): void;
  update(record: TestSuiteRecord): void;
  findById(projectId: string, suiteId: string): TestSuiteRecord | undefined;
  listByProject(projectId: string): TestSuiteRecord[];
}

type TestSuiteRow = {
  id: string;
  project_id: string;
  file_name: string;
  suite_json: string;
  imported_at: string;
};

function toRecord(row: TestSuiteRow): TestSuiteRecord {
  return testSuiteRecordSchema.parse({
    id: row.id,
    projectId: row.project_id,
    fileName: row.file_name,
    suite: JSON.parse(row.suite_json) as unknown,
    importedAt: row.imported_at,
  });
}

export class SqliteTestSuiteStore implements TestSuiteStore {
  readonly #sqlite: Database.Database;

  public constructor(sqlite: Database.Database) {
    this.#sqlite = sqlite;
  }

  public create(record: TestSuiteRecord): void {
    const parsed = testSuiteRecordSchema.parse(record);
    this.#sqlite
      .prepare(
        `
          INSERT INTO test_suites (id, project_id, file_name, suite_json, imported_at)
          VALUES (?, ?, ?, ?, ?)
        `,
      )
      .run(
        parsed.id,
        parsed.projectId,
        parsed.fileName,
        JSON.stringify(parsed.suite),
        parsed.importedAt,
      );
  }

  public update(record: TestSuiteRecord): void {
    const parsed = testSuiteRecordSchema.parse(record);
    this.#sqlite
      .prepare(
        `
          UPDATE test_suites
          SET file_name = ?, suite_json = ?, imported_at = ?
          WHERE id = ? AND project_id = ?
        `,
      )
      .run(
        parsed.fileName,
        JSON.stringify(parsed.suite),
        parsed.importedAt,
        parsed.id,
        parsed.projectId,
      );
  }

  public findById(projectId: string, suiteId: string): TestSuiteRecord | undefined {
    const row = this.#sqlite
      .prepare(
        `
          SELECT id, project_id, file_name, suite_json, imported_at
          FROM test_suites
          WHERE project_id = ? AND id = ?
        `,
      )
      .get(projectId, suiteId) as TestSuiteRow | undefined;
    return row === undefined ? undefined : toRecord(row);
  }

  public listByProject(projectId: string): TestSuiteRecord[] {
    const rows = this.#sqlite
      .prepare(
        `
          SELECT id, project_id, file_name, suite_json, imported_at
          FROM test_suites
          WHERE project_id = ?
          ORDER BY imported_at DESC
          LIMIT 100
        `,
      )
      .all(projectId) as TestSuiteRow[];
    return testSuiteListResponseSchema.parse({ projectId, suites: rows.map(toRecord) }).suites;
  }
}
