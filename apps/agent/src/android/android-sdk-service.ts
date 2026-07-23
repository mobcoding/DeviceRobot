import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { XMLParser } from "fast-xml-parser";
import type { AgentPaths } from "@device-robot/config";
import type { AndroidProjectModule, AndroidSdkInfo } from "@device-robot/contracts";

const ANDROID_REPOSITORY_URL = "https://dl.google.com/android/repository/repository2-1.xml";
const ANDROID_REPOSITORY_BASE_URL = "https://dl.google.com/android/repository/";
const SDK_MANAGER_RELATIVE_PATH =
  process.platform === "win32"
    ? ["cmdline-tools", "latest", "bin", "sdkmanager.bat"]
    : ["cmdline-tools", "latest", "bin", "sdkmanager"];
const MAX_DOWNLOAD_ATTEMPTS = 5;

type AndroidSdkSource = Exclude<AndroidSdkInfo["source"], "unavailable">;

type AndroidSdkCandidate = {
  path: string;
  source: AndroidSdkSource;
};

type AndroidRepositoryArchive = {
  url: string;
  checksum: string;
  size: number;
};

type AndroidSdkCommandResult = {
  output: string;
};

export class AndroidSdkServiceError extends Error {
  public constructor(message: string) {
    super(message);
  }
}

export type AndroidSdkServiceOptions = {
  paths: AgentPaths;
  environment?: NodeJS.ProcessEnv;
  managedSdkInstaller?: (requiredPackages: readonly string[]) => Promise<void>;
};

function asArray<T>(value: T | readonly T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? (Array.from(value) as T[]) : [value as T];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function formatCommandOutput(output: string): string {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.slice(-8).join("\n");
}

async function sha1(path: string): Promise<string> {
  const hash = createHash("sha1");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function readLocalSdkPath(projectRoot: string): Promise<string | undefined> {
  try {
    const localProperties = await readFile(join(projectRoot, "local.properties"), "utf8");
    const value = /^\s*sdk\.dir\s*=\s*(.+?)\s*$/mu.exec(localProperties)?.[1];
    if (value === undefined) {
      return undefined;
    }
    const path = value.replaceAll("\\:", ":").replaceAll("\\\\", "\\").trim();
    return path.length === 0 ? undefined : path;
  } catch {
    return undefined;
  }
}

function hasPlatformTools(sdkRoot: string): boolean {
  const executable = process.platform === "win32" ? "adb.exe" : "adb";
  return existsSync(join(sdkRoot, "platform-tools", executable));
}

async function hasBuildTools(sdkRoot: string, majorVersion: string): Promise<boolean> {
  try {
    const entries = await readdir(join(sdkRoot, "build-tools"), { withFileTypes: true });
    const executable = process.platform === "win32" ? "aapt.exe" : "aapt";
    return entries.some(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith(`${majorVersion}.`) &&
        existsSync(join(sdkRoot, "build-tools", entry.name, executable)),
    );
  } catch {
    return false;
  }
}

async function isPackageInstalled(sdkRoot: string, packageName: string): Promise<boolean> {
  if (packageName === "platform-tools") {
    return hasPlatformTools(sdkRoot);
  }

  const platform = /^platforms;android-(\d+)$/u.exec(packageName)?.[1];
  if (platform !== undefined) {
    return existsSync(join(sdkRoot, "platforms", `android-${platform}`, "android.jar"));
  }

  const buildTools = /^build-tools;(\d+)\.0\.0$/u.exec(packageName)?.[1];
  if (buildTools !== undefined) {
    return await hasBuildTools(sdkRoot, buildTools);
  }

  const ndkVersion = /^ndk;([0-9]+(?:\.[0-9]+)+)$/u.exec(packageName)?.[1];
  if (ndkVersion !== undefined) {
    return existsSync(join(sdkRoot, "ndk", ndkVersion, "source.properties"));
  }

  const cmakeVersion = /^cmake;([0-9]+(?:\.[0-9]+)+)$/u.exec(packageName)?.[1];
  if (cmakeVersion !== undefined) {
    const executable = process.platform === "win32" ? "cmake.exe" : "cmake";
    return existsSync(join(sdkRoot, "cmake", cmakeVersion, "bin", executable));
  }

  return false;
}

function packageInstallPath(sdkRoot: string, packageName: string): string | undefined {
  if (packageName === "platform-tools") {
    return join(sdkRoot, "platform-tools");
  }

  const platform = /^platforms;android-(\d+)$/u.exec(packageName)?.[1];
  if (platform !== undefined) {
    return join(sdkRoot, "platforms", `android-${platform}`);
  }

  const buildTools = /^build-tools;([0-9.]+)$/u.exec(packageName)?.[1];
  if (buildTools !== undefined) {
    return join(sdkRoot, "build-tools", buildTools);
  }

  const ndkVersion = /^ndk;([0-9]+(?:\.[0-9]+)+)$/u.exec(packageName)?.[1];
  if (ndkVersion !== undefined) {
    return join(sdkRoot, "ndk", ndkVersion);
  }

  const cmakeVersion = /^cmake;([0-9]+(?:\.[0-9]+)+)$/u.exec(packageName)?.[1];
  return cmakeVersion === undefined ? undefined : join(sdkRoot, "cmake", cmakeVersion);
}

async function missingPackages(
  sdkRoot: string,
  requiredPackages: readonly string[],
): Promise<string[]> {
  const results = await Promise.all(
    requiredPackages.map(async (packageName) => ({
      packageName,
      installed: await isPackageInstalled(sdkRoot, packageName),
    })),
  );
  return results.filter((result) => !result.installed).map((result) => result.packageName);
}

function compileSdkFromBuildScript(contents: string): number | undefined {
  const values = [
    ...contents.matchAll(/\bcompileSdk(?:Version)?\s*(?:=)?\s*(\d+)/gu),
    ...contents.matchAll(/\bcompileSdk\s*\{[\s\S]{0,320}?\brelease\(\s*(\d+)\s*\)/gu),
  ]
    .map((match) => Number.parseInt(match[1] ?? "", 10))
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return values.length === 0 ? undefined : Math.max(...values);
}

function nativeBuildPackagesFromBuildScript(contents: string): string[] {
  const packages: string[] = [];
  for (const match of contents.matchAll(/\bndkVersion\s*(?:=)?\s*["']([0-9]+(?:\.[0-9]+)+)["']/gu)) {
    const version = match[1];
    if (version !== undefined) {
      packages.push(`ndk;${version}`);
    }
  }
  for (const match of contents.matchAll(
    /\bcmake\s*\{[\s\S]{0,1024}?\bversion\s*(?:=)?\s*["']([0-9]+(?:\.[0-9]+)+)["']/gu,
  )) {
    const version = match[1];
    if (version !== undefined) {
      packages.push(`cmake;${version}`);
    }
  }
  return packages;
}

export async function requiredAndroidSdkPackages(
  projectRoot: string,
  modules: readonly AndroidProjectModule[],
): Promise<string[]> {
  const buildFiles = unique([
    "build.gradle",
    "build.gradle.kts",
    ...modules.map((module) => module.buildFile),
  ]);
  const contents = await Promise.all(
    buildFiles.map(async (buildFile) => {
      try {
        return await readFile(join(projectRoot, buildFile), "utf8");
      } catch {
        return "";
      }
    }),
  );
  const apiLevels = contents
    .map((content) => compileSdkFromBuildScript(content))
    .filter((value): value is number => value !== undefined);
  const packages = ["platform-tools"];
  if (apiLevels.length > 0) {
    const apiLevel = Math.max(...apiLevels);
    packages.push(`platforms;android-${apiLevel}`, `build-tools;${apiLevel}.0.0`);
  }
  packages.push(...contents.flatMap(nativeBuildPackagesFromBuildScript));
  return unique(packages);
}

export async function inspectAndroidSdk(options: {
  paths: AgentPaths;
  projectRoot?: string;
  environment?: NodeJS.ProcessEnv;
  requiredPackages?: readonly string[];
}): Promise<AndroidSdkInfo> {
  const environment = options.environment ?? process.env;
  const requiredPackages = unique(options.requiredPackages ?? ["platform-tools"]);
  const candidates: AndroidSdkCandidate[] = [];
  for (const configuredPath of [environment.ANDROID_SDK_ROOT, environment.ANDROID_HOME]) {
    const path = configuredPath?.trim();
    if (path !== undefined && path.length > 0 && existsSync(path)) {
      candidates.push({ path, source: "environment" });
    }
  }
  if (options.projectRoot !== undefined) {
    const path = await readLocalSdkPath(options.projectRoot);
    if (path !== undefined && existsSync(path)) {
      candidates.push({ path, source: "local-properties" });
    }
  }
  if (existsSync(options.paths.androidSdk)) {
    candidates.push({ path: options.paths.androidSdk, source: "managed" });
  }

  const inspected = await Promise.all(
    unique(candidates.map((candidate) => `${candidate.source}\u0000${candidate.path}`)).map(
      async (key) => {
        const [source, path] = key.split("\u0000", 2) as [AndroidSdkSource, string];
        return { path, source, missing: await missingPackages(path, requiredPackages) };
      },
    ),
  );
  const chosen = inspected.find((candidate) => candidate.missing.length === 0) ?? inspected[0];
  if (chosen === undefined) {
    return {
      available: false,
      source: "unavailable",
      requiredPackages,
      missingPackages: requiredPackages,
    };
  }
  return {
    available: true,
    path: chosen.path,
    source: chosen.source,
    requiredPackages,
    missingPackages: chosen.missing,
  };
}

export function parseAndroidRepositoryArchive(
  value: unknown,
  packagePath: string,
): AndroidRepositoryArchive {
  const document = value as Record<string, unknown>;
  const repository =
    record(document["sdk:sdk-repository"]) ??
    Object.entries(document)
      .filter(([name]) => name.endsWith("repository"))
      .map(([, candidate]) => record(candidate))
      .find((candidate) => candidate !== undefined);
  const packages = asArray<Record<string, unknown>>(record(repository?.remotePackage));
  const remotePackage = packages.find((candidate) => candidate.path === packagePath);
  if (remotePackage === undefined) {
    throw new AndroidSdkServiceError(`Android SDK 软件包不可用：${packagePath}`);
  }
  const archives = asArray(
    record(remotePackage.archives)?.archive as
      Record<string, unknown> | readonly Record<string, unknown>[] | undefined,
  );
  const archive =
    archives.find((candidate) => candidate["host-os"] === "windows") ??
    archives.find((candidate) => candidate["host-os"] === undefined);
  const complete = archive?.complete as Record<string, unknown> | undefined;
  const url = typeof complete?.url === "string" ? complete.url : undefined;
  const checksum = typeof complete?.checksum === "string" ? complete.checksum : undefined;
  const size = typeof complete?.size === "number" ? complete.size : Number(complete?.size);
  if (
    url === undefined ||
    checksum === undefined ||
    !/^[0-9a-f]{40}$/iu.test(checksum) ||
    !Number.isSafeInteger(size) ||
    size <= 0
  ) {
    throw new AndroidSdkServiceError(`Android SDK 软件包元数据无效：${packagePath}`);
  }
  return { url: new URL(url, ANDROID_REPOSITORY_BASE_URL).toString(), checksum, size };
}

async function downloadArchive(
  destination: string,
  archive: AndroidRepositoryArchive,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      const currentSize = existsSync(destination) ? (await stat(destination)).size : 0;
      if (currentSize > archive.size) {
        await rm(destination, { force: true });
        continue;
      }
      if (currentSize === archive.size) {
        if ((await sha1(destination)).toLowerCase() === archive.checksum.toLowerCase()) {
          return;
        }
        await rm(destination, { force: true });
        continue;
      }

      const response = await fetch(archive.url, {
        signal: AbortSignal.timeout(120_000),
        ...(currentSize === 0 ? {} : { headers: { Range: `bytes=${currentSize}-` } }),
      });
      if (!response.ok || response.body === null) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (currentSize > 0 && response.status !== 206) {
        await rm(destination, { force: true });
        continue;
      }
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream),
        createWriteStream(destination, { flags: currentSize === 0 ? "w" : "a" }),
      );

      const downloadedSize = (await stat(destination)).size;
      if (downloadedSize !== archive.size) {
        throw new Error(`下载不完整（${downloadedSize}/${archive.size} 字节）`);
      }
      if ((await sha1(destination)).toLowerCase() !== archive.checksum.toLowerCase()) {
        await rm(destination, { force: true });
        throw new Error("下载文件校验失败");
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_DOWNLOAD_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, attempt * 1_000));
      }
    }
  }
  throw new AndroidSdkServiceError(`无法下载 Android SDK 命令行工具：${errorMessage(lastError)}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runCommand(
  executable: string,
  args: readonly string[],
  input?: string,
): Promise<AndroidSdkCommandResult> {
  const useWindowsCommand = process.platform === "win32" && executable.endsWith(".bat");
  const command = useWindowsCommand ? (process.env.ComSpec ?? "cmd.exe") : executable;
  const commandArgs = useWindowsCommand
    ? ["/d", "/s", "/c", `"${executable}" ${args.join(" ")}`]
    : [...args];
  return await new Promise<AndroidSdkCommandResult>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: useWindowsCommand,
    });
    let output = "";
    const writeOutput = (chunk: Buffer | string): void => {
      if (output.length < 32_768) {
        output += chunk.toString();
      }
    };
    child.stdout?.on("data", writeOutput);
    child.stderr?.on("data", writeOutput);
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolve({ output });
        return;
      }
      reject(new AndroidSdkServiceError(formatCommandOutput(output) || `命令退出码 ${exitCode}`));
    });
    child.stdin?.end(input);
  });
}

export class AndroidSdkService {
  readonly #paths: AgentPaths;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #managedSdkInstaller: (requiredPackages: readonly string[]) => Promise<void>;
  #installation: Promise<void> | undefined;

  public constructor(options: AndroidSdkServiceOptions) {
    this.#paths = options.paths;
    this.#environment = options.environment ?? process.env;
    this.#managedSdkInstaller =
      options.managedSdkInstaller ?? (async (requiredPackages) => await this.#installManagedSdk(requiredPackages));
  }

  public async inspect(
    projectRoot: string,
    modules: readonly AndroidProjectModule[],
  ): Promise<AndroidSdkInfo> {
    const requiredPackages = await requiredAndroidSdkPackages(projectRoot, modules);
    return await inspectAndroidSdk({
      paths: this.#paths,
      projectRoot,
      environment: this.#environment,
      requiredPackages,
    });
  }

  public async install(
    projectRoot: string,
    modules: readonly AndroidProjectModule[],
  ): Promise<AndroidSdkInfo> {
    while (true) {
      const current = await this.inspect(projectRoot, modules);
      if (current.available && current.missingPackages.length === 0) {
        return current;
      }

      const activeInstallation = this.#installation;
      if (activeInstallation !== undefined) {
        await activeInstallation;
        // The active installation may belong to another project with a different compileSdk,
        // NDK, or CMake requirement. Re-check this project's requirements before returning.
        continue;
      }

      this.#installation = this.#managedSdkInstaller(current.requiredPackages).finally(() => {
        this.#installation = undefined;
      });
      await this.#installation;
    }
  }

  async #installManagedSdk(requiredPackages: readonly string[]): Promise<void> {
    await mkdir(this.#paths.androidSdk, { recursive: true });
    const sdkManagerPath = join(this.#paths.androidSdk, ...SDK_MANAGER_RELATIVE_PATH);
    if (!existsSync(sdkManagerPath)) {
      await this.#installCommandLineTools();
    }
    const incompletePackages = await missingPackages(this.#paths.androidSdk, requiredPackages);
    await Promise.all(
      incompletePackages.map(async (packageName) => {
        const packagePath = packageInstallPath(this.#paths.androidSdk, packageName);
        if (packagePath !== undefined) {
          await rm(packagePath, { force: true, recursive: true });
        }
      }),
    );
    await runCommand(
      sdkManagerPath,
      [`--sdk_root=${this.#paths.androidSdk}`, "--licenses"],
      "y\ny\ny\ny\ny\ny\ny\ny\ny\ny\n",
    );
    await runCommand(sdkManagerPath, [
      `--sdk_root=${this.#paths.androidSdk}`,
      "--install",
      "--channel=0",
      ...requiredPackages,
    ]);
  }

  async #installCommandLineTools(): Promise<void> {
    const response = await fetch(ANDROID_REPOSITORY_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      throw new AndroidSdkServiceError(
        `无法获取 Android SDK 软件包目录（HTTP ${response.status}）`,
      );
    }
    const manifest = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      trimValues: true,
    }).parse(await response.text());
    const archive = parseAndroidRepositoryArchive(manifest, "cmdline-tools;latest");
    const downloadPath = join(this.#paths.downloads, "android-commandline-tools-win.zip.download");
    await mkdir(this.#paths.downloads, { recursive: true });
    await downloadArchive(downloadPath, archive);

    const temporaryDirectory = join(this.#paths.downloads, "android-commandline-tools.extracting");
    await rm(temporaryDirectory, { force: true, recursive: true });
    await mkdir(temporaryDirectory, { recursive: true });
    try {
      await runCommand("tar.exe", ["-xf", downloadPath, "-C", temporaryDirectory]);
      const extractedDirectory = join(temporaryDirectory, "cmdline-tools");
      if (!existsSync(extractedDirectory)) {
        throw new AndroidSdkServiceError("Android SDK 命令行工具压缩包结构无效");
      }
      const destination = join(this.#paths.androidSdk, "cmdline-tools", "latest");
      await mkdir(join(this.#paths.androidSdk, "cmdline-tools"), { recursive: true });
      await rm(destination, { force: true, recursive: true });
      await rename(extractedDirectory, destination);
    } finally {
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  }
}
