import {
  deviceApplicationListResponseSchema,
  deviceFileListResponseSchema,
  deviceFileTransferResponseSchema,
  deviceLogcatResponseSchema,
  type DeviceApplicationFilter,
  type DeviceApplicationListResponse,
  type DeviceFileListResponse,
  type DeviceFileTransferResponse,
  type DeviceLogcatResponse,
} from "@device-robot/contracts";

async function fetchManagementResponse<T>(
  url: string,
  schema: { parse(value: unknown): T },
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new Error("无法连接本地 Agent。请确认 Agent 正在运行。");
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { error?: unknown } | undefined;
    const message = typeof payload?.error === "string" ? payload.error : "设备管理请求失败";
    throw new Error(message);
  }

  return schema.parse(await response.json());
}

export async function fetchDeviceFiles(
  serial: string,
  path?: string,
  signal?: AbortSignal,
): Promise<DeviceFileListResponse> {
  const query = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
  return await fetchManagementResponse(
    `/api/v1/devices/${encodeURIComponent(serial)}/files${query}`,
    deviceFileListResponseSchema,
    signal,
  );
}

export function deviceFileDownloadUrl(serial: string, path: string): string {
  return `/api/v1/devices/${encodeURIComponent(serial)}/files/download?path=${encodeURIComponent(path)}`;
}

export async function uploadDeviceFile(
  serial: string,
  directory: string,
  file: File,
  signal?: AbortSignal,
): Promise<DeviceFileTransferResponse> {
  const body = new FormData();
  body.append("file", file, file.name);

  let response: Response;
  try {
    response = await fetch(
      `/api/v1/devices/${encodeURIComponent(serial)}/files/upload?path=${encodeURIComponent(directory)}`,
      {
        method: "POST",
        body,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch {
    throw new Error("无法连接本地 Agent。请确认 Agent 正在运行。");
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { error?: unknown } | undefined;
    const message = typeof payload?.error === "string" ? payload.error : "设备文件上传失败。";
    throw new Error(message);
  }

  return deviceFileTransferResponseSchema.parse(await response.json());
}

export async function fetchDeviceApplications(
  serial: string,
  filter: DeviceApplicationFilter,
  signal?: AbortSignal,
): Promise<DeviceApplicationListResponse> {
  return await fetchManagementResponse(
    `/api/v1/devices/${encodeURIComponent(serial)}/applications?filter=${filter}`,
    deviceApplicationListResponseSchema,
    signal,
  );
}

export async function fetchDeviceLogcat(
  serial: string,
  limit: number,
  signal?: AbortSignal,
): Promise<DeviceLogcatResponse> {
  return await fetchManagementResponse(
    `/api/v1/devices/${encodeURIComponent(serial)}/logcat?limit=${limit}`,
    deviceLogcatResponseSchema,
    signal,
  );
}
