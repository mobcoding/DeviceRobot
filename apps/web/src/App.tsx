import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { fetchDevices } from "./api/devices";
import { fetchHealth } from "./api/health";
import { DeviceControlPanel } from "./components/DeviceControlPanel";

const viewIds = ["overview", "projects", "devices", "conversations", "runs", "reports"] as const;
type ViewId = (typeof viewIds)[number];

type NavigationItem = {
  id: ViewId;
  label: string;
  icon: string;
  status?: "规划中";
};

const navigationItems: readonly NavigationItem[] = [
  { id: "overview", label: "概览", icon: "OV" },
  { id: "projects", label: "项目", icon: "PR", status: "规划中" },
  { id: "devices", label: "设备", icon: "DV" },
  { id: "conversations", label: "AI 对话", icon: "AI", status: "规划中" },
  { id: "runs", label: "测试运行", icon: "TR", status: "规划中" },
  { id: "reports", label: "报告", icon: "RP", status: "规划中" },
];

const roadmap = [
  { label: "工作区基础能力", status: "已就绪" },
  { label: "ADB 设备发现", status: "已就绪" },
  { label: "屏幕控制", status: "已就绪" },
  { label: "Appium 执行", status: "规划中" },
  { label: "源码感知 AI 测试", status: "规划中" },
] as const;

const plannedViews: Record<Exclude<ViewId, "overview" | "devices">, PlannedViewContent> = {
  projects: {
    eyebrow: "代码仓库分析",
    title: "项目",
    description: "此设备尚未配置 Android 项目。",
    milestone: "源码分析",
    capabilities: ["本地与 Git 仓库", "Gradle 构建变体", "XML View 与 Compose 索引"],
  },
  conversations: {
    eyebrow: "Agent 工作区",
    title: "AI 对话",
    description: "此工作区尚无 AI 对话。",
    milestone: "AI 测试",
    capabilities: ["源码感知规划", "结构化操作", "审批与信任策略"],
  },
  runs: {
    eyebrow: "确定性执行",
    title: "测试运行",
    description: "尚未启动任何测试运行。",
    milestone: "执行引擎",
    capabilities: ["Appium 工作进程", "有限次数的定位器修复", "设备矩阵与分片"],
  },
  reports: {
    eyebrow: "本地证据",
    title: "报告",
    description: "尚未生成任何报告。",
    milestone: "报告系统",
    capabilities: ["离线 HTML", "截图与 UI 树", "ADB 与 Appium 审计"],
  },
};

type PlannedViewContent = {
  eyebrow: string;
  title: string;
  description: string;
  milestone: string;
  capabilities: readonly string[];
};

function isViewId(value: string): value is ViewId {
  return viewIds.some((viewId) => viewId === value);
}

function readViewFromHash(): ViewId {
  const value = globalThis.location.hash.replace(/^#/, "");
  return isViewId(value) ? value : "overview";
}

function formatStartedAt(value: string | undefined): string {
  if (value === undefined) {
    return "暂无数据";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function PlannedView({ content }: { content: PlannedViewContent }): React.JSX.Element {
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">{content.eyebrow}</p>
          <h1>{content.title}</h1>
          <p className="subtitle">{content.description}</p>
        </div>
        <span className="connection-badge planned">规划中</span>
      </header>

      <section className="planned-layout" aria-label={`${content.title} 状态`}>
        <article className="panel empty-state">
          <span className="empty-state-mark" aria-hidden="true">
            {content.title.slice(0, 2).toUpperCase()}
          </span>
          <p className="eyebrow">当前状态</p>
          <h2>{content.description}</h2>
          <p>工作区基础能力已就绪。此区域将在“{content.milestone}”阶段启用。</p>
        </article>

        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">计划范围</p>
              <h2>{content.milestone}</h2>
            </div>
          </div>
          <ul className="capability-list">
            {content.capabilities.map((capability) => (
              <li key={capability}>{capability}</li>
            ))}
          </ul>
        </article>
      </section>
    </>
  );
}

function deviceStateLabel(state: string): string {
  switch (state) {
    case "device":
      return "可用";
    case "emulator":
      return "模拟器";
    case "unauthorized":
      return "需要授权";
    case "offline":
      return "离线";
    default:
      return "未知";
  }
}

function deviceConnectionLabel(connection: string): string {
  switch (connection) {
    case "usb":
      return "USB 连接";
    case "tcp":
      return "TCP 连接";
    case "emulator":
      return "模拟器连接";
    default:
      return "未知连接";
  }
}

function DevicesView({ deviceQuery }: { deviceQuery: DevicesQuery }): React.JSX.Element {
  const response = deviceQuery.data;
  const readyDevices =
    response?.devices.filter(
      (device) => device.state === "device" || device.state === "emulator",
    ) ?? [];
  const [selectedSerial, setSelectedSerial] = useState<string>();
  const selectedDevice = readyDevices.find((device) => device.serial === selectedSerial);

  useEffect(() => {
    if (selectedDevice === undefined && readyDevices[0] !== undefined) {
      setSelectedSerial(readyDevices[0].serial);
    }
  }, [readyDevices, selectedDevice]);

  const statusText = deviceQuery.isPending
    ? "扫描中"
    : deviceQuery.isError || response?.adb.available === false
      ? "ADB 不可用"
      : `${readyDevices.length} 台可用`;

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">本地设备</p>
          <h1>设备</h1>
          <p className="subtitle">本机 ADB 服务可见的 Android 设备。</p>
        </div>
        <div className="header-actions">
          <span
            className={`connection-badge ${deviceQuery.isError || response?.adb.available === false ? "error" : ""}`}
          >
            {statusText}
          </span>
          <button
            className="refresh-button"
            type="button"
            disabled={deviceQuery.isFetching}
            onClick={() => void deviceQuery.refetch()}
          >
            {deviceQuery.isFetching ? "刷新中" : "刷新"}
          </button>
        </div>
      </header>

      {deviceQuery.isError && (
        <section className="notice error-notice" role="alert">
          <strong>设备发现失败。</strong>
          <span>{deviceQuery.error.message}</span>
        </section>
      )}

      {response?.error !== undefined && (
        <section className="notice error-notice" role="alert">
          <strong>{response.adb.available ? "ADB 请求失败。" : "ADB 不可用。"}</strong>
          <span>
            {response.adb.available
              ? "请查看本地 Agent 日志以获取详细信息。"
              : "请检查 ADB 安装、PATH 配置及设备授权状态。"}
          </span>
        </section>
      )}

      <section className="device-summary" aria-label="ADB 环境">
        <article className="metric-card featured">
          <span>ADB 状态</span>
          <strong>{response?.adb.available === true ? "可用" : "--"}</strong>
          <small>{response?.adb.installedPath ?? response?.adb.executable ?? "正在检测 ADB"}</small>
        </article>
        <article className="metric-card">
          <span>ADB 版本</span>
          <strong>{response?.adb.version ?? "--"}</strong>
          <small>本机 platform-tools</small>
        </article>
        <article className="metric-card">
          <span>已发现</span>
          <strong>{response?.devices.length ?? "--"}</strong>
          <small>{readyDevices.length} 台可用于自动化</small>
        </article>
      </section>

      {response !== undefined && response.adb.available && response.devices.length === 0 && (
        <section className="panel device-empty-state">
          <span className="empty-state-mark" aria-hidden="true">
            DV
          </span>
          <p className="eyebrow">未发现设备</p>
          <h2>未检测到 ADB 设备。</h2>
        </section>
      )}

      {response !== undefined && response.devices.length > 0 && (
        <section className="device-grid" aria-label="已发现的 Android 设备">
          {response.devices.map((device) => {
            const isReady = device.state === "device" || device.state === "emulator";
            return (
              <article className="device-card" key={device.serial}>
                <div className="device-card-heading">
                  <div>
                    <p className="eyebrow">{deviceConnectionLabel(device.connection)}</p>
                    <h2>{device.model ?? device.deviceName ?? device.serial}</h2>
                    <code>{device.serial}</code>
                  </div>
                  <span className={isReady ? "device-state ready" : "device-state warning"}>
                    {deviceStateLabel(device.state)}
                  </span>
                </div>

                {device.state === "unauthorized" && (
                  <p className="device-diagnostic">请解锁设备并允许 USB 调试授权。</p>
                )}
                {device.state === "offline" && (
                  <p className="device-diagnostic">当前 ADB 传输连接处于离线状态。</p>
                )}
                {device.detailsError !== undefined && (
                  <p className="device-diagnostic">无法读取设备详细信息。</p>
                )}

                <dl className="device-meta">
                  <div>
                    <dt>厂商</dt>
                    <dd>{device.manufacturer ?? "未上报"}</dd>
                  </div>
                  <div>
                    <dt>Android 版本</dt>
                    <dd>{device.androidVersion ?? "未上报"}</dd>
                  </div>
                  <div>
                    <dt>API 级别</dt>
                    <dd>{device.apiLevel ?? "未上报"}</dd>
                  </div>
                  <div>
                    <dt>产品代号</dt>
                    <dd>{device.product ?? "未上报"}</dd>
                  </div>
                  <div>
                    <dt>传输通道</dt>
                    <dd>{device.transportId ?? device.path ?? device.connection}</dd>
                  </div>
                </dl>

                {isReady && (
                  <button
                    className="device-control-button"
                    type="button"
                    aria-pressed={device.serial === selectedSerial}
                    onClick={() => setSelectedSerial(device.serial)}
                  >
                    {device.serial === selectedSerial ? "控制已激活" : "打开控制台"}
                  </button>
                )}
              </article>
            );
          })}
        </section>
      )}

      <DeviceControlPanel device={selectedDevice} />
    </>
  );
}

function Overview({ agentStatus, healthQuery, deviceQuery }: OverviewProps): React.JSX.Element {
  const readyDeviceCount =
    deviceQuery.data?.devices.filter(
      (device) => device.state === "device" || device.state === "emulator",
    ).length ?? 0;
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">工作区概览</p>
          <h1>本地 Android 自动化，随时扩展。</h1>
          <p className="subtitle">
            DeviceRobot 将源码分析、设备控制、执行证据和报告保留在这台电脑上。
          </p>
        </div>
        <span className={`connection-badge ${healthQuery.isError ? "error" : ""}`}>
          {agentStatus}
        </span>
      </header>

      <section className="metrics" aria-label="Agent 状态">
        <article className="metric-card featured">
          <span>Agent 状态</span>
          <strong>{agentStatus}</strong>
          <small>每 10 秒检查一次</small>
        </article>
        <article className="metric-card">
          <span>Agent 版本</span>
          <strong>{healthQuery.data?.version ?? "--"}</strong>
          <small>已安装运行时</small>
        </article>
        <article className="metric-card">
          <span>设备</span>
          <strong>{deviceQuery.data?.devices.length ?? "--"}</strong>
          <small>
            {deviceQuery.isError ? "设备发现不可用" : `${readyDeviceCount} 台可用于自动化`}
          </small>
        </article>
        <article className="metric-card">
          <span>测试运行</span>
          <strong>--</strong>
          <small>执行引擎尚在规划中</small>
        </article>
      </section>

      <section className="detail-grid">
        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">运行时详情</p>
              <h2>本地 Agent</h2>
            </div>
            <span className="panel-chip">仅 localhost</span>
          </div>
          <dl className="detail-list">
            <div>
              <dt>启动时间</dt>
              <dd>{formatStartedAt(healthQuery.data?.startedAt)}</dd>
            </div>
            <div>
              <dt>数据目录</dt>
              <dd className="path-value">{healthQuery.data?.dataDirectory ?? "暂无数据"}</dd>
            </div>
            <div>
              <dt>API 地址</dt>
              <dd>127.0.0.1:43110</dd>
            </div>
          </dl>
        </article>

        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">交付路线图</p>
              <h2>实施状态</h2>
            </div>
          </div>
          <ol className="roadmap">
            {roadmap.map((item, index) => (
              <li key={item.label}>
                <span className="roadmap-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="roadmap-label">{item.label}</span>
                <span
                  className={item.status === "已就绪" ? "roadmap-status ready" : "roadmap-status"}
                >
                  {item.status}
                </span>
              </li>
            ))}
          </ol>
        </article>
      </section>
    </>
  );
}

type HealthQuery = ReturnType<typeof useHealthQuery>;
type DevicesQuery = ReturnType<typeof useDevicesQuery>;
type OverviewProps = {
  agentStatus: string;
  healthQuery: HealthQuery;
  deviceQuery: DevicesQuery;
};

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

  useEffect(() => {
    const handleHashChange = (): void => setActiveView(readViewFromHash());
    globalThis.addEventListener("hashchange", handleHashChange);
    return () => globalThis.removeEventListener("hashchange", handleHashChange);
  }, []);

  const agentStatus = healthQuery.isPending
    ? "正在检查"
    : healthQuery.isError
      ? "不可用"
      : healthQuery.data.status === "ok"
        ? "已连接"
        : "降级";

  const navigate = (viewId: ViewId): void => {
    setActiveView(viewId);
    globalThis.location.hash = viewId;
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            DR
          </span>
          <div>
            <strong>DeviceRobot</strong>
            <span>本地 AI 测试</span>
          </div>
        </div>

        <nav aria-label="主导航">
          {navigationItems.map((item) => {
            const isActive = item.id === activeView;
            return (
              <button
                aria-current={isActive ? "page" : undefined}
                className={isActive ? "nav-item active" : "nav-item"}
                type="button"
                key={item.id}
                onClick={() => navigate(item.id)}
              >
                <span className="nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span>{item.label}</span>
                {item.status !== undefined && <small>{item.status}</small>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <span className={`status-dot ${healthQuery.isError ? "error" : ""}`} />
          Agent {agentStatus}
        </div>
      </aside>

      <main className="content">
        {healthQuery.isError && (
          <section className="notice error-notice" role="alert">
            <strong>本地 Agent 不可用。</strong>
            <span>{healthQuery.error.message}</span>
          </section>
        )}

        {activeView === "overview" ? (
          <Overview agentStatus={agentStatus} healthQuery={healthQuery} deviceQuery={deviceQuery} />
        ) : activeView === "devices" ? (
          <DevicesView deviceQuery={deviceQuery} />
        ) : (
          <PlannedView content={plannedViews[activeView]} />
        )}
      </main>
    </div>
  );
}
