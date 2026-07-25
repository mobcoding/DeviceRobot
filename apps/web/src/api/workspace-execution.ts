import {
  startWorkspaceExecutionRequestSchema,
  workspaceExecutionResponseSchema,
  type StartWorkspaceExecutionRequest,
  type WorkspaceExecutionResponse,
} from "@device-robot/contracts";

import { requestJson } from "./client";

export async function startWorkspaceExecution(
  request: StartWorkspaceExecutionRequest,
): Promise<WorkspaceExecutionResponse> {
  return await requestJson(
    "/api/v1/workspace-executions",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(startWorkspaceExecutionRequestSchema.parse(request)),
    },
    workspaceExecutionResponseSchema,
    "工作区操作执行失败。",
  );
}
