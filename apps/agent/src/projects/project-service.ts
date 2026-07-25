import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { AgentPaths } from "@device-robot/config";
import {
  androidProjectSchema,
  type AndroidProject,
  type AndroidProjectModule,
  type CreateProjectRequest,
} from "@device-robot/contracts";

import type { ProjectStore } from "./project-store.js";
import { indexAndroidProjectSource } from "./source-indexer.js";

const execFileAsync = promisify(execFile);
const MAX_PROJECT_DEPTH = 8;
const MAX_PROJECT_MODULES = 200;
const MAX_READ_FILE_SIZE_BYTES = 2 * 1_024 * 1_024;
const GIT_CLONE_MAX_ATTEMPTS = 3;
const GIT_CLONE_RETRY_DELAY_MS = 800;
const GIT_PARTIAL_CLONE_BLOB_LIMIT = "2m";
const gitHttpConfiguration = ["-c", "http.version=HTTP/1.1"] as const;
const gitFallbackSparsePatterns = ["/*", "!/.idea/", "!/docs/", "!/tools/"] as const;
const appConfigurationFileNames = ["app-config.gradle.kts", "app-config.gradle"] as const;
const androidApplicationIdPattern =
  /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
const ignoredDirectories = new Set([
  ".git",
  ".gradle",
  ".idea",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

export class ProjectError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: 400 | 404 | 409 | 422 | 502 | 503,
  ) {
    super(message);
  }
}

export interface ProjectCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string }>;
}

export interface ProjectService {
  list(): Promise<AndroidProject[]>;
  add(request: CreateProjectRequest): Promise<AndroidProject>;
  remove(id: string): Promise<void>;
  reindex(id: string): Promise<AndroidProject>;
}

export type LocalProjectServiceOptions = {
  paths: AgentPaths;
  store: ProjectStore;
  gitExecutable?: string;
  runner?: ProjectCommandRunner;
  retryDelay?: (milliseconds: number) => Promise<void>;
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createDefaultRunner(): ProjectCommandRunner {
  return {
    run: async (executable, args, timeoutMs) => {
      const { stdout, stderr } = await execFileAsync(executable, [...args], {
        encoding: "utf8",
        maxBuffer: 16 * 1_024 * 1_024,
        timeout: timeoutMs,
        windowsHide: true,
      });
      return { stdout: String(stdout), stderr: String(stderr) };
    },
  };
}

function defaultRetryDelay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isTransientGitTransportError(error: unknown): boolean {
  const message = toErrorMessage(error);
  return /(?:curl\s+\d+|recv failure|connection (?:was )?reset|early eof|unexpected disconnect|remote end hung up|fetch-pack|index-pack|could not fetch .* promisor remote|timed out|etimedout|econnreset|http\s+5\d\d)/iu.test(
    message,
  );
}

function relativeProjectPath(rootPath: string, path: string): string {
  const value = relative(rootPath, path).split(sep).join("/");
  return value.length === 0 ? "." : value;
}

async function readableText(path: string): Promise<string | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_READ_FILE_SIZE_BYTES) {
      return undefined;
    }
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function findBuildFile(directory: string): Promise<string | undefined> {
  for (const fileName of ["build.gradle.kts", "build.gradle"]) {
    const candidate = join(directory, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function parseManifestPackage(content: string | undefined): string | undefined {
  return /<manifest\b[^>]*\bpackage\s*=\s*["']([^"']+)["']/u.exec(content ?? "")?.[1]?.trim();
}

function parseApplicationId(content: string | undefined): string | undefined {
  return /\bapplicationId\s*(?:=\s*)?["']([^"']+)["']/u.exec(content ?? "")?.[1]?.trim();
}

function configuredApplicationId(value: string | undefined): string | undefined {
  const applicationId = value?.trim();
  return applicationId !== undefined && androidApplicationIdPattern.test(applicationId)
    ? applicationId
    : undefined;
}

function parseConfiguredApplicationId(content: string | undefined): string | undefined {
  const source = content ?? "";
  const patterns = [
    /\bAPPLICATION_ID\b\s*=\s*["']([^"']+)["']/u,
    /\b(?:extra|ext)\s*\[\s*["']APPLICATION_ID["']\s*\]\s*=\s*["']([^"']+)["']/u,
    /\b(?:set|put)\s*\(\s*["']APPLICATION_ID["']\s*,\s*["']([^"']+)["']\s*\)/u,
  ];
  for (const pattern of patterns) {
    const applicationId = configuredApplicationId(pattern.exec(source)?.[1]);
    if (applicationId !== undefined) {
      return applicationId;
    }
  }
  return undefined;
}

function gradleBlockContents(source: string, blockName: string): string | undefined {
  const blockStart = new RegExp(`\\b${blockName}\\s*\\{`, "u").exec(source);
  if (blockStart?.index === undefined) {
    return undefined;
  }
  const openingBrace = source.indexOf("{", blockStart.index);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(openingBrace + 1, index);
      }
    }
  }
  return undefined;
}

function applicationIdExpression(defaultConfig: string | undefined): string | undefined {
  return /\bapplicationId\s*(?:=\s*)?([^\r\n;}]+)/u.exec(defaultConfig ?? "")?.[1]?.trim();
}

function usesConfiguredApplicationId(buildContent: string | undefined): boolean {
  const source = buildContent ?? "";
  const expression = applicationIdExpression(gradleBlockContents(source, "defaultConfig"));
  if (expression === undefined) {
    return false;
  }
  if (/\bAPPLICATION_ID\b/u.test(expression)) {
    return true;
  }

  const variableName = /^([A-Za-z_][A-Za-z0-9_]*)\b/u.exec(expression)?.[1];
  return (
    variableName !== undefined &&
    new RegExp(
      `\\b(?:val|var|def)\\s+${variableName}\\s*=\\s*[^\\r\\n]*\\bAPPLICATION_ID\\b`,
      "u",
    ).test(source)
  );
}

async function resolveConfiguredApplicationId(
  rootPath: string,
  modulePath: string,
  buildContent: string | undefined,
): Promise<string | undefined> {
  const literalApplicationId = parseApplicationId(buildContent);
  if (literalApplicationId !== undefined || !usesConfiguredApplicationId(buildContent)) {
    return literalApplicationId;
  }

  for (const directory of new Set([modulePath, rootPath])) {
    for (const fileName of appConfigurationFileNames) {
      const applicationId = parseConfiguredApplicationId(await readableText(join(directory, fileName)));
      if (applicationId !== undefined) {
        return applicationId;
      }
    }
  }
  return undefined;
}

function hasApplicationConfiguration(rootPath: string): boolean {
  return appConfigurationFileNames.some((fileName) => existsSync(join(rootPath, fileName)));
}

function needsApplicationIdRefresh(project: AndroidProject): boolean {
  return (
    hasApplicationConfiguration(project.rootPath) &&
    project.modules.some(
      (module) =>
        (module.moduleType === undefined || module.moduleType === "application") &&
        module.applicationId === undefined,
    )
  );
}

function scanAddsApplicationId(project: AndroidProject, modules: AndroidProjectModule[]): boolean {
  const existingModules = new Map(project.modules.map((module) => [module.path, module]));
  return modules.some((module) => {
    const existing = existingModules.get(module.path);
    return (
      module.moduleType === "application" &&
      module.applicationId !== undefined &&
      existing?.applicationId !== module.applicationId
    );
  });
}

function namedGradleEntries(block: string | undefined): string[] {
  if (block === undefined) {
    return [];
  }
  const configurationMethods = new Set([
    "all",
    "configure",
    "configureEach",
    "each",
    "forEach",
    "matching",
    "whenObjectAdded",
    "whenObjectRemoved",
    "withType",
  ]);
  const entries = new Set<string>();
  for (const match of block.matchAll(/(?:^|[}\n;])\s*([A-Za-z][A-Za-z0-9_-]*)\s*\{/gmu)) {
    const name = match[1];
    if (name !== undefined && !configurationMethods.has(name)) {
      entries.add(name);
    }
  }
  for (const match of block.matchAll(
    /\b(?:create|maybeCreate|register|getByName|named)\s*\(\s*["']([A-Za-z][A-Za-z0-9_-]*)["']\s*\)/gu,
  )) {
    const name = match[1];
    if (name !== undefined) {
      entries.add(name);
    }
  }
  return [...entries];
}

function parseVariants(content: string | undefined): string[] {
  const source = content ?? "";
  const variants = new Set<string>();
  for (const name of namedGradleEntries(gradleBlockContents(source, "buildTypes"))) {
    variants.add(name);
  }
  for (const name of namedGradleEntries(gradleBlockContents(source, "productFlavors"))) {
    variants.add(name);
  }
  return [...variants].sort((left, right) => left.localeCompare(right, "en"));
}

function moduleVariants(content: string | undefined): string[] {
  const variants = parseVariants(content);
  if (variants.length > 0) {
    return variants;
  }
  // Some compact Groovy build scripts omit a buildTypes block and rely on AGP defaults.
  if (/\b(?:debug|release)\s*\{/u.test(content ?? "")) {
    for (const name of ["debug", "release"]) {
      if (new RegExp(`\\b${name}\\s*\\{`, "u").test(content ?? "")) {
        variants.push(name);
      }
    }
  }
  return [...variants].sort((left, right) => left.localeCompare(right, "en"));
}

function moduleType(content: string | undefined): "application" | "library" | "unknown" {
  const source = content ?? "";
  if (/\b(?:com\.android\.application|android\.application)\b/u.test(source)) {
    return "application";
  }
  if (/\b(?:com\.android\.library|android\.library)\b/u.test(source)) {
    return "library";
  }
  return "unknown";
}

async function discoverModuleDirectories(rootPath: string): Promise<string[]> {
  const modules: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (modules.length >= MAX_PROJECT_MODULES || depth > MAX_PROJECT_DEPTH) {
      return;
    }
    if ((await findBuildFile(directory)) !== undefined) {
      modules.push(directory);
    }
    if (depth === MAX_PROJECT_DEPTH) {
      return;
    }

    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) {
        continue;
      }
      await visit(join(directory, entry.name), depth + 1);
      if (modules.length >= MAX_PROJECT_MODULES) {
        return;
      }
    }
  };

  await visit(rootPath, 0);
  return modules;
}

export async function scanAndroidProject(rootPath: string): Promise<{
  gradleWrapper: boolean;
  modules: AndroidProjectModule[];
}> {
  const rootBuildFile = await findBuildFile(rootPath);
  const settingsFile = ["settings.gradle.kts", "settings.gradle"]
    .map((fileName) => join(rootPath, fileName))
    .find((candidate) => existsSync(candidate));
  if (rootBuildFile === undefined && settingsFile === undefined) {
    throw new ProjectError("所选目录不是 Gradle Android 项目。", 422);
  }

  const discoveredDirectories = await discoverModuleDirectories(rootPath);
  const rootManifestPath = join(rootPath, "src", "main", "AndroidManifest.xml");
  const moduleDirectories = discoveredDirectories.filter(
    (directory) =>
      directory !== rootPath || existsSync(rootManifestPath) || discoveredDirectories.length === 1,
  );
  if (moduleDirectories.length === 0) {
    throw new ProjectError("未在项目中发现 Gradle 模块。", 422);
  }

  const modules = await Promise.all(
    moduleDirectories.map(async (directory): Promise<AndroidProjectModule> => {
      const buildFile = await findBuildFile(directory);
      if (buildFile === undefined) {
        throw new ProjectError("项目模块的 Gradle 配置已丢失。", 422);
      }
      const modulePath = relativeProjectPath(rootPath, directory);
      const manifestPath = join(directory, "src", "main", "AndroidManifest.xml");
      const [buildContent, manifestContent] = await Promise.all([
        readableText(buildFile),
        readableText(manifestPath),
      ]);
      const packageName = parseManifestPackage(manifestContent);
      const applicationId = await resolveConfiguredApplicationId(rootPath, directory, buildContent);

      return {
        name: modulePath === "." ? "根项目" : (modulePath.split("/").at(-1) ?? modulePath),
        path: modulePath,
        buildFile: relativeProjectPath(rootPath, buildFile),
        moduleType: moduleType(buildContent),
        ...(manifestContent === undefined
          ? {}
          : { manifestPath: relativeProjectPath(rootPath, manifestPath) }),
        ...(packageName === undefined ? {} : { packageName }),
        ...(applicationId === undefined ? {} : { applicationId }),
        variants: moduleVariants(buildContent),
      };
    }),
  );

  return {
    gradleWrapper:
      existsSync(join(rootPath, "gradlew")) || existsSync(join(rootPath, "gradlew.bat")),
    modules: modules.sort((left, right) => left.path.localeCompare(right.path, "en")),
  };
}

function normalizeGitRemote(value: string): string {
  let remote: URL;
  try {
    remote = new URL(value);
  } catch {
    throw new ProjectError("Git 仓库地址无效。", 400);
  }
  if (remote.protocol !== "https:" || remote.username.length > 0 || remote.password.length > 0) {
    throw new ProjectError("仅支持不含凭据的 HTTPS Git 仓库地址。", 400);
  }
  return value;
}

function cloneDirectoryName(remoteUrl: string): string {
  const sourceName = repositoryName(remoteUrl);
  const safeName = sourceName.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 80) || "project";
  return `${safeName}-${randomUUID()}`;
}

function repositoryName(remoteUrl: string): string {
  try {
    const pathname = new URL(remoteUrl).pathname;
    const lastSegment = pathname.split("/").filter(Boolean).at(-1);
    const name = decodeURIComponent(lastSegment ?? "").replace(/\.git$/iu, "").trim();
    return name || "未命名项目";
  } catch {
    return "未命名项目";
  }
}

export class LocalProjectService implements ProjectService {
  readonly #paths: AgentPaths;
  readonly #store: ProjectStore;
  readonly #gitExecutable: string;
  readonly #runner: ProjectCommandRunner;
  readonly #retryDelay: (milliseconds: number) => Promise<void>;

  public constructor(options: LocalProjectServiceOptions) {
    this.#paths = options.paths;
    this.#store = options.store;
    this.#gitExecutable = options.gitExecutable ?? process.env.GIT_PATH ?? "git";
    this.#runner = options.runner ?? createDefaultRunner();
    this.#retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  public async list(): Promise<AndroidProject[]> {
    const projects: AndroidProject[] = [];
    for (const storedProject of this.#store.list()) {
      let project = storedProject;
      if (project.source !== "git" || project.remoteUrl === undefined) {
        project = await this.#refreshMissingApplicationIds(project);
      } else {
        const name = repositoryName(project.remoteUrl);
        if (project.name !== name) {
          this.#store.updateName(project.id, name);
          project = { ...project, name };
        }
        project = await this.#refreshMissingApplicationIds(project);
      }
      projects.push(project);
    }
    return projects;
  }

  public async add(request: CreateProjectRequest): Promise<AndroidProject> {
    if (request.source === "local") {
      const rootPath = await this.#resolveLocalRoot(request.rootPath);
      return await this.#recordProject(rootPath, "local");
    }

    const remoteUrl = normalizeGitRemote(request.remoteUrl);
    await mkdir(this.#paths.repositories, { recursive: true });
    const checkoutPath = join(this.#paths.repositories, cloneDirectoryName(remoteUrl));
    try {
      await this.#cloneRemote(remoteUrl, checkoutPath);
      return await this.#recordProject(await realpath(checkoutPath), "git", remoteUrl);
    } catch (error) {
      await rm(checkoutPath, { force: true, recursive: true });
      if (error instanceof ProjectError) {
        throw error;
      }
      if (isTransientGitTransportError(error)) {
        throw new ProjectError(
          `克隆 Git 仓库时网络连接中断，已自动重试 ${GIT_CLONE_MAX_ATTEMPTS} 次仍未完成。请检查网络或代理后重试。`,
          502,
        );
      }
      throw new ProjectError(`克隆 Git 仓库失败：${toErrorMessage(error)}`, 502);
    }
  }

  public async remove(id: string): Promise<void> {
    if (this.#store.findById(id) === undefined) {
      throw new ProjectError("未找到要删除的项目。", 404);
    }

    // Removing a project only unregisters it from DeviceRobot. Source files stay untouched.
    this.#store.delete(id);
  }

  public async reindex(id: string): Promise<AndroidProject> {
    const project = this.#store.findById(id);
    if (project === undefined) {
      throw new ProjectError("未找到要重新索引的项目。", 404);
    }
    if (!existsSync(project.rootPath)) {
      throw new ProjectError("项目目录已不存在或无法访问。", 422);
    }

    const scan = await scanAndroidProject(project.rootPath);
    const sourceIndex = await indexAndroidProjectSource(project.rootPath, scan.modules);
    const indexedProject = androidProjectSchema.parse({
      ...project,
      ...scan,
      sourceIndex,
      updatedAt: new Date().toISOString(),
    });
    this.#store.updateSourceIndex(indexedProject);
    return indexedProject;
  }

  async #resolveLocalRoot(value: string): Promise<string> {
    const requestedPath = value.trim();
    if (!isAbsolute(requestedPath)) {
      throw new ProjectError("本地项目目录必须是绝对路径。", 400);
    }
    try {
      const metadata = await stat(requestedPath);
      if (!metadata.isDirectory()) {
        throw new ProjectError("本地项目目录不存在或不是文件夹。", 422);
      }
      return await realpath(requestedPath);
    } catch (error) {
      if (error instanceof ProjectError) {
        throw error;
      }
      throw new ProjectError("本地项目目录不存在或无法访问。", 422);
    }
  }

  async #cloneRemote(remoteUrl: string, checkoutPath: string): Promise<void> {
    let fullCloneError: unknown;
    for (let attempt = 1; attempt <= GIT_CLONE_MAX_ATTEMPTS; attempt += 1) {
      await rm(checkoutPath, { force: true, recursive: true });
      try {
        await this.#runner.run(
          this.#gitExecutable,
          [
            ...gitHttpConfiguration,
            "clone",
            "--depth",
            "1",
            "--no-tags",
            remoteUrl,
            checkoutPath,
          ],
          5 * 60_000,
        );
        return;
      } catch (error) {
        fullCloneError = error;
        if (!isTransientGitTransportError(error)) {
          throw error;
        }
        if (attempt < GIT_CLONE_MAX_ATTEMPTS) {
          await this.#retryDelay(GIT_CLONE_RETRY_DELAY_MS * attempt);
        }
      }
    }

    if (!isTransientGitTransportError(fullCloneError)) {
      throw fullCloneError;
    }
    await this.#cloneRemoteWithFilteredObjects(remoteUrl, checkoutPath);
  }

  async #cloneRemoteWithFilteredObjects(remoteUrl: string, checkoutPath: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= GIT_CLONE_MAX_ATTEMPTS; attempt += 1) {
      await rm(checkoutPath, { force: true, recursive: true });
      try {
        await this.#runner.run(
          this.#gitExecutable,
          [
            ...gitHttpConfiguration,
            "clone",
            "--depth",
            "1",
            "--no-tags",
            "--filter=blob:none",
            "--no-checkout",
            remoteUrl,
            checkoutPath,
          ],
          5 * 60_000,
        );
        await this.#runner.run(
          this.#gitExecutable,
          ["-C", checkoutPath, "sparse-checkout", "init", "--no-cone"],
          30_000,
        );
        await this.#runner.run(
          this.#gitExecutable,
          [
            "-C",
            checkoutPath,
            "sparse-checkout",
            "set",
            "--no-cone",
            ...gitFallbackSparsePatterns,
          ],
          30_000,
        );
        await this.#runner.run(
          this.#gitExecutable,
          [
            "-C",
            checkoutPath,
            ...gitHttpConfiguration,
            "fetch",
            "--refetch",
            `--filter=blob:limit=${GIT_PARTIAL_CLONE_BLOB_LIMIT}`,
            "origin",
            "HEAD",
          ],
          5 * 60_000,
        );
        await this.#runner.run(
          this.#gitExecutable,
          ["-C", checkoutPath, "checkout", "--force", "HEAD"],
          5 * 60_000,
        );
        return;
      } catch (error) {
        lastError = error;
        if (!isTransientGitTransportError(error) || attempt === GIT_CLONE_MAX_ATTEMPTS) {
          throw error;
        }
        await this.#retryDelay(GIT_CLONE_RETRY_DELAY_MS * attempt);
      }
    }
    throw lastError;
  }

  async #recordProject(
    rootPath: string,
    source: "local" | "git",
    remoteUrl?: string,
  ): Promise<AndroidProject> {
    if (this.#store.findByRootPath(rootPath) !== undefined) {
      throw new ProjectError("该项目目录已经接入。", 409);
    }

    const scan = await scanAndroidProject(rootPath);
    const [revision, sourceIndex] = await Promise.all([
      this.#readGitRevision(rootPath),
      indexAndroidProjectSource(rootPath, scan.modules),
    ]);
    const now = new Date().toISOString();
    const project = androidProjectSchema.parse({
      id: randomUUID(),
      name: source === "git" && remoteUrl !== undefined ? repositoryName(remoteUrl) : basename(rootPath) || "未命名项目",
      source,
      rootPath,
      ...(remoteUrl === undefined ? {} : { remoteUrl }),
      ...(revision === undefined ? {} : { revision }),
      ...scan,
      sourceIndex,
      createdAt: now,
      updatedAt: now,
    });
    this.#store.create(project);
    return project;
  }

  async #refreshMissingApplicationIds(project: AndroidProject): Promise<AndroidProject> {
    if (!needsApplicationIdRefresh(project) || !existsSync(project.rootPath)) {
      return project;
    }
    try {
      const scan = await scanAndroidProject(project.rootPath);
      if (!scanAddsApplicationId(project, scan.modules)) {
        return project;
      }
      const refreshedProject = androidProjectSchema.parse({
        ...project,
        ...scan,
        updatedAt: new Date().toISOString(),
      });
      this.#store.updateSourceIndex(refreshedProject);
      return refreshedProject;
    } catch {
      return project;
    }
  }

  async #readGitRevision(rootPath: string): Promise<string | undefined> {
    try {
      const result = await this.#runner.run(
        this.#gitExecutable,
        ["-C", rootPath, "rev-parse", "HEAD"],
        10_000,
      );
      const revision = result.stdout.trim();
      return revision.length === 0 ? undefined : revision;
    } catch {
      return undefined;
    }
  }
}
