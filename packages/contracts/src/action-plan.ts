import { z } from "zod";

export const selectorSchema = z
  .object({
    accessibilityId: z.string().min(1).optional(),
    resourceId: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    className: z.string().min(1).optional(),
    x: z.number().int().nonnegative().optional(),
    y: z.number().int().nonnegative().optional(),
  })
  .refine(
    (selector) =>
      selector.accessibilityId !== undefined ||
      selector.resourceId !== undefined ||
      selector.text !== undefined ||
      selector.className !== undefined ||
      (selector.x !== undefined && selector.y !== undefined),
    "A selector must include a semantic locator or an x/y coordinate pair",
  );

const timeoutSchema = z.number().int().positive().max(120_000).optional();

const appActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("app.install"), apkPath: z.string().min(1) }),
  z.object({ action: z.literal("app.launch"), appId: z.string().min(1) }),
  z.object({ action: z.literal("app.stop"), appId: z.string().min(1) }),
]);

const uiActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ui.tap"), target: selectorSchema, timeoutMs: timeoutSchema }),
  z.object({
    action: z.literal("ui.longPress"),
    target: selectorSchema,
    durationMs: z.number().int().positive().max(30_000).optional(),
  }),
  z.object({
    action: z.literal("ui.input"),
    target: selectorSchema.optional(),
    value: z.string(),
  }),
  z.object({
    action: z.literal("ui.swipe"),
    start: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }),
    end: z.object({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }),
    durationMs: z.number().int().positive().max(30_000).optional(),
  }),
  z.object({ action: z.literal("ui.back") }),
  z.object({ action: z.literal("ui.wait"), durationMs: z.number().int().positive().max(120_000) }),
]);

const assertionActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("assert.visible"),
    target: selectorSchema,
    timeoutMs: timeoutSchema,
  }),
  z.object({
    action: z.literal("assert.notVisible"),
    target: selectorSchema,
    timeoutMs: timeoutSchema,
  }),
  z.object({
    action: z.literal("assert.text"),
    target: selectorSchema,
    expected: z.string(),
    timeoutMs: timeoutSchema,
  }),
  z.object({
    action: z.literal("assert.activity"),
    expected: z.string().min(1),
    timeoutMs: timeoutSchema,
  }),
]);

const deviceActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("device.permission"),
    appId: z.string().min(1),
    permission: z.string().min(1),
    mode: z.enum(["grant", "revoke"]),
  }),
  z.object({
    action: z.literal("device.orientation"),
    orientation: z.enum(["portrait", "landscape"]),
  }),
  z.object({ action: z.literal("device.screenshot"), name: z.string().min(1).optional() }),
]);

const adbActionSchema = z.object({
  action: z.literal("adb.shell"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
});

export const agentActionSchema = z.union([
  appActionSchema,
  uiActionSchema,
  assertionActionSchema,
  deviceActionSchema,
  adbActionSchema,
]);

export type AgentAction = z.infer<typeof agentActionSchema>;

export const actionPlanSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  deviceSerial: z.string().min(1).optional(),
  actions: z.array(agentActionSchema).min(1).max(20),
  requiresApproval: z.boolean(),
});

export type ActionPlan = z.infer<typeof actionPlanSchema>;
export type Selector = z.infer<typeof selectorSchema>;
