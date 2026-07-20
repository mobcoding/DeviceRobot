import { describe, expect, it } from "vitest";

import { actionPlanSchema, deviceListResponseSchema, healthResponseSchema } from "../src/index.js";

describe("shared contracts", () => {
  it("accepts a valid health response", () => {
    expect(
      healthResponseSchema.parse({
        status: "ok",
        version: "0.1.0",
        startedAt: "2026-07-20T10:00:00.000Z",
        dataDirectory: "C:\\Users\\tester\\AppData\\Local\\AIMobileTester",
      }),
    ).toBeDefined();
  });

  it("rejects an action plan without a usable selector", () => {
    const result = actionPlanSchema.safeParse({
      id: "plan-1",
      projectId: "project-1",
      requiresApproval: true,
      actions: [{ action: "ui.tap", target: {} }],
    });

    expect(result.success).toBe(false);
  });

  it("accepts a real connected-device response", () => {
    const response = deviceListResponseSchema.parse({
      adb: {
        available: true,
        executable: "adb",
        version: "37.0.0-14910828",
        installedPath: "D:\\Android\\Sdk\\platform-tools\\adb.exe",
      },
      devices: [
        {
          serial: "8B3Y0THX0",
          state: "device",
          connection: "usb",
          model: "Pixel 3 XL",
          androidVersion: "12",
          apiLevel: 31,
        },
      ],
      refreshedAt: "2026-07-20T10:00:00.000Z",
    });

    expect(response.devices[0]?.model).toBe("Pixel 3 XL");
  });
});
