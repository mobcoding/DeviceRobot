import { z } from "zod";

export const deviceFileKindSchema = z.enum(["directory", "file", "link", "other"]);

export const deviceFileEntrySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  kind: deviceFileKindSchema,
});

export const deviceFileListResponseSchema = z.object({
  serial: z.string().min(1),
  path: z.string().min(1),
  parentPath: z.string().min(1).optional(),
  entries: z.array(deviceFileEntrySchema),
  readAt: z.iso.datetime(),
});

export const deviceApplicationSourceSchema = z.enum(["user", "system"]);
export const deviceApplicationFilterSchema = z.enum(["all", "user", "system"]);

export const deviceApplicationSchema = z.object({
  packageName: z.string().min(1),
  source: deviceApplicationSourceSchema,
  apkPath: z.string().min(1).optional(),
  versionCode: z.string().min(1).optional(),
});

export const deviceApplicationListResponseSchema = z.object({
  serial: z.string().min(1),
  filter: deviceApplicationFilterSchema,
  applications: z.array(deviceApplicationSchema),
  readAt: z.iso.datetime(),
});

export const deviceLogcatLevelSchema = z.enum([
  "verbose",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "assert",
  "unknown",
]);

export const deviceLogcatEntrySchema = z.object({
  timestamp: z.string().min(1).optional(),
  processId: z.number().int().nonnegative().optional(),
  threadId: z.number().int().nonnegative().optional(),
  level: deviceLogcatLevelSchema,
  tag: z.string().min(1).optional(),
  message: z.string(),
});

export const deviceLogcatResponseSchema = z.object({
  serial: z.string().min(1),
  entries: z.array(deviceLogcatEntrySchema).max(1_000),
  readAt: z.iso.datetime(),
});

export type DeviceFileKind = z.infer<typeof deviceFileKindSchema>;
export type DeviceFileEntry = z.infer<typeof deviceFileEntrySchema>;
export type DeviceFileListResponse = z.infer<typeof deviceFileListResponseSchema>;
export type DeviceApplicationSource = z.infer<typeof deviceApplicationSourceSchema>;
export type DeviceApplicationFilter = z.infer<typeof deviceApplicationFilterSchema>;
export type DeviceApplication = z.infer<typeof deviceApplicationSchema>;
export type DeviceApplicationListResponse = z.infer<typeof deviceApplicationListResponseSchema>;
export type DeviceLogcatLevel = z.infer<typeof deviceLogcatLevelSchema>;
export type DeviceLogcatEntry = z.infer<typeof deviceLogcatEntrySchema>;
export type DeviceLogcatResponse = z.infer<typeof deviceLogcatResponseSchema>;
