import { z } from "zod";

export const localDataCategorySchema = z.enum(["buildLogs", "reports", "artifacts", "downloads"]);

export const localDataUsageSchema = z.object({
  category: localDataCategorySchema,
  fileCount: z.number().int().nonnegative(),
  sizeBytes: z.number().int().nonnegative(),
});

export const localDataUsageResponseSchema = z.object({
  usage: z.array(localDataUsageSchema),
  excluded: z.array(z.string().min(1)),
});

export const cleanupLocalDataRequestSchema = z
  .object({
    categories: z.array(localDataCategorySchema).min(1).max(4),
    olderThanDays: z.number().int().min(1).max(3_650),
    approved: z.literal(true),
  })
  .strict();

export const cleanupLocalDataResponseSchema = z.object({
  deletedFileCount: z.number().int().nonnegative(),
  reclaimedBytes: z.number().int().nonnegative(),
});

export type LocalDataCategory = z.infer<typeof localDataCategorySchema>;
export type LocalDataUsage = z.infer<typeof localDataUsageSchema>;
export type LocalDataUsageResponse = z.infer<typeof localDataUsageResponseSchema>;
export type CleanupLocalDataRequest = z.infer<typeof cleanupLocalDataRequestSchema>;
export type CleanupLocalDataResponse = z.infer<typeof cleanupLocalDataResponseSchema>;
