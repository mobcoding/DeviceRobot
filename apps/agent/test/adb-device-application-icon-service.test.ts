import { describe, expect, it } from "vitest";

import {
  parseAaptIconPath,
  selectBitmapIconResource,
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
});
