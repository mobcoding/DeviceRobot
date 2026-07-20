import { useEffect, useState } from "react";
import type { AndroidDevice } from "@device-robot/contracts";

import { deviceScreenshotUrl } from "../api/device-control";

type DeviceMirrorPanelProps = {
  device: AndroidDevice;
};

function deviceName(device: AndroidDevice): string {
  return device.model ?? device.deviceName ?? device.serial;
}

export function DeviceMirrorPanel({ device }: DeviceMirrorPanelProps): React.JSX.Element {
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setRevision(0);
    setError(undefined);
  }, [device.serial]);

  return (
    <section className="device-mirror" aria-label="屏幕镜像">
      <header className="mirror-header">
        <div>
          <p>屏幕镜像</p>
          <strong>{deviceName(device)}</strong>
        </div>
        <button
          type="button"
          className="mirror-refresh"
          onClick={() => {
            setError(undefined);
            setRevision((value) => value + 1);
          }}
        >
          刷新
        </button>
      </header>
      <div className="mirror-screen-frame">
        <img
          alt={`设备截图：${deviceName(device)}`}
          src={deviceScreenshotUrl(device.serial, revision)}
          onError={() => setError("无法读取设备截图")}
        />
      </div>
      {error !== undefined && <p className="mirror-error">{error}</p>}
    </section>
  );
}
