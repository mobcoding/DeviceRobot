import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import type { AgentPaths } from "@device-robot/config";
import type { DeviceListResponse } from "@device-robot/contracts";

import {
  ApkArtifactError,
  resolveAaptPath,
  type ApkCommandRunner,
} from "../apks/apk-artifact-service.js";
import type { DeviceDiscoveryService } from "./adb-device-service.js";

const execFileAsync = promisify(execFile);
const APPLICATION_ICON_TIMEOUT_MS = 60_000;
const APPLICATION_ICON_CACHE_VERSION = "4";
const MAX_APPLICATION_ICON_SIZE_BYTES = 5 * 1_024 * 1_024;
const MAX_CONCURRENT_ICON_EXTRACTIONS = 2;
const DEVICE_FRAMEWORK_APK_PATH = "/system/framework/framework-res.apk";
const BITMAP_ICON_EXTENSIONS = new Map([
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".avif", "image/avif"],
]);
const CACHED_ICON_EXTENSIONS = new Map([...BITMAP_ICON_EXTENSIONS, [".svg", "image/svg+xml"]]);

export class DeviceApplicationIconError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 413 | 422 | 502 | 503,
    public readonly fallbackIcon = false,
  ) {
    super(message);
  }
}

export type DeviceApplicationIcon = {
  content: Buffer;
  contentType: string;
};

type IconArchive = {
  apkPath: string;
  resourcePaths: ReadonlySet<string>;
};

type LoadedIconArchive = {
  archive: IconArchive;
  colorValues: ReadonlyMap<string, string>;
  resourceFiles: ReadonlyMap<string, string>;
};

type BitmapIconResource = {
  archive: IconArchive;
  resourcePath: string;
};

type VectorDrawable = {
  viewBox: string;
  markup: string;
};

type ResolvedIconResource =
  | {
      type: "bitmap";
      resource: BitmapIconResource;
    }
  | {
      type: "svg";
      content: Buffer;
      vector: VectorDrawable;
    };

export interface DeviceApplicationIconService {
  readIcon(serial: string, packageName: string): Promise<DeviceApplicationIcon>;
}

export type AdbDeviceApplicationIconServiceOptions = {
  paths: AgentPaths;
  deviceService: DeviceDiscoveryService;
  adbExecutable?: string;
  aaptPath?: string;
  environment?: NodeJS.ProcessEnv;
  runner?: ApkCommandRunner;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandOutput(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

function createDefaultRunner(): ApkCommandRunner {
  return {
    run: async (executable, args, timeoutMs) => {
      const { stdout, stderr } = await execFileAsync(executable, [...args], {
        encoding: "utf8",
        maxBuffer: 256 * 1_024 * 1_024,
        timeout: timeoutMs,
        windowsHide: true,
      });
      return { stdout: String(stdout), stderr: String(stderr) };
    },
  };
}

export function parseInstalledApkPaths(output: string): readonly string[] {
  const paths = output
    .split(/\r?\n/u)
    .map((line) => /^package:(\/[^\s]+)$/u.exec(line.trim())?.[1])
    .filter((path): path is string => path !== undefined);
  const baseApk = paths.find((path) => path.endsWith("/base.apk"));
  return [...new Set(baseApk === undefined ? paths : [baseApk, ...paths])];
}

export function parseAaptIconPath(output: string): string | undefined {
  const candidates = output.split(/\r?\n/u).flatMap((line) => {
    const densityMatch = /^application-icon-(\d+):'([^']+)'$/u.exec(line.trim());
    if (densityMatch !== null) {
      const density = Number.parseInt(densityMatch[1] ?? "", 10);
      const path = densityMatch[2];
      return Number.isSafeInteger(density) && path !== undefined ? [{ density, path }] : [];
    }

    const applicationIconMatch = /\bicon='([^']+)'/u.exec(line);
    return applicationIconMatch?.[1] === undefined
      ? []
      : [{ density: 0, path: applicationIconMatch[1] }];
  });

  return candidates.sort(
    (left, right) => Math.abs(left.density - 320) - Math.abs(right.density - 320),
  )[0]?.path;
}

export function parseAaptManifestIconResourceId(output: string): string | undefined {
  return /^\s*A:\s+(?:(?:android|https?:\/\/schemas\.android\.com\/apk\/res\/android):)?icon\(0x[\da-f]+\)=@(0x[\da-f]+)\b/imu
    .exec(output)?.[1]
    ?.toLocaleLowerCase();
}

function normalizeIconResourcePath(value: string): string {
  const normalized = posix.normalize(value);
  if (!normalized.startsWith("res/") || value.split("/").includes("..")) {
    throw new DeviceApplicationIconError("应用未提供可读取的位图图标。", 404, true);
  }
  return normalized;
}

function densityForResourcePath(path: string): number {
  if (/(?:^|-)xxxhdpi(?:-|\/)/u.test(path)) {
    return 640;
  }
  if (/(?:^|-)xxhdpi(?:-|\/)/u.test(path)) {
    return 480;
  }
  if (/(?:^|-)xhdpi(?:-|\/)/u.test(path)) {
    return 320;
  }
  if (/(?:^|-)hdpi(?:-|\/)/u.test(path)) {
    return 240;
  }
  if (/(?:^|-)mdpi(?:-|\/)/u.test(path)) {
    return 160;
  }
  if (/(?:^|-)ldpi(?:-|\/)/u.test(path)) {
    return 120;
  }
  return 0;
}

export function selectBitmapIconResource(
  iconResourcePath: string,
  archiveEntries: readonly string[],
): string | undefined {
  const normalized = normalizeIconResourcePath(iconResourcePath);
  if (BITMAP_ICON_EXTENSIONS.has(posix.extname(normalized).toLowerCase())) {
    return normalized;
  }

  const directory = posix.dirname(normalized);
  const resourceType = /^res\/([^/-]+)/u.exec(directory)?.[1];
  const resourceName = posix.basename(normalized, ".xml");
  if (resourceType === undefined || resourceName.length === 0) {
    return undefined;
  }

  const candidates = archiveEntries.flatMap((entry) => {
    const path = posix.normalize(entry.trim());
    const extension = posix.extname(path).toLowerCase();
    const candidateResourceType = /^res\/([^/-]+)(?:-[^/]+)?\//u.exec(path)?.[1];
    const candidateName = posix.basename(path, extension);
    return candidateResourceType === resourceType &&
      candidateName === resourceName &&
      BITMAP_ICON_EXTENSIONS.has(extension)
      ? [{ path, density: densityForResourcePath(path) }]
      : [];
  });
  return candidates.sort(
    (left, right) => Math.abs(left.density - 320) - Math.abs(right.density - 320),
  )[0]?.path;
}

function findResourceInArchives(
  resourcePath: string,
  archives: readonly IconArchive[],
): BitmapIconResource | undefined {
  const normalized = normalizeIconResourcePath(resourcePath);
  for (const archive of archives) {
    if (archive.resourcePaths.has(normalized)) {
      return { archive, resourcePath: normalized };
    }
  }
  return undefined;
}

function findBitmapIconResource(
  iconResourcePath: string,
  archives: readonly IconArchive[],
): BitmapIconResource | undefined {
  const resourcePaths = archives.flatMap((archive) => [...archive.resourcePaths]);
  const selected = selectBitmapIconResource(iconResourcePath, resourcePaths);
  return selected === undefined ? undefined : findResourceInArchives(selected, archives);
}

export function parseAaptResourcePaths(output: string): readonly string[] {
  return [
    ...new Set(
      [...output.matchAll(/\(string8\) "(res\/[^"\\]+)"/gu)].flatMap((match) =>
        match[1] === undefined ? [] : [posix.normalize(match[1])],
      ),
    ),
  ];
}

export function parseAaptColorValues(output: string): ReadonlyMap<string, string> {
  const colorValues = new Map<string, string>();
  let resourceId: string | undefined;
  for (const line of output.split(/\r?\n/u)) {
    const resourceMatch = /^\s*resource (0x[\da-f]+)\b/iu.exec(line);
    if (resourceMatch?.[1] !== undefined) {
      resourceId = resourceMatch[1].toLocaleLowerCase();
      continue;
    }
    const color = /\(color\) #(\d{8}|[\da-f]{8})\b/iu.exec(line)?.[1];
    if (resourceId !== undefined && color !== undefined) {
      colorValues.set(resourceId, `0x${color}`);
    }
  }
  return colorValues;
}

export function parseAaptResourceFilePaths(output: string): ReadonlyMap<string, string> {
  const resourceCandidates = new Map<string, { density: number; path: string }>();
  const lines = output.split(/\r?\n/u);
  let density = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const configMatch = /^\s*config ([^:]+):/iu.exec(line);
    if (configMatch?.[1] !== undefined) {
      density = densityForResourceConfiguration(configMatch[1]);
      continue;
    }
    const resourceMatch = /^\s*resource (0x[\da-f]+)\b/iu.exec(line);
    if (resourceMatch?.[1] === undefined) {
      continue;
    }

    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex] ?? "";
      if (/^\s*(?:config [^:]+:|resource 0x[\da-f]+\b)/iu.test(nextLine)) {
        break;
      }
      const filePathMatch = /\(string8\) "(res\/[^"\\]+)"/u.exec(nextLine);
      if (filePathMatch?.[1] !== undefined) {
        const resourceId = resourceMatch[1].toLocaleLowerCase();
        const existing = resourceCandidates.get(resourceId);
        if (existing === undefined || Math.abs(density - 320) < Math.abs(existing.density - 320)) {
          resourceCandidates.set(resourceId, { density, path: filePathMatch[1] });
        }
        break;
      }
    }
  }
  return new Map(
    [...resourceCandidates].map(([resourceId, candidate]) => [resourceId, candidate.path]),
  );
}

function densityForResourceConfiguration(configuration: string): number {
  const namedDensity = /(?:^|-)(ldpi|mdpi|hdpi|xhdpi|xxhdpi|xxxhdpi)(?:-|$)/iu
    .exec(configuration)?.[1]
    ?.toLocaleLowerCase();
  if (namedDensity !== undefined) {
    return (
      {
        ldpi: 120,
        mdpi: 160,
        hdpi: 240,
        xhdpi: 320,
        xxhdpi: 480,
        xxxhdpi: 640,
      }[namedDensity] ?? 0
    );
  }
  return Number.parseInt(/(?:^|-)(\d+)dpi(?:-|$)/iu.exec(configuration)?.[1] ?? "", 10) || 0;
}

export function parseAaptXmlResourceIds(output: string): readonly string[] {
  return [...output.matchAll(/=@(0x[\da-f]+)/giu)].map((match) =>
    (match[1] ?? "").toLocaleLowerCase(),
  );
}

type AaptXmlNode = {
  name: string;
  indent: number;
  attributes: Map<string, string>;
  children: AaptXmlNode[];
};

function parseAaptXmlTree(output: string): readonly AaptXmlNode[] {
  const roots: AaptXmlNode[] = [];
  const stack: AaptXmlNode[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const elementMatch = /^(\s*)E:\s+([\w-]+)/u.exec(line);
    if (elementMatch?.[1] !== undefined && elementMatch[2] !== undefined) {
      const indent = elementMatch[1].length;
      while (stack.at(-1)?.indent !== undefined && stack.at(-1)!.indent >= indent) {
        stack.pop();
      }
      const node: AaptXmlNode = {
        name: elementMatch[2],
        indent,
        attributes: new Map(),
        children: [],
      };
      const parent = stack.at(-1);
      if (parent === undefined) {
        roots.push(node);
      } else {
        parent.children.push(node);
      }
      stack.push(node);
      continue;
    }

    const attributeMatch = /^\s*A:\s+(?:android:)?([\w-]+)\(/u.exec(line);
    const current = stack.at(-1);
    if (attributeMatch?.[1] === undefined || current === undefined) {
      continue;
    }
    const rawValue = /\(Raw: "([^"]*)"\)/u.exec(line)?.[1];
    const value = rawValue ?? /=([^\r\n]+)$/u.exec(line)?.[1]?.trim();
    if (value !== undefined) {
      current.attributes.set(attributeMatch[1], value);
    }
  }
  return roots;
}

function aaptFloat(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const hexadecimalValues = [...value.matchAll(/0x([\da-f]{8})\b/giu)];
  const hexadecimal = hexadecimalValues.at(-1)?.[1];
  if (hexadecimal !== undefined) {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32BE(Number.parseInt(hexadecimal, 16));
    const parsed = buffer.readFloatBE();
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const decimal = Number.parseFloat(value);
  return Number.isFinite(decimal) ? decimal : undefined;
}

function aaptColorValue(hexadecimal: string): { color: string; opacity: number } {
  const color = Number.parseInt(hexadecimal, 16);
  const alpha = (color >>> 24) & 0xff;
  const red = (color >>> 16) & 0xff;
  const green = (color >>> 8) & 0xff;
  const blue = color & 0xff;
  return {
    color: `#${red.toString(16).padStart(2, "0")}${green
      .toString(16)
      .padStart(2, "0")}${blue.toString(16).padStart(2, "0")}`,
    opacity: alpha / 255,
  };
}

function aaptColor(
  value: string | undefined,
  resourceColors: ReadonlyMap<string, string>,
): { color: string; opacity: number } | undefined {
  const reference = /^@(0x[\da-f]{8})\b/iu.exec(value ?? "")?.[1]?.toLocaleLowerCase();
  if (reference !== undefined) {
    const resolved = resourceColors.get(reference);
    const hexadecimal = /0x([\da-f]{8})\b/iu.exec(resolved ?? "")?.[1];
    return hexadecimal === undefined ? undefined : aaptColorValue(hexadecimal);
  }
  const hexadecimal = /0x([\da-f]{8})\b/iu.exec(value ?? "")?.[1];
  if (hexadecimal === undefined) {
    return undefined;
  }
  return aaptColorValue(hexadecimal);
}

function escapeSvgAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function formatSvgNumber(value: number): string {
  return Number.parseFloat(value.toFixed(4)).toString();
}

function renderVectorNode(node: AaptXmlNode, resourceColors: ReadonlyMap<string, string>): string {
  if (node.name === "path") {
    const pathData = node.attributes.get("pathData");
    if (pathData === undefined) {
      return "";
    }
    const fill = aaptColor(node.attributes.get("fillColor"), resourceColors);
    const stroke = aaptColor(node.attributes.get("strokeColor"), resourceColors);
    const fillAlpha = aaptFloat(node.attributes.get("fillAlpha")) ?? 1;
    const strokeAlpha = aaptFloat(node.attributes.get("strokeAlpha")) ?? 1;
    const attributes = [
      `d="${escapeSvgAttribute(pathData)}"`,
      `fill="${fill?.color ?? "#000000"}"`,
    ];
    const totalFillOpacity = (fill?.opacity ?? 1) * fillAlpha;
    if (totalFillOpacity < 1) {
      attributes.push(`fill-opacity="${formatSvgNumber(totalFillOpacity)}"`);
    }
    if (stroke !== undefined) {
      attributes.push(`stroke="${stroke.color}"`);
      const strokeWidth = aaptFloat(node.attributes.get("strokeWidth"));
      if (strokeWidth !== undefined) {
        attributes.push(`stroke-width="${formatSvgNumber(strokeWidth)}"`);
      }
      const totalStrokeOpacity = stroke.opacity * strokeAlpha;
      if (totalStrokeOpacity < 1) {
        attributes.push(`stroke-opacity="${formatSvgNumber(totalStrokeOpacity)}"`);
      }
    }
    return `<path ${attributes.join(" ")} />`;
  }

  const children = node.children.map((child) => renderVectorNode(child, resourceColors)).join("");
  if (node.name !== "group") {
    return children;
  }
  const translateX = aaptFloat(node.attributes.get("translateX")) ?? 0;
  const translateY = aaptFloat(node.attributes.get("translateY")) ?? 0;
  const scaleX = aaptFloat(node.attributes.get("scaleX")) ?? 1;
  const scaleY = aaptFloat(node.attributes.get("scaleY")) ?? 1;
  const rotation = aaptFloat(node.attributes.get("rotation")) ?? 0;
  const pivotX = aaptFloat(node.attributes.get("pivotX")) ?? 0;
  const pivotY = aaptFloat(node.attributes.get("pivotY")) ?? 0;
  const transforms = [
    `translate(${formatSvgNumber(translateX)} ${formatSvgNumber(translateY)})`,
    `rotate(${formatSvgNumber(rotation)} ${formatSvgNumber(pivotX)} ${formatSvgNumber(pivotY)})`,
    `translate(${formatSvgNumber(pivotX)} ${formatSvgNumber(pivotY)})`,
    `scale(${formatSvgNumber(scaleX)} ${formatSvgNumber(scaleY)})`,
    `translate(${formatSvgNumber(-pivotX)} ${formatSvgNumber(-pivotY)})`,
  ];
  return `<g transform="${transforms.join(" ")}">${children}</g>`;
}

function parseVectorDrawable(
  output: string,
  resourceColors: ReadonlyMap<string, string> = new Map(),
): VectorDrawable | undefined {
  const vector = parseAaptXmlTree(output).find((node) => node.name === "vector");
  if (vector === undefined) {
    return undefined;
  }
  const viewportWidth = aaptFloat(vector.attributes.get("viewportWidth"));
  const viewportHeight = aaptFloat(vector.attributes.get("viewportHeight"));
  if (
    viewportWidth === undefined ||
    viewportHeight === undefined ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return undefined;
  }
  return {
    viewBox: `0 0 ${formatSvgNumber(viewportWidth)} ${formatSvgNumber(viewportHeight)}`,
    markup: vector.children.map((child) => renderVectorNode(child, resourceColors)).join(""),
  };
}

export function vectorDrawableToSvg(output: string): string | undefined {
  const vector = parseVectorDrawable(output);
  return vector === undefined ? undefined : svgForVector(vector);
}

function svgForVector(vector: VectorDrawable): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vector.viewBox}">${vector.markup}</svg>`;
}

function compositeVectorDrawables(vectors: readonly VectorDrawable[]): VectorDrawable | undefined {
  const primary = vectors[0];
  if (primary === undefined || vectors.some((vector) => vector.viewBox !== primary.viewBox)) {
    return undefined;
  }
  return {
    viewBox: primary.viewBox,
    markup: vectors.map((vector) => vector.markup).join(""),
  };
}

function imageExtension(content: Buffer): ".avif" | ".jpeg" | ".png" | ".webp" | undefined {
  if (
    content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return ".png";
  }
  if (
    content.subarray(0, 4).equals(Buffer.from("RIFF")) &&
    content.subarray(8, 12).equals(Buffer.from("WEBP"))
  ) {
    return ".webp";
  }
  if (content.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return ".jpeg";
  }
  if (
    content.subarray(4, 8).equals(Buffer.from("ftyp")) &&
    ["avif", "avis"].includes(content.subarray(8, 12).toString("ascii"))
  ) {
    return ".avif";
  }
  return undefined;
}

function iconCachePrefix(serial: string, packageName: string, apkPaths: readonly string[]): string {
  return createHash("sha256")
    .update(
      `${APPLICATION_ICON_CACHE_VERSION}\u0000${serial}\u0000${packageName}\u0000${apkPaths.join("\u0000")}`,
    )
    .digest("hex");
}

function cacheFileName(
  serial: string,
  packageName: string,
  apkPaths: readonly string[],
  extension: string,
): string {
  return `${iconCachePrefix(serial, packageName, apkPaths)}${extension}`;
}

export class AdbDeviceApplicationIconService implements DeviceApplicationIconService {
  readonly #paths: AgentPaths;
  readonly #iconDirectory: string;
  readonly #deviceService: DeviceDiscoveryService;
  readonly #adbExecutable: string;
  readonly #configuredAaptPath: string | undefined;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #runner: ApkCommandRunner;
  readonly #inFlightRequests = new Map<string, Promise<DeviceApplicationIcon>>();
  readonly #frameworkArchiveRequests = new Map<string, Promise<LoadedIconArchive>>();
  readonly #frameworkApkRequests = new Map<string, Promise<string>>();
  readonly #pendingIconJobs: Array<() => void> = [];
  #activeIconJobs = 0;

  public constructor(options: AdbDeviceApplicationIconServiceOptions) {
    this.#paths = options.paths;
    this.#iconDirectory = join(options.paths.artifacts, "application-icons");
    this.#deviceService = options.deviceService;
    this.#adbExecutable = options.adbExecutable ?? process.env.ADB_PATH ?? "adb";
    this.#configuredAaptPath = options.aaptPath ?? process.env.AAPT_PATH;
    this.#environment = options.environment ?? process.env;
    this.#runner = options.runner ?? createDefaultRunner();
  }

  public readIcon(serial: string, packageName: string): Promise<DeviceApplicationIcon> {
    const requestKey = `${serial}\u0000${packageName}`;
    const existing = this.#inFlightRequests.get(requestKey);
    if (existing !== undefined) {
      return existing;
    }

    const request = this.#enqueueIconJob(async () => await this.#readIcon(serial, packageName));
    this.#inFlightRequests.set(requestKey, request);
    void request.then(
      () => this.#inFlightRequests.delete(requestKey),
      () => this.#inFlightRequests.delete(requestKey),
    );
    return request;
  }

  async #readIcon(serial: string, packageName: string): Promise<DeviceApplicationIcon> {
    await this.#requireReadyDevice(serial);

    try {
      const packagePathResult = await this.#runner.run(
        this.#adbExecutable,
        ["-s", serial, "shell", "pm", "path", packageName],
        20_000,
      );
      const apkPaths = parseInstalledApkPaths(commandOutput(packagePathResult));
      if (apkPaths.length === 0) {
        throw new DeviceApplicationIconError("未找到应用的 APK 文件。", 404);
      }

      await mkdir(this.#iconDirectory, { recursive: true });
      const cachePrefix = iconCachePrefix(serial, packageName, apkPaths);
      const cached = await this.#readCachedIcon(cachePrefix);
      if (cached !== undefined) {
        return cached;
      }

      const workDirectory = join(this.#iconDirectory, randomUUID());
      try {
        await mkdir(workDirectory, { recursive: true });
        const downloadedApks: string[] = [];
        for (const [index, apkPath] of apkPaths.entries()) {
          const downloadedApk = join(workDirectory, `application-${index}.apk`);
          await this.#runner.run(
            this.#adbExecutable,
            ["-s", serial, "pull", apkPath, downloadedApk],
            APPLICATION_ICON_TIMEOUT_MS,
          );
          downloadedApks.push(downloadedApk);
        }
        const aaptPath = await resolveAaptPath({
          paths: this.#paths,
          adbExecutable: this.#adbExecutable,
          ...(this.#configuredAaptPath === undefined ? {} : { aaptPath: this.#configuredAaptPath }),
          environment: this.#environment,
          runner: this.#runner,
        });
        const loadedArchives: LoadedIconArchive[] = [];
        for (const downloadedApk of downloadedApks) {
          loadedArchives.push(await this.#loadIconArchive(aaptPath, downloadedApk));
        }
        const manifest = await this.#runner.run(
          aaptPath,
          ["dump", "xmltree", downloadedApks[0] ?? "", "AndroidManifest.xml"],
          30_000,
        );
        const iconResourceId = parseAaptManifestIconResourceId(commandOutput(manifest));
        if (iconResourceId === undefined) {
          throw new DeviceApplicationIconError("应用未提供可读取的位图图标。", 404, true);
        }

        const archives = loadedArchives.map(({ archive }) => archive);
        const resourcePaths = new Map<string, BitmapIconResource>();
        const resourceColors = new Map<string, string>();
        for (const loadedArchive of loadedArchives) {
          this.#mergeIconArchive(loadedArchive, resourcePaths, resourceColors);
        }
        if (iconResourceId.startsWith("0x01")) {
          await this.#appendFrameworkArchive(
            serial,
            aaptPath,
            archives,
            resourcePaths,
            resourceColors,
          );
        }
        const iconResource = resourcePaths.get(iconResourceId);
        if (iconResource === undefined) {
          throw new DeviceApplicationIconError("应用未提供可读取的位图图标。", 404, true);
        }

        const resolved = await this.#resolveIconResource(
          serial,
          aaptPath,
          archives,
          resourcePaths,
          resourceColors,
          iconResource,
          new Set(),
        );
        if (resolved === undefined) {
          throw new DeviceApplicationIconError("应用未提供可读取的位图图标。", 404, true);
        }

        const icon =
          resolved.type === "svg"
            ? { content: resolved.content, contentType: "image/svg+xml", extension: ".svg" }
            : await this.#readBitmapIcon(resolved.resource, workDirectory);
        if (icon.content.length > MAX_APPLICATION_ICON_SIZE_BYTES) {
          throw new DeviceApplicationIconError("应用图标文件过大。", 413);
        }
        const contentType = CACHED_ICON_EXTENSIONS.get(icon.extension);
        if (contentType === undefined) {
          throw new DeviceApplicationIconError("应用图标格式不受支持。", 404, true);
        }
        await writeFile(
          join(this.#iconDirectory, cacheFileName(serial, packageName, apkPaths, icon.extension)),
          icon.content,
          {
            flag: "wx",
          },
        ).catch((error: unknown) => {
          if ((error as { code?: unknown }).code !== "EEXIST") {
            throw error;
          }
        });
        return { content: icon.content, contentType };
      } finally {
        await rm(workDirectory, { force: true, recursive: true });
      }
    } catch (error) {
      if (error instanceof DeviceApplicationIconError) {
        throw error;
      }
      if (error instanceof ApkArtifactError) {
        throw new DeviceApplicationIconError(error.message, error.statusCode);
      }
      throw new DeviceApplicationIconError(`读取应用图标失败：${toErrorMessage(error)}`, 502);
    }
  }

  async #loadIconArchive(aaptPath: string, apkPath: string): Promise<LoadedIconArchive> {
    const resources = await this.#runner.run(
      aaptPath,
      ["dump", "--values", "resources", apkPath],
      30_000,
    );
    const output = commandOutput(resources);
    return {
      archive: {
        apkPath,
        resourcePaths: new Set(parseAaptResourcePaths(output)),
      },
      colorValues: parseAaptColorValues(output),
      resourceFiles: parseAaptResourceFilePaths(output),
    };
  }

  #mergeIconArchive(
    loadedArchive: LoadedIconArchive,
    resourcePaths: Map<string, BitmapIconResource>,
    resourceColors: Map<string, string>,
  ): void {
    for (const [resourceId, resourcePath] of loadedArchive.resourceFiles) {
      const resource = findResourceInArchives(resourcePath, [loadedArchive.archive]);
      if (resource !== undefined) {
        resourcePaths.set(resourceId, resource);
      }
    }
    for (const [resourceId, color] of loadedArchive.colorValues) {
      resourceColors.set(resourceId, color);
    }
  }

  async #appendFrameworkArchive(
    serial: string,
    aaptPath: string,
    archives: IconArchive[],
    resourcePaths: Map<string, BitmapIconResource>,
    resourceColors: Map<string, string>,
  ): Promise<void> {
    const frameworkArchive = await this.#frameworkArchive(serial, aaptPath);
    if (archives.some((archive) => archive.apkPath === frameworkArchive.archive.apkPath)) {
      return;
    }
    archives.push(frameworkArchive.archive);
    this.#mergeIconArchive(frameworkArchive, resourcePaths, resourceColors);
  }

  async #frameworkArchive(serial: string, aaptPath: string): Promise<LoadedIconArchive> {
    const existing = this.#frameworkArchiveRequests.get(serial);
    if (existing !== undefined) {
      return await existing;
    }
    const request = this.#frameworkApk(serial).then(
      async (frameworkApk) => await this.#loadIconArchive(aaptPath, frameworkApk),
    );
    this.#frameworkArchiveRequests.set(serial, request);
    void request.catch(() => this.#frameworkArchiveRequests.delete(serial));
    return await request;
  }

  async #frameworkApk(serial: string): Promise<string> {
    const existing = this.#frameworkApkRequests.get(serial);
    if (existing !== undefined) {
      return await existing;
    }

    const request = this.#downloadFrameworkApk(serial);
    this.#frameworkApkRequests.set(serial, request);
    void request.then(
      () => this.#frameworkApkRequests.delete(serial),
      () => this.#frameworkApkRequests.delete(serial),
    );
    return await request;
  }

  async #downloadFrameworkApk(serial: string): Promise<string> {
    const cacheKey = createHash("sha256").update(serial).digest("hex");
    const frameworkApk = join(this.#iconDirectory, `framework-${cacheKey}.apk`);
    try {
      const metadata = await stat(frameworkApk);
      if (metadata.isFile() && metadata.size > 0) {
        return frameworkApk;
      }
    } catch {
      // Pull the framework archive below when it is not cached yet.
    }
    await this.#runner.run(
      this.#adbExecutable,
      ["-s", serial, "pull", DEVICE_FRAMEWORK_APK_PATH, frameworkApk],
      APPLICATION_ICON_TIMEOUT_MS,
    );
    return frameworkApk;
  }

  async #resolveIconResource(
    serial: string,
    aaptPath: string,
    archives: IconArchive[],
    resourcePaths: Map<string, BitmapIconResource>,
    resourceColors: Map<string, string>,
    resource: BitmapIconResource,
    visited: Set<string>,
  ): Promise<ResolvedIconResource | undefined> {
    const normalized = normalizeIconResourcePath(resource.resourcePath);
    const resourceKey = `${resource.archive.apkPath}\u0000${normalized}`;
    if (visited.has(resourceKey)) {
      return undefined;
    }
    visited.add(resourceKey);

    const extension = posix.extname(normalized).toLowerCase();
    if (BITMAP_ICON_EXTENSIONS.has(extension)) {
      return { type: "bitmap", resource };
    }
    let xmlTreeOutput: string;
    try {
      const xmlTree = await this.#runner.run(
        aaptPath,
        ["dump", "xmltree", resource.archive.apkPath, normalized],
        30_000,
      );
      xmlTreeOutput = commandOutput(xmlTree);
    } catch (error) {
      if (extension !== ".xml") {
        return { type: "bitmap", resource };
      }
      throw error;
    }
    const resourceIds = new Set(parseAaptXmlResourceIds(xmlTreeOutput));
    if ([...resourceIds].some((resourceId) => resourceId.startsWith("0x01"))) {
      await this.#appendFrameworkArchive(serial, aaptPath, archives, resourcePaths, resourceColors);
    }
    const vector = parseVectorDrawable(xmlTreeOutput, resourceColors);
    if (vector !== undefined) {
      return {
        type: "svg",
        content: Buffer.from(svgForVector(vector), "utf8"),
        vector,
      };
    }

    const resolvedChildren: ResolvedIconResource[] = [];
    for (const resourceId of resourceIds) {
      const childResource = resourcePaths.get(resourceId);
      if (childResource === undefined) {
        continue;
      }
      const child = await this.#resolveIconResource(
        serial,
        aaptPath,
        archives,
        resourcePaths,
        resourceColors,
        childResource,
        visited,
      );
      if (child !== undefined) {
        resolvedChildren.push(child);
      }
    }

    const bitmap = resolvedChildren.findLast((child) => child.type === "bitmap");
    if (bitmap !== undefined) {
      return bitmap;
    }
    const vectors = resolvedChildren.flatMap((child) =>
      child.type === "svg" ? [child.vector] : [],
    );
    const composite = compositeVectorDrawables(vectors);
    if (composite !== undefined) {
      return {
        type: "svg",
        content: Buffer.from(svgForVector(composite), "utf8"),
        vector: composite,
      };
    }
    const fallbackBitmap = findBitmapIconResource(normalized, archives);
    return fallbackBitmap === undefined ? undefined : { type: "bitmap", resource: fallbackBitmap };
  }

  async #readBitmapIcon(
    resource: BitmapIconResource,
    workDirectory: string,
  ): Promise<{ content: Buffer; extension: string }> {
    await this.#runner.run(
      "tar",
      ["-xf", resource.archive.apkPath, "-C", workDirectory, resource.resourcePath],
      30_000,
    );
    const extractedIcon = join(workDirectory, ...resource.resourcePath.split("/"));
    const metadata = await stat(extractedIcon);
    if (!metadata.isFile() || metadata.size === 0) {
      throw new DeviceApplicationIconError("应用图标文件不可用。", 404, true);
    }
    const content = await readFile(extractedIcon);
    const extension = imageExtension(content);
    if (extension === undefined) {
      throw new DeviceApplicationIconError("应用图标格式不受支持。", 404, true);
    }
    return { content, extension };
  }

  async #readCachedIcon(cachePrefix: string): Promise<DeviceApplicationIcon | undefined> {
    for (const [extension, contentType] of CACHED_ICON_EXTENSIONS) {
      const filePath = join(this.#iconDirectory, `${cachePrefix}${extension}`);
      try {
        const metadata = await stat(filePath);
        if (
          !metadata.isFile() ||
          metadata.size === 0 ||
          metadata.size > MAX_APPLICATION_ICON_SIZE_BYTES
        ) {
          continue;
        }
        return { content: await readFile(filePath), contentType };
      } catch {
        // Try the next supported file extension.
      }
    }
    return undefined;
  }

  #enqueueIconJob<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#pendingIconJobs.push(() => {
        this.#activeIconJobs += 1;
        void job()
          .then(resolve, reject)
          .finally(() => {
            this.#activeIconJobs -= 1;
            this.#startPendingIconJobs();
          });
      });
      this.#startPendingIconJobs();
    });
  }

  #startPendingIconJobs(): void {
    while (
      this.#activeIconJobs < MAX_CONCURRENT_ICON_EXTRACTIONS &&
      this.#pendingIconJobs.length > 0
    ) {
      this.#pendingIconJobs.shift()?.();
    }
  }

  async #requireReadyDevice(serial: string): Promise<void> {
    let response: DeviceListResponse;
    try {
      response = await this.#deviceService.listDevices();
    } catch (error) {
      throw new DeviceApplicationIconError(`设备发现失败：${toErrorMessage(error)}`, 503);
    }

    if (!response.adb.available) {
      throw new DeviceApplicationIconError(response.adb.error ?? "ADB 不可用。", 503);
    }
    if (response.error !== undefined) {
      throw new DeviceApplicationIconError(response.error, 503);
    }
    const device = response.devices.find((candidate) => candidate.serial === serial);
    if (device === undefined) {
      throw new DeviceApplicationIconError("目标设备已断开连接。", 404);
    }
    if (device.state !== "device" && device.state !== "emulator") {
      throw new DeviceApplicationIconError(`目标设备当前不可用（${device.state}）。`, 409);
    }
  }
}
