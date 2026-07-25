import { z } from "zod";

import { actionPlanSchema, agentActionSchema } from "./action-plan.js";

export const workspaceActionExecutionStatusSchema = z.enum(["succeeded", "failed"]);

export const workspaceActionResultSchema = z.object({
  index: z.number().int().nonnegative(),
  action: agentActionSchema,
  status: workspaceActionExecutionStatusSchema,
  message: z.string().min(1).max(8_000).optional(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});

export const workspaceExecutionResponseSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  deviceSerial: z.string().min(1).max(256),
  status: workspaceActionExecutionStatusSchema,
  results: z.array(workspaceActionResultSchema).min(1).max(20),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});

export const startWorkspaceExecutionRequestSchema = z
  .object({
    plan: actionPlanSchema,
    deviceSerial: z.string().min(1).max(256),
  })
  .strict();

export type WorkspaceActionExecutionStatus = z.infer<typeof workspaceActionExecutionStatusSchema>;
export type WorkspaceActionResult = z.infer<typeof workspaceActionResultSchema>;
export type WorkspaceExecutionResponse = z.infer<typeof workspaceExecutionResponseSchema>;
export type StartWorkspaceExecutionRequest = z.infer<typeof startWorkspaceExecutionRequestSchema>;
