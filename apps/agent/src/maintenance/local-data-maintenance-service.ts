import { existsSync, type Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentPaths } from "@device-robot/config";
import {
  cleanupLocalDataResponseSchema,
  localDataUsageResponseSchema,
  type CleanupLocalDataRequest,
  type CleanupLocalDataResponse,
  type LocalDataCategory,
  type LocalDataUsage,
  type LocalDataUsageResponse,
} from "@device-robot/contracts";

type CleanupSummary = {
  deletedFileCount: number;
  reclaimedBytes: number;
};

const retentionRoots = (paths: AgentPaths): Record<LocalDataCategory, string> => ({
  buildLogs: join(paths.logs, "builds"),
  reports: paths.reports,
  artifacts: paths.artifacts,
  downloads: paths.downloads,
});

const excludedDirectories = [
  "Android SDK、Gradle 缓存、Appium 运行时、项目 Git 检出目录和本地受管调试签名不会自动清理。",
];

async function usageFor(category: LocalDataCategory, root: string): Promise<LocalDataUsage> {
  let fileCount = 0;
  let sizeBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        try {
          const metadata = await stat(path);
          fileCount += 1;
          sizeBytes += metadata.size;
        } catch {
          // A concurrently removed file does not invalidate the maintenance summary.
        }
      }
    }
  };
  await visit(root);
  return { category, fileCount, sizeBytes };
}

async function cleanRoot(root: string, cutoff: number): Promise<CleanupSummary> {
  const summary: CleanupSummary = { deletedFileCount: 0, reclaimedBytes: 0 };
  const visit = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        try {
          await rm(path, { recursive: false });
        } catch {
          // Keep non-empty or concurrently changed directories.
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      try {
        const metadata = await stat(path);
        if (metadata.mtimeMs >= cutoff) {
          continue;
        }
        await rm(path, { force: true });
        summary.deletedFileCount += 1;
        summary.reclaimedBytes += metadata.size;
      } catch {
        // A file may be actively written or have disappeared; leave it for a later explicit cleanup.
      }
    }
  };
  await visit(root);
  return summary;
}

export interface LocalDataMaintenanceService {
  usage(): Promise<LocalDataUsageResponse>;
  cleanup(request: CleanupLocalDataRequest): Promise<CleanupLocalDataResponse>;
}

export class FilesystemLocalDataMaintenanceService implements LocalDataMaintenanceService {
  readonly #paths: AgentPaths;

  public constructor(paths: AgentPaths) {
    this.#paths = paths;
  }

  public async usage(): Promise<LocalDataUsageResponse> {
    const roots = retentionRoots(this.#paths);
    return localDataUsageResponseSchema.parse({
      usage: await Promise.all(
        (Object.entries(roots) as Array<[LocalDataCategory, string]>).map(
          async ([category, root]) => await usageFor(category, root),
        ),
      ),
      excluded: excludedDirectories,
    });
  }

  public async cleanup(request: CleanupLocalDataRequest): Promise<CleanupLocalDataResponse> {
    const roots = retentionRoots(this.#paths);
    const cutoff = Date.now() - request.olderThanDays * 24 * 60 * 60 * 1_000;
    const summaries = await Promise.all(
      request.categories.map(async (category) => {
        const root = roots[category];
        return existsSync(root) ? await cleanRoot(root, cutoff) : { deletedFileCount: 0, reclaimedBytes: 0 };
      }),
    );
    return cleanupLocalDataResponseSchema.parse({
      deletedFileCount: summaries.reduce((total, summary) => total + summary.deletedFileCount, 0),
      reclaimedBytes: summaries.reduce((total, summary) => total + summary.reclaimedBytes, 0),
    });
  }
}
