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
  reindex(id: string): Promise<AndroidProject>;
}

export type LocalProjectServiceOptions = {
  paths: AgentPaths;
  store: ProjectStore;
  gitExecutable?: string;
  runner?: ProjectCommandRunner;
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

function parseVariants(content: string | undefined): string[] {
  const source = content ?? "";
  const variants = new Set<string>();
  if (/\bdebug\s*\{/u.test(source)) {
    variants.add("debug");
  }
  if (/\brelease\s*\{/u.test(source)) {
    variants.add("release");
  }
  const flavorBlock = /\bproductFlavors\s*\{([\s\S]{0,100000})/u.exec(source)?.[1];
  if (flavorBlock !== undefined) {
    for (const match of flavorBlock.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*\{/gmu)) {
      const name = match[1];
      if (name !== undefined && name !== "create") {
        variants.add(name);
      }
    }
  }
  return [...variants].sort((left, right) => left.localeCompare(right, "en"));
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
      const applicationId = parseApplicationId(buildContent);

      return {
        name: modulePath === "." ? "根项目" : (modulePath.split("/").at(-1) ?? modulePath),
        path: modulePath,
        buildFile: relativeProjectPath(rootPath, buildFile),
        ...(manifestContent === undefined
          ? {}
          : { manifestPath: relativeProjectPath(rootPath, manifestPath) }),
        ...(packageName === undefined ? {} : { packageName }),
        ...(applicationId === undefined ? {} : { applicationId }),
        variants: parseVariants(buildContent),
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

  public constructor(options: LocalProjectServiceOptions) {
    this.#paths = options.paths;
    this.#store = options.store;
    this.#gitExecutable = options.gitExecutable ?? process.env.GIT_PATH ?? "git";
    this.#runner = options.runner ?? createDefaultRunner();
  }

  public async list(): Promise<AndroidProject[]> {
    return this.#store.list().map((project) => {
      if (project.source !== "git" || project.remoteUrl === undefined) {
        return project;
      }
      const name = repositoryName(project.remoteUrl);
      if (project.name === name) {
        return project;
      }
      this.#store.updateName(project.id, name);
      return { ...project, name };
    });
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
      await this.#runner.run(
        this.#gitExecutable,
        ["clone", "--depth", "1", remoteUrl, checkoutPath],
        5 * 60_000,
      );
      return await this.#recordProject(await realpath(checkoutPath), "git", remoteUrl);
    } catch (error) {
      await rm(checkoutPath, { force: true, recursive: true });
      if (error instanceof ProjectError) {
        throw error;
      }
      throw new ProjectError(`克隆 Git 仓库失败：${toErrorMessage(error)}`, 502);
    }
  }

  public async reindex(id: string): Promise<AndroidProject> {
    const project = this.#store.findById(id);
    if (project === undefined) {
      throw new ProjectError("未找到要重新索引的项目。", 404);
    }
    if (!existsSync(project.rootPath)) {
      throw new ProjectError("项目目录已不存在或无法访问。", 422);
    }

    const sourceIndex = await indexAndroidProjectSource(project.rootPath, project.modules);
    const indexedProject = androidProjectSchema.parse({
      ...project,
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
