import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentPaths } from "@device-robot/config";
import { afterEach, describe, expect, it } from "vitest";

import { FilesystemLocalDataMaintenanceService } from "../src/maintenance/local-data-maintenance-service.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("local data maintenance service", () => {
  it("only removes approved, expired disposable data and preserves excluded directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-maintenance-"));
    temporaryDirectories.push(root);
    const paths = resolveAgentPaths(root);
    const oldReport = join(paths.reports, "run", "old.png");
    const newReport = join(paths.reports, "run", "new.png");
    const sdkMarker = join(paths.androidSdk, "platform-tools", "adb.exe");
    mkdirSync(join(paths.reports, "run"), { recursive: true });
    mkdirSync(join(paths.androidSdk, "platform-tools"), { recursive: true });
    writeFileSync(oldReport, "old");
    writeFileSync(newReport, "new");
    writeFileSync(sdkMarker, "sdk");
    const expired = new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000);
    utimesSync(oldReport, expired, expired);
    const service = new FilesystemLocalDataMaintenanceService(paths);

    await expect(service.usage()).resolves.toMatchObject({
      usage: expect.arrayContaining([
        expect.objectContaining({ category: "reports", fileCount: 2, sizeBytes: 6 }),
      ]),
      excluded: expect.arrayContaining([expect.stringContaining("Android SDK")]),
    });
    await expect(
      service.cleanup({ categories: ["reports"], olderThanDays: 30, approved: true }),
    ).resolves.toEqual({ deletedFileCount: 1, reclaimedBytes: 3 });

    expect(existsSync(oldReport)).toBe(false);
    expect(existsSync(newReport)).toBe(true);
    expect(existsSync(sdkMarker)).toBe(true);
  });
});
