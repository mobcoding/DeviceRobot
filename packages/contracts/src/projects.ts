import { z } from "zod";

export const projectSourceSchema = z.enum(["local", "git"]);

export const androidProjectModuleSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  buildFile: z.string().min(1),
  manifestPath: z.string().min(1).optional(),
  packageName: z.string().min(1).optional(),
  applicationId: z.string().min(1).optional(),
  variants: z.array(z.string().min(1)),
});

export const androidSourceEvidenceKindSchema = z.enum([
  "xml-view",
  "compose-screen",
  "navigation-destination",
  "kotlin-type",
  "java-type",
]);

export const androidSourceEvidenceSchema = z.object({
  kind: androidSourceEvidenceKindSchema,
  name: z.string().min(1),
  filePath: z.string().min(1),
  line: z.number().int().positive(),
  modulePath: z.string().min(1),
});

export const androidSourceIndexModuleSchema = z.object({
  path: z.string().min(1),
  sourceFileCount: z.number().int().nonnegative(),
  xmlViewCount: z.number().int().nonnegative(),
  composeScreenCount: z.number().int().nonnegative(),
  navigationDestinationCount: z.number().int().nonnegative(),
  typeCount: z.number().int().nonnegative(),
});

export const androidSourceIndexSummarySchema = z.object({
  filesScanned: z.number().int().nonnegative(),
  kotlinJavaFileCount: z.number().int().nonnegative(),
  xmlViewCount: z.number().int().nonnegative(),
  composeScreenCount: z.number().int().nonnegative(),
  navigationDestinationCount: z.number().int().nonnegative(),
  typeCount: z.number().int().nonnegative(),
});

export const androidSourceIndexSchema = z.object({
  schemaVersion: z.literal(1),
  scannedAt: z.iso.datetime(),
  summary: androidSourceIndexSummarySchema,
  modules: z.array(androidSourceIndexModuleSchema).max(200),
  evidence: z.array(androidSourceEvidenceSchema).max(2_000),
});

export const androidProjectSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  source: projectSourceSchema,
  rootPath: z.string().min(1),
  remoteUrl: z.string().url().optional(),
  revision: z.string().min(1).optional(),
  gradleWrapper: z.boolean(),
  modules: z.array(androidProjectModuleSchema).max(200),
  sourceIndex: androidSourceIndexSchema.optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const projectListResponseSchema = z.object({
  projects: z.array(androidProjectSchema),
});

export const createProjectRequestSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("local"), rootPath: z.string().min(1).max(4_096) }),
  z.object({ source: z.literal("git"), remoteUrl: z.string().url().max(2_048) }),
]);

export type ProjectSource = z.infer<typeof projectSourceSchema>;
export type AndroidProjectModule = z.infer<typeof androidProjectModuleSchema>;
export type AndroidSourceEvidenceKind = z.infer<typeof androidSourceEvidenceKindSchema>;
export type AndroidSourceEvidence = z.infer<typeof androidSourceEvidenceSchema>;
export type AndroidSourceIndexModule = z.infer<typeof androidSourceIndexModuleSchema>;
export type AndroidSourceIndexSummary = z.infer<typeof androidSourceIndexSummarySchema>;
export type AndroidSourceIndex = z.infer<typeof androidSourceIndexSchema>;
export type AndroidProject = z.infer<typeof androidProjectSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
