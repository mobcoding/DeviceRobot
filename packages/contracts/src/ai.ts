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

export const aiModelListRequestSchema = z.object({
  baseUrl: z.string().trim().url().max(2_048).optional(),
  apiKey: z.string().trim().min(1).max(4_096).optional(),
});

export const aiModelListResponseSchema = z.object({
  provider: z.literal("openai-compatible"),
  models: z.array(z.string().min(1).max(256)).min(1).max(1_000),
});

export const aiModelConnectionTestRequestSchema = aiModelListRequestSchema.extend({
  model: z.string().trim().min(1).max(256),
});

export const aiModelConnectionTestResponseSchema = z.object({
  provider: z.literal("openai-compatible"),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  message: z.string().min(1).max(1_000),
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
export type AiModelListRequest = z.infer<typeof aiModelListRequestSchema>;
export type AiModelListResponse = z.infer<typeof aiModelListResponseSchema>;
export type AiModelConnectionTestRequest = z.infer<typeof aiModelConnectionTestRequestSchema>;
export type AiModelConnectionTestResponse = z.infer<typeof aiModelConnectionTestResponseSchema>;
export type GenerateAiPlanRequest = z.infer<typeof generateAiPlanRequestSchema>;
export type AiPlanPolicy = z.infer<typeof aiPlanPolicySchema>;
export type AiPlanContext = z.infer<typeof aiPlanContextSchema>;
export type AiPlanResponse = z.infer<typeof aiPlanResponseSchema>;
