import { describe, expect, it } from "vitest";

import { parseTestSuiteDocument, testSuiteSchema } from "../src/index.js";

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

    expect(suite.cases[0]?.steps[0]?.healingEnabled).toBe(false);
  });

  it("rejects unsupported schema versions", () => {
    expect(
      testSuiteSchema.safeParse({ schemaVersion: 2, appId: "x", suite: {}, cases: [] }).success,
    ).toBe(false);
  });

  it("parses a YAML document with the shared schema", () => {
    expect(
      parseTestSuiteDocument(
        [
          "schemaVersion: 1",
          "appId: com.example.app",
          "suite:",
          "  id: smoke",
          "  name: Smoke",
          "  sourceRevision: main",
          "cases:",
          "  - id: launches",
          "    name: Launches",
          "    steps:",
          "      - id: launch",
          "        action:",
          "          action: app.launch",
          "          appId: com.example.app",
        ].join("\n"),
        "smoke.yaml",
      ),
    ).toMatchObject({ suite: { id: "smoke" }, cases: [{ id: "launches" }] });
  });
});
