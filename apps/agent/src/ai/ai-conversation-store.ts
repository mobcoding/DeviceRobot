import { desc, eq, inArray } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  aiConversationMessageSchema,
  aiConversationSchema,
  aiContextSnapshotSchema,
  type AiConversation,
  type AiConversationMessage,
  type AiContextSnapshot,
} from "@device-robot/contracts";

import {
  aiContextSnapshots,
  aiConversationMessages,
  aiConversations,
  aiPlans,
} from "../db/schema.js";
import type * as databaseSchema from "../db/schema.js";

export type CreateConversationRecord = Omit<AiConversation, "contextStatus">;
export type StoredAiConversationMessage = AiConversationMessage & { planId?: string };
export type AppendConversationMessage = Omit<AiConversationMessage, "plan"> & {
  planId?: string;
};
export type CreateContextSnapshot = AiContextSnapshot;

export interface AiConversationStore {
  listByProject(projectId: string): AiConversation[];
  find(id: string): AiConversation | undefined;
  create(conversation: CreateConversationRecord): AiConversation;
  updateContext(id: string, values: Pick<AiConversation, "sourceRevision" | "updatedAt">): void;
  listMessages(conversationId: string): StoredAiConversationMessage[];
  appendMessage(message: AppendConversationMessage): void;
  createSnapshot(snapshot: CreateContextSnapshot): void;
  latestSnapshot(conversationId: string): AiContextSnapshot | undefined;
  deleteByProject(projectId: string): void;
}

type ConversationContext = { sourceRevision?: string; sourceIndexAvailable: boolean };

function contextStatus(
  sourceRevision: string | null,
  context: ConversationContext,
): AiConversation["contextStatus"] {
  if (!context.sourceIndexAvailable) {
    return "unavailable";
  }
  if (sourceRevision !== null && sourceRevision !== context.sourceRevision) {
    return "outdated";
  }
  return "current";
}

export class DrizzleAiConversationStore implements AiConversationStore {
  readonly #db: BetterSQLite3Database<typeof databaseSchema>;

  public constructor(db: BetterSQLite3Database<typeof databaseSchema>) {
    this.#db = db;
  }

  public listByProject(projectId: string): AiConversation[] {
    return this.#db
      .select()
      .from(aiConversations)
      .where(eq(aiConversations.projectId, projectId))
      .orderBy(desc(aiConversations.updatedAt))
      .limit(100)
      .all()
      .map((row) => this.#parseConversation(row));
  }

  public find(id: string): AiConversation | undefined {
    const row = this.#db.select().from(aiConversations).where(eq(aiConversations.id, id)).get();
    return row === undefined ? undefined : this.#parseConversation(row);
  }

  public create(conversation: CreateConversationRecord): AiConversation {
    this.#db
      .insert(aiConversations)
      .values({
        id: conversation.id,
        projectId: conversation.projectId,
        appId: conversation.appId ?? null,
        variant: conversation.variant ?? null,
        title: conversation.title,
        sourceRevision: conversation.sourceRevision ?? null,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
      })
      .run();
    return this.find(conversation.id)!;
  }

  public updateContext(
    id: string,
    values: Pick<AiConversation, "sourceRevision" | "updatedAt">,
  ): void {
    this.#db
      .update(aiConversations)
      .set({ sourceRevision: values.sourceRevision ?? null, updatedAt: values.updatedAt })
      .where(eq(aiConversations.id, id))
      .run();
  }

  public listMessages(conversationId: string): StoredAiConversationMessage[] {
    const rows = this.#db
      .select()
      .from(aiConversationMessages)
      .where(eq(aiConversationMessages.conversationId, conversationId))
      .orderBy(aiConversationMessages.createdAt)
      .limit(500)
      .all();
    return rows.map((row) => ({
      ...aiConversationMessageSchema.parse({
        id: row.id,
        conversationId: row.conversationId,
        role: row.role,
        content: row.content,
        ...(row.contextSnapshotId === null ? {} : { contextSnapshotId: row.contextSnapshotId }),
        createdAt: row.createdAt,
      }),
      ...(row.planId === null ? {} : { planId: row.planId }),
    }));
  }

  public appendMessage(message: AppendConversationMessage): void {
    const parsed = aiConversationMessageSchema.parse(message);
    this.#db
      .insert(aiConversationMessages)
      .values({
        id: parsed.id,
        conversationId: parsed.conversationId,
        role: parsed.role,
        content: parsed.content,
        planId: message.planId ?? null,
        contextSnapshotId: parsed.contextSnapshotId ?? null,
        createdAt: parsed.createdAt,
      })
      .run();
  }

  public createSnapshot(snapshot: CreateContextSnapshot): void {
    const parsed = aiContextSnapshotSchema.parse(snapshot);
    this.#db
      .insert(aiContextSnapshots)
      .values({
        id: parsed.id,
        conversationId: parsed.conversationId,
        projectId: parsed.projectId,
        sourceRevision: parsed.sourceRevision ?? null,
        contextJson: JSON.stringify(parsed.context),
        createdAt: parsed.createdAt,
      })
      .run();
  }

  public latestSnapshot(conversationId: string): AiContextSnapshot | undefined {
    const row = this.#db
      .select()
      .from(aiContextSnapshots)
      .where(eq(aiContextSnapshots.conversationId, conversationId))
      .orderBy(desc(aiContextSnapshots.createdAt))
      .limit(1)
      .get();
    return row === undefined
      ? undefined
      : aiContextSnapshotSchema.parse({
          id: row.id,
          conversationId: row.conversationId,
          projectId: row.projectId,
          ...(row.sourceRevision === null ? {} : { sourceRevision: row.sourceRevision }),
          context: JSON.parse(row.contextJson) as unknown,
          createdAt: row.createdAt,
        });
  }

  public deleteByProject(projectId: string): void {
    this.#db.transaction((transaction) => {
      const conversationIds = transaction
        .select({ id: aiConversations.id })
        .from(aiConversations)
        .where(eq(aiConversations.projectId, projectId))
        .all()
        .map((conversation) => conversation.id);

      if (conversationIds.length > 0) {
        transaction
          .delete(aiConversationMessages)
          .where(inArray(aiConversationMessages.conversationId, conversationIds))
          .run();
      }
      transaction
        .delete(aiContextSnapshots)
        .where(eq(aiContextSnapshots.projectId, projectId))
        .run();
      transaction.delete(aiPlans).where(eq(aiPlans.projectId, projectId)).run();
      transaction.delete(aiConversations).where(eq(aiConversations.projectId, projectId)).run();
    });
  }

  #parseConversation(row: typeof aiConversations.$inferSelect): AiConversation {
    const latestSnapshot = this.latestSnapshot(row.id);
    const context = latestSnapshot?.context ?? { sourceIndexAvailable: false };
    return aiConversationSchema.parse({
      id: row.id,
      projectId: row.projectId,
      ...(row.appId === null ? {} : { appId: row.appId }),
      ...(row.variant === null ? {} : { variant: row.variant }),
      title: row.title,
      ...(row.sourceRevision === null ? {} : { sourceRevision: row.sourceRevision }),
      contextStatus: contextStatus(row.sourceRevision, context),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }
}
