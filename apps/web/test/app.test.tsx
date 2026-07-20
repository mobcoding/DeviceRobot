import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";

beforeEach(() => {
  globalThis.location.hash = "#overview";
});

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

  it("navigates to every workspace section", async () => {
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
    const user = userEvent.setup();
    renderApp();

    const destinations = [
      ["Projects", "projects", "Projects"],
      ["Devices", "devices", "Devices"],
      ["AI conversations", "conversations", "AI conversations"],
      ["Test runs", "runs", "Test runs"],
      ["Reports", "reports", "Reports"],
      ["Overview", "overview", "Local Android automation, ready to grow."],
    ] as const;

    for (const [label, hash, heading] of destinations) {
      await user.click(screen.getByRole("button", { name: new RegExp(label, "i") }));
      expect(screen.getByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: new RegExp(label, "i") })).toHaveAttribute(
        "aria-current",
        "page",
      );
      expect(globalThis.location.hash).toBe(`#${hash}`);
    }
  });
});
