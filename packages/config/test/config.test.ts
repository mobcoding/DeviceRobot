import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureAgentDirectories, resolveAgentPaths } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("agent paths", () => {
  it("resolves and creates the expected runtime directories", () => {
    const base = mkdtempSync(join(tmpdir(), "device-robot-config-"));
    temporaryDirectories.push(base);
    const paths = resolveAgentPaths(base);

    ensureAgentDirectories(paths);

    expect(paths.root).toBe(join(base, "AIMobileTester"));
    expect(paths.database).toBe(join(paths.root, "device-robot.sqlite"));
  });
});
