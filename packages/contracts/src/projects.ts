import { z } from "zod";

export const projectSourceSchema = z.enum(["local", "git"]);
export const androidProjectModuleTypeSchema = z.enum(["application", "library", "unknown"]);

export const androidProjectModuleSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  buildFile: z.string().min(1),
  moduleType: androidProjectModuleTypeSchema.optional(),
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

export const androidBuildTargetSchema = z.object({
  modulePath: z.string().min(1),
  moduleName: z.string().min(1),
  variant: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u),
  taskName: z.string().regex(/^:[A-Za-z0-9_:]+$/u),
});

export const androidSdkInfoSchema = z.object({
  available: z.boolean(),
  path: z.string().min(1).optional(),
  source: z.enum(["environment", "local-properties", "managed", "unavailable"]),
  requiredPackages: z.array(z.string().min(1)).max(32).default([]),
  missingPackages: z.array(z.string().min(1)).max(32).default([]),
});

export const installAndroidSdkRequestSchema = z.object({
  approved: z.literal(true),
});

export const androidBuildTargetListResponseSchema = z.object({
  projectId: z.uuid(),
  gradleWrapper: z.boolean(),
  androidSdk: androidSdkInfoSchema,
  targets: z.array(androidBuildTargetSchema).max(500),
});

export const projectBuildRunStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);

export const projectBuildRunSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  modulePath: z.string().min(1),
  variant: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u),
  taskName: z.string().regex(/^:[A-Za-z0-9_:]+$/u),
  status: projectBuildRunStatusSchema,
  logPath: z.string().min(1),
  artifactPaths: z.array(z.string().min(1)).max(100),
  message: z.string().min(1).optional(),
  exitCode: z.number().int().nullable().optional(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
});

export const projectBuildRunListResponseSchema = z.object({
  projectId: z.uuid(),
  runs: z.array(projectBuildRunSchema).max(100),
});

export const startProjectBuildRequestSchema = z.object({
  modulePath: z.string().min(1).max(1_024),
  variant: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/u),
  approved: z.literal(true),
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
export type AndroidProjectModuleType = z.infer<typeof androidProjectModuleTypeSchema>;
export type AndroidProjectModule = z.infer<typeof androidProjectModuleSchema>;
export type AndroidSourceEvidenceKind = z.infer<typeof androidSourceEvidenceKindSchema>;
export type AndroidSourceEvidence = z.infer<typeof androidSourceEvidenceSchema>;
export type AndroidSourceIndexModule = z.infer<typeof androidSourceIndexModuleSchema>;
export type AndroidSourceIndexSummary = z.infer<typeof androidSourceIndexSummarySchema>;
export type AndroidSourceIndex = z.infer<typeof androidSourceIndexSchema>;
export type AndroidBuildTarget = z.infer<typeof androidBuildTargetSchema>;
export type AndroidSdkInfo = z.infer<typeof androidSdkInfoSchema>;
export type InstallAndroidSdkRequest = z.infer<typeof installAndroidSdkRequestSchema>;
export type AndroidBuildTargetListResponse = z.infer<typeof androidBuildTargetListResponseSchema>;
export type ProjectBuildRunStatus = z.infer<typeof projectBuildRunStatusSchema>;
export type ProjectBuildRun = z.infer<typeof projectBuildRunSchema>;
export type ProjectBuildRunListResponse = z.infer<typeof projectBuildRunListResponseSchema>;
export type StartProjectBuildRequest = z.infer<typeof startProjectBuildRequestSchema>;
export type AndroidProject = z.infer<typeof androidProjectSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
