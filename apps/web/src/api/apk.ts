import {
  apkArtifactSchema,
  apkInstallResponseSchema,
  type ApkArtifact,
  type ApkInstallRequest,
  type ApkInstallResponse,
} from "@device-robot/contracts";

import { responseError } from "./client";

export async function uploadApk(file: File, signal?: AbortSignal): Promise<ApkArtifact> {
  const body = new FormData();
  body.append("apk", file, file.name);

  let response: Response;
  try {
    response = await fetch("/api/v1/apks", {
      method: "POST",
      body,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new Error("无法连接本地 Agent，APK 上传失败。");
  }

  if (!response.ok) {
    throw await responseError(response, "APK 上传或解析失败。");
  }
  return apkArtifactSchema.parse(await response.json());
}

export async function discardApk(artifactId: string): Promise<void> {
  const response = await fetch(`/api/v1/apks/${encodeURIComponent(artifactId)}`, {
    method: "DELETE",
  }).catch(() => undefined);
  if (response !== undefined && !response.ok && response.status !== 404) {
    throw await responseError(response, "无法删除临时 APK 文件。");
  }
}

export async function installApk(
  serial: string,
  artifactId: string,
  options: ApkInstallRequest,
): Promise<ApkInstallResponse> {
  let response: Response;
  try {
    response = await fetch(
      `/api/v1/devices/${encodeURIComponent(serial)}/apks/${encodeURIComponent(artifactId)}/install`,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(options),
      },
    );
  } catch {
    throw new Error("无法连接本地 Agent，APK 安装失败。");
  }

  if (!response.ok) {
    throw await responseError(response, "APK 安装失败。");
  }
  return apkInstallResponseSchema.parse(await response.json());
}
