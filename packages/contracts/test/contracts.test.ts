import { describe, expect, it } from "vitest";

import { actionPlanSchema, healthResponseSchema } from "../src/index.js";

describe("shared contracts", () => {
  it("accepts a valid health response", () => {
    expect(
      healthResponseSchema.parse({
        status: "ok",
        version: "0.1.0",
        startedAt: "2026-07-20T10:00:00.000Z",
        dataDirectory: "C:\\Users\\tester\\AppData\\Local\\AIMobileTester",
      }),
    ).toBeDefined();
  });

  it("rejects an action plan without a usable selector", () => {
    const result = actionPlanSchema.safeParse({
      id: "plan-1",
      projectId: "project-1",
      requiresApproval: true,
      actions: [{ action: "ui.tap", target: {} }],
    });

    expect(result.success).toBe(false);
  });
});
