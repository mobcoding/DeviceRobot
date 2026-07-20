import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { AndroidDevice } from "@device-robot/contracts";

import { fetchDevices } from "./api/devices";
import { fetchHealth } from "./api/health";
import { AppiumRuntimePanel } from "./components/AppiumRuntimePanel";
import { DeviceControlPanel } from "./components/DeviceControlPanel";
import { DeviceMirrorPanel } from "./components/DeviceMirrorPanel";

const viewIds = ["devices", "projects", "conversations", "runs", "reports"] as const;
type ViewId = (typeof viewIds)[number];
type PlannedViewId = Exclude<ViewId, "devices">;

type PlannedViewContent = {
  title: string;
  description: string;
  capabilities: readonly string[];
};

const plannedViews: Record<PlannedViewId, PlannedViewContent> = {
  projects: {
    title: "项目",
    description: "尚未接入 Android 项目。",
    capabilities: ["本地与 Git 仓库", "Gradle 构建变体", "XML View 与 Compose 索引"],
  },
  conversations: {
    title: "AI 与用例",
    description: "尚未创建 AI 对话或测试用例。",
    capabilities: ["源码感知规划", "结构化操作", "审批与信任策略"],
  },
  runs: {
    title: "运行",
    description: "尚未启动测试运行。",
    capabilities: ["Appium 工作进程", "定位器修复", "设备矩阵与分片"],
  },
  reports: {
    title: "报告",
    description: "尚未生成测试报告。",
    capabilities: ["离线 HTML", "截图与 UI 树", "ADB 与 Appium 审计"],
  },
};

function isViewId(value: string): value is ViewId {
  return viewIds.some((viewId) => viewId === value);
}

function readViewFromHash(): ViewId {
  const value = globalThis.location.hash.replace(/^#/, "");
  return value === "overview" || !isViewId(value) ? "devices" : value;
}

function isReadyDevice(device: AndroidDevice): boolean {
  return device.state === "device" || device.state === "emulator";
}

function deviceName(device: AndroidDevice): string {
  return device.model ?? device.deviceName ?? device.serial;
}

function PlannedView({ content }: { content: PlannedViewContent }): React.JSX.Element {
  return (
    <section className="planned-workspace" aria-label={`${content.title} 工作区`}>
      <p className="eyebrow">规划中</p>
      <h1>{content.title}</h1>
      <p>{content.description}</p>
      <div className="planned-capabilities">
        {content.capabilities.map((capability) => (
          <span key={capability}>{capability}</span>
        ))}
      </div>
    </section>
  );
}

type ConsoleHeaderProps = {
  activeView: ViewId;
  agentStatus: string;
  adbAvailable: boolean | undefined;
  devices: readonly AndroidDevice[];
  selectedSerial: string | undefined;
  moreOpen: boolean;
  onNavigate(viewId: ViewId): void;
  onSelectDevice(serial: string): void;
  onToggleMore(): void;
};

function ConsoleHeader({
  activeView,
  agentStatus,
  adbAvailable,
  devices,
  selectedSerial,
  moreOpen,
  onNavigate,
  onSelectDevice,
  onToggleMore,
}: ConsoleHeaderProps): React.JSX.Element {
  return (
    <header className="console-topbar">
      <div className="console-brand" aria-label="DeviceRobot">
        <span aria-hidden="true">DR</span>
        <strong>DeviceRobot</strong>
      </div>

      <label className="device-selector">
        <span>当前设备</span>
        <select
          aria-label="当前设备"
          value={selectedSerial ?? ""}
          disabled={devices.length === 0}
          onChange={(event) => onSelectDevice(event.target.value)}
        >
          {devices.length === 0 ? (
            <option value="">未发现可用设备</option>
          ) : (
            devices.map((device) => (
              <option key={device.serial} value={device.serial}>
                {deviceName(device)}
              </option>
            ))
          )}
        </select>
      </label>

      <nav className="console-nav" aria-label="设备导航">
        <button
          type="button"
          aria-current={activeView === "devices" ? "page" : undefined}
          onClick={() => onNavigate("devices")}
        >
          概览
        </button>
        <div className="more-workspaces">
          <button
            type="button"
            aria-expanded={moreOpen}
            className={moreOpen ? "more-workspaces-trigger active" : "more-workspaces-trigger"}
            onClick={onToggleMore}
          >
            更多
          </button>
          {moreOpen && (
            <div className="more-workspaces-menu">
              <button type="button" onClick={() => onNavigate("projects")}>
                项目
              </button>
              <button type="button" onClick={() => onNavigate("conversations")}>
                AI 与用例
              </button>
              <button type="button" onClick={() => onNavigate("runs")}>
                运行
              </button>
              <button type="button" onClick={() => onNavigate("reports")}>
                报告
              </button>
            </div>
          )}
        </div>
      </nav>

      <div className="console-runtime" aria-label="本地运行状态">
        <span
          className={agentStatus === "已连接" ? "runtime-indicator healthy" : "runtime-indicator"}
        >
          Agent {agentStatus}
        </span>
        <span className={adbAvailable ? "runtime-indicator healthy" : "runtime-indicator"}>
          ADB {adbAvailable ? "就绪" : "不可用"}
        </span>
        <AppiumRuntimePanel variant="compact" />
      </div>
    </header>
  );
}

function useHealthQuery() {
  return useQuery({
    queryKey: ["agent-health"],
    queryFn: ({ signal }) => fetchHealth(signal),
    retry: 1,
    refetchInterval: 10_000,
  });
}

function useDevicesQuery() {
  return useQuery({
    queryKey: ["devices"],
    queryFn: ({ signal }) => fetchDevices(signal),
    retry: 1,
    refetchInterval: 3_000,
  });
}

export function App(): React.JSX.Element {
  const healthQuery = useHealthQuery();
  const deviceQuery = useDevicesQuery();
  const [activeView, setActiveView] = useState<ViewId>(readViewFromHash);
  const [selectedSerial, setSelectedSerial] = useState<string>();
  const [moreOpen, setMoreOpen] = useState(false);
  const readyDevices = (deviceQuery.data?.devices ?? []).filter(isReadyDevice);
  const selectedDevice = readyDevices.find((device) => device.serial === selectedSerial);

  useEffect(() => {
    if (selectedDevice === undefined && readyDevices[0] !== undefined) {
      setSelectedSerial(readyDevices[0].serial);
    }
  }, [readyDevices, selectedDevice]);

  useEffect(() => {
    const handleHashChange = (): void => setActiveView(readViewFromHash());
    globalThis.addEventListener("hashchange", handleHashChange);
    return () => globalThis.removeEventListener("hashchange", handleHashChange);
  }, []);

  const agentStatus = healthQuery.isPending
    ? "检查中"
    : healthQuery.isError
      ? "不可用"
      : healthQuery.data.status === "ok"
        ? "已连接"
        : "降级";

  const navigate = (viewId: ViewId): void => {
    setActiveView(viewId);
    globalThis.location.hash = viewId;
    setMoreOpen(false);
  };

  const selectDevice = (serial: string): void => {
    setSelectedSerial(serial);
    navigate("devices");
  };

  return (
    <div className="device-console-shell">
      <ConsoleHeader
        activeView={activeView}
        agentStatus={agentStatus}
        adbAvailable={deviceQuery.data?.adb.available}
        devices={readyDevices}
        selectedSerial={selectedSerial}
        moreOpen={moreOpen}
        onNavigate={navigate}
        onSelectDevice={selectDevice}
        onToggleMore={() => setMoreOpen((open) => !open)}
      />

      <div className="device-console-layout">
        <aside className="mirror-sidebar">
          {selectedDevice === undefined ? (
            <section className="mirror-empty" aria-label="设备连接状态">
              <p>屏幕镜像</p>
              <strong>{deviceQuery.isPending ? "正在扫描设备" : "未检测到可用设备"}</strong>
            </section>
          ) : (
            <DeviceMirrorPanel device={selectedDevice} />
          )}
        </aside>

        <main className="console-main">
          {healthQuery.isError && (
            <section className="notice" role="alert">
              <strong>本地 Agent 不可用。</strong>
              <span>{healthQuery.error.message}</span>
            </section>
          )}
          {deviceQuery.isError && (
            <section className="notice" role="alert">
              <strong>设备发现失败。</strong>
              <span>{deviceQuery.error.message}</span>
            </section>
          )}
          {deviceQuery.data?.error !== undefined && (
            <section className="notice" role="alert">
              <strong>{deviceQuery.data.adb.available ? "ADB 请求失败。" : "ADB 不可用。"}</strong>
              <span>{deviceQuery.data.error}</span>
            </section>
          )}

          {activeView === "devices" ? (
            selectedDevice === undefined ? (
              <section className="main-empty-state" aria-label="设备工作台">
                <h1>连接 Android 设备</h1>
                <p>连接设备并完成 USB 调试授权后，即可在这里查看概览和执行受控操作。</p>
              </section>
            ) : (
              <DeviceControlPanel device={selectedDevice} />
            )
          ) : (
            <PlannedView content={plannedViews[activeView]} />
          )}
        </main>
      </div>
    </div>
  );
}
