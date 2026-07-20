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
      return `Tap ${action.x}, ${action.y}`;
    case "ui.longPress":
      return `Long press ${action.x}, ${action.y}`;
    case "ui.input":
      return "Input text";
    case "ui.swipe":
      return `Swipe ${action.startX}, ${action.startY} to ${action.endX}, ${action.endY}`;
    case "ui.back":
      return "Back";
    case "app.launch":
      return `Launch ${action.appId}`;
    case "app.stop":
      return `Stop ${action.appId}`;
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
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
        throw new Error("Select a ready device before sending an action");
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
      setValidationError("Tap coordinates must be non-negative integers.");
      return;
    }

    submitAction(longPress ? { action: "ui.longPress", x, y } : { action: "ui.tap", x, y });
  };

  const submitSwipe = (): void => {
    const values = [startX, startY, endX, endY].map((value) => Number(value));
    if (values.some((value) => !Number.isInteger(value) || value < 0)) {
      setValidationError("Swipe coordinates must be non-negative integers.");
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
      setValidationError("An Android package name is required.");
      return;
    }

    submitAction({ action, appId: appId.trim() });
  };

  const errorMessage =
    validationError ?? (actionMutation.isError ? actionMutation.error.message : undefined);

  return (
    <section className="device-console" aria-label="Device control console">
      <header className="device-console-heading">
        <div>
          <p className="eyebrow">Active device</p>
          <h2>{device.model ?? device.deviceName ?? device.serial}</h2>
          <code>{device.serial}</code>
        </div>
        <span className="panel-chip">ADB controls</span>
      </header>

      <div className="device-console-layout">
        <section className="device-screen-surface" aria-label="Current device screenshot">
          <div className="surface-heading">
            <div>
              <p className="eyebrow">Screen</p>
              <h3>Current screenshot</h3>
            </div>
            <button
              className="compact-button"
              type="button"
              onClick={() => {
                setScreenshotError(undefined);
                setScreenshotRevision((revision) => revision + 1);
              }}
            >
              Capture
            </button>
          </div>
          <div className="screenshot-frame">
            <img
              alt={`Device screenshot for ${device.model ?? device.serial}`}
              src={deviceScreenshotUrl(serial, screenshotRevision)}
              onError={() =>
                setScreenshotError("Screenshot capture failed. Check the device connection.")
              }
            />
          </div>
          {screenshotError !== undefined && <p className="control-error">{screenshotError}</p>}
        </section>

        <section className="ui-tree-surface" aria-label="Current Android UI hierarchy">
          <div className="surface-heading">
            <div>
              <p className="eyebrow">UI hierarchy</p>
              <h3>Accessibility snapshot</h3>
            </div>
            <button
              className="compact-button"
              type="button"
              disabled={uiTreeQuery.isFetching}
              onClick={() => void uiTreeQuery.refetch()}
            >
              {uiTreeQuery.isFetching ? "Reading" : "Refresh XML"}
            </button>
          </div>
          {uiTreeQuery.isError ? (
            <p className="control-error">{uiTreeQuery.error.message}</p>
          ) : uiTreeQuery.data === undefined ? (
            <p className="control-empty">Reading UI hierarchy...</p>
          ) : (
            <pre className="ui-tree-code">{uiTreeQuery.data.xml}</pre>
          )}
        </section>
      </div>

      <section className="device-actions" aria-label="Device actions">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Safe actions</p>
            <h3>Direct ADB controls</h3>
          </div>
          {actionMutation.isPending && <span className="action-progress">Sending action</span>}
        </div>

        {errorMessage !== undefined && (
          <p className="control-error" role="alert">
            {errorMessage}
          </p>
        )}

        <div className="action-grid">
          <section className="action-card">
            <h4>Touch</h4>
            <div className="coordinate-fields">
              <label>
                X
                <input
                  aria-label="Tap X coordinate"
                  inputMode="numeric"
                  value={tapX}
                  onChange={(event) => setTapX(event.target.value)}
                />
              </label>
              <label>
                Y
                <input
                  aria-label="Tap Y coordinate"
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
                Tap
              </button>
              <button
                type="button"
                onClick={() => submitTap(true)}
                disabled={actionMutation.isPending}
              >
                Long press
              </button>
              <button
                className="subtle-action"
                type="button"
                onClick={() => submitAction({ action: "ui.back" })}
                disabled={actionMutation.isPending}
              >
                Back
              </button>
            </div>
          </section>

          <section className="action-card">
            <h4>Text input</h4>
            <label>
              Text
              <input
                aria-label="Text to input"
                value={inputValue}
                onChange={(event) => setInputValue(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={actionMutation.isPending || inputValue.trim().length === 0}
              onClick={() => submitAction({ action: "ui.input", value: inputValue })}
            >
              Send text
            </button>
          </section>

          <section className="action-card">
            <h4>Swipe</h4>
            <div className="coordinate-fields swipe-fields">
              <label>
                Start X
                <input
                  aria-label="Swipe start X coordinate"
                  inputMode="numeric"
                  value={startX}
                  onChange={(event) => setStartX(event.target.value)}
                />
              </label>
              <label>
                Start Y
                <input
                  aria-label="Swipe start Y coordinate"
                  inputMode="numeric"
                  value={startY}
                  onChange={(event) => setStartY(event.target.value)}
                />
              </label>
              <label>
                End X
                <input
                  aria-label="Swipe end X coordinate"
                  inputMode="numeric"
                  value={endX}
                  onChange={(event) => setEndX(event.target.value)}
                />
              </label>
              <label>
                End Y
                <input
                  aria-label="Swipe end Y coordinate"
                  inputMode="numeric"
                  value={endY}
                  onChange={(event) => setEndY(event.target.value)}
                />
              </label>
            </div>
            <button type="button" disabled={actionMutation.isPending} onClick={submitSwipe}>
              Swipe
            </button>
          </section>

          <section className="action-card">
            <h4>Application</h4>
            <label>
              Package
              <input
                aria-label="Android package name"
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
                Launch
              </button>
              <button
                className="subtle-action"
                type="button"
                disabled={actionMutation.isPending}
                onClick={() => submitAppAction("app.stop")}
              >
                Stop
              </button>
            </div>
          </section>
        </div>
      </section>

      <section className="device-action-history" aria-label="Device action history">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Audit trail</p>
            <h3>Recent device actions</h3>
          </div>
          <button
            className="compact-button"
            type="button"
            disabled={actionHistoryQuery.isFetching}
            onClick={() => void actionHistoryQuery.refetch()}
          >
            {actionHistoryQuery.isFetching ? "Loading" : "Refresh history"}
          </button>
        </div>
        {actionHistoryQuery.isError ? (
          <p className="control-error">{actionHistoryQuery.error.message}</p>
        ) : actionHistoryQuery.data === undefined ? (
          <p className="control-empty">Loading action history...</p>
        ) : actionHistoryQuery.data.actions.length === 0 ? (
          <p className="control-empty">No device actions have been recorded yet.</p>
        ) : (
          <ol className="action-history-list">
            {actionHistoryQuery.data.actions.map((audit) => (
              <li key={audit.id}>
                <span className={audit.success ? "audit-result success" : "audit-result failed"}>
                  {audit.success ? "Completed" : "Failed"}
                </span>
                <strong>{formatAction(audit.action)}</strong>
                <time dateTime={audit.finishedAt}>{formatTime(audit.finishedAt)}</time>
                {audit.message !== undefined && <p>{audit.message}</p>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </section>
  );
}
