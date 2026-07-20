import { describe, expect, it } from "vitest";

import { evaluateActionPolicy } from "../src/index.js";

describe("AI action policy", () => {
  it("requires approval for high-risk commands in standard projects", () => {
    const decision = evaluateActionPolicy(
      { action: "adb.shell", command: "reboot", args: [] },
      "standard",
    );

    expect(decision.requiresApproval).toBe(true);
  });

  it("allows trusted projects to run ADB commands without per-command approval", () => {
    const decision = evaluateActionPolicy(
      { action: "adb.shell", command: "reboot", args: [] },
      "trusted",
    );

    expect(decision).toMatchObject({ allowed: true, requiresApproval: false });
  });
});
