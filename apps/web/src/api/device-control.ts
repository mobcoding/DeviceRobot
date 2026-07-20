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
  const payload: unknown = await response.json().catch(() => undefined);
  const message =
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
      ? payload.error
      : `Device request failed with status ${response.status}`;
  return new Error(message);
}

export function deviceScreenshotUrl(serial: string, revision: number): string {
  return `${deviceEndpoint(serial, "screenshot")}?revision=${revision}`;
}

export async function fetchDeviceUiTree(
  serial: string,
  signal?: AbortSignal,
): Promise<DeviceUiTreeResponse> {
  const response = await fetch(deviceEndpoint(serial, "ui-tree"), {
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
  const response = await fetch(deviceEndpoint(serial, "actions"), {
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
  const response = await fetch(deviceEndpoint(serial, "actions"), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(action),
  });

  if (!response.ok) {
    throw await responseError(response);
  }

  return deviceActionResultSchema.parse(await response.json());
}
