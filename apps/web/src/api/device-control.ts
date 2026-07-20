import {
  deviceActionHistoryResponseSchema,
  deviceActionResultSchema,
  deviceUiTreeResponseSchema,
  type DeviceActionHistoryResponse,
  type DeviceActionResult,
  type DeviceControlAction,
  type DeviceUiTreeResponse,
} from "@device-robot/contracts";

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
