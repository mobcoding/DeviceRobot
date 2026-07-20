import { describe, expect, it } from "vitest";

import {
  actionPlanSchema,
  appiumRuntimeSchema,
  deviceControlActionSchema,
  deviceListResponseSchema,
  deviceUiTreeResponseSchema,
  healthResponseSchema,
} from "../src/index.js";

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

  it("accepts only structured direct device controls", () => {
    expect(
      deviceControlActionSchema.parse({
        action: "ui.swipe",
        startX: 10,
        startY: 20,
        endX: 30,
        endY: 40,
      }),
    ).toMatchObject({ action: "ui.swipe", endY: 40 });
    expect(
      deviceControlActionSchema.safeParse({ action: "app.launch", appId: "not a package" }).success,
    ).toBe(false);
    expect(
      deviceUiTreeResponseSchema.parse({
        serial: "device-1",
        xml: "<hierarchy />",
        capturedAt: "2026-07-20T10:00:00.000Z",
      }),
    ).toMatchObject({ serial: "device-1" });
  });

  it("accepts a local Appium runtime diagnostic", () => {
    expect(
      appiumRuntimeSchema.parse({
        status: "ready",
        checkedAt: "2026-07-20T10:00:00.000Z",
        appium: { available: true, version: "3.5.2" },
        uiautomator2: {
          available: true,
          packageName: "appium-uiautomator2-driver",
          version: "8.1.0",
        },
        java: { available: true, version: "21" },
        androidSdk: { available: true, path: "D:\\Android\\Sdk" },
        server: {
          state: "stopped",
          host: "127.0.0.1",
          port: 4723,
          logFile: "C:\\logs\\appium.log",
        },
        issues: [],
      }),
    ).toMatchObject({ status: "ready", server: { port: 4723 } });
  });
});
