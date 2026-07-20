import { describe, expect, it } from "vitest";

import { testSuiteSchema } from "../src/index.js";

describe("test suite DSL", () => {
  it("parses a deterministic login test", () => {
    const suite = testSuiteSchema.parse({
      schemaVersion: 1,
      appId: "com.example.app",
      suite: {
        id: "login-suite",
        name: "Login suite",
        sourceRevision: "abc123",
      },
      cases: [
        {
          id: "valid-login",
          name: "Valid login",
          priority: "P0",
          steps: [
            {
              id: "tap-login",
              action: { action: "ui.tap", target: { text: "Login" } },
            },
          ],
        },
      ],
    });

    expect(suite.cases[0]?.steps[0]?.healingEnabled).toBe(true);
  });

  it("rejects unsupported schema versions", () => {
    expect(
      testSuiteSchema.safeParse({ schemaVersion: 2, appId: "x", suite: {}, cases: [] }).success,
    ).toBe(false);
  });
});
