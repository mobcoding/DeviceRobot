import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentPaths } from "@device-robot/config";
import type { AiPlanRecord } from "@device-robot/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { DrizzleAiPlanStore } from "../src/ai/ai-plan-store.js";
import { openDatabase } from "../src/db/database.js";

const temporaryDirectories: string[] = [];

function createPlan(id: string, generatedAt: string): AiPlanRecord {
  return {
    goal: "验证启动流程",
    reply: "启动应用并记录结果。",
    plan: {
      id,
      projectId: "123e4567-e89b-12d3-a456-426614174000",
      actions: [{ action: "ui.wait", durationMs: 500 }],
      requiresApproval: true,
    },
    policy: {
      allowed: true,
      requiresApproval: true,
      reason: "需要确认。",
      warnings: [],
    },
    context: {
      projectName: "Example",
      sourceIndexAvailable: false,
      evidence: [],
    },
    generatedAt,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("AI plan store", () => {
  it("persists plans with Drizzle and returns the newest plan first", () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-ai-plans-"));
    temporaryDirectories.push(root);
    const database = openDatabase(resolveAgentPaths(root).database);
    try {
      const store = new DrizzleAiPlanStore(database.db);
      const older = createPlan("first-plan", "2026-07-23T08:00:00.000Z");
      const newer = createPlan("second-plan", "2026-07-23T09:00:00.000Z");

      store.save(older);
      store.save(newer);

      expect(store.list()).toEqual([newer, older]);
    } finally {
      database.close();
    }
  });
});
