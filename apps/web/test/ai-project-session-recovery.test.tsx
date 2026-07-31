import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AiPlanPanel } from "../src/components/AiPlanPanel";

vi.mock("../src/agent-availability", () => ({
  useAgentUnavailable: () => false,
}));

vi.mock("../src/components/TestSuitePanel", () => ({
  TestSuitePanel: () => null,
}));

const firstProject = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  name: "Example project",
  source: "local",
  rootPath: "C:\\Github\\Example",
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

const recentProject = {
  ...firstProject,
  id: "223e4567-e89b-12d3-a456-426614174000",
  name: "Recent AI project",
  rootPath: "C:\\Github\\RecentAiProject",
};

const conversations = [firstProject, recentProject].map((project, index) => ({
  id: index === 0 ? "323e4567-e89b-12d3-a456-426614174000" : "423e4567-e89b-12d3-a456-426614174000",
  projectId: project.id,
  appId: "com.example.app",
  title: `${project.name} conversation`,
  sourceRevision: "2026-07-20T10:00:00.000Z",
  contextStatus: "current" as const,
  createdAt: "2026-07-20T10:00:00.000Z",
  updatedAt: "2026-07-20T10:00:00.000Z",
}));

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockApis(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "/api/v1/ai/status") {
      return response({
        configured: true,
        provider: "openai-compatible",
        baseUrl: "https://model.example/v1",
        model: "test-model",
      });
    }
    if (url === "/api/v1/ai/models") {
      return response({ provider: "openai-compatible", models: ["test-model"] });
    }
    if (url === "/api/v1/projects") {
      return response({ projects: [firstProject, recentProject] });
    }
    if (url === "/api/v1/test-runs") {
      return response({ runs: [] });
    }

    const conversationListMatch = url.match(/^\/api\/v1\/projects\/([^/]+)\/ai-conversations$/u);
    if (conversationListMatch !== null) {
      const projectId = conversationListMatch[1]!;
      return response({
        projectId,
        conversations: conversations.filter((conversation) => conversation.projectId === projectId),
      });
    }

    const conversationId = url.match(/^\/api\/v1\/ai-conversations\/([^/]+)$/u)?.[1];
    if (conversationId !== undefined) {
      const conversation = conversations.find((candidate) => candidate.id === conversationId);
      return response({ conversation, messages: [] });
    }

    throw new Error(`Unexpected request: ${url}`);
  });
}

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AiPlanPanel device={undefined} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  globalThis.localStorage.clear();
  mockApis();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AI project session recovery", () => {
  it("restores the most recent project and conversation after the AI workspace remounts", async () => {
    const user = userEvent.setup();
    const view = renderPanel();

    const recentProjectButton = await screen.findByRole("button", { name: /Recent AI project/u });
    await user.click(recentProjectButton);

    await waitFor(() => expect(recentProjectButton).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() =>
      expect(
        globalThis.localStorage.getItem(
          "device-robot:ai:last-conversation:223e4567-e89b-12d3-a456-426614174000",
        ),
      ).toBe("423e4567-e89b-12d3-a456-426614174000"),
    );
    const projectList = screen.getByLabelText("测试项目");
    expect(
      within(projectList).getAllByRole("button", { name: /Example project|Recent AI project/u })[0],
    ).toHaveTextContent("Recent AI project");

    view.unmount();
    renderPanel();

    const restoredProjectButton = await screen.findByRole("button", { name: /Recent AI project/u });
    expect(restoredProjectButton).toHaveAttribute("aria-pressed", "true");
    expect(
      within(screen.getByLabelText("测试项目")).getAllByRole("button", {
        name: /Example project|Recent AI project/u,
      })[0],
    ).toHaveTextContent("Recent AI project");
  });
});
