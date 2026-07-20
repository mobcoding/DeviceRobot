import { z } from "zod";

const coordinateSchema = z.number().int().min(0).max(10_000);
const durationSchema = z.number().int().min(50).max(30_000);
const androidPackageSchema = z
  .string()
  .regex(
    /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/,
    "A valid Android package name is required",
  );

export const deviceControlActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ui.tap"), x: coordinateSchema, y: coordinateSchema }),
  z.object({
    action: z.literal("ui.longPress"),
    x: coordinateSchema,
    y: coordinateSchema,
    durationMs: durationSchema.optional(),
  }),
  z.object({ action: z.literal("ui.input"), value: z.string().min(1).max(500) }),
  z.object({
    action: z.literal("ui.swipe"),
    startX: coordinateSchema,
    startY: coordinateSchema,
    endX: coordinateSchema,
    endY: coordinateSchema,
    durationMs: durationSchema.optional(),
  }),
  z.object({ action: z.literal("ui.back") }),
  z.object({ action: z.literal("app.launch"), appId: androidPackageSchema }),
  z.object({ action: z.literal("app.stop"), appId: androidPackageSchema }),
]);

export const deviceUiTreeResponseSchema = z.object({
  serial: z.string().min(1),
  xml: z.string().min(1),
  capturedAt: z.iso.datetime(),
});

export const deviceActionAuditSchema = z.object({
  id: z.uuid(),
  serial: z.string().min(1),
  action: deviceControlActionSchema,
  success: z.boolean(),
  message: z.string().min(1).optional(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});

export const deviceActionResultSchema = deviceActionAuditSchema.extend({
  success: z.literal(true),
});

export const deviceActionHistoryResponseSchema = z.object({
  serial: z.string().min(1),
  actions: z.array(deviceActionAuditSchema),
});

export type DeviceControlAction = z.infer<typeof deviceControlActionSchema>;
export type DeviceUiTreeResponse = z.infer<typeof deviceUiTreeResponseSchema>;
export type DeviceActionAudit = z.infer<typeof deviceActionAuditSchema>;
export type DeviceActionResult = z.infer<typeof deviceActionResultSchema>;
export type DeviceActionHistoryResponse = z.infer<typeof deviceActionHistoryResponseSchema>;
