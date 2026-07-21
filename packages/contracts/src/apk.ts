import { z } from "zod";

const androidPackageNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u);

export const apkMetadataSchema = z.object({
  packageName: androidPackageNameSchema,
  applicationLabel: z.string().min(1).optional(),
  versionName: z.string().min(1).optional(),
  versionCode: z.string().min(1),
  minSdkVersion: z.string().min(1).optional(),
  targetSdkVersion: z.string().min(1).optional(),
});

export const apkArtifactSchema = z.object({
  id: z.uuid(),
  fileName: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  uploadedAt: z.iso.datetime(),
  metadata: apkMetadataSchema,
});

export const apkInstallRequestSchema = z.object({
  replaceExisting: z.boolean().default(true),
  allowTestPackage: z.boolean().default(true),
  // This is deliberately opt-in because uninstalling removes the application's local data.
  uninstallExisting: z.boolean().default(false),
});

export const apkInstallResponseSchema = z.object({
  status: z.literal("installed"),
  serial: z.string().min(1),
  artifactId: z.uuid(),
  packageName: androidPackageNameSchema,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  message: z.string().min(1).optional(),
});

export type ApkMetadata = z.infer<typeof apkMetadataSchema>;
export type ApkArtifact = z.infer<typeof apkArtifactSchema>;
export type ApkInstallRequest = z.infer<typeof apkInstallRequestSchema>;
export type ApkInstallResponse = z.infer<typeof apkInstallResponseSchema>;
