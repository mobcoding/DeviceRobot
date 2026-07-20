import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { AndroidDevice, DeviceControlAction } from "@device-robot/contracts";

import {
  deviceScreenshotUrl,
  executeDeviceAction,
  fetchDeviceActionHistory,
  fetchDeviceUiTree,
} from "../api/device-control";

type DeviceControlPanelProps = {
  device: AndroidDevice | undefined;
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
      return `从 ${action.startX}, ${action.startY} 滑动到 ${action.endX}, ${action.endY}`;
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

export function DeviceControlPanel({ device }: DeviceControlPanelProps): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const serial = device?.serial ?? "";
  const [screenshotRevision, setScreenshotRevision] = useState(0);
  const [screenshotError, setScreenshotError] = useState<string>();
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
    setScreenshotRevision(0);
    setScreenshotError(undefined);
    setValidationError(undefined);
  }, [serial]);

  const uiTreeQuery = useQuery({
    queryKey: ["device-ui-tree", serial],
    queryFn: ({ signal }) => fetchDeviceUiTree(serial, signal),
    enabled: serial.length > 0,
    retry: false,
  });
  const actionHistoryQuery = useQuery({
    queryKey: ["device-action-history", serial],
    queryFn: ({ signal }) => fetchDeviceActionHistory(serial, signal),
    enabled: serial.length > 0,
    retry: false,
  });
  const actionMutation = useMutation({
    mutationFn: async (action: DeviceControlAction) => {
      if (serial.length === 0) {
        throw new Error("请先选择一台可用设备再发送操作");
      }

      return executeDeviceAction(serial, action);
    },
    onSuccess: async () => {
      setValidationError(undefined);
      setScreenshotError(undefined);
      setScreenshotRevision((revision) => revision + 1);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["device-action-history", serial] }),
        queryClient.invalidateQueries({ queryKey: ["device-ui-tree", serial] }),
      ]);
    },
  });

  if (device === undefined) {
    return null;
  }

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
    <section className="device-console" aria-label="设备控制台">
      <header className="device-console-heading">
        <div>
          <p className="eyebrow">当前设备</p>
          <h2>{device.model ?? device.deviceName ?? device.serial}</h2>
          <code>{device.serial}</code>
        </div>
        <span className="panel-chip">ADB 控制</span>
      </header>

      <div className="device-console-layout">
        <section className="device-screen-surface" aria-label="当前设备截图">
          <div className="surface-heading">
            <div>
              <p className="eyebrow">屏幕</p>
              <h3>当前截图</h3>
            </div>
            <button
              className="compact-button"
              type="button"
              onClick={() => {
                setScreenshotError(undefined);
                setScreenshotRevision((revision) => revision + 1);
              }}
            >
              获取截图
            </button>
          </div>
          <div className="screenshot-frame">
            <img
              alt={`设备截图：${device.model ?? device.serial}`}
              src={deviceScreenshotUrl(serial, screenshotRevision)}
              onError={() => setScreenshotError("截图获取失败，请检查设备连接。")}
            />
          </div>
          {screenshotError !== undefined && <p className="control-error">{screenshotError}</p>}
        </section>

        <section className="ui-tree-surface" aria-label="当前 Android UI 层级">
          <div className="surface-heading">
            <div>
              <p className="eyebrow">UI 层级</p>
              <h3>无障碍快照</h3>
            </div>
            <button
              className="compact-button"
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
      </div>

      <section className="device-actions" aria-label="设备操作">
        <div className="section-heading">
          <div>
            <p className="eyebrow">安全操作</p>
            <h3>直接 ADB 控制</h3>
          </div>
          {actionMutation.isPending && <span className="action-progress">正在发送操作</span>}
        </div>

        {errorMessage !== undefined && (
          <p className="control-error" role="alert">
            {errorMessage}
          </p>
        )}

        <div className="action-grid">
          <section className="action-card">
            <h4>触控</h4>
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
                className="subtle-action"
                type="button"
                onClick={() => submitAction({ action: "ui.back" })}
                disabled={actionMutation.isPending}
              >
                返回
              </button>
            </div>
          </section>

          <section className="action-card">
            <h4>文本输入</h4>
            <label>
              文本
              <input
                aria-label="待输入文本"
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={actionMutation.isPending || inputValue.trim().length === 0}
              onClick={() => submitAction({ action: "ui.input", value: inputValue })}
            >
              发送文本
            </button>
          </section>

          <section className="action-card">
            <h4>滑动</h4>
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
            <button type="button" disabled={actionMutation.isPending} onClick={submitSwipe}>
              滑动
            </button>
          </section>

          <section className="action-card">
            <h4>应用</h4>
            <label>
              包名
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
                启动
              </button>
              <button
                className="subtle-action"
                type="button"
                disabled={actionMutation.isPending}
                onClick={() => submitAppAction("app.stop")}
              >
                停止
              </button>
            </div>
          </section>
        </div>
      </section>

      <section className="device-action-history" aria-label="设备操作历史">
        <div className="section-heading">
          <div>
            <p className="eyebrow">操作审计</p>
            <h3>最近设备操作</h3>
          </div>
          <button
            className="compact-button"
            type="button"
            disabled={actionHistoryQuery.isFetching}
            onClick={() => void actionHistoryQuery.refetch()}
          >
            {actionHistoryQuery.isFetching ? "加载中" : "刷新历史"}
          </button>
        </div>
        {actionHistoryQuery.isError ? (
          <p className="control-error">{actionHistoryQuery.error.message}</p>
        ) : actionHistoryQuery.data === undefined ? (
          <p className="control-empty">正在加载操作历史...</p>
        ) : actionHistoryQuery.data.actions.length === 0 ? (
          <p className="control-empty">尚未记录任何设备操作。</p>
        ) : (
          <ol className="action-history-list">
            {actionHistoryQuery.data.actions.map((audit) => (
              <li key={audit.id}>
                <span className={audit.success ? "audit-result success" : "audit-result failed"}>
                  {audit.success ? "已完成" : "失败"}
                </span>
                <strong>{formatAction(audit.action)}</strong>
                <time dateTime={audit.finishedAt}>{formatTime(audit.finishedAt)}</time>
                {audit.message !== undefined && (
                  <p>
                    {audit.success
                      ? "设备已返回执行结果。"
                      : "设备操作失败，请查看本地 Agent 日志。"}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
