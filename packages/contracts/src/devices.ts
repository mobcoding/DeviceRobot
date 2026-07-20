import { z } from "zod";

export const adbEnvironmentSchema = z.object({
  available: z.boolean(),
  executable: z.string().min(1),
  version: z.string().min(1).optional(),
  installedPath: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
});

export const androidDeviceSchema = z.object({
  serial: z.string().min(1),
  state: z.enum(["device", "emulator", "offline", "unauthorized", "unknown"]),
  connection: z.enum(["usb", "tcp", "emulator"]),
  path: z.string().min(1).optional(),
  product: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  deviceName: z.string().min(1).optional(),
  manufacturer: z.string().min(1).optional(),
  androidVersion: z.string().min(1).optional(),
  apiLevel: z.number().int().positive().optional(),
  transportId: z.string().min(1).optional(),
  detailsError: z.string().min(1).optional(),
});

export const deviceListResponseSchema = z.object({
  adb: adbEnvironmentSchema,
  devices: z.array(androidDeviceSchema),
  refreshedAt: z.iso.datetime(),
  error: z.string().min(1).optional(),
});

export type AdbEnvironment = z.infer<typeof adbEnvironmentSchema>;
export type AndroidDevice = z.infer<typeof androidDeviceSchema>;
export type DeviceListResponse = z.infer<typeof deviceListResponseSchema>;
