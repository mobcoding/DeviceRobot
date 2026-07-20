import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type ApkInstallAuditEntry = {
  artifactId: string;
  serial: string;
  fileName: string;
  packageName: string;
  sha256: string;
  success: boolean;
  message?: string;
  startedAt: string;
  finishedAt: string;
};

export interface ApkInstallAuditStore {
  record(entry: ApkInstallAuditEntry): void;
}

export class SqliteApkInstallAuditStore implements ApkInstallAuditStore {
  readonly #sqlite: Database.Database;

  public constructor(sqlite: Database.Database) {
    this.#sqlite = sqlite;
  }

  public record(entry: ApkInstallAuditEntry): void {
    this.#sqlite
      .prepare(
        `
          INSERT INTO apk_install_audits (
            id, artifact_id, serial, file_name, package_name, sha256,
            success, message, started_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        randomUUID(),
        entry.artifactId,
        entry.serial,
        entry.fileName,
        entry.packageName,
        entry.sha256,
        entry.success ? 1 : 0,
        entry.message ?? null,
        entry.startedAt,
        entry.finishedAt,
      );
  }
}
