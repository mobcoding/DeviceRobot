import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";

type Migration = {
  version: number;
  name: string;
  sql: string;
};

const migrations: Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE IF NOT EXISTS app_metadata (
        id INTEGER PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "device-action-audit",
    sql: `
      CREATE TABLE IF NOT EXISTS device_action_audits (
        id TEXT PRIMARY KEY,
        serial TEXT NOT NULL,
        action_name TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        success INTEGER NOT NULL,
        message TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS device_action_audits_serial_finished_at
        ON device_action_audits (serial, finished_at DESC);
    `,
  },
  {
    version: 3,
    name: "apk-install-audit",
    sql: `
      CREATE TABLE IF NOT EXISTS apk_install_audits (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        serial TEXT NOT NULL,
        file_name TEXT NOT NULL,
        package_name TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        success INTEGER NOT NULL,
        message TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS apk_install_audits_serial_finished_at
        ON apk_install_audits (serial, finished_at DESC);
    `,
  },
  {
    version: 4,
    name: "projects",
    sql: `
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source TEXT NOT NULL,
        root_path TEXT NOT NULL UNIQUE,
        remote_url TEXT,
        revision TEXT,
        gradle_wrapper INTEGER NOT NULL,
        modules_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS projects_updated_at
        ON projects (updated_at DESC);
    `,
  },
];

export type DatabaseHandle = {
  sqlite: Database.Database;
  db: BetterSQLite3Database<typeof schema>;
  close(): void;
};

export function migrateDatabase(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const hasMigration = sqlite.prepare("SELECT 1 FROM schema_migrations WHERE version = ?");
  const recordMigration = sqlite.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
  );

  for (const migration of migrations) {
    if (hasMigration.get(migration.version) !== undefined) {
      continue;
    }

    sqlite.transaction(() => {
      sqlite.exec(migration.sql);
      recordMigration.run(migration.version, migration.name, new Date().toISOString());
    })();
  }
}

export function openDatabase(databasePath: string): DatabaseHandle {
  mkdirSync(dirname(databasePath), { recursive: true });
  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  migrateDatabase(sqlite);

  return {
    sqlite,
    db: drizzle(sqlite, { schema }),
    close: () => sqlite.close(),
  };
}
