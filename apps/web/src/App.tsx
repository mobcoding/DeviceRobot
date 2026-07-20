import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { AndroidDevice } from "@device-robot/contracts";

import { fetchDevices } from "./api/devices";
import { fetchHealth } from "./api/health";
import { AppiumRuntimePanel } from "./components/AppiumRuntimePanel";
import { DeviceControlPanel } from "./components/DeviceControlPanel";

const viewIds = ["devices", "projects", "conversations", "runs", "reports"] as const;
type ViewId = (typeof viewIds)[number];
type PlannedViewId = Exclude<ViewId, "devices">;

type PlannedViewContent = {
  eyebrow: string;
  title: string;
  description: string;
  capabilities: readonly string[];
};

const plannedViews: Record<PlannedViewId, PlannedViewContent> = {
  projects: {
    eyebrow: "代码仓库分析",
    title: "项目",
    description: "尚未接入 Android 项目。",
    capabilities: ["本地与 Git 仓库", "Gradle 构建变体", "XML View 与 Compose 索引"],
  },
  conversations: {
    eyebrow: "Agent 工作区",
    title: "AI 与用例",
    description: "尚未创建 AI 对话或测试用例。",
    capabilities: ["源码感知规划", "结构化操作", "审批与信任策略"],
  },
  runs: {
    eyebrow: "确定性执行",
    title: "运行",
    description: "尚未启动测试运行。",
    capabilities: ["Appium 工作进程", "定位器修复", "设备矩阵与分片"],
  },
  reports: {
    eyebrow: "本地证据",
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

function deviceStateLabel(device: AndroidDevice): string {
  switch (device.state) {
    case "device":
      return "可用";
    case "emulator":
      return "模拟器";
    case "unauthorized":
      return "待授权";
    case "offline":
      return "离线";
    default:
      return "未知";
  }
}

function deviceName(device: AndroidDevice): string {
  return device.model ?? device.deviceName ?? device.serial;
}

function PlannedView({ content }: { content: PlannedViewContent }): React.JSX.Element {
  return (
    <section className="planned-workspace" aria-label={`${content.title} 工作区`}>
      <p className="eyebrow">{content.eyebrow}</p>
      <h1>{content.title}</h1>
      <p className="subtitle">{content.description}</p>
      <div className="planned-capabilities">
        {content.capabilities.map((capability) => (
          <span key={capability}>{capability}</span>
        ))}
      </div>
    </section>
  );
}

type DeviceSidebarProps = {
  devices: readonly AndroidDevice[];
  selectedSerial: string | undefined;
  isFetching: boolean;
  moreOpen: boolean;
  onRefresh(): void;
  onSelectDevice(serial: string): void;
  onToggleMore(): void;
  onNavigate(viewId: PlannedViewId): void;
};

function DeviceSidebar({
  devices,
  selectedSerial,
  isFetching,
  moreOpen,
  onRefresh,
  onSelectDevice,
  onToggleMore,
  onNavigate,
}: DeviceSidebarProps): React.JSX.Element {
  return (
    <aside className="device-sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          DR
        </span>
        <div>
          <strong>DeviceRobot</strong>
          <span>本地 AI 测试</span>
        </div>
      </div>

      <section className="device-picker" aria-label="我的设备">
        <div className="device-picker-heading">
          <p>我的设备</p>
          <button type="button" className="text-button" onClick={onRefresh} disabled={isFetching}>
            {isFetching ? "刷新中" : "刷新"}
          </button>
        </div>
        {devices.length === 0 ? (
          <p className="sidebar-empty">未发现设备</p>
        ) : (
          <div className="device-picker-list">
            {devices.map((device) => {
              const ready = isReadyDevice(device);
              const selected = device.serial === selectedSerial;
              return (
                <button
                  key={device.serial}
                  type="button"
                  className={selected ? "device-picker-item selected" : "device-picker-item"}
                  disabled={!ready}
                  aria-pressed={selected}
                  onClick={() => onSelectDevice(device.serial)}
                >
                  <span className={ready ? "device-picker-state ready" : "device-picker-state"} />
                  <span className="device-picker-name">{deviceName(device)}</span>
                  <small>{deviceStateLabel(device)}</small>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <div className="sidebar-bottom">
        <button
          type="button"
          className={moreOpen ? "more-button active" : "more-button"}
          aria-expanded={moreOpen}
          onClick={onToggleMore}
        >
          更多工作区
        </button>
        {moreOpen && (
          <div className="more-menu">
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
    </aside>
  );
}

type WorkspaceHeaderProps = {
  agentStatus: string;
  adbAvailable: boolean | undefined;
  readyDeviceCount: number;
  selectedDevice: AndroidDevice | undefined;
};

function WorkspaceHeader({
  agentStatus,
  adbAvailable,
  readyDeviceCount,
  selectedDevice,
}: WorkspaceHeaderProps): React.JSX.Element {
  return (
    <header className="workspace-header">
      <div>
        <p className="eyebrow">设备工作台</p>
        <h1>{selectedDevice === undefined ? "连接 Android 设备" : deviceName(selectedDevice)}</h1>
      </div>
      <div className="workspace-statuses" aria-label="本地运行状态">
        <span className={agentStatus === "已连接" ? "status-chip healthy" : "status-chip warning"}>
          Agent {agentStatus}
        </span>
        <span className={adbAvailable ? "status-chip healthy" : "status-chip warning"}>
          ADB {adbAvailable ? `${readyDeviceCount} 台设备` : "不可用"}
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
  const devices = deviceQuery.data?.devices ?? [];
  const readyDevices = devices.filter(isReadyDevice);
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
    if (viewId !== "devices") {
      setMoreOpen(false);
    }
  };

  const selectDevice = (serial: string): void => {
    setSelectedSerial(serial);
    navigate("devices");
  };

  return (
    <div className="app-shell">
      <DeviceSidebar
        devices={devices}
        selectedSerial={selectedSerial}
        isFetching={deviceQuery.isFetching}
        moreOpen={moreOpen}
        onRefresh={() => void deviceQuery.refetch()}
        onSelectDevice={selectDevice}
        onToggleMore={() => setMoreOpen((open) => !open)}
        onNavigate={navigate}
      />

      <main className="workspace-content">
        {healthQuery.isError && (
          <section className="notice error-notice" role="alert">
            <strong>本地 Agent 不可用。</strong>
            <span>{healthQuery.error.message}</span>
          </section>
        )}

        {activeView === "devices" ? (
          <>
            <WorkspaceHeader
              agentStatus={agentStatus}
              adbAvailable={deviceQuery.data?.adb.available}
              readyDeviceCount={readyDevices.length}
              selectedDevice={selectedDevice}
            />
            {deviceQuery.isError && (
              <section className="notice error-notice" role="alert">
                <strong>设备发现失败。</strong>
                <span>{deviceQuery.error.message}</span>
              </section>
            )}
            {deviceQuery.data?.error !== undefined && (
              <section className="notice error-notice" role="alert">
                <strong>
                  {deviceQuery.data.adb.available ? "ADB 请求失败。" : "ADB 不可用。"}
                </strong>
                <span>{deviceQuery.data.error}</span>
              </section>
            )}
            {selectedDevice === undefined ? (
              <section className="device-workspace-empty" aria-label="设备连接状态">
                <p className="eyebrow">设备连接</p>
                <h2>{deviceQuery.isPending ? "正在扫描设备" : "未检测到可用设备"}</h2>
                <p>连接设备并完成 USB 调试授权后，它会出现在左侧列表中。</p>
              </section>
            ) : (
              <DeviceControlPanel device={selectedDevice} />
            )}
          </>
        ) : (
          <PlannedView content={plannedViews[activeView]} />
        )}
      </main>
    </div>
  );
}
