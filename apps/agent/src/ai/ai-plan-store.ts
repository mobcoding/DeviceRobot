import { desc, eq } from "drizzle-orm";
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
  listByConversation(conversationId: string): AiPlanRecord[];
  find(id: string): AiPlanRecord | undefined;
  save(plan: AiPlanRecord): void;
}

export class DrizzleAiPlanStore implements AiPlanStore {
  readonly #db: BetterSQLite3Database<typeof databaseSchema>;

  public constructor(db: BetterSQLite3Database<typeof databaseSchema>) {
    this.#db = db;
  }

  public list(): AiPlanRecord[] {
    return this.#parseRows(
      this.#db.select().from(aiPlans).orderBy(desc(aiPlans.generatedAt)).limit(100).all(),
    );
  }

  public listByConversation(conversationId: string): AiPlanRecord[] {
    return this.#parseRows(
      this.#db
        .select()
        .from(aiPlans)
        .where(eq(aiPlans.conversationId, conversationId))
        .orderBy(desc(aiPlans.generatedAt))
        .limit(100)
        .all(),
    );
  }

  public find(id: string): AiPlanRecord | undefined {
    const row = this.#db.select().from(aiPlans).where(eq(aiPlans.id, id)).get();
    return row === undefined ? undefined : this.#parseRows([row])[0];
  }

  public save(plan: AiPlanRecord): void {
    const record = aiPlanRecordSchema.parse(plan);
    this.#db
      .insert(aiPlans)
      .values({
        id: record.plan.id,
        projectId: record.plan.projectId,
        conversationId: record.conversationId ?? null,
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
          conversationId: record.conversationId ?? null,
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

  #parseRows(rows: (typeof aiPlans.$inferSelect)[]): AiPlanRecord[] {
    return aiPlanListResponseSchema.parse({
      plans: rows.map((row) => ({
        id: row.id,
        projectId: row.projectId,
        ...(row.conversationId === null ? {} : { conversationId: row.conversationId }),
        goal: row.goal,
        reply: row.reply,
        plan: JSON.parse(row.planJson) as unknown,
        policy: JSON.parse(row.policyJson) as unknown,
        context: JSON.parse(row.contextJson) as unknown,
        generatedAt: row.generatedAt,
      })),
    }).plans;
  }
}
