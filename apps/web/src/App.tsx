import { useQuery } from "@tanstack/react-query";
import {
  AppWindow,
  Bot,
  FileText,
  FolderGit2,
  FolderOpen,
  LayoutDashboard,
  Play,
  Plus,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AndroidDevice } from "@device-robot/contracts";

import { fetchDevices } from "./api/devices";
import { fetchHealth } from "./api/health";
import { AppiumRuntimePanel } from "./components/AppiumRuntimePanel";
import { ApkInstallDialog } from "./components/ApkInstallDialog";
import { ApplicationManagerPanel } from "./components/ApplicationManagerPanel";
import { DeviceControlPanel } from "./components/DeviceControlPanel";
import { DeviceMirrorPanel } from "./components/DeviceMirrorPanel";
import { FileManagerPanel } from "./components/FileManagerPanel";

const viewIds = [
  "devices",
  "files",
  "applications",
  "projects",
  "conversations",
  "runs",
  "reports",
] as const;
const defaultVisibleViews: ViewId[] = ["devices", "files", "applications"];
const GOLDEN_RATIO = 1.618;
const MINIMUM_MIRROR_WIDTH = 280;

type ViewId = (typeof viewIds)[number];
type PlannedViewId = Exclude<ViewId, "devices" | "files" | "applications">;
type WorkspaceTab = { id: ViewId; label: string };

type PlannedViewContent = {
  title: string;
  description: string;
  capabilities: readonly string[];
};

function sidebarWidthBounds(container: HTMLElement | null): { minimum: number; maximum: number } {
  const width = container?.getBoundingClientRect().width ?? 0;

  if (width <= 0) {
    return { minimum: MINIMUM_MIRROR_WIDTH, maximum: MINIMUM_MIRROR_WIDTH };
  }

  const maximum = Math.round(width / (GOLDEN_RATIO + 1));
  return { minimum: Math.min(MINIMUM_MIRROR_WIDTH, maximum), maximum };
}

const workspaceTabs: readonly WorkspaceTab[] = [
  { id: "devices", label: "概览" },
  { id: "files", label: "文件管理器" },
  { id: "applications", label: "应用管理器" },
  { id: "projects", label: "项目" },
  { id: "conversations", label: "AI 与用例" },
  { id: "runs", label: "测试运行" },
  { id: "reports", label: "报告" },
];

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
    title: "测试运行",
    description: "尚未启动测试运行。",
    capabilities: ["Appium 工作进程", "定位器自愈", "设备矩阵与分片"],
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

function networkLabel(device: AndroidDevice | undefined): string {
  const network = device?.network;
  if (network === undefined) {
    return "网络未知";
  }

  if (!network.connected) {
    return "网络未连接";
  }

  switch (network.transport) {
    case "wifi":
      return "Wi-Fi 已连接";
    case "mobile":
      return "移动网络";
    case "ethernet":
      return "以太网";
    default:
      return "网络已连接";
  }
}

function batteryLabel(device: AndroidDevice | undefined): string {
  const battery = device?.battery;
  if (battery === undefined) {
    return "电量未知";
  }

  const suffix =
    battery.state === "charging" ? " 充电中" : battery.state === "full" ? " 已充满" : "";
  return `电量 ${battery.level}%${suffix}`;
}

function WorkspaceIcon({ viewId }: { viewId: ViewId }): React.JSX.Element {
  const iconProps = { "aria-hidden": true, size: 16, strokeWidth: 1.8 };

  switch (viewId) {
    case "devices":
      return <LayoutDashboard {...iconProps} />;
    case "files":
      return <FolderOpen {...iconProps} />;
    case "applications":
      return <AppWindow {...iconProps} />;
    case "projects":
      return <FolderGit2 {...iconProps} />;
    case "conversations":
      return <Bot {...iconProps} />;
    case "runs":
      return <Play {...iconProps} />;
    case "reports":
      return <FileText {...iconProps} />;
  }
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
  selectedDevice: AndroidDevice | undefined;
  visibleViews: readonly ViewId[];
  addMenuOpen: boolean;
  onNavigate(viewId: ViewId): void;
  onAddView(viewId: ViewId): void;
  onSelectDevice(serial: string): void;
  onToggleAddMenu(): void;
};

function ConsoleHeader({
  activeView,
  agentStatus,
  adbAvailable,
  devices,
  selectedDevice,
  visibleViews,
  addMenuOpen,
  onNavigate,
  onAddView,
  onSelectDevice,
  onToggleAddMenu,
}: ConsoleHeaderProps): React.JSX.Element {
  const visibleTabs = workspaceTabs.filter((tab) => visibleViews.includes(tab.id));
  const addableTabs = workspaceTabs.filter((tab) => !visibleViews.includes(tab.id));

  return (
    <header className="console-topbar">
      <label className="device-selector">
        <span>当前设备</span>
        <select
          aria-label="当前设备"
          value={selectedDevice?.serial ?? ""}
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

      <div className="workspace-header">
        <nav className="console-nav" aria-label="设备工作页签">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              aria-current={activeView === tab.id ? "page" : undefined}
              onClick={() => onNavigate(tab.id)}
            >
              <WorkspaceIcon viewId={tab.id} />
              <span>{tab.label}</span>
            </button>
          ))}
          <div className="workspace-add">
            <button
              type="button"
              className="workspace-add-trigger"
              aria-label="添加工作页签"
              title="添加工作页签"
              aria-expanded={addMenuOpen}
              disabled={addableTabs.length === 0}
              onClick={onToggleAddMenu}
            >
              <Plus aria-hidden="true" size={17} strokeWidth={1.8} />
            </button>
            {addMenuOpen && (
              <div className="workspace-add-menu" aria-label="可添加的工作页签">
                {addableTabs.map((tab) => (
                  <button key={tab.id} type="button" onClick={() => onAddView(tab.id)}>
                    <WorkspaceIcon viewId={tab.id} />
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </nav>

        <div className="console-runtime" aria-label="本地运行状态">
          <span className="device-telemetry">{networkLabel(selectedDevice)}</span>
          <span className="device-telemetry">{batteryLabel(selectedDevice)}</span>
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
  const [visibleViews, setVisibleViews] = useState<readonly ViewId[]>(defaultVisibleViews);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [mirrorWidth, setMirrorWidth] = useState<number>();
  const [isResizingLayout, setIsResizingLayout] = useState(false);
  const [apkSelection, setApkSelection] = useState<
    { key: number; file?: File; error?: string } | undefined
  >();
  const layoutRef = useRef<HTMLDivElement>(null);
  const apkInputRef = useRef<HTMLInputElement>(null);
  const resizingRef = useRef(false);
  const mirrorWidthAdjustedRef = useRef(false);
  const readyDevices = (deviceQuery.data?.devices ?? []).filter(isReadyDevice);
  const selectedDevice = readyDevices.find((device) => device.serial === selectedSerial);

  const queueApk = useCallback((file: File): void => {
    const isApk = file.name.toLocaleLowerCase().endsWith(".apk");
    setApkSelection({
      key: Date.now(),
      ...(isApk ? { file } : { error: "仅支持安装 .apk 文件。" }),
    });
  }, []);

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

  useEffect(() => {
    mirrorWidthAdjustedRef.current = false;
    setMirrorWidth(undefined);
  }, [selectedDevice?.serial]);

  useEffect(() => {
    setVisibleViews((current) =>
      current.includes(activeView) ? current : [...current, activeView],
    );
  }, [activeView]);

  useEffect(() => {
    const constrainMirrorWidth = (): void => {
      setMirrorWidth((current) => {
        if (current === undefined) {
          return current;
        }

        const { minimum, maximum } = sidebarWidthBounds(layoutRef.current);
        return Math.min(maximum, Math.max(minimum, current));
      });
    };

    globalThis.addEventListener("resize", constrainMirrorWidth);
    return () => globalThis.removeEventListener("resize", constrainMirrorWidth);
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
    setAddMenuOpen(false);
  };

  const addView = (viewId: ViewId): void => {
    setVisibleViews((current) => (current.includes(viewId) ? current : [...current, viewId]));
    navigate(viewId);
  };

  const selectDevice = (serial: string): void => {
    setSelectedSerial(serial);
    navigate("devices");
  };

  const updateMirrorWidth = useCallback((clientX: number): void => {
    const layout = layoutRef.current;
    if (layout === null) {
      return;
    }

    const bounds = sidebarWidthBounds(layout);
    const width = clientX - layout.getBoundingClientRect().left;
    setMirrorWidth(Math.min(bounds.maximum, Math.max(bounds.minimum, Math.round(width))));
  }, []);

  const usePreferredMirrorWidth = useCallback((width: number): void => {
    if (mirrorWidthAdjustedRef.current) {
      return;
    }

    const { minimum, maximum } = sidebarWidthBounds(layoutRef.current);
    setMirrorWidth(Math.min(maximum, Math.max(minimum, Math.round(width))));
  }, []);

  const finishLayoutResize = useCallback((): void => {
    resizingRef.current = false;
    setIsResizingLayout(false);
  }, []);

  const finishPointerLayoutResize = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    finishLayoutResize();
  };

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent): void => {
      if (resizingRef.current) {
        updateMirrorWidth(event.clientX);
      }
    };
    const handleMouseUp = (): void => {
      if (resizingRef.current) {
        finishLayoutResize();
      }
    };

    globalThis.addEventListener("mousemove", handleMouseMove);
    globalThis.addEventListener("mouseup", handleMouseUp);
    return () => {
      globalThis.removeEventListener("mousemove", handleMouseMove);
      globalThis.removeEventListener("mouseup", handleMouseUp);
    };
  }, [finishLayoutResize, updateMirrorWidth]);

  const adjustMirrorWidthWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const { minimum, maximum } = sidebarWidthBounds(layoutRef.current);
    const current = mirrorWidth ?? maximum;
    let next: number | undefined;

    if (event.key === "ArrowLeft") {
      next = current - 16;
    } else if (event.key === "ArrowRight") {
      next = current + 16;
    } else if (event.key === "Home") {
      next = minimum;
    } else if (event.key === "End") {
      next = maximum;
    }

    if (next !== undefined) {
      event.preventDefault();
      mirrorWidthAdjustedRef.current = true;
      setMirrorWidth(Math.min(maximum, Math.max(minimum, next)));
    }
  };

  const sidebarBounds = sidebarWidthBounds(layoutRef.current);
  const sidebarWidth = mirrorWidth ?? sidebarBounds.maximum;
  const shellStyle =
    mirrorWidth === undefined
      ? undefined
      : ({ "--device-sidebar-width": `${mirrorWidth}px` } as React.CSSProperties);

  return (
    <div className="device-console-shell" style={shellStyle}>
      <input
        ref={apkInputRef}
        className="visually-hidden"
        type="file"
        accept=".apk,application/vnd.android.package-archive"
        aria-label="APK 文件"
        onChange={(event) => {
          const file = event.currentTarget.files?.item(0);
          event.currentTarget.value = "";
          if (file !== null && file !== undefined) {
            queueApk(file);
          }
        }}
      />
      <ConsoleHeader
        activeView={activeView}
        agentStatus={agentStatus}
        adbAvailable={deviceQuery.data?.adb.available}
        devices={readyDevices}
        selectedDevice={selectedDevice}
        visibleViews={visibleViews}
        addMenuOpen={addMenuOpen}
        onNavigate={navigate}
        onAddView={addView}
        onSelectDevice={selectDevice}
        onToggleAddMenu={() => setAddMenuOpen((open) => !open)}
      />

      <div ref={layoutRef} className="device-console-layout">
        <aside className="mirror-sidebar">
          {selectedDevice === undefined ? (
            <section className="mirror-empty" aria-label="设备连接状态">
              <p>屏幕镜像</p>
              <strong>{deviceQuery.isPending ? "正在扫描设备" : "未检测到可用设备"}</strong>
            </section>
          ) : (
            <DeviceMirrorPanel
              device={selectedDevice}
              onPreferredSidebarWidth={usePreferredMirrorWidth}
              onApkDrop={queueApk}
            />
          )}
        </aside>

        <div
          role="separator"
          tabIndex={0}
          className={`layout-divider${isResizingLayout ? " is-resizing" : ""}`}
          aria-label="调整左右区域宽度"
          aria-orientation="vertical"
          aria-valuemin={sidebarBounds.minimum}
          aria-valuemax={sidebarBounds.maximum}
          aria-valuenow={sidebarWidth}
          aria-valuetext="左侧镜像区域宽度，最大值为黄金比例"
          onKeyDown={adjustMirrorWidthWithKeyboard}
          onPointerDown={(event) => {
            if (event.button !== 0) {
              return;
            }

            event.preventDefault();
            mirrorWidthAdjustedRef.current = true;
            resizingRef.current = true;
            event.currentTarget.setPointerCapture?.(event.pointerId);
            setIsResizingLayout(true);
            updateMirrorWidth(event.clientX);
          }}
          onPointerMove={(event) => {
            if (resizingRef.current) {
              updateMirrorWidth(event.clientX);
            }
          }}
          onPointerUp={finishPointerLayoutResize}
          onPointerCancel={finishPointerLayoutResize}
          onMouseDown={(event) => {
            if (resizingRef.current || event.button !== 0) {
              return;
            }

            event.preventDefault();
            mirrorWidthAdjustedRef.current = true;
            resizingRef.current = true;
            setIsResizingLayout(true);
            updateMirrorWidth(event.clientX);
          }}
          onMouseMove={(event) => {
            if (resizingRef.current) {
              updateMirrorWidth(event.clientX);
            }
          }}
          onMouseUp={finishLayoutResize}
          onLostPointerCapture={() => {
            finishLayoutResize();
          }}
        />

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

          {selectedDevice === undefined &&
          (activeView === "devices" || activeView === "files" || activeView === "applications") ? (
            <section className="main-empty-state" aria-label="设备工作台">
              <h1>连接 Android 设备</h1>
              <p>连接设备并完成 USB 调试授权后，即可在这里查看和管理设备内容。</p>
            </section>
          ) : activeView === "devices" && selectedDevice !== undefined ? (
            <DeviceControlPanel device={selectedDevice} />
          ) : activeView === "files" && selectedDevice !== undefined ? (
            <FileManagerPanel device={selectedDevice} />
          ) : activeView === "applications" && selectedDevice !== undefined ? (
            <ApplicationManagerPanel
              device={selectedDevice}
              onRequestApkInstall={() => apkInputRef.current?.click()}
            />
          ) : (
            <PlannedView content={plannedViews[activeView as PlannedViewId]} />
          )}
        </main>
      </div>
      {apkSelection !== undefined && selectedDevice !== undefined && (
        <ApkInstallDialog
          key={apkSelection.key}
          device={selectedDevice}
          {...(apkSelection.file === undefined ? {} : { file: apkSelection.file })}
          {...(apkSelection.error === undefined ? {} : { initialError: apkSelection.error })}
          onClose={() => setApkSelection(undefined)}
        />
      )}
    </div>
  );
}
