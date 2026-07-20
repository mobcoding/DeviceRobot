import { deviceListResponseSchema, type DeviceListResponse } from "@device-robot/contracts";

export async function fetchDevices(signal?: AbortSignal): Promise<DeviceListResponse> {
  const response = await fetch("/api/v1/devices", {
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });

  if (!response.ok) {
    throw new Error(`Device request failed with status ${response.status}`);
  }

  return deviceListResponseSchema.parse(await response.json());
}
