import { z } from "zod";

const screenRecordingBitRateSchema = z.number().int().min(1).max(20);
const screenRecordingResolutionSchema = z.union([z.literal(50), z.literal(75), z.literal(100)]);

export const screenRecordingConfigurationSchema = z.object({
  bitRateMbps: screenRecordingBitRateSchema,
  resolutionPercent: screenRecordingResolutionSchema,
  showTouches: z.boolean(),
  outputDirectory: z.string().trim().min(1).max(1_024),
});

export const startScreenRecordingRequestSchema = screenRecordingConfigurationSchema;

export const openScreenRecordingLocationRequestSchema = z.object({
  savedPath: z.string().trim().min(1).max(1_024),
});

export const openScreenRecordingLocationResponseSchema = z.object({
  opened: z.literal(true),
});

export const screenRecordingStatusSchema = z.object({
  serial: z.string().min(1),
  recording: z.boolean(),
  configuration: screenRecordingConfigurationSchema,
  maxDurationSeconds: z.literal(1_800),
  startedAt: z.iso.datetime().optional(),
});

export const screenRecordingResultSchema = z.object({
  serial: z.string().min(1),
  savedPath: z.string().min(1),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});

export type ScreenRecordingConfiguration = z.infer<typeof screenRecordingConfigurationSchema>;
export type StartScreenRecordingRequest = z.infer<typeof startScreenRecordingRequestSchema>;
export type OpenScreenRecordingLocationRequest = z.infer<
  typeof openScreenRecordingLocationRequestSchema
>;
export type ScreenRecordingStatus = z.infer<typeof screenRecordingStatusSchema>;
export type ScreenRecordingResult = z.infer<typeof screenRecordingResultSchema>;
