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
  conversationId: z.uuid().optional(),
  deviceSerial: z.string().min(1).max(256).optional(),
  appId: z.string().min(1).max(256).optional(),
  // Opaque IDs returned by the local Agent after the user explicitly uploads APK files.
  // Local paths are intentionally never accepted by the API contract.
  installableArtifactIds: z.array(z.uuid()).max(20).optional(),
  liveUiExecution: z.boolean().optional(),
  workspaceExecution: z.boolean().optional(),
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

export const aiConversationContextStatusSchema = z.enum(["current", "outdated", "unavailable"]);

export const aiConversationSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  appId: z.string().min(1).max(256).optional(),
  variant: z.string().min(1).max(256).optional(),
  title: z.string().min(1).max(256),
  sourceRevision: z.string().min(1).max(512).optional(),
  contextStatus: aiConversationContextStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const createAiConversationRequestSchema = z
  .object({
    appId: z.string().min(1).max(256).optional(),
    variant: z.string().min(1).max(256).optional(),
    title: z.string().min(1).max(256).optional(),
  })
  .strict();

export const aiContextSnapshotSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  projectId: z.uuid(),
  sourceRevision: z.string().min(1).max(512).optional(),
  context: aiPlanContextSchema,
  createdAt: z.iso.datetime(),
});

export const aiConversationMessageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(8_000),
  plan: aiPlanResponseSchema.optional(),
  contextSnapshotId: z.uuid().optional(),
  createdAt: z.iso.datetime(),
});

export const aiConversationListResponseSchema = z.object({
  projectId: z.uuid(),
  conversations: z.array(aiConversationSchema).max(100),
});

export const aiConversationDetailResponseSchema = z.object({
  conversation: aiConversationSchema,
  messages: z.array(aiConversationMessageSchema).max(500),
  latestContextSnapshot: aiContextSnapshotSchema.optional(),
});

export const aiPlanRecordSchema = aiPlanResponseSchema.extend({
  goal: z.string().min(1).max(4_000),
  conversationId: z.uuid().optional(),
});

export const aiPlanListResponseSchema = z.object({
  plans: z.array(aiPlanRecordSchema).max(100),
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
export type AiConversationContextStatus = z.infer<typeof aiConversationContextStatusSchema>;
export type AiConversation = z.infer<typeof aiConversationSchema>;
export type CreateAiConversationRequest = z.infer<typeof createAiConversationRequestSchema>;
export type AiContextSnapshot = z.infer<typeof aiContextSnapshotSchema>;
export type AiConversationMessage = z.infer<typeof aiConversationMessageSchema>;
export type AiConversationListResponse = z.infer<typeof aiConversationListResponseSchema>;
export type AiConversationDetailResponse = z.infer<typeof aiConversationDetailResponseSchema>;
export type AiPlanRecord = z.infer<typeof aiPlanRecordSchema>;
export type AiPlanListResponse = z.infer<typeof aiPlanListResponseSchema>;
