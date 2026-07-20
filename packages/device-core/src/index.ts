import type { AgentAction } from "@device-robot/contracts";

export type DeviceState = "device" | "unauthorized" | "offline" | "disconnected";

export type AndroidDevice = {
  serial: string;
  state: DeviceState;
  model?: string;
  apiLevel?: number;
  resolution?: { width: number; height: number };
  batteryLevel?: number;
};

export type ActionExecutionResult = {
  action: AgentAction["action"];
  startedAt: string;
  finishedAt: string;
  success: boolean;
  message?: string;
};

export interface DeviceController {
  listDevices(): Promise<AndroidDevice[]>;
  execute(serial: string, action: AgentAction): Promise<ActionExecutionResult>;
  captureScreenshot(serial: string): Promise<Uint8Array>;
  readUiTree(serial: string): Promise<string>;
}
