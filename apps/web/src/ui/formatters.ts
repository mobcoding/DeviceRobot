import type { AndroidDevice } from "@device-robot/contracts";

export function formatDeviceName(device: AndroidDevice): string {
  return device.model ?? device.deviceName ?? device.serial;
}

export function formatBytes(value: number): string {
  if (value >= 1_024 * 1_024) {
    return `${(value / (1_024 * 1_024)).toFixed(2)} MB`;
  }
  return `${Math.max(1, Math.ceil(value / 1_024))} KB`;
}

export function formatDateTime(value: string | undefined): string {
  if (value === undefined) {
    return "--";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
