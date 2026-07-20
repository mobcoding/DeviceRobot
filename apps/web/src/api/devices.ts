import { deviceListResponseSchema, type DeviceListResponse } from "@device-robot/contracts";

export async function fetchDevices(signal?: AbortSignal): Promise<DeviceListResponse> {
  let response: Response;
  try {
    response = await fetch("/api/v1/devices", {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new Error("无法连接本地 Agent，无法读取设备列表。");
  }

  if (!response.ok) {
    throw new Error(`设备列表请求失败（HTTP ${response.status}）`);
  }

  return deviceListResponseSchema.parse(await response.json());
}
