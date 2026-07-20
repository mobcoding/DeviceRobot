import { describe, expect, it } from "vitest";

import { evaluateActionPlanPolicy, evaluateActionPolicy } from "../src/index.js";

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

  it("requires explicit approval for an AI-requested APK installation, including trusted projects", () => {
    const decision = evaluateActionPolicy(
      {
        action: "app.install",
        artifactId: "123e4567-e89b-12d3-a456-426614174000",
        replaceExisting: true,
        allowTestPackage: true,
      },
      "trusted",
      { stagedArtifactIds: new Set(["123e4567-e89b-12d3-a456-426614174000"]) },
    );

    expect(decision).toMatchObject({ allowed: true, requiresApproval: true });
  });

  it("rejects installation of an APK that was not staged for the conversation", () => {
    const decision = evaluateActionPolicy(
      {
        action: "app.install",
        artifactId: "123e4567-e89b-12d3-a456-426614174000",
        replaceExisting: true,
        allowTestPackage: true,
      },
      "standard",
      { stagedArtifactIds: new Set() },
    );

    expect(decision).toMatchObject({ allowed: false, requiresApproval: false });
  });

  it("recomputes approval instead of trusting the model-provided plan flag", () => {
    const decision = evaluateActionPlanPolicy(
      {
        id: "plan-1",
        projectId: "project-1",
        requiresApproval: false,
        actions: [
          {
            action: "app.install",
            artifactId: "123e4567-e89b-12d3-a456-426614174000",
            replaceExisting: true,
            allowTestPackage: true,
          },
        ],
      },
      "standard",
      { stagedArtifactIds: new Set(["123e4567-e89b-12d3-a456-426614174000"]) },
    );

    expect(decision).toMatchObject({ allowed: true, requiresApproval: true });
  });
});
