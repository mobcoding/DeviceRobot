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

const uiTreeResponse = {
  serial: "8B3Y0THX0",
  xml: '<?xml version="1.0"?><hierarchy rotation="0" />',
  capturedAt: "2026-07-20T10:00:00.000Z",
};

function mockApis(options: { healthError?: Error } = {}): {
  getDeviceRequests: () => number;
  getActionRequests: () => number;
} {
  let deviceRequests = 0;
  let actionRequests = 0;
  const actionHistory = {
    serial: "8B3Y0THX0",
    actions: [] as Array<{
      id: string;
      serial: string;
      action: { action: "ui.back" };
      success: true;
      startedAt: string;
      finishedAt: string;
    }>,
  };

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");

    if (url.includes("/api/v1/devices")) {
      deviceRequests += 1;

      if (url.includes("/ui-tree")) {
        return new Response(JSON.stringify(uiTreeResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.includes("/actions")) {
        if (method === "POST") {
          actionRequests += 1;
          const recordedAction = {
            id: "123e4567-e89b-12d3-a456-426614174000",
            serial: "8B3Y0THX0",
            action: { action: "ui.back" as const },
            success: true as const,
            startedAt: "2026-07-20T10:00:00.000Z",
            finishedAt: "2026-07-20T10:00:01.000Z",
          };
          actionHistory.actions = [recordedAction, ...actionHistory.actions];
          return new Response(JSON.stringify(recordedAction), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify(actionHistory), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

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

  return { getDeviceRequests: () => deviceRequests, getActionRequests: () => actionRequests };
}

describe("DeviceRobot Web UI", () => {
  it("renders the real Agent health response", async () => {
    mockApis();

    renderApp();

    expect((await screen.findAllByText("已连接")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("0.1.0")).toBeInTheDocument();
    expect(screen.getByText(/AIMobileTester/)).toBeInTheDocument();
  });

  it("shows an actionable error when the Agent is unavailable", async () => {
    mockApis({ healthError: new Error("Connection refused") });

    renderApp();

    expect(await screen.findByRole("alert", {}, { timeout: 3_000 })).toHaveTextContent(
      "本地 Agent 不可用",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("无法连接本地 Agent");
  });

  it("navigates to every workspace section", async () => {
    mockApis();
    const user = userEvent.setup();
    renderApp();

    const destinations = [
      ["项目", "projects", "项目"],
      ["设备", "devices", "设备"],
      ["AI 对话", "conversations", "AI 对话"],
      ["测试运行", "runs", "测试运行"],
      ["报告", "reports", "报告"],
      ["概览", "overview", "本地 Android 自动化，随时扩展。"],
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
    expect(screen.getAllByText("8B3Y0THX0")).toHaveLength(2);
    expect(screen.getByText("37.0.0-14910828")).toBeInTheDocument();
    expect(screen.getAllByText("可用")).toHaveLength(2);
  });

  it("manually refreshes the device list", async () => {
    const { getDeviceRequests } = mockApis();
    const user = userEvent.setup();
    globalThis.location.hash = "#devices";
    renderApp();

    await screen.findByRole("heading", { level: 2, name: "Pixel 3 XL" });
    const initialRequests = getDeviceRequests();
    await user.click(screen.getByRole("button", { name: "刷新" }));

    await vi.waitFor(() => expect(getDeviceRequests()).toBeGreaterThan(initialRequests));
  });

  it("shows the selected device screenshot and UI hierarchy", async () => {
    mockApis();
    globalThis.location.hash = "#devices";
    renderApp();

    expect(await screen.findByRole("region", { name: "设备控制台" })).toBeInTheDocument();
    expect(screen.getByAltText("设备截图：Pixel 3 XL")).toBeInTheDocument();
    expect(await screen.findByText(/hierarchy rotation/)).toBeInTheDocument();
  });

  it("sends a structured back action from the control console", async () => {
    const { getActionRequests } = mockApis();
    const user = userEvent.setup();
    globalThis.location.hash = "#devices";
    renderApp();

    await screen.findByRole("region", { name: "设备控制台" });
    await user.click(screen.getByRole("button", { name: "返回" }));

    await vi.waitFor(() => expect(getActionRequests()).toBe(1));
    expect(await screen.findByText("已完成")).toBeInTheDocument();
  });
});
