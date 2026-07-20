import type { ActionPlan, AgentAction } from "@device-robot/contracts";

export type ModelRequest = {
  system: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  responseSchemaName: string;
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

const highRiskAdbCommands = new Set(["reboot", "root", "unroot", "remount", "disable-verity"]);
const highRiskShellCommands = new Set(["pm", "settings", "reboot", "su"]);

export function evaluateActionPolicy(action: AgentAction, trust: ProjectTrust): PolicyDecision {
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
