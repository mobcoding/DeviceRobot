import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const appMetadata = sqliteTable("app_metadata", {
  id: integer("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const deviceActionAudits = sqliteTable("device_action_audits", {
  id: text("id").primaryKey(),
  serial: text("serial").notNull(),
  actionName: text("action_name").notNull(),
  payloadJson: text("payload_json").notNull(),
  success: integer("success", { mode: "boolean" }).notNull(),
  message: text("message"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at").notNull(),
});
