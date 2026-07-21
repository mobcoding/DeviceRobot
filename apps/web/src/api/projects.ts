import {
  androidProjectSchema,
  projectListResponseSchema,
  type AndroidProject,
  type CreateProjectRequest,
  type ProjectListResponse,
} from "@device-robot/contracts";

async function projectRequest<T>(
  url: string,
  init: RequestInit | undefined,
  schema: { parse(value: unknown): T },
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error("无法连接本地 Agent。请确认 Agent 正在运行。");
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { error?: unknown } | undefined;
    const message = typeof payload?.error === "string" ? payload.error : "项目请求失败。";
    throw new Error(message);
  }

  return schema.parse(await response.json());
}

export async function fetchProjects(signal?: AbortSignal): Promise<ProjectListResponse> {
  return await projectRequest(
    "/api/v1/projects",
    {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    },
    projectListResponseSchema,
  );
}

export async function createProject(request: CreateProjectRequest): Promise<AndroidProject> {
  return await projectRequest(
    "/api/v1/projects",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
    },
    androidProjectSchema,
  );
}

export async function reindexProject(projectId: string): Promise<AndroidProject> {
  return await projectRequest(
    `/api/v1/projects/${encodeURIComponent(projectId)}/index`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
    },
    androidProjectSchema,
  );
}
