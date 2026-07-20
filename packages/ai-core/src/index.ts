import type { ActionPlan, AgentAction, ApkArtifact } from "@device-robot/contracts";

export type ModelRequest = {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  responseSchemaName: string;
  /**
   * APK files that the local Agent has already staged and validated for this conversation.
   * An ActionPlan may only refer to an item's opaque id, never a local file path.
   */
  installableArtifacts?: readonly ApkArtifact[];
};

export interface ModelProvider {
  readonly name: string;
  createActionPlan(request: ModelRequest): Promise<ActionPlan>;
}

export type ProjectTrust = "standard" | "trusted";
export type PolicyDecision = {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
};

export type ActionPolicyContext = {
  /**
   * When supplied by the Agent, prevents a model from referring to an APK outside
   * the current conversation's staged-artifact set.
   */
  stagedArtifactIds?: ReadonlySet<string>;
};

export type ActionPlanPolicyDecision = PolicyDecision & {
  actionDecisions: PolicyDecision[];
};

const highRiskAdbCommands = new Set(["reboot", "root", "unroot", "remount", "disable-verity"]);
const highRiskShellCommands = new Set(["pm", "settings", "reboot", "su"]);

export function evaluateActionPolicy(
  action: AgentAction,
  trust: ProjectTrust,
  context: ActionPolicyContext = {},
): PolicyDecision {
  if (action.action === "app.install") {
    if (
      context.stagedArtifactIds !== undefined &&
      !context.stagedArtifactIds.has(action.artifactId)
    ) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: "APK is not available in the current conversation",
      };
    }

    return {
      allowed: true,
      requiresApproval: true,
      reason: "APK installation requires explicit user approval",
    };
  }

  if (action.action !== "adb.shell") {
    return { allowed: true, requiresApproval: false, reason: "Structured device action" };
  }

  if (trust === "trusted") {
    return { allowed: true, requiresApproval: false, reason: "Trusted project ADB policy" };
  }

  const command = action.command.toLowerCase();
  const firstArgument = action.args[0]?.toLowerCase();
  const isHighRisk =
    highRiskAdbCommands.has(command) ||
    (command === "shell" &&
      firstArgument !== undefined &&
      highRiskShellCommands.has(firstArgument));

  return {
    allowed: true,
    requiresApproval: isHighRisk,
    reason: isHighRisk ? "High-risk ADB command" : "Standard project ADB command",
  };
}

/**
 * Recomputes a model-provided plan's authorization state. Callers must not trust
 * ActionPlan.requiresApproval from model output when deciding whether to execute.
 */
export function evaluateActionPlanPolicy(
  plan: ActionPlan,
  trust: ProjectTrust,
  context: ActionPolicyContext = {},
): ActionPlanPolicyDecision {
  const actionDecisions = plan.actions.map((action) =>
    evaluateActionPolicy(action, trust, context),
  );
  const rejected = actionDecisions.find((decision) => !decision.allowed);
  const approvalRequired = actionDecisions.some((decision) => decision.requiresApproval);

  if (rejected !== undefined) {
    return {
      allowed: false,
      requiresApproval: false,
      reason: rejected.reason,
      actionDecisions,
    };
  }

  return {
    allowed: true,
    requiresApproval: approvalRequired,
    reason: approvalRequired
      ? "One or more actions require user approval"
      : "All actions approved by policy",
    actionDecisions,
  };
}
