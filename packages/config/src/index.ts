import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AGENT_HOST = "127.0.0.1";
export const AGENT_PORT = 43_110;
export const PRODUCT_NAME = "AIMobileTester";

export type AgentPaths = {
  root: string;
  database: string;
  logs: string;
  appiumHome: string;
  repositories: string;
  artifacts: string;
  reports: string;
};

export function resolveAgentPaths(localAppData = process.env.LOCALAPPDATA): AgentPaths {
  const baseDirectory = localAppData ?? join(homedir(), "AppData", "Local");
  const root = join(baseDirectory, PRODUCT_NAME);

  return {
    root,
    database: join(root, "device-robot.sqlite"),
    logs: join(root, "logs"),
    appiumHome: join(root, "appium"),
    repositories: join(root, "repositories"),
    artifacts: join(root, "artifacts"),
    reports: join(root, "reports"),
  };
}

export function ensureAgentDirectories(paths: AgentPaths): void {
  for (const directory of [
    paths.root,
    paths.logs,
    paths.appiumHome,
    paths.repositories,
    paths.artifacts,
    paths.reports,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
}
