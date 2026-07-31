import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  House,
  ListVideo,
  LoaderCircle,
  PackagePlus,
  Power,
  RefreshCw,
  Square,
  Video,
  Volume1,
  Volume2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  AndroidDevice,
  ScreenRecordingConfiguration,
  ScreenRecordingStatus,
} from "@device-robot/contracts";

import { useAgentUnavailable } from "../agent-availability";
import {
  captureDeviceScreenshot,
  fetchScreenRecordingStatus,
  startScreenRecording,
  stopScreenRecording,
} from "../api/device-control";
import { formatDeviceName } from "../ui/formatters";
import { ScreenRecordingDialog } from "./ScreenRecordingDialog";

type DeviceMirrorPanelProps = {
  device: AndroidDevice;
  onPreferredSidebarWidth?(width: number): void;
  onScreenSize?(size: { width: number; height: number }): void;
  onApkDrop?(file: File): void;
};

type DevicePoint = {
  x: number;
  y: number;
};

type StreamConfiguration = {
  type: "configuration";
  codec: string;
  description: string;
  width: number;
  height: number;
};

type StreamControl =
  | {
      type: "pointer";
      action: "down" | "move" | "up" | "cancel";
      pointerId: number;
      x: number;
      y: number;
      videoWidth: number;
      videoHeight: number;
    }
  | { type: "back" }
  | { type: "key"; key: "home" | "recentApps" | "volumeUp" | "volumeDown" | "power" };

type ActivePointer = DevicePoint & {
  pointerId: number;
};

const INITIAL_RECONNECT_DELAY_MS = 750;
const MAX_RECONNECT_DELAY_MS = 10_000;

function streamUrl(serial: string): string {
  const protocol = globalThis.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${globalThis.location.host}/api/v1/devices/${encodeURIComponent(serial)}/scrcpy/stream`;
}

function decodeBase64(value: string): Uint8Array {
  const decoded = globalThis.atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function parseConfiguration(value: unknown): StreamConfiguration | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const message = value as Record<string, unknown>;
  if (
    message.type !== "configuration" ||
    typeof message.codec !== "string" ||
    typeof message.description !== "string" ||
    typeof message.width !== "number" ||
    typeof message.height !== "number"
  ) {
    return undefined;
  }

  return {
    type: "configuration",
    codec: message.codec,
    description: message.description,
    width: message.width,
    height: message.height,
  };
}

function reconnectDelay(attempt: number): number {
  return Math.min(
    MAX_RECONNECT_DELAY_MS,
    INITIAL_RECONNECT_DELAY_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 4),
  );
}

function pointFromPointer(
  event: React.PointerEvent<HTMLCanvasElement>,
  deviceSize: DevicePoint,
): DevicePoint | undefined {
  const canvas = event.currentTarget;
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width === 0 || bounds.height === 0) {
    return undefined;
  }

  const deviceAspectRatio = deviceSize.x / deviceSize.y;
  const boundsAspectRatio = bounds.width / bounds.height;
  const renderedWidth =
    deviceAspectRatio > boundsAspectRatio ? bounds.width : bounds.height * deviceAspectRatio;
  const renderedHeight =
    deviceAspectRatio > boundsAspectRatio ? bounds.width / deviceAspectRatio : bounds.height;
  const offsetX = (bounds.width - renderedWidth) / 2;
  const offsetY = (bounds.height - renderedHeight) / 2;
  const relativeX = event.clientX - bounds.left - offsetX;
  const relativeY = event.clientY - bounds.top - offsetY;

  if (relativeX < 0 || relativeY < 0 || relativeX > renderedWidth || relativeY > renderedHeight) {
    return undefined;
  }

  return {
    x: Math.round((relativeX / renderedWidth) * deviceSize.x),
    y: Math.round((relativeY / renderedHeight) * deviceSize.y),
  };
}

export function DeviceMirrorPanel({
  device,
  onPreferredSidebarWidth,
  onScreenSize,
  onApkDrop,
}: DeviceMirrorPanelProps): React.JSX.Element {
  const agentUnavailable = useAgentUnavailable();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const decoderRef = useRef<VideoDecoder | undefined>(undefined);
  const socketRef = useRef<WebSocket | undefined>(undefined);
  const pointerStart = useRef<ActivePointer | undefined>(undefined);
  const apkDragDepth = useRef(0);
  const reconnectFailuresRef = useRef(0);
  const screenSerialRef = useRef<string | undefined>(undefined);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [streamState, setStreamState] = useState<"connecting" | "live" | "error">("connecting");
  const [streamError, setStreamError] = useState<string>();
  const [controlError, setControlError] = useState<string>();
  const [copyingScreenshot, setCopyingScreenshot] = useState(false);
  const [recordingStatus, setRecordingStatus] = useState<ScreenRecordingStatus>();
  const [recordingConfiguration, setRecordingConfiguration] =
    useState<ScreenRecordingConfiguration>();
  const [recordingDialogOpen, setRecordingDialogOpen] = useState(false);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [recordingError, setRecordingError] = useState<string>();
  const [recordingSavedPath, setRecordingSavedPath] = useState<string>();
  const [screenSize, setScreenSize] = useState<DevicePoint>();
  const [quickControlsCollapsed, setQuickControlsCollapsed] = useState(false);
  const [apkDragActive, setApkDragActive] = useState(false);
  const serial = device.serial;

  const reconnectNow = (): void => {
    reconnectFailuresRef.current = 0;
    setStreamAttempt((attempt) => attempt + 1);
  };

  useEffect(() => {
    let disposed = false;
    setRecordingStatus(undefined);
    setRecordingConfiguration(undefined);
    setRecordingError(undefined);
    setRecordingSavedPath(undefined);

    if (agentUnavailable) {
      return () => {
        disposed = true;
      };
    }

    void fetchScreenRecordingStatus(serial)
      .then((status) => {
        if (!disposed) {
          setRecordingStatus(status);
          setRecordingConfiguration(status.configuration);
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setRecordingError(error instanceof Error ? error.message : "读取录屏配置失败。");
        }
      });

    return () => {
      disposed = true;
    };
  }, [agentUnavailable, serial]);

  useEffect(() => {
    let disposed = false;
    let decoder: VideoDecoder | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const closeDecoder = (): void => {
      if (decoder !== undefined && decoder.state !== "closed") {
        decoder.close();
      }
      if (decoderRef.current === decoder) {
        decoderRef.current = undefined;
      }
    };

    const fail = (message: string): void => {
      if (disposed) {
        return;
      }

      setStreamState("error");
      setStreamError(message);
    };

    const scheduleReconnect = (immediate = false): void => {
      if (disposed || reconnectTimer !== undefined || document.visibilityState === "hidden") {
        return;
      }

      const delay = immediate ? 0 : reconnectDelay(++reconnectFailuresRef.current);
      setStreamState("connecting");
      setStreamError("实时画面连接已断开，正在重连。");
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        if (!disposed && document.visibilityState !== "hidden") {
          setStreamAttempt((attempt) => attempt + 1);
        }
      }, delay);
    };

    if (!("WebSocket" in globalThis) || !("VideoDecoder" in globalThis)) {
      fail("当前浏览器不支持实时画面解码");
      return () => undefined;
    }

    const drawFrame = (frame: VideoFrame): void => {
      if (disposed) {
        frame.close();
        return;
      }

      const canvas = canvasRef.current;
      if (canvas === null) {
        frame.close();
        return;
      }

      const context = canvas.getContext("2d");
      if (context === null) {
        frame.close();
        return;
      }

      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      context.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
      reconnectFailuresRef.current = 0;
      setScreenSize((current) =>
        current?.x === canvas.width && current.y === canvas.height
          ? current
          : { x: canvas.width, y: canvas.height },
      );
      setStreamState("live");
      setStreamError(undefined);
    };

    const configureDecoder = (configuration: StreamConfiguration): void => {
      closeDecoder();
      try {
        const description = decodeBase64(configuration.description);
        decoder = new VideoDecoder({
          output: drawFrame,
          error: () => {
            fail("实时画面解码失败");
          },
        });
        decoder.configure({
          codec: configuration.codec,
          description: description.buffer,
          codedWidth: configuration.width,
          codedHeight: configuration.height,
        });
        decoderRef.current = decoder;
        const canvas = canvasRef.current;
        if (canvas !== null) {
          canvas.width = configuration.width;
          canvas.height = configuration.height;
        }
        setScreenSize({ x: configuration.width, y: configuration.height });
        reconnectFailuresRef.current = 0;
      } catch {
        fail("设备视频格式无法在当前浏览器中解码");
      }
    };

    setStreamState("connecting");
    setStreamError(undefined);
    if (screenSerialRef.current !== serial) {
      screenSerialRef.current = serial;
      setScreenSize(undefined);
    }
    pointerStart.current = undefined;
    const socket = new WebSocket(streamUrl(serial));
    socketRef.current = socket;
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        let message: unknown;
        try {
          message = JSON.parse(event.data);
        } catch {
          fail("实时画面协议返回了无效数据");
          return;
        }

        const configuration = parseConfiguration(message);
        if (configuration !== undefined) {
          configureDecoder(configuration);
          return;
        }

        if (
          typeof message === "object" &&
          message !== null &&
          (message as Record<string, unknown>).type === "error"
        ) {
          fail("无法建立设备实时画面");
        }
        if (
          typeof message === "object" &&
          message !== null &&
          (message as Record<string, unknown>).type === "control-error"
        ) {
          setControlError("设备实时控制失败");
        }
        return;
      }

      if (!(event.data instanceof ArrayBuffer) || decoder?.state !== "configured") {
        return;
      }

      const packet = new Uint8Array(event.data);
      if (packet.byteLength <= 9) {
        return;
      }

      const packetType = packet[0];
      if (packetType === undefined) {
        return;
      }

      const keyframe = (packetType & 1) === 1;

      try {
        const timestamp = Number(new DataView(packet.buffer).getBigUint64(1, false));
        decoder.decode(
          new EncodedVideoChunk({
            type: keyframe ? "key" : "delta",
            timestamp,
            data: packet.subarray(9),
          }),
        );
      } catch {
        fail("实时画面解码失败");
      }
    };
    socket.onclose = () => {
      if (!disposed) {
        fail("实时画面已断开");
        scheduleReconnect();
      }
    };

    const reconnectAfterPageRestore = (): void => {
      if (document.visibilityState === "hidden") {
        return;
      }

      if (socket.readyState !== WebSocket.OPEN) {
        scheduleReconnect(true);
      }
    };
    document.addEventListener("visibilitychange", reconnectAfterPageRestore);
    globalThis.addEventListener("focus", reconnectAfterPageRestore);
    globalThis.addEventListener("online", reconnectAfterPageRestore);

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
      }
      document.removeEventListener("visibilitychange", reconnectAfterPageRestore);
      globalThis.removeEventListener("focus", reconnectAfterPageRestore);
      globalThis.removeEventListener("online", reconnectAfterPageRestore);
      socket.close();
      if (socketRef.current === socket) {
        socketRef.current = undefined;
      }
      closeDecoder();
    };
  }, [serial, streamAttempt]);

  useEffect(() => {
    if (screenSize === undefined || onPreferredSidebarWidth === undefined) {
      return;
    }

    const frameHeight = frameRef.current?.getBoundingClientRect().height ?? 0;
    const deviceAspectRatio = screenSize.x / screenSize.y;
    if (frameHeight > 0 && Number.isFinite(deviceAspectRatio)) {
      onPreferredSidebarWidth(Math.ceil(frameHeight * deviceAspectRatio) + 28);
    }
  }, [onPreferredSidebarWidth, screenSize]);

  useEffect(() => {
    if (screenSize === undefined || onScreenSize === undefined) {
      return;
    }

    onScreenSize({ width: screenSize.x, height: screenSize.y });
  }, [onScreenSize, screenSize]);

  const sendControl = (command: StreamControl): boolean => {
    const socket = socketRef.current;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      setControlError("设备实时控制通道尚未就绪");
      return false;
    }

    setControlError(undefined);
    socket.send(JSON.stringify(command));
    return true;
  };

  const supportsImageClipboard =
    globalThis.navigator.clipboard?.write !== undefined && globalThis.ClipboardItem !== undefined;

  const handleCopyScreenshot = async (): Promise<void> => {
    const clipboard = globalThis.navigator.clipboard;
    const ClipboardItemConstructor = globalThis.ClipboardItem;
    if (
      copyingScreenshot ||
      clipboard?.write === undefined ||
      ClipboardItemConstructor === undefined
    ) {
      return;
    }

    setCopyingScreenshot(true);
    setControlError(undefined);
    try {
      const screenshot = await captureDeviceScreenshot(serial);
      await clipboard.write([new ClipboardItemConstructor({ "image/png": screenshot })]);
    } catch {
      setControlError("设备截图复制到剪贴板失败。");
    } finally {
      setCopyingScreenshot(false);
    }
  };

  const handleStartRecording = async (
    configuration: ScreenRecordingConfiguration,
  ): Promise<void> => {
    setRecordingBusy(true);
    setRecordingError(undefined);
    setRecordingSavedPath(undefined);
    try {
      const status = await startScreenRecording(serial, configuration);
      setRecordingStatus(status);
      setRecordingConfiguration(status.configuration);
      setRecordingDialogOpen(false);
    } catch (error) {
      setRecordingError(error instanceof Error ? error.message : "启动录屏失败。");
    } finally {
      setRecordingBusy(false);
    }
  };

  const handleStopRecording = async (): Promise<void> => {
    setRecordingBusy(true);
    setRecordingError(undefined);
    try {
      const result = await stopScreenRecording(serial);
      setRecordingStatus((current) =>
        current === undefined ? current : { ...current, recording: false, startedAt: undefined },
      );
      setRecordingSavedPath(result.savedPath);
    } catch (error) {
      setRecordingError(error instanceof Error ? error.message : "停止录屏失败。");
    } finally {
      setRecordingBusy(false);
    }
  };

  const recording = recordingStatus?.recording === true;

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0 || screenSize === undefined) {
      return;
    }

    const point = pointFromPointer(event, screenSize);
    if (point === undefined) {
      return;
    }

    const pointer = { ...point, pointerId: event.pointerId };
    if (
      !sendControl({
        type: "pointer",
        action: "down",
        pointerId: pointer.pointerId,
        x: pointer.x,
        y: pointer.y,
        videoWidth: screenSize.x,
        videoHeight: screenSize.y,
      })
    ) {
      return;
    }

    pointerStart.current = pointer;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const start = pointerStart.current;
    if (start === undefined || start.pointerId !== event.pointerId || screenSize === undefined) {
      return;
    }

    const point = pointFromPointer(event, screenSize);
    if (point === undefined) {
      return;
    }

    sendControl({
      type: "pointer",
      action: "move",
      pointerId: start.pointerId,
      x: point.x,
      y: point.y,
      videoWidth: screenSize.x,
      videoHeight: screenSize.y,
    });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const start = pointerStart.current;
    pointerStart.current = undefined;
    if (start === undefined || start.pointerId !== event.pointerId || screenSize === undefined) {
      return;
    }

    const end = pointFromPointer(event, screenSize);
    if (end === undefined) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    sendControl({
      type: "pointer",
      action: "up",
      pointerId: start.pointerId,
      x: end.x,
      y: end.y,
      videoWidth: screenSize.x,
      videoHeight: screenSize.y,
    });
  };

  const handlePointerCancel = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const start = pointerStart.current;
    pointerStart.current = undefined;
    if (start === undefined || start.pointerId !== event.pointerId || screenSize === undefined) {
      return;
    }

    const point = pointFromPointer(event, screenSize) ?? start;
    sendControl({
      type: "pointer",
      action: "cancel",
      pointerId: start.pointerId,
      x: point.x,
      y: point.y,
      videoWidth: screenSize.x,
      videoHeight: screenSize.y,
    });
  };

  const error = agentUnavailable ? undefined : (recordingError ?? controlError ?? streamError);

  const handleApkDragEnter = (event: React.DragEvent<HTMLDivElement>): void => {
    if (onApkDrop === undefined || !Array.from(event.dataTransfer.types).includes("Files")) {
      return;
    }
    event.preventDefault();
    apkDragDepth.current += 1;
    setApkDragActive(true);
  };

  const handleApkDragLeave = (event: React.DragEvent<HTMLDivElement>): void => {
    if (!apkDragActive) {
      return;
    }
    event.preventDefault();
    apkDragDepth.current = Math.max(0, apkDragDepth.current - 1);
    if (apkDragDepth.current === 0) {
      setApkDragActive(false);
    }
  };

  const handleApkDrop = (event: React.DragEvent<HTMLDivElement>): void => {
    if (onApkDrop === undefined) {
      return;
    }
    event.preventDefault();
    apkDragDepth.current = 0;
    setApkDragActive(false);
    const file = event.dataTransfer.files.item(0);
    if (file !== null) {
      onApkDrop(file);
    }
  };

  return (
    <section className="device-mirror" aria-label="屏幕镜像">
      {recordingDialogOpen &&
        recordingConfiguration !== undefined &&
        recordingStatus !== undefined && (
          <ScreenRecordingDialog
            configuration={recordingConfiguration}
            maxDurationSeconds={recordingStatus.maxDurationSeconds}
            starting={recordingBusy}
            {...(recordingError === undefined ? {} : { error: recordingError })}
            onCancel={() => {
              if (!recordingBusy) {
                setRecordingDialogOpen(false);
                setRecordingError(undefined);
              }
            }}
            onStart={(configuration) => void handleStartRecording(configuration)}
          />
        )}
      <header className="mirror-header">
        <div>
          <p>实时画面</p>
        </div>
        <div className="mirror-actions">
          <button
            type="button"
            className="mirror-refresh"
            aria-label="重新连接实时画面"
            title="重新连接实时画面"
            onClick={reconnectNow}
          >
            <RefreshCw aria-hidden="true" size={16} strokeWidth={1.8} />
          </button>
        </div>
      </header>
      <div className="mirror-workspace">
        <aside
          className={`mirror-quick-controls${quickControlsCollapsed ? " collapsed" : ""}`}
          aria-label="设备快捷操作"
        >
          {!quickControlsCollapsed && (
            <div className="mirror-quick-groups">
              <div className="mirror-quick-group">
                <button
                  type="button"
                  className="mirror-quick-button"
                  aria-label="主页"
                  title="主页"
                  onClick={() => sendControl({ type: "key", key: "home" })}
                >
                  <House aria-hidden="true" size={18} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  className="mirror-quick-button"
                  aria-label="返回"
                  title="返回"
                  onClick={() => sendControl({ type: "back" })}
                >
                  <ArrowLeft aria-hidden="true" size={18} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  className="mirror-quick-button"
                  aria-label="最近任务"
                  title="最近任务"
                  onClick={() => sendControl({ type: "key", key: "recentApps" })}
                >
                  <ListVideo aria-hidden="true" size={18} strokeWidth={1.8} />
                </button>
              </div>
              <div className="mirror-quick-group mirror-quick-group-secondary">
                <button
                  type="button"
                  className="mirror-quick-button"
                  aria-label="音量增加"
                  title="音量增加"
                  onClick={() => sendControl({ type: "key", key: "volumeUp" })}
                >
                  <Volume2 aria-hidden="true" size={18} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  className="mirror-quick-button"
                  aria-label="音量减小"
                  title="音量减小"
                  onClick={() => sendControl({ type: "key", key: "volumeDown" })}
                >
                  <Volume1 aria-hidden="true" size={18} strokeWidth={1.8} />
                </button>
                <button
                  type="button"
                  className="mirror-quick-button"
                  aria-label="电源（亮屏或息屏）"
                  title="电源（亮屏或息屏）"
                  onClick={() => sendControl({ type: "key", key: "power" })}
                >
                  <Power aria-hidden="true" size={18} strokeWidth={1.8} />
                </button>
              </div>
              <div className="mirror-quick-group mirror-quick-group-secondary">
                <button
                  type="button"
                  className="mirror-quick-button"
                  aria-label={copyingScreenshot ? "正在截屏并复制到剪贴板" : "截屏并复制到剪贴板"}
                  title={
                    supportsImageClipboard
                      ? "截屏并复制到剪贴板"
                      : "当前浏览器不支持复制图片到剪贴板"
                  }
                  disabled={agentUnavailable || copyingScreenshot || !supportsImageClipboard}
                  onClick={() => void handleCopyScreenshot()}
                >
                  {copyingScreenshot ? (
                    <LoaderCircle aria-hidden="true" size={17} className="test-run-spinner" />
                  ) : (
                    <ClipboardCopy aria-hidden="true" size={18} strokeWidth={1.8} />
                  )}
                </button>
                <button
                  type="button"
                  className={`mirror-quick-button mirror-recording-button${recording ? " recording" : ""}`}
                  aria-label={
                    recording ? "停止录制并保存" : recordingBusy ? "正在准备录制" : "配置并开始录制"
                  }
                  title={recording ? "停止录制并保存" : "配置并开始录制"}
                  disabled={
                    agentUnavailable ||
                    recordingBusy ||
                    (!recording && recordingConfiguration === undefined)
                  }
                  onClick={() => {
                    if (recording) {
                      void handleStopRecording();
                    } else {
                      setRecordingError(undefined);
                      setRecordingSavedPath(undefined);
                      setRecordingDialogOpen(true);
                    }
                  }}
                >
                  {recordingBusy ? (
                    <LoaderCircle aria-hidden="true" size={17} className="test-run-spinner" />
                  ) : recording ? (
                    <Square aria-hidden="true" size={14} fill="currentColor" strokeWidth={1.8} />
                  ) : (
                    <Video aria-hidden="true" size={18} strokeWidth={1.8} />
                  )}
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            className="mirror-quick-button mirror-quick-collapse"
            aria-label={quickControlsCollapsed ? "展开快捷操作" : "收起快捷操作"}
            title={quickControlsCollapsed ? "展开快捷操作" : "收起快捷操作"}
            onClick={() => setQuickControlsCollapsed((collapsed) => !collapsed)}
          >
            {quickControlsCollapsed ? (
              <ChevronUp aria-hidden="true" size={18} strokeWidth={1.8} />
            ) : (
              <ChevronDown aria-hidden="true" size={18} strokeWidth={1.8} />
            )}
          </button>
        </aside>
        <div
          ref={frameRef}
          className="mirror-screen-frame"
          onDragEnter={handleApkDragEnter}
          onDragOver={(event) => {
            if (onApkDrop !== undefined) {
              event.preventDefault();
            }
          }}
          onDragLeave={handleApkDragLeave}
          onDrop={handleApkDrop}
          style={
            screenSize === undefined
              ? undefined
              : { aspectRatio: `${screenSize.x} / ${screenSize.y}` }
          }
        >
          {apkDragActive && (
            <div className="apk-drop-overlay" role="status">
              <PackagePlus aria-hidden="true" size={28} strokeWidth={1.7} />
              <strong>释放以安装 APK</strong>
              <span>{formatDeviceName(device)}</span>
            </div>
          )}
          <canvas
            ref={canvasRef}
            className="interactive-device-screen"
            role="img"
            aria-label={`设备实时画面：${formatDeviceName(device)}`}
            aria-busy={screenSize === undefined}
            onPointerCancel={handlePointerCancel}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
          {streamState === "connecting" && (
            <span className="mirror-operation" aria-label="正在连接实时画面">
              <LoaderCircle aria-hidden="true" size={20} strokeWidth={1.8} />
            </span>
          )}
        </div>
      </div>
      {error !== undefined && <p className="mirror-error">{error}</p>}
      {recordingSavedPath !== undefined && (
        <p className="mirror-recording-saved" role="status">
          <CheckCircle2 aria-hidden="true" size={15} strokeWidth={1.8} />
          录屏已保存：<code>{recordingSavedPath}</code>
        </p>
      )}
    </section>
  );
}
