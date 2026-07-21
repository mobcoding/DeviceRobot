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

export const androidProjectSchema = z.object({
  id: z.uuid(),
  name: z.string().min(1),
  source: projectSourceSchema,
  rootPath: z.string().min(1),
  remoteUrl: z.string().url().optional(),
  revision: z.string().min(1).optional(),
  gradleWrapper: z.boolean(),
  modules: z.array(androidProjectModuleSchema).max(200),
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
export type AndroidProject = z.infer<typeof androidProjectSchema>;
export type ProjectListResponse = z.infer<typeof projectListResponseSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
