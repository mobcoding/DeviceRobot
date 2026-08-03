import { describe, expect, it } from "vitest";

import {
  parseAaptResourceFilePaths,
  parseAaptIconPath,
  parseAaptXmlResourceIds,
  parseInstalledApkPaths,
  selectBitmapIconResource,
  vectorDrawableToSvg,
} from "../src/devices/adb-device-application-icon-service.js";

describe("ADB application icon parsing", () => {
  it("prefers a display-density bitmap icon from aapt metadata", () => {
    const icon = parseAaptIconPath(
      [
        "application: label='Example' icon='res/mipmap-anydpi-v26/ic_launcher.xml'",
        "application-icon-160:'res/mipmap-mdpi-v4/ic_launcher.png'",
        "application-icon-320:'res/mipmap-xhdpi-v4/ic_launcher.webp'",
        "application-icon-480:'res/mipmap-xxhdpi-v4/ic_launcher.png'",
      ].join("\n"),
    );

    expect(icon).toBe("res/mipmap-xhdpi-v4/ic_launcher.webp");
  });

  it("resolves an adaptive icon to the closest matching bitmap resource", () => {
    const adaptiveIcon = parseAaptIconPath(
      "application: label='Example' icon='res/mipmap-anydpi-v26/ic_launcher.xml'",
    );

    expect(adaptiveIcon).toBe("res/mipmap-anydpi-v26/ic_launcher.xml");
    expect(
      selectBitmapIconResource(adaptiveIcon ?? "", [
        "res/mipmap-mdpi-v4/ic_launcher.webp",
        "res/mipmap-hdpi-v4/ic_launcher.webp",
        "res/mipmap-xhdpi-v4/ic_launcher.webp",
        "res/mipmap-xxhdpi-v4/ic_launcher.webp",
      ]),
    ).toBe("res/mipmap-xhdpi-v4/ic_launcher.webp");
  });

  it("keeps the base APK first while retaining split APK resource paths", () => {
    expect(
      parseInstalledApkPaths(
        [
          "package:/data/app/example/split_config.xxhdpi.apk",
          "package:/data/app/example/base.apk",
          "package:/data/app/example/split_config.en.apk",
        ].join("\n"),
      ),
    ).toEqual([
      "/data/app/example/base.apk",
      "/data/app/example/split_config.xxhdpi.apk",
      "/data/app/example/split_config.en.apk",
    ]);
  });

  it("maps AAPT resource IDs and references to compressed XML resource files", () => {
    const resources = parseAaptResourceFilePaths(
      [
        "      resource 0x7f0800b4 com.example:drawable/ic_launcher_background: t=0x03",
        '        (string8) "res/0w.xml"',
        "      resource 0x7f0800b5 com.example:drawable/ic_launcher_foreground: t=0x03",
        '        (string8) "res/Qr.xml"',
      ].join("\n"),
    );

    expect(resources.get("0x7f0800b4")).toBe("res/0w.xml");
    expect(resources.get("0x7f0800b5")).toBe("res/Qr.xml");
    expect(
      parseAaptXmlResourceIds(
        [
          "A: android:drawable(0x01010199)=@0x7f0800b4",
          "A: android:drawable(0x01010199)=@0x7f0800b5",
        ].join("\n"),
      ),
    ).toEqual(["0x7f0800b4", "0x7f0800b5"]);
  });

  it("converts a decoded Android Vector Drawable into a browser-displayable SVG", () => {
    const svg = vectorDrawableToSvg(
      [
        "N: android=http://schemas.android.com/apk/res/android",
        "  E: vector (line=2)",
        "    A: android:viewportWidth(0x01010402)=(type 0x4)0x42d80000",
        "    A: android:viewportHeight(0x01010403)=(type 0x4)0x42d80000",
        "    E: group (line=4)",
        "      A: android:scaleX(0x01010324)=(type 0x4)0x3e580000",
        "      A: android:scaleY(0x01010325)=(type 0x4)0x3e580000",
        "      E: path (line=6)",
        "        A: android:fillColor(0x01010404)=(type 0x1d)0xff2196f3",
        '        A: android:pathData(0x01010405)="M0,0h512v512h-512z" (Raw: "M0,0h512v512h-512z")',
      ].join("\n"),
    );

    expect(svg).toContain('viewBox="0 0 108 108"');
    expect(svg).toContain("scale(0.2109 0.2109)");
    expect(svg).toContain('fill="#2196f3"');
    expect(svg).toContain('d="M0,0h512v512h-512z"');
  });
});
