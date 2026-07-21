import { z } from "zod";

import { actionPlanSchema } from "./action-plan.js";
import { androidSourceEvidenceSchema } from "./projects.js";

export const aiModelStatusSchema = z.object({
  configured: z.boolean(),
  provider: z.literal("openai-compatible"),
  baseUrl: z.string().url().optional(),
  model: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
});

export const generateAiPlanRequestSchema = z.object({
  projectId: z.uuid(),
  deviceSerial: z.string().min(1).max(256).optional(),
  goal: z.string().min(1).max(4_000),
});

export const aiPlanPolicySchema = z.object({
  allowed: z.boolean(),
  requiresApproval: z.boolean(),
  reason: z.string().min(1),
  warnings: z.array(z.string().min(1)).max(20),
});

export const aiPlanContextSchema = z.object({
  projectName: z.string().min(1),
  sourceIndexAvailable: z.boolean(),
  evidence: z.array(androidSourceEvidenceSchema).max(80),
});

export const aiPlanResponseSchema = z.object({
  reply: z.string().min(1).max(8_000),
  plan: actionPlanSchema,
  policy: aiPlanPolicySchema,
  context: aiPlanContextSchema,
  generatedAt: z.iso.datetime(),
});

export type AiModelStatus = z.infer<typeof aiModelStatusSchema>;
export type GenerateAiPlanRequest = z.infer<typeof generateAiPlanRequestSchema>;
export type AiPlanPolicy = z.infer<typeof aiPlanPolicySchema>;
export type AiPlanContext = z.infer<typeof aiPlanContextSchema>;
export type AiPlanResponse = z.infer<typeof aiPlanResponseSchema>;
