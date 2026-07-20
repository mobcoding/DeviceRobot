import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healthResponseSchema } from "@device-robot/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentApp } from "../src/app.js";

const temporaryDirectories: string[] = [];

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "device-robot-agent-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("DeviceRobot Agent", () => {
  it("initializes the database and returns a contract-valid health response", async () => {
    const root = createTemporaryRoot();
    const { app, paths } = await createAgentApp({ localAppData: root });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/health",
      headers: { host: "127.0.0.1:43110" },
    });

    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(readFileSync(paths.database).byteLength).toBeGreaterThan(0);
    await app.close();

    const reopened = await createAgentApp({ localAppData: root });
    const migrationCount = reopened.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number };
    expect(migrationCount.count).toBe(2);
    await reopened.app.close();
  });

  it("rejects non-loopback hosts", async () => {
    const { app } = await createAgentApp({ localAppData: createTemporaryRoot() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/health",
      headers: { host: "192.168.1.10:43110" },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("rejects cross-origin browser requests", async () => {
    const { app } = await createAgentApp({ localAppData: createTemporaryRoot() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/health",
      headers: {
        host: "127.0.0.1:43110",
        origin: "https://example.com",
      },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("allows a loopback Vite development origin on a different port", async () => {
    const { app } = await createAgentApp({ localAppData: createTemporaryRoot() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/health",
      headers: {
        host: "127.0.0.1:43110",
        origin: "http://127.0.0.1:5173",
      },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("returns devices from the injected discovery service", async () => {
    const { app } = await createAgentApp({
      localAppData: createTemporaryRoot(),
      deviceService: {
        listDevices: async () => ({
          adb: { available: true, executable: "adb", version: "37.0.0" },
          devices: [
            {
              serial: "device-1",
              state: "device",
              connection: "usb",
              model: "Pixel 3 XL",
              androidVersion: "12",
              apiLevel: 31,
            },
          ],
          refreshedAt: "2026-07-20T10:00:00.000Z",
        }),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { host: "127.0.0.1:43110" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      adb: { available: true },
      devices: [{ serial: "device-1", model: "Pixel 3 XL" }],
    });
    await app.close();
  });

  it("serves device control data and records action audits", async () => {
    const { app } = await createAgentApp({
      localAppData: createTemporaryRoot(),
      deviceControlService: {
        captureScreenshot: async () =>
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        readUiTree: async (serial) => ({
          serial,
          xml: '<?xml version="1.0"?><hierarchy />',
          capturedAt: "2026-07-20T10:00:00.000Z",
        }),
        execute: async () => ({
          startedAt: "2026-07-20T10:00:00.000Z",
          finishedAt: "2026-07-20T10:00:01.000Z",
          message: "completed",
        }),
      },
    });
    const headers = { host: "127.0.0.1:43110" };

    try {
      const screenshot = await app.inject({
        method: "GET",
        url: "/api/v1/devices/device-1/screenshot",
        headers,
      });
      const tree = await app.inject({
        method: "GET",
        url: "/api/v1/devices/device-1/ui-tree",
        headers,
      });
      const action = await app.inject({
        method: "POST",
        url: "/api/v1/devices/device-1/actions",
        headers,
        payload: { action: "ui.back" },
      });
      const history = await app.inject({
        method: "GET",
        url: "/api/v1/devices/device-1/actions",
        headers,
      });

      expect(screenshot.statusCode).toBe(200);
      expect(screenshot.headers["content-type"]).toContain("image/png");
      expect(tree.json()).toMatchObject({ serial: "device-1" });
      expect((tree.json() as { xml: string }).xml).toMatch(/^<\?xml/);
      expect(action.json()).toMatchObject({ serial: "device-1", action: { action: "ui.back" } });
      expect(history.json()).toMatchObject({
        serial: "device-1",
        actions: [{ success: true, action: { action: "ui.back" } }],
      });
    } finally {
      await app.close();
    }
  });
});
