import { desc } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  aiPlanListResponseSchema,
  aiPlanRecordSchema,
  type AiPlanRecord,
} from "@device-robot/contracts";

import { aiPlans } from "../db/schema.js";
import type * as databaseSchema from "../db/schema.js";

export interface AiPlanStore {
  list(): AiPlanRecord[];
  save(plan: AiPlanRecord): void;
}

export class DrizzleAiPlanStore implements AiPlanStore {
  readonly #db: BetterSQLite3Database<typeof databaseSchema>;

  public constructor(db: BetterSQLite3Database<typeof databaseSchema>) {
    this.#db = db;
  }

  public list(): AiPlanRecord[] {
    const rows = this.#db
      .select()
      .from(aiPlans)
      .orderBy(desc(aiPlans.generatedAt))
      .limit(100)
      .all();
    return aiPlanListResponseSchema.parse({
      plans: rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        goal: row.goal,
        reply: row.reply,
        plan: JSON.parse(row.planJson) as unknown,
        policy: JSON.parse(row.policyJson) as unknown,
        context: JSON.parse(row.contextJson) as unknown,
        generatedAt: row.generatedAt,
      })),
    }).plans;
  }

  public save(plan: AiPlanRecord): void {
    const record = aiPlanRecordSchema.parse(plan);
    this.#db
      .insert(aiPlans)
      .values({
        id: record.plan.id,
        projectId: record.plan.projectId,
        goal: record.goal,
        reply: record.reply,
        planJson: JSON.stringify(record.plan),
        policyJson: JSON.stringify(record.policy),
        contextJson: JSON.stringify(record.context),
        generatedAt: record.generatedAt,
      })
      .onConflictDoUpdate({
        target: aiPlans.id,
        set: {
          projectId: record.plan.projectId,
          goal: record.goal,
          reply: record.reply,
          planJson: JSON.stringify(record.plan),
          policyJson: JSON.stringify(record.policy),
          contextJson: JSON.stringify(record.context),
          generatedAt: record.generatedAt,
        },
      })
      .run();
  }
}
