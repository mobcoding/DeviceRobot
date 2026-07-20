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

export type DeviceFileKind = z.infer<typeof deviceFileKindSchema>;
export type DeviceFileEntry = z.infer<typeof deviceFileEntrySchema>;
export type DeviceFileListResponse = z.infer<typeof deviceFileListResponseSchema>;
export type DeviceApplicationSource = z.infer<typeof deviceApplicationSourceSchema>;
export type DeviceApplicationFilter = z.infer<typeof deviceApplicationFilterSchema>;
export type DeviceApplication = z.infer<typeof deviceApplicationSchema>;
export type DeviceApplicationListResponse = z.infer<typeof deviceApplicationListResponseSchema>;
