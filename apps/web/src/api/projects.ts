import {
  apkInstallResponseSchema,
  androidProjectSchema,
  androidSdkInfoSchema,
  androidBuildTargetListResponseSchema,
  projectBuildLogResponseSchema,
  projectBuildRunListResponseSchema,
  projectBuildRunSchema,
  projectListResponseSchema,
  type AndroidProject,
  type AndroidSdkInfo,
  type CreateProjectRequest,
  type InstallAndroidSdkRequest,
  type AndroidBuildTargetListResponse,
  type ApkInstallRequest,
  type ApkInstallResponse,
  type ProjectBuildRun,
  type ProjectBuildLogResponse,
  type ProjectBuildRunListResponse,
  type StartProjectBuildRequest,
  type ProjectListResponse,
} from "@device-robot/contracts";

import { requestJson } from "./client";

export async function fetchProjects(signal?: AbortSignal): Promise<ProjectListResponse> {
  return await requestJson(
    "/api/v1/projects",
    {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    },
    projectListResponseSchema,
    "项目请求失败。",
  );
}

export async function createProject(request: CreateProjectRequest): Promise<AndroidProject> {
  return await requestJson(
    "/api/v1/projects",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
    },
    androidProjectSchema,
    "项目创建失败。",
  );
}

export async function reindexProject(projectId: string): Promise<AndroidProject> {
  return await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/index`,
    {
      method: "POST",
      headers: { Accept: "application/json" },
    },
    androidProjectSchema,
    "项目索引失败。",
  );
}

export async function fetchProjectBuildTargets(
  projectId: string,
  signal?: AbortSignal,
): Promise<AndroidBuildTargetListResponse> {
  return await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/builds/targets`,
    {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    },
    androidBuildTargetListResponseSchema,
    "构建目标读取失败。",
  );
}

export async function fetchProjectBuildRuns(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectBuildRunListResponse> {
  return await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/builds`,
    {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    },
    projectBuildRunListResponseSchema,
    "构建记录读取失败。",
  );
}

export async function fetchProjectBuildLog(
  projectId: string,
  buildId: string,
  signal?: AbortSignal,
): Promise<ProjectBuildLogResponse> {
  return await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/builds/${encodeURIComponent(buildId)}/log`,
    {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    },
    projectBuildLogResponseSchema,
    "构建日志读取失败。",
  );
}

export async function installProjectAndroidSdk(
  projectId: string,
  request: InstallAndroidSdkRequest,
): Promise<AndroidSdkInfo> {
  return await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/android-sdk/install`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
    },
    androidSdkInfoSchema,
    "Android SDK 安装失败。",
  );
}

export async function startProjectBuild(
  projectId: string,
  request: StartProjectBuildRequest,
): Promise<ProjectBuildRun> {
  return await requestJson(
    `/api/v1/projects/${encodeURIComponent(projectId)}/builds`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
    },
    projectBuildRunSchema,
    "构建启动失败。",
  );
}

export function projectBuildArtifactDownloadUrl(
  projectId: string,
  buildId: string,
  artifactIndex: number,
): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/builds/${encodeURIComponent(
    buildId,
  )}/artifacts/${artifactIndex}/download`;
}

export async function installProjectBuildArtifact(
  serial: string,
  projectId: string,
  buildId: string,
  artifactIndex: number,
  request: ApkInstallRequest,
): Promise<ApkInstallResponse> {
  return await requestJson(
    `/api/v1/devices/${encodeURIComponent(serial)}/projects/${encodeURIComponent(
      projectId,
    )}/builds/${encodeURIComponent(buildId)}/artifacts/${artifactIndex}/install`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
    },
    apkInstallResponseSchema,
    "APK 安装失败。",
  );
}
