import { agentActionSchema } from "@device-robot/contracts";
import { z } from "zod";

export const sourceEvidenceSchema = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
});

export const testStepSchema = z.object({
  id: z.string().min(1),
  action: agentActionSchema,
  healingEnabled: z.boolean().default(true),
});

export const testCaseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  priority: z.enum(["P0", "P1", "P2", "P3"]).default("P2"),
  tags: z.array(z.string().min(1)).default([]),
  sourceEvidence: z.array(sourceEvidenceSchema).default([]),
  data: z.record(z.string(), z.string()).default({}),
  steps: z.array(testStepSchema).min(1),
});

export const testSuiteSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.string().min(1),
  suite: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    sourceRevision: z.string().min(1),
  }),
  cases: z.array(testCaseSchema).min(1),
});

export type SourceEvidence = z.infer<typeof sourceEvidenceSchema>;
export type TestStep = z.infer<typeof testStepSchema>;
export type TestCase = z.infer<typeof testCaseSchema>;
export type TestSuite = z.infer<typeof testSuiteSchema>;
