import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  androidSourceIndexSchema,
  type AndroidProjectModule,
  type AndroidSourceEvidence,
  type AndroidSourceEvidenceKind,
  type AndroidSourceIndex,
  type AndroidSourceIndexModule,
} from "@device-robot/contracts";

const MAX_INDEX_DEPTH = 14;
const MAX_INDEXED_FILES = 2_500;
const MAX_EVIDENCE_ITEMS = 2_000;
const MAX_SOURCE_FILE_SIZE_BYTES = 2 * 1_024 * 1_024;
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
const nonViewXmlTags = new Set(["data", "import", "layout", "merge", "requestFocus", "variable"]);

type IndexableFileKind = "layout" | "navigation" | "source";

type MutableModuleSummary = AndroidSourceIndexModule;

function relativeProjectPath(rootPath: string, path: string): string {
  const value = relative(rootPath, path).split(sep).join("/");
  return value.length === 0 ? "." : value;
}

function getIndexableFileKind(filePath: string): IndexableFileKind | undefined {
  const normalized = filePath.replaceAll("\\", "/");
  if (/\bsrc\/.*\/res\/layout(?:-[^/]+)?\/.*\.xml$/iu.test(normalized)) {
    return "layout";
  }
  if (/\bsrc\/.*\/res\/navigation(?:-[^/]+)?\/.*\.xml$/iu.test(normalized)) {
    return "navigation";
  }
  if (/\bsrc\/.*\.(?:kt|java)$/iu.test(normalized)) {
    return "source";
  }
  return undefined;
}

function getLineNumber(content: string, position: number): number {
  let line = 1;
  for (let index = 0; index < position; index += 1) {
    if (content.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

function attributeValue(attributes: string, name: string): string | undefined {
  const expression = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "u");
  return expression.exec(attributes)?.[1]?.trim();
}

function displayXmlTag(tag: string): string {
  return tag.startsWith("androidx.") || tag.startsWith("android.")
    ? (tag.split(".").at(-1) ?? tag)
    : tag;
}

function isViewTag(tag: string): boolean {
  return !nonViewXmlTags.has(tag);
}

async function readableText(path: string): Promise<string | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > MAX_SOURCE_FILE_SIZE_BYTES) {
      return undefined;
    }
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function discoverIndexableFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_INDEX_DEPTH || files.length >= MAX_INDEXED_FILES) {
      return;
    }

    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      if (files.length >= MAX_INDEXED_FILES) {
        return;
      }

      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) {
          await visit(path, depth + 1);
        }
        continue;
      }

      if (
        entry.isFile() &&
        getIndexableFileKind(relativeProjectPath(rootPath, path)) !== undefined
      ) {
        files.push(path);
      }
    }
  };

  await visit(rootPath, 0);
  return files;
}

function findModulePath(
  rootPath: string,
  filePath: string,
  modules: readonly AndroidProjectModule[],
): string {
  const normalizedFilePath = relativeProjectPath(rootPath, filePath);
  const matchingModule = [...modules]
    .sort((left, right) => right.path.length - left.path.length)
    .find(
      (module) =>
        module.path === "." ||
        normalizedFilePath === module.path ||
        normalizedFilePath.startsWith(`${module.path}/`),
    );
  return matchingModule?.path ?? ".";
}

function initialModuleSummaries(
  modules: readonly AndroidProjectModule[],
): Map<string, MutableModuleSummary> {
  const summaries = new Map(
    modules.map((module) => [
      module.path,
      {
        path: module.path,
        sourceFileCount: 0,
        xmlViewCount: 0,
        composeScreenCount: 0,
        navigationDestinationCount: 0,
        typeCount: 0,
      },
    ]),
  );
  if (!summaries.has(".")) {
    summaries.set(".", {
      path: ".",
      sourceFileCount: 0,
      xmlViewCount: 0,
      composeScreenCount: 0,
      navigationDestinationCount: 0,
      typeCount: 0,
    });
  }
  return summaries;
}

function incrementEvidenceCount(
  summary: MutableModuleSummary,
  kind: AndroidSourceEvidenceKind,
): void {
  switch (kind) {
    case "xml-view":
      summary.xmlViewCount += 1;
      return;
    case "compose-screen":
      summary.composeScreenCount += 1;
      return;
    case "navigation-destination":
      summary.navigationDestinationCount += 1;
      return;
    case "kotlin-type":
    case "java-type":
      summary.typeCount += 1;
  }
}

function scanLayoutXml(
  content: string,
  lineFor: (position: number) => number,
  addEvidence: (kind: AndroidSourceEvidenceKind, name: string, line: number) => void,
): void {
  const expression = /<([A-Za-z_][A-Za-z0-9_.$-]*)(?:\s|\/?>)/gu;
  for (const match of content.matchAll(expression)) {
    const tag = match[1];
    if (tag !== undefined && isViewTag(tag)) {
      addEvidence("xml-view", displayXmlTag(tag), lineFor(match.index ?? 0));
    }
  }
}

function scanNavigationXml(
  content: string,
  lineFor: (position: number) => number,
  addEvidence: (kind: AndroidSourceEvidenceKind, name: string, line: number) => void,
): void {
  const expression = /<(fragment|activity)\b([^>]*)>/gu;
  for (const match of content.matchAll(expression)) {
    const tag = match[1];
    const attributes = match[2];
    if (tag === undefined || attributes === undefined) {
      continue;
    }
    const name =
      attributeValue(attributes, "android:name") ??
      attributeValue(attributes, "android:id") ??
      attributeValue(attributes, "app:route") ??
      tag;
    addEvidence("navigation-destination", name, lineFor(match.index ?? 0));
  }
}

function scanKotlin(
  content: string,
  lineFor: (position: number) => number,
  addEvidence: (kind: AndroidSourceEvidenceKind, name: string, line: number) => void,
): void {
  const composableExpression =
    /@(?:[A-Za-z_][A-Za-z0-9_.]*\.)?Composable\b[\s\S]{0,360}?\bfun\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>{}]*>)?\s*\(/gu;
  for (const match of content.matchAll(composableExpression)) {
    const name = match[1];
    if (name !== undefined) {
      addEvidence("compose-screen", name, lineFor(match.index ?? 0));
    }
  }

  const routeExpression = /\bcomposable\s*\(\s*(?:route\s*=\s*)?["']([^"']+)["']/gu;
  for (const match of content.matchAll(routeExpression)) {
    const route = match[1];
    if (route !== undefined) {
      addEvidence("navigation-destination", route, lineFor(match.index ?? 0));
    }
  }

  const typeExpression =
    /\b(?:data\s+|sealed\s+|abstract\s+|open\s+|inner\s+|enum\s+)?(?:class|interface|object)\s+([A-Za-z_][A-Za-z0-9_]*)/gu;
  for (const match of content.matchAll(typeExpression)) {
    const name = match[1];
    if (name !== undefined) {
      addEvidence("kotlin-type", name, lineFor(match.index ?? 0));
    }
  }
}

function scanJava(
  content: string,
  lineFor: (position: number) => number,
  addEvidence: (kind: AndroidSourceEvidenceKind, name: string, line: number) => void,
): void {
  const typeExpression =
    /\b(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|static\s+)*(?:class|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/gu;
  for (const match of content.matchAll(typeExpression)) {
    const name = match[1];
    if (name !== undefined) {
      addEvidence("java-type", name, lineFor(match.index ?? 0));
    }
  }
}

export async function indexAndroidProjectSource(
  rootPath: string,
  modules: readonly AndroidProjectModule[],
): Promise<AndroidSourceIndex> {
  const files = await discoverIndexableFiles(rootPath);
  const moduleSummaries = initialModuleSummaries(modules);
  const evidence: AndroidSourceEvidence[] = [];
  let kotlinJavaFileCount = 0;
  let filesScanned = 0;

  for (const path of files) {
    const projectPath = relativeProjectPath(rootPath, path);
    const kind = getIndexableFileKind(projectPath);
    const content = kind === undefined ? undefined : await readableText(path);
    if (kind === undefined || content === undefined) {
      continue;
    }

    filesScanned += 1;
    const modulePath = findModulePath(rootPath, path, modules);
    const moduleSummary = moduleSummaries.get(modulePath);
    if (moduleSummary === undefined) {
      continue;
    }
    if (kind === "source") {
      kotlinJavaFileCount += 1;
      moduleSummary.sourceFileCount += 1;
    }

    const addEvidence = (
      evidenceKind: AndroidSourceEvidenceKind,
      name: string,
      line: number,
    ): void => {
      if (evidence.length >= MAX_EVIDENCE_ITEMS) {
        return;
      }
      evidence.push({ kind: evidenceKind, name, filePath: projectPath, line, modulePath });
      incrementEvidenceCount(moduleSummary, evidenceKind);
    };
    const lineFor = (position: number): number => getLineNumber(content, position);

    switch (kind) {
      case "layout":
        scanLayoutXml(content, lineFor, addEvidence);
        break;
      case "navigation":
        scanNavigationXml(content, lineFor, addEvidence);
        break;
      case "source":
        if (projectPath.endsWith(".kt")) {
          scanKotlin(content, lineFor, addEvidence);
        } else {
          scanJava(content, lineFor, addEvidence);
        }
        break;
    }
  }

  const summary = {
    filesScanned,
    kotlinJavaFileCount,
    xmlViewCount: evidence.filter((item) => item.kind === "xml-view").length,
    composeScreenCount: evidence.filter((item) => item.kind === "compose-screen").length,
    navigationDestinationCount: evidence.filter((item) => item.kind === "navigation-destination")
      .length,
    typeCount: evidence.filter((item) => item.kind === "kotlin-type" || item.kind === "java-type")
      .length,
  };

  return androidSourceIndexSchema.parse({
    schemaVersion: 1,
    scannedAt: new Date().toISOString(),
    summary,
    modules: [...moduleSummaries.values()].sort((left, right) =>
      left.path.localeCompare(right.path, "en"),
    ),
    evidence,
  });
}
