import { z } from "zod";

import { agentActionSchema } from "./action-plan.js";

export const sourceEvidenceSchema = z.object({
  file: z.string().min(1).max(4_096),
  line: z.number().int().positive(),
});

export const testStepSchema = z.object({
  id: z.string().min(1).max(256),
  action: agentActionSchema,
  healingEnabled: z.boolean().default(true),
});

export const testCaseSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  priority: z.enum(["P0", "P1", "P2", "P3"]).default("P2"),
  tags: z.array(z.string().min(1).max(128)).max(50).default([]),
  sourceEvidence: z.array(sourceEvidenceSchema).max(500).default([]),
  data: z
    .record(z.string().max(256), z.string().max(8_000))
    .refine((value) => Object.keys(value).length <= 100, "测试数据键数不能超过 100。")
    .default({}),
  steps: z.array(testStepSchema).min(1).max(20),
});

export const testSuiteSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.string().min(1).max(512),
  suite: z.object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    sourceRevision: z.string().min(1).max(256),
  }),
  cases: z.array(testCaseSchema).min(1).max(500),
});

export const testSuiteRecordSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  fileName: z.string().min(1).max(255),
  suite: testSuiteSchema,
  importedAt: z.iso.datetime(),
});

export const testSuiteListResponseSchema = z.object({
  projectId: z.uuid(),
  suites: z.array(testSuiteRecordSchema).max(100),
});

export const startTestSuiteCaseRequestSchema = z
  .object({
    deviceSerial: z.string().min(1).max(256),
    approved: z.literal(true),
  })
  .strict();

export type SourceEvidence = z.infer<typeof sourceEvidenceSchema>;
export type TestStep = z.infer<typeof testStepSchema>;
export type TestCase = z.infer<typeof testCaseSchema>;
export type TestSuite = z.infer<typeof testSuiteSchema>;
export type TestSuiteRecord = z.infer<typeof testSuiteRecordSchema>;
export type TestSuiteListResponse = z.infer<typeof testSuiteListResponseSchema>;
export type StartTestSuiteCaseRequest = z.infer<typeof startTestSuiteCaseRequestSchema>;
