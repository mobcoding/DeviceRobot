import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";

type Migration = {
  version: number;
  name: string;
  sql: string;
  skipWhen?: (sqlite: Database.Database) => boolean;
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
  {
    version: 5,
    name: "project-source-index",
    sql: `
      ALTER TABLE projects ADD COLUMN source_index_json TEXT;
    `,
  },
  {
    version: 6,
    name: "project-build-runs",
    sql: `
      CREATE TABLE IF NOT EXISTS project_build_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        module_path TEXT NOT NULL,
        variant TEXT NOT NULL,
        task_name TEXT NOT NULL,
        status TEXT NOT NULL,
        log_path TEXT NOT NULL,
        artifact_paths_json TEXT NOT NULL,
        message TEXT,
        exit_code INTEGER,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS project_build_runs_project_started_at
        ON project_build_runs (project_id, started_at DESC);

      CREATE INDEX IF NOT EXISTS project_build_runs_project_status
        ON project_build_runs (project_id, status);
    `,
  },
  {
    version: 7,
    name: "ai-model-configuration",
    sql: `
      CREATE TABLE IF NOT EXISTS ai_model_configurations (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        provider TEXT NOT NULL,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        protected_api_key TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 8,
    name: "test-execution-runs",
    sql: `
      CREATE TABLE IF NOT EXISTS test_execution_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        name TEXT NOT NULL,
        device_serial TEXT NOT NULL,
        app_id TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS test_execution_runs_project_started_at
        ON test_execution_runs (project_id, started_at DESC);

      CREATE INDEX IF NOT EXISTS test_execution_runs_status
        ON test_execution_runs (status);

      CREATE TABLE IF NOT EXISTS test_execution_steps (
        run_id TEXT NOT NULL,
        step_index INTEGER NOT NULL,
        action_json TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT,
        screenshot_path TEXT,
        started_at TEXT,
        finished_at TEXT,
        PRIMARY KEY (run_id, step_index)
      );

      CREATE INDEX IF NOT EXISTS test_execution_steps_run_index
        ON test_execution_steps (run_id, step_index);
    `,
  },
  {
    version: 9,
    name: "ai-plans",
    sql: `
      CREATE TABLE IF NOT EXISTS ai_plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        reply TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_plans_project_generated_at
        ON ai_plans (project_id, generated_at DESC);
    `,
  },
  {
    version: 10,
    name: "test-suites",
    sql: `
      CREATE TABLE IF NOT EXISTS test_suites (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        suite_json TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS test_suites_project_imported_at
        ON test_suites (project_id, imported_at DESC);
    `,
  },
  {
    version: 11,
    name: "ai-conversations",
    sql: `
      CREATE TABLE IF NOT EXISTS ai_conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        app_id TEXT,
        variant TEXT,
        title TEXT NOT NULL,
        source_revision TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_context_snapshots (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        source_revision TEXT,
        context_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        plan_id TEXT,
        context_snapshot_id TEXT,
        created_at TEXT NOT NULL
      );

      ALTER TABLE ai_plans ADD COLUMN conversation_id TEXT;

      CREATE INDEX IF NOT EXISTS ai_conversations_project_updated_at
        ON ai_conversations (project_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS ai_context_snapshots_conversation_created_at
        ON ai_context_snapshots (conversation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS ai_conversation_messages_conversation_created_at
        ON ai_conversation_messages (conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS ai_plans_conversation_generated_at
        ON ai_plans (conversation_id, generated_at DESC);

      CREATE TEMP TABLE legacy_ai_conversation_map (
        project_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL
      );

      INSERT INTO legacy_ai_conversation_map (project_id, conversation_id)
      SELECT
        legacy_projects.project_id,
        lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
          substr(lower(hex(randomblob(2))), 2) || '-' ||
          substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
          lower(hex(randomblob(6)))
      FROM (
        SELECT DISTINCT project_id
        FROM ai_plans
        WHERE conversation_id IS NULL
      ) AS legacy_projects;

      INSERT INTO ai_conversations (
        id, project_id, app_id, variant, title, source_revision, created_at, updated_at
      )
      SELECT
        mapping.conversation_id,
        mapping.project_id,
        NULL,
        NULL,
        '历史测试会话',
        projects.revision,
        COALESCE((SELECT MIN(generated_at) FROM ai_plans WHERE project_id = mapping.project_id), projects.created_at),
        COALESCE((SELECT MAX(generated_at) FROM ai_plans WHERE project_id = mapping.project_id), projects.updated_at)
      FROM legacy_ai_conversation_map AS mapping
      LEFT JOIN projects ON projects.id = mapping.project_id;

      UPDATE ai_plans
      SET conversation_id = (
        SELECT conversation_id
        FROM legacy_ai_conversation_map
        WHERE legacy_ai_conversation_map.project_id = ai_plans.project_id
      )
      WHERE conversation_id IS NULL;

      CREATE TEMP TABLE legacy_ai_plan_snapshot_map (
        plan_id TEXT PRIMARY KEY,
        snapshot_id TEXT NOT NULL
      );

      INSERT INTO legacy_ai_plan_snapshot_map (plan_id, snapshot_id)
      SELECT
        plans.id,
        lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
          substr(lower(hex(randomblob(2))), 2) || '-' ||
          substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
          lower(hex(randomblob(6)))
      FROM ai_plans AS plans
      INNER JOIN legacy_ai_conversation_map AS mapping ON mapping.conversation_id = plans.conversation_id;

      INSERT INTO ai_context_snapshots (
        id, conversation_id, project_id, source_revision, context_json, created_at
      )
      SELECT
        snapshots.snapshot_id,
        plans.conversation_id,
        plans.project_id,
        projects.revision,
        plans.context_json,
        plans.generated_at
      FROM ai_plans AS plans
      INNER JOIN legacy_ai_plan_snapshot_map AS snapshots ON snapshots.plan_id = plans.id
      LEFT JOIN projects ON projects.id = plans.project_id;

      INSERT INTO ai_conversation_messages (
        id, conversation_id, role, content, plan_id, context_snapshot_id, created_at
      )
      SELECT
        lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
          substr(lower(hex(randomblob(2))), 2) || '-' ||
          substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
          lower(hex(randomblob(6))),
        plans.conversation_id,
        'user',
        plans.goal,
        NULL,
        snapshots.snapshot_id,
        plans.generated_at
      FROM ai_plans AS plans
      INNER JOIN legacy_ai_plan_snapshot_map AS snapshots ON snapshots.plan_id = plans.id;

      INSERT INTO ai_conversation_messages (
        id, conversation_id, role, content, plan_id, context_snapshot_id, created_at
      )
      SELECT
        lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
          substr(lower(hex(randomblob(2))), 2) || '-' ||
          substr('89ab', abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))), 2) || '-' ||
          lower(hex(randomblob(6))),
        plans.conversation_id,
        'assistant',
        plans.reply,
        plans.id,
        snapshots.snapshot_id,
        plans.generated_at
      FROM ai_plans AS plans
      INNER JOIN legacy_ai_plan_snapshot_map AS snapshots ON snapshots.plan_id = plans.id;

      DROP TABLE legacy_ai_plan_snapshot_map;
      DROP TABLE legacy_ai_conversation_map;
    `,
  },
  {
    version: 12,
    name: "project-scoped-ai-conversations",
    sql: `
      CREATE TEMP TABLE project_ai_conversation_map (
        project_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL
      );

      INSERT INTO project_ai_conversation_map (project_id, conversation_id)
      SELECT project_id, MIN(id)
      FROM ai_conversations
      GROUP BY project_id;

      UPDATE ai_conversation_messages
      SET conversation_id = (
        SELECT mapping.conversation_id
        FROM project_ai_conversation_map AS mapping
        INNER JOIN ai_conversations AS conversations
          ON conversations.project_id = mapping.project_id
        WHERE conversations.id = ai_conversation_messages.conversation_id
      )
      WHERE conversation_id IN (SELECT id FROM ai_conversations);

      UPDATE ai_context_snapshots
      SET conversation_id = (
        SELECT conversation_id
        FROM project_ai_conversation_map
        WHERE project_ai_conversation_map.project_id = ai_context_snapshots.project_id
      )
      WHERE project_id IN (SELECT project_id FROM project_ai_conversation_map);

      UPDATE ai_plans
      SET conversation_id = (
        SELECT conversation_id
        FROM project_ai_conversation_map
        WHERE project_ai_conversation_map.project_id = ai_plans.project_id
      )
      WHERE project_id IN (SELECT project_id FROM project_ai_conversation_map);

      DELETE FROM ai_conversations
      WHERE id NOT IN (SELECT conversation_id FROM project_ai_conversation_map);

      UPDATE ai_conversations
      SET app_id = NULL, variant = NULL, title = '项目测试会话';

      DROP TABLE project_ai_conversation_map;
    `,
  },
  {
    version: 13,
    name: "test-execution-mode",
    sql: `
      ALTER TABLE test_execution_runs
        ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'static-plan';
    `,
    // Some historical, test-only database snapshots predate test execution entirely.
    // Mark this migration applied there; real Agent databases always have the table from v8.
    skipWhen: (sqlite) =>
      sqlite
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'test_execution_runs'",
        )
        .get() === undefined,
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
      if (migration.skipWhen?.(sqlite) !== true) {
        sqlite.exec(migration.sql);
      }
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
