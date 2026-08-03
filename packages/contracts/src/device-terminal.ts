import { z } from "zod";

export const deviceTerminalCommandSchema = z.object({
  command: z.string().trim().min(1).max(4_096),
});

export const deviceTerminalResponseSchema = z.object({
  serial: z.string().min(1),
  command: z.string().min(1).max(4_096),
  output: z.string().max(512 * 1_024),
  exitCode: z.number().int().min(0).max(255),
  executedAt: z.iso.datetime(),
});

export type DeviceTerminalCommand = z.infer<typeof deviceTerminalCommandSchema>;
export type DeviceTerminalResponse = z.infer<typeof deviceTerminalResponseSchema>;
