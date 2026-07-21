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

export const apkInstallAudits = sqliteTable("apk_install_audits", {
  id: text("id").primaryKey(),
  artifactId: text("artifact_id").notNull(),
  serial: text("serial").notNull(),
  fileName: text("file_name").notNull(),
  packageName: text("package_name").notNull(),
  sha256: text("sha256").notNull(),
  success: integer("success", { mode: "boolean" }).notNull(),
  message: text("message"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at").notNull(),
});

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  source: text("source").notNull(),
  rootPath: text("root_path").notNull().unique(),
  remoteUrl: text("remote_url"),
  revision: text("revision"),
  gradleWrapper: integer("gradle_wrapper", { mode: "boolean" }).notNull(),
  modulesJson: text("modules_json").notNull(),
  sourceIndexJson: text("source_index_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
