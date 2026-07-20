import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderApp(): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
  );
}

describe("DeviceRobot Web UI", () => {
  it("renders the real Agent health response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "ok",
          version: "0.1.0",
          startedAt: "2026-07-20T10:00:00.000Z",
          dataDirectory: "C:\\Users\\tester\\AppData\\Local\\AIMobileTester",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    renderApp();

    expect((await screen.findAllByText("Connected")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("0.1.0")).toBeInTheDocument();
    expect(screen.getByText(/AIMobileTester/)).toBeInTheDocument();
  });

  it("shows an actionable error when the Agent is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Connection refused"));

    renderApp();

    expect(await screen.findByRole("alert", {}, { timeout: 3_000 })).toHaveTextContent(
      "Local Agent is unavailable",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Connection refused");
  });
});
