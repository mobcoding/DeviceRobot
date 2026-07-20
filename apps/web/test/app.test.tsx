import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";

beforeEach(() => {
  globalThis.location.hash = "#devices";
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

const appiumRuntimeResponse = {
  status: "ready",
  checkedAt: "2026-07-20T10:00:00.000Z",
  appium: { available: true, version: "3.5.2" },
  uiautomator2: {
    available: true,
    packageName: "appium-uiautomator2-driver",
    version: "8.1.0",
  },
  java: { available: true, version: "21" },
  androidSdk: { available: true, path: "D:\\Android\\Sdk" },
  server: {
    state: "stopped",
    host: "127.0.0.1",
    port: 4723,
    logFile: "C:\\logs\\appium.log",
  },
  issues: [],
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
      network: { transport: "wifi", connected: true },
      battery: { level: 86, state: "charging" },
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

    if (url.includes("/api/v1/appium/runtime")) {
      return new Response(JSON.stringify(appiumRuntimeResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

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
  it("opens directly into the selected device overview", async () => {
    mockApis();
    renderApp();

    expect(await screen.findByRole("heading", { level: 1, name: "概览" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "设备工作台" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启动" })).toBeInTheDocument();
    expect(screen.getByText("ADB 就绪")).toBeInTheDocument();
    expect(screen.getAllByText("Wi-Fi 已连接")).toHaveLength(2);
    expect(screen.getByText("电量 86% 充电中")).toBeInTheDocument();
  });

  it("shows an actionable error when the Agent is unavailable", async () => {
    mockApis({ healthError: new Error("Connection refused") });
    renderApp();

    expect(await screen.findByRole("alert", {}, { timeout: 3_000 })).toHaveTextContent(
      "本地 Agent 不可用",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("无法连接本地 Agent");
  });

  it("adds a hidden workspace tab from the add-tab menu", async () => {
    mockApis();
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole("heading", { level: 1, name: "概览" });
    expect(screen.getByRole("button", { name: "项目" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI 与用例" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "测试运行" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "添加工作页签" }));
    await user.click(screen.getByRole("button", { name: "测试运行" }));

    expect(screen.getByRole("heading", { level: 1, name: "测试运行" })).toBeInTheDocument();
    expect(globalThis.location.hash).toBe("#runs");
    expect(screen.getByRole("button", { name: "测试运行" })).toBeInTheDocument();
  });

  it("shows a real authorized Android device in the selector", async () => {
    mockApis();
    renderApp();

    const selector = await screen.findByRole("combobox", { name: "当前设备" });
    await vi.waitFor(() => expect(selector).toHaveValue("8B3Y0THX0"));
    expect(within(selector).getByRole("option", { name: "Pixel 3 XL" })).toBeInTheDocument();
    expect(screen.getAllByText("8B3Y0THX0")).toHaveLength(1);
    expect(screen.getByText("USB")).toBeInTheDocument();
  });

  it("manually refreshes the selected device mirror", async () => {
    mockApis();
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole("heading", { level: 1, name: "概览" });
    const screenshot = screen.getByAltText("设备截图：Pixel 3 XL");
    expect(screenshot).toHaveAttribute("src", "/api/v1/devices/8B3Y0THX0/screenshot?revision=0");
    await user.click(screen.getByRole("button", { name: "刷新" }));

    await vi.waitFor(() =>
      expect(screenshot).toHaveAttribute("src", "/api/v1/devices/8B3Y0THX0/screenshot?revision=1"),
    );
  });

  it("shows the selected device mirror and collapsed evidence controls", async () => {
    mockApis();
    renderApp();

    expect(await screen.findByRole("region", { name: "屏幕镜像" })).toBeInTheDocument();
    expect(screen.getByAltText("设备截图：Pixel 3 XL")).toBeInTheDocument();
    expect(screen.getByText("设备控制")).toBeInTheDocument();
    expect(screen.getByText("UI 层级与操作审计")).toBeInTheDocument();
  });

  it("sends a structured back action from the device control accordion", async () => {
    const { getActionRequests } = mockApis();
    const user = userEvent.setup();
    renderApp();

    await screen.findByRole("heading", { level: 1, name: "概览" });
    await user.click(screen.getByText("设备控制"));
    await user.click(screen.getByRole("button", { name: "返回" }));

    await vi.waitFor(() => expect(getActionRequests()).toBe(1));
    expect(await screen.findByText("完成")).toBeInTheDocument();
  });
});
