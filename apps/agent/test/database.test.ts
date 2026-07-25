import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { migrateDatabase } from "../src/db/database.js";

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe("database migrations", () => {
  it("moves legacy AI plans into a project-scoped history conversation", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        revision TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE ai_plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        goal TEXT NOT NULL,
        reply TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );
    `);
    const insertMigration = database.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    );
    for (let version = 1; version <= 10; version += 1) {
      insertMigration.run(version, "legacy", "2026-07-24T00:00:00.000Z");
    }
    database
      .prepare("INSERT INTO projects (id, revision, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(
        "123e4567-e89b-12d3-a456-426614174000",
        "abc123",
        "2026-07-20T00:00:00.000Z",
        "2026-07-20T00:00:00.000Z",
      );
    database
      .prepare(
        `
          INSERT INTO ai_plans (
            id, project_id, goal, reply, plan_json, policy_json, context_json, generated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "223e4567-e89b-12d3-a456-426614174000",
        "123e4567-e89b-12d3-a456-426614174000",
        "历史目标",
        "历史回复",
        "{}",
        "{}",
        '{"projectName":"Example","sourceIndexAvailable":true,"evidence":[]}',
        "2026-07-21T00:00:00.000Z",
      );
    database
      .prepare(
        `
          INSERT INTO ai_plans (
            id, project_id, goal, reply, plan_json, policy_json, context_json, generated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "323e4567-e89b-12d3-a456-426614174000",
        "123e4567-e89b-12d3-a456-426614174000",
        "第二个历史目标",
        "第二个历史回复",
        "{}",
        "{}",
        '{"projectName":"Example","sourceIndexAvailable":true,"evidence":[]}',
        "2026-07-21T00:01:00.000Z",
      );

    migrateDatabase(database);

    const plans = database
      .prepare("SELECT conversation_id AS conversationId FROM ai_plans ORDER BY id")
      .all() as Array<{ conversationId: string }>;
    const conversationCount = database
      .prepare("SELECT COUNT(*) AS count FROM ai_conversations")
      .get() as {
      count: number;
    };
    const snapshotCount = database
      .prepare("SELECT COUNT(*) AS count FROM ai_context_snapshots")
      .get() as {
      count: number;
    };
    const messageCount = database
      .prepare("SELECT COUNT(*) AS count FROM ai_conversation_messages")
      .get() as { count: number };

    expect(plans).toHaveLength(2);
    expect(plans[0]?.conversationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(plans[1]?.conversationId).toBe(plans[0]?.conversationId);
    expect(conversationCount.count).toBe(1);
    expect(snapshotCount.count).toBe(2);
    expect(messageCount.count).toBe(4);
  });

  it("merges older per-application conversations into one project conversation", () => {
    const database = new Database(":memory:");
    databases.push(database);
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE ai_conversations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        app_id TEXT,
        variant TEXT,
        title TEXT NOT NULL,
        source_revision TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE ai_context_snapshots (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        source_revision TEXT,
        context_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE ai_conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        plan_id TEXT,
        context_snapshot_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE ai_plans (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        conversation_id TEXT,
        goal TEXT NOT NULL,
        reply TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );
    `);
    const insertMigration = database.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    );
    for (let version = 1; version <= 11; version += 1) {
      insertMigration.run(version, "legacy", "2026-07-24T00:00:00.000Z");
    }
    const projectId = "123e4567-e89b-12d3-a456-426614174000";
    const firstConversationId = "223e4567-e89b-12d3-a456-426614174000";
    const secondConversationId = "323e4567-e89b-12d3-a456-426614174000";
    const insertConversation = database.prepare(`
      INSERT INTO ai_conversations (
        id, project_id, app_id, variant, title, source_revision, created_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, NULL, ?, ?)
    `);
    insertConversation.run(
      firstConversationId,
      projectId,
      "com.example.one",
      "应用一会话",
      "2026-07-20T00:00:00.000Z",
      "2026-07-20T00:00:00.000Z",
    );
    insertConversation.run(
      secondConversationId,
      projectId,
      "com.example.two",
      "应用二会话",
      "2026-07-21T00:00:00.000Z",
      "2026-07-21T00:00:00.000Z",
    );
    database
      .prepare(
        `
          INSERT INTO ai_conversation_messages (
            id, conversation_id, role, content, plan_id, context_snapshot_id, created_at
          ) VALUES (?, ?, 'user', ?, NULL, NULL, ?)
        `,
      )
      .run(
        "423e4567-e89b-12d3-a456-426614174000",
        firstConversationId,
        "第一个会话目标",
        "2026-07-20T00:00:00.000Z",
      );
    database
      .prepare(
        `
          INSERT INTO ai_conversation_messages (
            id, conversation_id, role, content, plan_id, context_snapshot_id, created_at
          ) VALUES (?, ?, 'user', ?, NULL, NULL, ?)
        `,
      )
      .run(
        "523e4567-e89b-12d3-a456-426614174000",
        secondConversationId,
        "第二个会话目标",
        "2026-07-21T00:00:00.000Z",
      );
    database
      .prepare(
        `
          INSERT INTO ai_context_snapshots (
            id, conversation_id, project_id, source_revision, context_json, created_at
          ) VALUES (?, ?, ?, NULL, '{}', ?)
        `,
      )
      .run(
        "623e4567-e89b-12d3-a456-426614174000",
        secondConversationId,
        projectId,
        "2026-07-21T00:00:00.000Z",
      );
    database
      .prepare(
        `
          INSERT INTO ai_plans (
            id, project_id, conversation_id, goal, reply, plan_json, policy_json, context_json, generated_at
          ) VALUES (?, ?, ?, ?, ?, '{}', '{}', '{}', ?)
        `,
      )
      .run(
        "723e4567-e89b-12d3-a456-426614174000",
        projectId,
        secondConversationId,
        "第二个会话目标",
        "第二个会话回复",
        "2026-07-21T00:00:00.000Z",
      );

    migrateDatabase(database);

    const conversations = database
      .prepare("SELECT id, app_id AS appId, title FROM ai_conversations")
      .all() as Array<{ id: string; appId: string | null; title: string }>;
    const messageConversationIds = database
      .prepare("SELECT DISTINCT conversation_id AS conversationId FROM ai_conversation_messages")
      .all() as Array<{ conversationId: string }>;
    const snapshotConversationId = database
      .prepare("SELECT conversation_id AS conversationId FROM ai_context_snapshots")
      .get() as { conversationId: string };
    const planConversationId = database
      .prepare("SELECT conversation_id AS conversationId FROM ai_plans")
      .get() as { conversationId: string };

    expect(conversations).toEqual([
      { id: firstConversationId, appId: null, title: "项目测试会话" },
    ]);
    expect(messageConversationIds).toEqual([{ conversationId: firstConversationId }]);
    expect(snapshotConversationId.conversationId).toBe(firstConversationId);
    expect(planConversationId.conversationId).toBe(firstConversationId);
  });
});
