import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
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

function mockApis(testRuns: readonly unknown[] = []): void {
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
      return response({ runs: testRuns });
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

function AiWorkspaceHarness({ visible }: { visible: boolean }): React.JSX.Element | null {
  const [conversationId, setConversationId] = useState("");
  const [projectId, setProjectId] = useState("");

  if (!visible) {
    return null;
  }

  return (
    <AiPlanPanel
      device={undefined}
      initialConversationId={conversationId}
      initialProjectId={projectId}
      onConversationSelectionChange={setConversationId}
      onProjectSelectionChange={setProjectId}
    />
  );
}

function workspaceView(queryClient: QueryClient, visible: boolean): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <AiWorkspaceHarness visible={visible} />
    </QueryClientProvider>
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
  it("limits the right-side test records to the active conversation project", async () => {
    const user = userEvent.setup();
    mockApis([
      {
        id: "523e4567-e89b-12d3-a456-426614174000",
        projectId: firstProject.id,
        planId: "example-plan",
        name: "Example 项目运行",
        deviceSerial: "device-1",
        appId: "com.example.app",
        status: "succeeded",
        steps: [],
        startedAt: "2026-07-20T10:00:00.000Z",
      },
      {
        id: "623e4567-e89b-12d3-a456-426614174000",
        projectId: recentProject.id,
        planId: "recent-plan",
        name: "Recent 项目运行",
        deviceSerial: "device-1",
        appId: "com.example.app",
        status: "failed",
        steps: [],
        startedAt: "2026-07-20T10:01:00.000Z",
      },
    ]);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(workspaceView(queryClient, true));

    expect(await screen.findByText("Example 项目运行")).toBeInTheDocument();
    expect(screen.queryByText("Recent 项目运行")).not.toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: /Recent AI project/u }));

    expect(await screen.findByText("Recent 项目运行")).toBeInTheDocument();
    expect(screen.queryByText("Example 项目运行")).not.toBeInTheDocument();
  });

  it("scrolls to the latest message whenever the AI workspace is shown", async () => {
    const timelinePrototype = HTMLDivElement.prototype;
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
      timelinePrototype,
      "scrollHeight",
    );
    const scrollTopDescriptor = Object.getOwnPropertyDescriptor(timelinePrototype, "scrollTop");
    let timelineScrollTop = -1;
    Object.defineProperty(timelinePrototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("ai-test-timeline") ? 480 : 0;
      },
    });
    Object.defineProperty(timelinePrototype, "scrollTop", {
      configurable: true,
      get() {
        return timelineScrollTop;
      },
      set(value: number) {
        if (this.classList.contains("ai-test-timeline")) {
          timelineScrollTop = value;
        }
      },
    });

    try {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const view = render(workspaceView(queryClient, true));
      await screen.findByLabelText("测试过程");
      await waitFor(() => expect(timelineScrollTop).toBe(480));

      view.rerender(workspaceView(queryClient, false));
      timelineScrollTop = -1;
      view.rerender(workspaceView(queryClient, true));

      await waitFor(() => expect(timelineScrollTop).toBe(480));
    } finally {
      if (scrollHeightDescriptor === undefined) {
        Reflect.deleteProperty(timelinePrototype, "scrollHeight");
      } else {
        Object.defineProperty(timelinePrototype, "scrollHeight", scrollHeightDescriptor);
      }
      if (scrollTopDescriptor === undefined) {
        Reflect.deleteProperty(timelinePrototype, "scrollTop");
      } else {
        Object.defineProperty(timelinePrototype, "scrollTop", scrollTopDescriptor);
      }
    }
  });

  it("restores the most recent project and conversation after the AI workspace remounts", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(workspaceView(queryClient, true));

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

    view.rerender(workspaceView(queryClient, false));
    globalThis.localStorage.clear();
    view.rerender(workspaceView(queryClient, true));

    const restoredProjectButton = await screen.findByRole("button", { name: /Recent AI project/u });
    expect(restoredProjectButton).toHaveAttribute("aria-pressed", "true");
    expect(
      within(screen.getByLabelText("测试项目")).getAllByRole("button", {
        name: /Example project|Recent AI project/u,
      })[0],
    ).toHaveTextContent("Recent AI project");
  });
});
