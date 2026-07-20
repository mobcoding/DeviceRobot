import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  version: z.string().min(1),
  startedAt: z.iso.datetime(),
  dataDirectory: z.string().min(1),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
