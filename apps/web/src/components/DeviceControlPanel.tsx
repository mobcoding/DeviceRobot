import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { AndroidDevice, DeviceControlAction } from "@device-robot/contracts";

import {
  executeDeviceAction,
  fetchDeviceActionHistory,
  fetchDeviceUiTree,
} from "../api/device-control";
import { AppiumRuntimePanel } from "./AppiumRuntimePanel";

type DeviceControlPanelProps = {
  device: AndroidDevice;
};

function formatAction(action: DeviceControlAction): string {
  switch (action.action) {
    case "ui.tap":
      return `点击 ${action.x}, ${action.y}`;
    case "ui.longPress":
      return `长按 ${action.x}, ${action.y}`;
    case "ui.input":
      return "输入文本";
    case "ui.swipe":
      return `滑动 ${action.startX}, ${action.startY} 到 ${action.endX}, ${action.endY}`;
    case "ui.back":
      return "返回";
    case "app.launch":
      return `启动 ${action.appId}`;
    case "app.stop":
      return `停止 ${action.appId}`;
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function deviceName(device: AndroidDevice): string {
  return device.model ?? device.deviceName ?? device.serial;
}

function connectionLabel(connection: AndroidDevice["connection"]): string {
  switch (connection) {
    case "usb":
      return "USB";
    case "tcp":
      return "TCP";
    default:
      return "模拟器";
  }
}

export function DeviceControlPanel({ device }: DeviceControlPanelProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const serial = device.serial;
  const [tapX, setTapX] = useState("");
  const [tapY, setTapY] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [startX, setStartX] = useState("");
  const [startY, setStartY] = useState("");
  const [endX, setEndX] = useState("");
  const [endY, setEndY] = useState("");
  const [appId, setAppId] = useState("");
  const [validationError, setValidationError] = useState<string>();

  useEffect(() => {
    setValidationError(undefined);
  }, [serial]);

  const uiTreeQuery = useQuery({
    queryKey: ["device-ui-tree", serial],
    queryFn: ({ signal }) => fetchDeviceUiTree(serial, signal),
    retry: false,
  });
  const actionHistoryQuery = useQuery({
    queryKey: ["device-action-history", serial],
    queryFn: ({ signal }) => fetchDeviceActionHistory(serial, signal),
    retry: false,
  });
  const actionMutation = useMutation({
    mutationFn: async (action: DeviceControlAction) => await executeDeviceAction(serial, action),
    onSuccess: async () => {
      setValidationError(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["device-action-history", serial] }),
        queryClient.invalidateQueries({ queryKey: ["device-ui-tree", serial] }),
      ]);
    },
  });

  const submitAction = (action: DeviceControlAction): void => {
    setValidationError(undefined);
    actionMutation.mutate(action);
  };

  const submitTap = (longPress: boolean): void => {
    const x = Number(tapX);
    const y = Number(tapY);
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
      setValidationError("点击坐标必须为非负整数。");
      return;
    }

    submitAction(longPress ? { action: "ui.longPress", x, y } : { action: "ui.tap", x, y });
  };

  const submitSwipe = (): void => {
    const values = [startX, startY, endX, endY].map((value) => Number(value));
    if (values.some((value) => !Number.isInteger(value) || value < 0)) {
      setValidationError("滑动坐标必须为非负整数。");
      return;
    }

    const [swipeStartX, swipeStartY, swipeEndX, swipeEndY] = values as [
      number,
      number,
      number,
      number,
    ];
    submitAction({
      action: "ui.swipe",
      startX: swipeStartX,
      startY: swipeStartY,
      endX: swipeEndX,
      endY: swipeEndY,
    });
  };

  const submitAppAction = (action: "app.launch" | "app.stop"): void => {
    if (appId.trim().length === 0) {
      setValidationError("请输入 Android 包名。");
      return;
    }

    submitAction({ action, appId: appId.trim() });
  };

  const errorMessage =
    validationError ?? (actionMutation.isError ? actionMutation.error.message : undefined);

  return (
    <section className="device-overview" aria-label="设备工作台">
      <header className="overview-heading">
        <div>
          <p className="eyebrow">设备</p>
          <h1>概览</h1>
        </div>
        <span className="overview-device-name">{deviceName(device)}</span>
      </header>

      <dl className="overview-grid">
        <div>
          <dt>制造商</dt>
          <dd>{device.manufacturer ?? "未上报"}</dd>
        </div>
        <div>
          <dt>型号</dt>
          <dd>{deviceName(device)}</dd>
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
          <dt>传输连接</dt>
          <dd>{connectionLabel(device.connection)}</dd>
        </div>
        <div>
          <dt>设备序列号</dt>
          <dd className="serial-value">{serial}</dd>
        </div>
      </dl>

      <details className="console-accordion">
        <summary>测试运行环境</summary>
        <div className="console-accordion-content">
          <AppiumRuntimePanel controls={false} />
        </div>
      </details>

      <details className="console-accordion">
        <summary>设备控制</summary>
        <div className="console-accordion-content">
          {errorMessage !== undefined && (
            <p className="control-error" role="alert">
              {errorMessage}
            </p>
          )}
          {actionMutation.isPending && <p className="action-progress">正在发送操作...</p>}
          <div className="control-sections">
            <section>
              <h2>触控</h2>
              <div className="coordinate-fields">
                <label>
                  X
                  <input
                    aria-label="点击 X 坐标"
                    inputMode="numeric"
                    value={tapX}
                    onChange={(event) => setTapX(event.target.value)}
                  />
                </label>
                <label>
                  Y
                  <input
                    aria-label="点击 Y 坐标"
                    inputMode="numeric"
                    value={tapY}
                    onChange={(event) => setTapY(event.target.value)}
                  />
                </label>
              </div>
              <div className="action-button-row">
                <button
                  type="button"
                  onClick={() => submitTap(false)}
                  disabled={actionMutation.isPending}
                >
                  点击
                </button>
                <button
                  type="button"
                  onClick={() => submitTap(true)}
                  disabled={actionMutation.isPending}
                >
                  长按
                </button>
                <button
                  type="button"
                  className="subtle-action"
                  onClick={() => submitAction({ action: "ui.back" })}
                  disabled={actionMutation.isPending}
                >
                  返回
                </button>
              </div>
            </section>

            <section>
              <h2>文本输入</h2>
              <label>
                文本
                <input
                  aria-label="待输入文本"
                  value={inputValue}
                  onChange={(event) => setInputValue(event.target.value)}
                />
              </label>
              <button
                className="wide-action"
                type="button"
                disabled={actionMutation.isPending || inputValue.trim().length === 0}
                onClick={() => submitAction({ action: "ui.input", value: inputValue })}
              >
                发送文本
              </button>
            </section>

            <section>
              <h2>滑动</h2>
              <div className="coordinate-fields swipe-fields">
                <label>
                  起点 X
                  <input
                    aria-label="滑动起点 X 坐标"
                    inputMode="numeric"
                    value={startX}
                    onChange={(event) => setStartX(event.target.value)}
                  />
                </label>
                <label>
                  起点 Y
                  <input
                    aria-label="滑动起点 Y 坐标"
                    inputMode="numeric"
                    value={startY}
                    onChange={(event) => setStartY(event.target.value)}
                  />
                </label>
                <label>
                  终点 X
                  <input
                    aria-label="滑动终点 X 坐标"
                    inputMode="numeric"
                    value={endX}
                    onChange={(event) => setEndX(event.target.value)}
                  />
                </label>
                <label>
                  终点 Y
                  <input
                    aria-label="滑动终点 Y 坐标"
                    inputMode="numeric"
                    value={endY}
                    onChange={(event) => setEndY(event.target.value)}
                  />
                </label>
              </div>
              <button
                className="wide-action"
                type="button"
                disabled={actionMutation.isPending}
                onClick={submitSwipe}
              >
                执行滑动
              </button>
            </section>
          </div>
        </div>
      </details>

      <details className="console-accordion">
        <summary>应用控制</summary>
        <div className="console-accordion-content application-control">
          {errorMessage !== undefined && (
            <p className="control-error" role="alert">
              {errorMessage}
            </p>
          )}
          <label>
            Android 包名
            <input
              aria-label="Android 包名"
              placeholder="com.example.app"
              value={appId}
              onChange={(event) => setAppId(event.target.value)}
            />
          </label>
          <div className="action-button-row">
            <button
              type="button"
              disabled={actionMutation.isPending}
              onClick={() => submitAppAction("app.launch")}
            >
              启动应用
            </button>
            <button
              type="button"
              className="subtle-action"
              disabled={actionMutation.isPending}
              onClick={() => submitAppAction("app.stop")}
            >
              停止应用
            </button>
          </div>
        </div>
      </details>

      <details className="console-accordion">
        <summary>UI 层级与操作审计</summary>
        <div className="console-accordion-content evidence-content">
          <section>
            <div className="evidence-heading">
              <h2>UI 层级</h2>
              <button
                className="text-button"
                type="button"
                disabled={uiTreeQuery.isFetching}
                onClick={() => void uiTreeQuery.refetch()}
              >
                {uiTreeQuery.isFetching ? "读取中" : "刷新 XML"}
              </button>
            </div>
            {uiTreeQuery.isError ? (
              <p className="control-error">{uiTreeQuery.error.message}</p>
            ) : uiTreeQuery.data === undefined ? (
              <p className="control-empty">正在读取 UI 层级...</p>
            ) : (
              <pre className="ui-tree-code">{uiTreeQuery.data.xml}</pre>
            )}
          </section>
          <section>
            <h2>操作审计</h2>
            {actionHistoryQuery.isError ? (
              <p className="control-error">{actionHistoryQuery.error.message}</p>
            ) : actionHistoryQuery.data === undefined ? (
              <p className="control-empty">正在加载操作记录...</p>
            ) : actionHistoryQuery.data.actions.length === 0 ? (
              <p className="control-empty">尚未记录设备操作。</p>
            ) : (
              <ol className="action-history-list">
                {actionHistoryQuery.data.actions.map((audit) => (
                  <li key={audit.id}>
                    <span
                      className={audit.success ? "audit-result success" : "audit-result failed"}
                    >
                      {audit.success ? "完成" : "失败"}
                    </span>
                    <strong>{formatAction(audit.action)}</strong>
                    <time dateTime={audit.finishedAt}>{formatTime(audit.finishedAt)}</time>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </details>
    </section>
  );
}
