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

const healthResponse = {
  status: "ok",
  version: "0.1.0",
  startedAt: "2026-07-20T10:00:00.000Z",
  dataDirectory: "C:\\Users\\tester\\AppData\\Local\\AIMobileTester",
};

const devicesResponse = {
  adb: {
    available: true,
    executable: "adb",
    version: "37.0.0-14910828",
    installedPath: "D:\\Android\\Sdk\\platform-tools\\adb.exe",
  },
  devices: [
    {
      serial: "8B3Y0THX0",
      state: "device",
      connection: "usb",
      product: "crosshatch",
      model: "Pixel 3 XL",
      manufacturer: "Google",
      androidVersion: "12",
      apiLevel: 31,
      transportId: "1",
    },
  ],
  refreshedAt: "2026-07-20T10:00:00.000Z",
};

function mockApis(options: { healthError?: Error } = {}): { getDeviceRequests: () => number } {
  let deviceRequests = 0;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.includes("/api/v1/devices")) {
      deviceRequests += 1;
      return new Response(JSON.stringify(devicesResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (options.healthError !== undefined) {
      throw options.healthError;
    }

    return new Response(JSON.stringify(healthResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });

  return { getDeviceRequests: () => deviceRequests };
}

describe("DeviceRobot Web UI", () => {
  it("renders the real Agent health response", async () => {
    mockApis();

    renderApp();

    expect((await screen.findAllByText("Connected")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("0.1.0")).toBeInTheDocument();
    expect(screen.getByText(/AIMobileTester/)).toBeInTheDocument();
  });

  it("shows an actionable error when the Agent is unavailable", async () => {
    mockApis({ healthError: new Error("Connection refused") });

    renderApp();

    expect(await screen.findByRole("alert", {}, { timeout: 3_000 })).toHaveTextContent(
      "Local Agent is unavailable",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Connection refused");
  });

  it("navigates to every workspace section", async () => {
    mockApis();
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

  it("shows a real authorized Android device", async () => {
    mockApis();
    globalThis.location.hash = "#devices";
    renderApp();

    expect(
      await screen.findByRole("heading", { level: 2, name: "Pixel 3 XL" }),
    ).toBeInTheDocument();
    expect(screen.getByText("8B3Y0THX0")).toBeInTheDocument();
    expect(screen.getByText("37.0.0-14910828")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("manually refreshes the device list", async () => {
    const { getDeviceRequests } = mockApis();
    const user = userEvent.setup();
    globalThis.location.hash = "#devices";
    renderApp();

    await screen.findByRole("heading", { level: 2, name: "Pixel 3 XL" });
    const initialRequests = getDeviceRequests();
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await vi.waitFor(() => expect(getDeviceRequests()).toBeGreaterThan(initialRequests));
  });
});
