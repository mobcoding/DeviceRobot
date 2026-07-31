import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectManagerPanel } from "../src/components/ProjectManagerPanel";

vi.mock("../src/agent-availability", () => ({
  useAgentUnavailable: () => false,
}));

const project = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  name: "Cached project",
  source: "local",
  rootPath: "C:\\Github\\CachedProject",
  gradleWrapper: true,
  modules: [
    {
      name: "app",
      path: "app",
      buildFile: "app/build.gradle.kts",
      manifestPath: "app/src/main/AndroidManifest.xml",
      packageName: "com.example.app",
      variants: ["debug"],
    },
  ],
  createdAt: "2026-07-20T10:00:00.000Z",
  updatedAt: "2026-07-20T10:00:00.000Z",
};

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPanel(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectManagerPanel device={undefined} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("project build cache", () => {
  it("keeps completed build metadata cached when the project workspace remounts", async () => {
    let targetRequests = 0;
    let runRequests = 0;
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/v1/projects") {
        return response({ projects: [project] });
      }
      if (url === `/api/v1/projects/${project.id}/builds/targets`) {
        targetRequests += 1;
        return response({
          projectId: project.id,
          gradleWrapper: true,
          androidSdk: { available: true, path: "D:\\Android\\Sdk", source: "environment" },
          targets: [
            {
              modulePath: "app",
              moduleName: "app",
              variant: "debug",
              taskName: ":app:assembleDebug",
            },
          ],
        });
      }
      if (url === `/api/v1/projects/${project.id}/builds`) {
        runRequests += 1;
        return response({ projectId: project.id, runs: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const firstView = renderPanel(queryClient);
    await screen.findByRole("combobox", { name: "app 构建变体" });
    await waitFor(() => {
      expect(targetRequests).toBe(1);
      expect(runRequests).toBe(1);
    });

    firstView.unmount();
    renderPanel(queryClient);
    await screen.findByRole("combobox", { name: "app 构建变体" });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(targetRequests).toBe(1);
    expect(runRequests).toBe(1);
  });
});
