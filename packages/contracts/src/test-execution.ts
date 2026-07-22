import { z } from "zod";

import { actionPlanSchema, agentActionSchema } from "./action-plan.js";

export const testExecutionStatusSchema = z.enum(["running", "succeeded", "failed", "cancelled"]);

export const testStepExecutionStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const testStepExecutionSchema = z.object({
  index: z.number().int().nonnegative(),
  action: agentActionSchema,
  status: testStepExecutionStatusSchema,
  message: z.string().min(1).max(8_000).optional(),
  screenshotAvailable: z.boolean(),
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
});

export const testExecutionRunSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  planId: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  deviceSerial: z.string().min(1).max(256),
  appId: z.string().min(1).max(512),
  status: testExecutionStatusSchema,
  message: z.string().min(1).max(8_000).optional(),
  steps: z.array(testStepExecutionSchema).max(20),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
});

export const startTestExecutionRequestSchema = z
  .object({
    plan: actionPlanSchema,
    deviceSerial: z.string().min(1).max(256),
    appId: z.string().min(1).max(512),
    name: z.string().min(1).max(256).optional(),
    approved: z.literal(true),
  })
  .strict();

export const testExecutionRunListResponseSchema = z.object({
  runs: z.array(testExecutionRunSchema),
});

export type TestExecutionStatus = z.infer<typeof testExecutionStatusSchema>;
export type TestStepExecutionStatus = z.infer<typeof testStepExecutionStatusSchema>;
export type TestStepExecution = z.infer<typeof testStepExecutionSchema>;
export type TestExecutionRun = z.infer<typeof testExecutionRunSchema>;
export type StartTestExecutionRequest = z.infer<typeof startTestExecutionRequestSchema>;
export type TestExecutionRunListResponse = z.infer<typeof testExecutionRunListResponseSchema>;
