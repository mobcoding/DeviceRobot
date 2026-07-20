import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { resolveAgentPaths } from "@device-robot/config";
import type { DeviceListResponse } from "@device-robot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AdbDeviceFileTransferService,
  type FileTransferCommandRunner,
} from "../src/files/adb-device-file-transfer-service.js";
import type { DeviceDiscoveryService } from "../src/devices/adb-device-service.js";

const temporaryDirectories: string[] = [];
const connectedDevice: DeviceListResponse = {
  adb: { available: true, executable: "adb" },
  devices: [{ serial: "device-1", state: "device", connection: "usb" }],
  refreshedAt: "2026-07-21T10:00:00.000Z",
};

function createFixture(runner: FileTransferCommandRunner): AdbDeviceFileTransferService {
  const root = mkdtempSync(join(tmpdir(), "device-robot-file-transfer-"));
  temporaryDirectories.push(root);
  const deviceService: DeviceDiscoveryService = {
    listDevices: vi.fn().mockResolvedValue(connectedDevice),
  };
  return new AdbDeviceFileTransferService({
    paths: resolveAgentPaths(root),
    deviceService,
    executable: "adb",
    runner,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("ADB device file transfer", () => {
  it("uploads a staged file with fixed ADB arguments and removes the temporary file", async () => {
    const runner: FileTransferCommandRunner = {
      run: vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
    };
    const service = createFixture(runner);

    const result = await service.upload(
      "device-1",
      "/storage/emulated/0/Download",
      "notes.txt",
      Readable.from("hello"),
    );

    expect(result).toMatchObject({
      serial: "device-1",
      fileName: "notes.txt",
      path: "/storage/emulated/0/Download/notes.txt",
      sizeBytes: 5,
    });
    expect(runner.run).toHaveBeenCalledWith(
      "adb",
      [
        "-s",
        "device-1",
        "push",
        expect.stringMatching(/\.upload$/u),
        "/storage/emulated/0/Download/notes.txt",
      ],
      300_000,
    );
    const temporaryPath = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]?.[3];
    expect(typeof temporaryPath).toBe("string");
    expect(existsSync(String(temporaryPath))).toBe(false);
  });

  it("downloads a file with fixed ADB arguments and disposes the local copy", async () => {
    const runner: FileTransferCommandRunner = {
      run: vi.fn().mockImplementation(async (_executable, args: readonly string[]) => {
        if (args[2] === "pull") {
          writeFileSync(String(args[4]), "device file");
        }
        return { stdout: "", stderr: "" };
      }),
    };
    const service = createFixture(runner);

    const downloaded = await service.download("device-1", "/storage/emulated/0/Download/notes.txt");

    expect(downloaded).toMatchObject({ fileName: "notes.txt", sizeBytes: 11 });
    expect(runner.run).toHaveBeenCalledWith(
      "adb",
      [
        "-s",
        "device-1",
        "pull",
        "/storage/emulated/0/Download/notes.txt",
        expect.stringMatching(/\.download$/u),
      ],
      300_000,
    );
    expect(existsSync(downloaded.filePath)).toBe(true);
    await downloaded.dispose();
    expect(existsSync(downloaded.filePath)).toBe(false);
  });

  it("rejects unsafe remote paths and upload file names before running ADB", async () => {
    const runner: FileTransferCommandRunner = { run: vi.fn() };
    const service = createFixture(runner);

    await expect(service.download("device-1", "/storage/emulated/0;id")).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(service.download("device-1", "")).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      service.upload("device-1", "/storage/emulated/0", "nested/file.txt", Readable.from("x")),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rejects device directories before invoking adb pull", async () => {
    const runner: FileTransferCommandRunner = {
      run: vi
        .fn()
        .mockResolvedValue({ stdout: "drwxrwx--- 2 root root 4096 Download", stderr: "" }),
    };
    const service = createFixture(runner);

    await expect(
      service.download("device-1", "/storage/emulated/0/Download"),
    ).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(runner.run).toHaveBeenCalledWith(
      "adb",
      ["-s", "device-1", "shell", "ls", "-ld", "/storage/emulated/0/Download"],
      20_000,
    );
    expect(runner.run).not.toHaveBeenCalledWith(
      "adb",
      expect.arrayContaining(["pull"]),
      expect.any(Number),
    );
  });
});
