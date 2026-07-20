import { z } from "zod";

const runtimeDependencySchema = z.object({
  available: z.boolean(),
  version: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

export const appiumRuntimeSchema = z.object({
  status: z.enum(["ready", "degraded"]),
  checkedAt: z.iso.datetime(),
  appium: runtimeDependencySchema,
  uiautomator2: runtimeDependencySchema.extend({
    packageName: z.literal("appium-uiautomator2-driver"),
  }),
  java: runtimeDependencySchema,
  androidSdk: runtimeDependencySchema,
  server: z.object({
    state: z.enum(["stopped", "starting", "running", "failed"]),
    host: z.literal("127.0.0.1"),
    port: z.number().int().min(1).max(65_535),
    logFile: z.string().min(1),
    startedAt: z.iso.datetime().optional(),
    error: z.string().min(1).optional(),
  }),
  issues: z.array(z.string().min(1)),
});

export type AppiumRuntime = z.infer<typeof appiumRuntimeSchema>;
