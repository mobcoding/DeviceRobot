import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentPaths } from "@device-robot/config";
import { XMLParser } from "fast-xml-parser";
import { afterEach, describe, expect, it } from "vitest";

import {
  inspectAndroidSdk,
  parseAndroidRepositoryArchive,
  requiredAndroidSdkPackages,
} from "../src/android/android-sdk-service.js";

const temporaryDirectories: string[] = [];

function writeSdkPackage(root: string, packageName: string): void {
  const executable = process.platform === "win32" ? "aapt.exe" : "aapt";
  if (packageName === "platform-tools") {
    const adb = process.platform === "win32" ? "adb.exe" : "adb";
    mkdirSync(join(root, "platform-tools"), { recursive: true });
    writeFileSync(join(root, "platform-tools", adb), "");
    return;
  }
  if (packageName.startsWith("platforms;android-")) {
    const apiLevel = packageName.slice("platforms;android-".length);
    mkdirSync(join(root, "platforms", `android-${apiLevel}`), { recursive: true });
    writeFileSync(join(root, "platforms", `android-${apiLevel}`, "android.jar"), "");
    return;
  }
  if (packageName.startsWith("build-tools;")) {
    const version = packageName.slice("build-tools;".length);
    mkdirSync(join(root, "build-tools", version), { recursive: true });
    writeFileSync(join(root, "build-tools", version, executable), "");
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Android SDK service", () => {
  it("reads the Windows command line tools archive from the official repository format", () => {
    const manifest = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      trimValues: true,
    }).parse(
      `<?xml version="1.0"?><sdk:sdk-repository><remotePackage path="cmdline-tools;latest"><archives><archive><complete><size>1024</size><checksum>0123456789012345678901234567890123456789</checksum><url>commandlinetools-linux.zip</url></complete><host-os>linux</host-os></archive><archive><complete><size>2048</size><checksum>abcdefabcdefabcdefabcdefabcdefabcdefabcd</checksum><url>commandlinetools-win.zip</url></complete><host-os>windows</host-os></archive></archives></remotePackage></sdk:sdk-repository>`,
    );

    expect(parseAndroidRepositoryArchive(manifest, "cmdline-tools;latest")).toEqual({
      url: "https://dl.google.com/android/repository/commandlinetools-win.zip",
      checksum: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      size: 2048,
    });
  });

  it("discovers a project API level from Kotlin Gradle configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-sdk-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(
      join(root, "app", "build.gradle.kts"),
      "android { compileSdk { version = release(36) } }",
    );

    await expect(
      requiredAndroidSdkPackages(root, [
        { name: "app", path: "app", buildFile: "app/build.gradle.kts", variants: ["debug"] },
      ]),
    ).resolves.toEqual(["platform-tools", "platforms;android-36", "build-tools;36.0.0"]);
  });

  it("prefers a complete managed SDK over an incomplete environment SDK", async () => {
    const root = mkdtempSync(join(tmpdir(), "device-robot-sdk-"));
    temporaryDirectories.push(root);
    const paths = resolveAgentPaths(join(root, "agent-data"));
    const incompleteSdk = join(root, "external-sdk");
    writeSdkPackage(incompleteSdk, "platform-tools");
    for (const packageName of ["platform-tools", "platforms;android-36", "build-tools;36.0.0"]) {
      writeSdkPackage(paths.androidSdk, packageName);
    }

    await expect(
      inspectAndroidSdk({
        paths,
        environment: { ANDROID_SDK_ROOT: incompleteSdk },
        requiredPackages: ["platform-tools", "platforms;android-36", "build-tools;36.0.0"],
      }),
    ).resolves.toMatchObject({
      available: true,
      path: paths.androidSdk,
      source: "managed",
      missingPackages: [],
    });
  });
});
