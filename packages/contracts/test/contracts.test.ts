import { describe, expect, it } from "vitest";

import {
  actionPlanSchema,
  apkArtifactSchema,
  apkInstallResponseSchema,
  appiumRuntimeSchema,
  deviceApplicationListResponseSchema,
  deviceControlActionSchema,
  deviceFileListResponseSchema,
  deviceListResponseSchema,
  deviceLogcatResponseSchema,
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

  it("allows an installation plan to reference only a staged APK artifact", () => {
    const plan = actionPlanSchema.parse({
      id: "plan-1",
      projectId: "project-1",
      requiresApproval: true,
      actions: [
        {
          action: "app.install",
          artifactId: "123e4567-e89b-12d3-a456-426614174000",
          replaceExisting: true,
          allowTestPackage: true,
        },
      ],
    });

    expect(plan.actions[0]).toMatchObject({ action: "app.install" });
    expect(
      actionPlanSchema.safeParse({
        ...plan,
        actions: [{ action: "app.install", apkPath: "C:\\untrusted.apk" }],
      }).success,
    ).toBe(false);
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
          network: { transport: "wifi", connected: true },
          battery: { level: 86, state: "charging" },
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

  it("accepts read-only file and application management responses", () => {
    expect(
      deviceFileListResponseSchema.parse({
        serial: "device-1",
        path: "/storage/emulated/0",
        parentPath: "/storage/emulated",
        entries: [
          {
            name: "Download",
            path: "/storage/emulated/0/Download",
            kind: "directory",
          },
        ],
        readAt: "2026-07-20T10:00:00.000Z",
      }),
    ).toMatchObject({ entries: [{ kind: "directory" }] });

    expect(
      deviceApplicationListResponseSchema.parse({
        serial: "device-1",
        filter: "user",
        applications: [
          {
            packageName: "com.example.app",
            source: "user",
            apkPath: "/data/app/com.example.app/base.apk",
            versionCode: "42",
          },
        ],
        readAt: "2026-07-20T10:00:00.000Z",
      }),
    ).toMatchObject({ applications: [{ packageName: "com.example.app" }] });

    expect(
      deviceLogcatResponseSchema.parse({
        serial: "device-1",
        entries: [
          {
            timestamp: "07-21 10:00:00.123",
            processId: 1000,
            threadId: 1001,
            level: "info",
            tag: "ActivityManager",
            message: "Displayed com.example.app",
          },
        ],
        readAt: "2026-07-21T10:00:00.000Z",
      }),
    ).toMatchObject({ entries: [{ level: "info", tag: "ActivityManager" }] });
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

  it("accepts APK staging and installation results", () => {
    expect(
      apkArtifactSchema.parse({
        id: "123e4567-e89b-12d3-a456-426614174000",
        fileName: "sample.apk",
        sizeBytes: 1_024,
        sha256: "a".repeat(64),
        uploadedAt: "2026-07-20T10:00:00.000Z",
        metadata: {
          packageName: "com.example.app",
          versionName: "1.0",
          versionCode: "42",
          minSdkVersion: "23",
          targetSdkVersion: "35",
        },
      }),
    ).toMatchObject({ metadata: { packageName: "com.example.app" } });

    expect(
      apkInstallResponseSchema.parse({
        status: "installed",
        serial: "device-1",
        artifactId: "123e4567-e89b-12d3-a456-426614174000",
        packageName: "com.example.app",
        startedAt: "2026-07-20T10:01:00.000Z",
        finishedAt: "2026-07-20T10:01:02.000Z",
        message: "Success",
      }),
    ).toMatchObject({ status: "installed", serial: "device-1" });
  });
});
