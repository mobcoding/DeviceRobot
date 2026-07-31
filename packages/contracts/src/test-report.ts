import { z } from "zod";

import { testExecutionRunSchema } from "./test-execution.js";

export const testExecutionReportSchema = z.object({
  run: testExecutionRunSchema,
  generatedAt: z.iso.datetime(),
  htmlFileName: z.string().min(1).max(255),
  zipFileName: z.string().min(1).max(255),
  screenshotCount: z.number().int().nonnegative().max(60),
  evidence: z.object({
    uiXml: z.boolean(),
    logcat: z.boolean(),
    appiumLog: z.boolean(),
  }),
});

export type TestExecutionReport = z.infer<typeof testExecutionReportSchema>;
