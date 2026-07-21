import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { resolveAgentPaths } from "@device-robot/config";
import type { DeviceListResponse } from "@device-robot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalApkArtifactService,
  parseAaptBadging,
  type ApkCommandRunner,
} from "../src/apks/apk-artifact-service.js";
import type { ApkInstallAuditStore } from "../src/apks/apk-install-audit-store.js";
import type { DeviceDiscoveryService } from "../src/devices/adb-device-service.js";

const temporaryDirectories: string[] = [];
const connectedDevice: DeviceListResponse = {
  adb: { available: true, executable: "adb" },
  devices: [{ serial: "device-1", state: "device", connection: "usb" }],
  refreshedAt: "2026-07-20T10:00:00.000Z",
};

function createFixture(): {
  service: LocalApkArtifactService;
  runner: ApkCommandRunner;
  auditStore: ApkInstallAuditStore;
} {
  const root = mkdtempSync(join(tmpdir(), "device-robot-apk-"));
  temporaryDirectories.push(root);
  const aaptPath = join(root, "aapt.exe");
  writeFileSync(aaptPath, "test executable");
  const runner: ApkCommandRunner = {
    run: vi.fn().mockImplementation(async (_executable: string, args: readonly string[]) => {
      if (args[0] === "dump") {
        return {
          stdout: [
            "package: name='com.example.app' versionCode='42' versionName='1.2.3'",
            "sdkVersion:'23'",
            "targetSdkVersion:'35'",
            "application-label:'示例应用'",
          ].join("\n"),
          stderr: "",
        };
      }
      return { stdout: "Performing Streamed Install\nSuccess", stderr: "" };
    }),
  };
  const auditStore: ApkInstallAuditStore = { record: vi.fn() };
  const deviceService: DeviceDiscoveryService = {
    listDevices: vi.fn().mockResolvedValue(connectedDevice),
  };
  return {
    runner,
    auditStore,
    service: new LocalApkArtifactService({
      paths: resolveAgentPaths(root),
      deviceService,
      auditStore,
      adbExecutable: "adb",
      aaptPath,
      runner,
    }),
  };
}

function validApkStream(): Readable {
  return Readable.from(
    Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(128, 1)]),
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("APK artifact service", () => {
  it("parses APK badging output", () => {
    expect(
      parseAaptBadging(
        [
          "package: name='com.example.app' versionCode='42' versionName='1.2.3'",
          "sdkVersion:'23'",
          "targetSdkVersion:'35'",
          "application-label:'示例应用'",
        ].join("\n"),
      ),
    ).toEqual({
      packageName: "com.example.app",
      applicationLabel: "示例应用",
      versionName: "1.2.3",
      versionCode: "42",
      minSdkVersion: "23",
      targetSdkVersion: "35",
    });
  });

  it("stages, inspects, and installs an APK with fixed ADB arguments", async () => {
    const { service, runner, auditStore } = createFixture();
    const artifact = await service.stage("sample.apk", validApkStream());

    expect(artifact).toMatchObject({
      fileName: "sample.apk",
      sizeBytes: 132,
      metadata: { packageName: "com.example.app", versionCode: "42" },
    });
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);

    const result = await service.install("device-1", artifact.id, {
      replaceExisting: true,
      allowTestPackage: true,
      uninstallExisting: false,
    });

    expect(result).toMatchObject({
      status: "installed",
      serial: "device-1",
      packageName: "com.example.app",
    });
    expect(runner.run).toHaveBeenCalledWith(
      "adb",
      ["-s", "device-1", "install", "-r", "-t", expect.stringMatching(/\.apk$/u)],
      300_000,
    );
    expect(auditStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ serial: "device-1", success: true }),
    );
  });

  it("rejects a file without an APK ZIP signature", async () => {
    const { service } = createFixture();

    await expect(service.stage("invalid.apk", Readable.from("not an apk"))).rejects.toMatchObject({
      statusCode: 422,
      message: "文件不是有效的 APK 压缩包。",
    });
  });

  it("maps incompatible package signatures to a confirmation-required error", async () => {
    const { service, runner, auditStore } = createFixture();
    vi.mocked(runner.run).mockImplementation(async (_executable, args) => {
      if (args[0] === "dump") {
        return {
          stdout: "package: name='com.example.app' versionCode='42' versionName='1.2.3'",
          stderr: "",
        };
      }
      throw new Error("Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]");
    });
    const artifact = await service.stage("sample.apk", validApkStream());

    await expect(
      service.install("device-1", artifact.id, {
        replaceExisting: true,
        allowTestPackage: true,
        uninstallExisting: false,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("签名不同"),
    });
    expect(auditStore.record).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, message: expect.stringContaining("签名不同") }),
    );
  });

  it("uninstalls the existing package only when explicitly requested", async () => {
    const { service, runner } = createFixture();
    const artifact = await service.stage("sample.apk", validApkStream());

    await service.install("device-1", artifact.id, {
      replaceExisting: true,
      allowTestPackage: true,
      uninstallExisting: true,
    });

    expect(runner.run).toHaveBeenCalledWith(
      "adb",
      ["-s", "device-1", "uninstall", "com.example.app"],
      60_000,
    );
    expect(runner.run).toHaveBeenCalledWith(
      "adb",
      ["-s", "device-1", "install", "-r", "-t", expect.stringMatching(/\.apk$/u)],
      300_000,
    );
  });
});
