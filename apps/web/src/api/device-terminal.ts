import { deviceTerminalResponseSchema, type DeviceTerminalResponse } from "@device-robot/contracts";

export async function executeDeviceTerminalCommand(
  serial: string,
  command: string,
  signal?: AbortSignal,
): Promise<DeviceTerminalResponse> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/devices/${encodeURIComponent(serial)}/terminal`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ command }),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new Error("无法连接本地 Agent。请确认 Agent 正在运行。");
  }

  if (!response.ok) {
    const payload = (await response.json().catch(() => undefined)) as
      { error?: unknown } | undefined;
    throw new Error(typeof payload?.error === "string" ? payload.error : "终端命令执行失败。");
  }

  return deviceTerminalResponseSchema.parse(await response.json());
}
