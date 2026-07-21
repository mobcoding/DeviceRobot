import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { AgentPaths } from "@device-robot/config";
import type { AndroidProject } from "@device-robot/contracts";

const execFileAsync = promisify(execFile);
const KEYTOOL_TIMEOUT_MS = 30_000;
const KEY_VALIDITY_DAYS = 3_650;

type SigningConfiguration = {
  keyStorePath: string;
  storePassword: string;
  keyAlias: string;
  keyPassword: string;
};

type GeneratedSigningKey = {
  path: string;
  createdDirectories: string[];
};

export class ProjectTemporarySigningError extends Error {
  public constructor(message: string) {
    super(message);
  }
}

export interface SigningKeyCommandRunner {
  run(executable: string, args: readonly string[]): Promise<void>;
}

export interface TemporarySigningMaterial {
  readonly generatedPaths: readonly string[];
  dispose(): Promise<void>;
}

export interface ProjectTemporarySigningService {
  prepare(project: AndroidProject): Promise<TemporarySigningMaterial | undefined>;
}

export type LocalProjectTemporarySigningServiceOptions = {
  runner?: SigningKeyCommandRunner;
  paths?: AgentPaths;
};

function stringAssignment(contents: string, name: string): string | undefined {
  const value = new RegExp(`\\b${name}\\s*=\\s*["']([^"'\\r\\n]+)["']`, "u")
    .exec(contents)?.[1]
    ?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function signingBlocks(contents: string): string[] {
  const blocks = [
    ...contents.matchAll(/\b(?:getByName|create)\s*\([^)]*\)\s*\{([\s\S]*?)^\s*\}/gmu),
  ]
    .map((match) => match[1])
    .filter((block): block is string => block !== undefined);
  return blocks.length === 0 ? [contents] : blocks;
}

function isInsideProject(projectRoot: string, path: string): boolean {
  const relativePath = relative(projectRoot, path);
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function signingConfigurations(
  projectRoot: string,
  buildFilePath: string,
  contents: string,
): SigningConfiguration[] {
  const configurations: SigningConfiguration[] = [];
  for (const block of signingBlocks(contents)) {
    const keyStoreValue = /\bstoreFile\s*(?:=\s*)?file\(\s*["']([^"']+)["']\s*\)/u
      .exec(block)?.[1]
      ?.trim();
    const storePassword = stringAssignment(block, "storePassword");
    const keyAlias = stringAssignment(block, "keyAlias");
    const keyPassword = stringAssignment(block, "keyPassword");
    if (
      keyStoreValue === undefined ||
      storePassword === undefined ||
      keyAlias === undefined ||
      keyPassword === undefined ||
      isAbsolute(keyStoreValue)
    ) {
      continue;
    }
    const keyStorePath = resolve(dirname(buildFilePath), keyStoreValue);
    if (!isInsideProject(projectRoot, keyStorePath)) {
      continue;
    }
    configurations.push({ keyStorePath, storePassword, keyAlias, keyPassword });
  }
  return configurations;
}

async function discoverSigningConfigurations(
  project: AndroidProject,
): Promise<SigningConfiguration[]> {
  const configurations: SigningConfiguration[] = [];
  const buildFiles = new Set(project.modules.map((module) => module.buildFile));
  for (const buildFile of buildFiles) {
    const buildFilePath = join(project.rootPath, ...buildFile.split("/"));
    try {
      const contents = await readFile(buildFilePath, "utf8");
      configurations.push(...signingConfigurations(project.rootPath, buildFilePath, contents));
    } catch {
      // Gradle will report missing or malformed build scripts during the approved build.
    }
  }
  return configurations;
}

async function createParentDirectory(path: string, projectRoot: string): Promise<string[]> {
  const parent = dirname(path);
  const missing: string[] = [];
  let current = parent;
  while (isInsideProject(projectRoot, current) && !existsSync(current)) {
    missing.push(current);
    current = dirname(current);
  }
  await mkdir(parent, { recursive: true });
  return missing;
}

function createDefaultRunner(): SigningKeyCommandRunner {
  return {
    run: async (executable, args) => {
      await execFileAsync(executable, [...args], {
        windowsHide: true,
        timeout: KEYTOOL_TIMEOUT_MS,
        maxBuffer: 1_024 * 1_024,
      });
    },
  };
}

async function disposeGeneratedKeys(keys: readonly GeneratedSigningKey[]): Promise<void> {
  for (const key of [...keys].reverse()) {
    await rm(key.path, { force: true });
    for (const directory of key.createdDirectories) {
      try {
        await rmdir(directory);
      } catch {
        // Do not remove user-provided directories or files created by Gradle.
      }
    }
  }
}

function persistentKeyPath(
  paths: AgentPaths,
  project: AndroidProject,
  configuration: SigningConfiguration,
): string {
  const identity = JSON.stringify({
    projectId: project.id,
    keyStorePath: relative(project.rootPath, configuration.keyStorePath).split(sep).join("/"),
    keyAlias: configuration.keyAlias,
    storePassword: configuration.storePassword,
    keyPassword: configuration.keyPassword,
  });
  const fingerprint = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return join(paths.root, "signing-keys", `${project.id}-${fingerprint}.jks`);
}

export class LocalProjectTemporarySigningService implements ProjectTemporarySigningService {
  readonly #runner: SigningKeyCommandRunner;
  readonly #paths: AgentPaths | undefined;

  public constructor(options: LocalProjectTemporarySigningServiceOptions = {}) {
    this.#runner = options.runner ?? createDefaultRunner();
    this.#paths = options.paths;
  }

  public async prepare(project: AndroidProject): Promise<TemporarySigningMaterial | undefined> {
    const configurations = await discoverSigningConfigurations(project);
    const generated: GeneratedSigningKey[] = [];
    try {
      for (const configuration of configurations) {
        if (existsSync(configuration.keyStorePath)) {
          continue;
        }
        if (configuration.storePassword.length < 6 || configuration.keyPassword.length < 6) {
          throw new ProjectTemporarySigningError("临时签名密码长度不足，无法生成 JKS 文件。");
        }
        const createdDirectories = await createParentDirectory(
          configuration.keyStorePath,
          project.rootPath,
        );
        const generatedKey = { path: configuration.keyStorePath, createdDirectories };
        generated.push(generatedKey);
        const generatedPath =
          this.#paths === undefined
            ? configuration.keyStorePath
            : persistentKeyPath(this.#paths, project, configuration);
        if (this.#paths !== undefined) {
          await mkdir(dirname(generatedPath), { recursive: true });
        }
        const needsGeneration = !existsSync(generatedPath);
        if (needsGeneration) {
          await this.#runner.run("keytool", [
            "-genkeypair",
            "-keystore",
            generatedPath,
            "-storetype",
            "JKS",
            "-storepass",
            configuration.storePassword,
            "-alias",
            configuration.keyAlias,
            "-keypass",
            configuration.keyPassword,
            "-keyalg",
            "RSA",
            "-keysize",
            "2048",
            "-validity",
            String(KEY_VALIDITY_DAYS),
            "-dname",
            "CN=DeviceRobot Temporary Build, OU=Local, O=DeviceRobot, L=Local, ST=Local, C=CN",
            "-noprompt",
          ]);
        }
        if (needsGeneration && !existsSync(generatedPath)) {
          throw new ProjectTemporarySigningError("keytool 未生成预期的临时签名文件。");
        }
        if (this.#paths !== undefined) {
          await copyFile(generatedPath, configuration.keyStorePath);
        }
      }
    } catch (error) {
      await disposeGeneratedKeys(generated);
      throw new ProjectTemporarySigningError(
        `无法生成构建临时签名：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (generated.length === 0) {
      return undefined;
    }
    return {
      generatedPaths: generated.map((key) => key.path),
      dispose: async () => await disposeGeneratedKeys(generated),
    };
  }
}
