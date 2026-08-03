import {
  deviceActionHistoryResponseSchema,
  deviceActionResultSchema,
  deviceUiTreeResponseSchema,
  openScreenRecordingLocationResponseSchema,
  type DeviceActionHistoryResponse,
  type DeviceActionResult,
  type DeviceControlAction,
  type DeviceUiTreeResponse,
  screenRecordingResultSchema,
  screenRecordingStatusSchema,
  type ScreenRecordingConfiguration,
  type ScreenRecordingResult,
  type ScreenRecordingStatus,
} from "@device-robot/contracts";

import { requestJson } from "./client";

function deviceEndpoint(serial: string, path: string): string {
  return `/api/v1/devices/${encodeURIComponent(serial)}/${path}`;
}

async function responseError(response: Response): Promise<Error> {
  await response.json().catch(() => undefined);
  return new Error(`设备请求失败（HTTP ${response.status}）`);
}

async function requestDeviceEndpoint(
  serial: string,
  path: string,
  options: RequestInit,
): Promise<Response> {
  try {
    return await fetch(deviceEndpoint(serial, path), options);
  } catch {
    throw new Error("无法连接本地 Agent，请检查设备连接和服务状态。");
  }
}

export function deviceScreenshotUrl(serial: string, revision: number): string {
  return `${deviceEndpoint(serial, "screenshot")}?revision=${revision}`;
}

export async function captureDeviceScreenshot(serial: string): Promise<Blob> {
  const response = await requestDeviceEndpoint(serial, `screenshot?revision=${Date.now()}`, {
    headers: { Accept: "image/png" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  if (response.headers.get("Content-Type")?.toLowerCase().startsWith("image/png") !== true) {
    throw new Error("设备未返回有效的 PNG 截图。");
  }

  return await response.blob();
}

export async function fetchScreenRecordingStatus(serial: string): Promise<ScreenRecordingStatus> {
  return await requestJson(
    deviceEndpoint(serial, "recording"),
    { headers: { Accept: "application/json" } },
    screenRecordingStatusSchema,
    "读取录屏状态失败。",
  );
}

export async function startScreenRecording(
  serial: string,
  configuration: ScreenRecordingConfiguration,
): Promise<ScreenRecordingStatus> {
  return await requestJson(
    deviceEndpoint(serial, "recording/start"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(configuration),
    },
    screenRecordingStatusSchema,
    "启动录屏失败。",
  );
}

export async function stopScreenRecording(serial: string): Promise<ScreenRecordingResult> {
  return await requestJson(
    deviceEndpoint(serial, "recording/stop"),
    { method: "POST", headers: { Accept: "application/json" } },
    screenRecordingResultSchema,
    "停止录屏失败。",
  );
}

export async function openScreenRecordingLocation(
  serial: string,
  savedPath: string,
): Promise<void> {
  await requestJson(
    deviceEndpoint(serial, "recording/open-location"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ savedPath }),
    },
    openScreenRecordingLocationResponseSchema,
    "打开录屏保存位置失败。",
  );
}

export async function fetchDeviceUiTree(
  serial: string,
  signal?: AbortSignal,
): Promise<DeviceUiTreeResponse> {
  const response = await requestDeviceEndpoint(serial, "ui-tree", {
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  return deviceUiTreeResponseSchema.parse(await response.json());
}

export async function fetchDeviceActionHistory(
  serial: string,
  signal?: AbortSignal,
): Promise<DeviceActionHistoryResponse> {
  const response = await requestDeviceEndpoint(serial, "actions", {
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  return deviceActionHistoryResponseSchema.parse(await response.json());
}

export async function executeDeviceAction(
  serial: string,
  action: DeviceControlAction,
): Promise<DeviceActionResult> {
  const response = await requestDeviceEndpoint(serial, "actions", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  return deviceActionResultSchema.parse(await response.json());
}
