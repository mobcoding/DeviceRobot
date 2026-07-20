import { useQuery } from "@tanstack/react-query";
import { RefreshCw, ScrollText, Search } from "lucide-react";
import { useMemo, useState } from "react";
import type { AndroidDevice, DeviceLogcatEntry, DeviceLogcatLevel } from "@device-robot/contracts";

import { fetchDeviceLogcat } from "../api/device-management";

type DeviceLogcatPanelProps = {
  device: AndroidDevice;
};

const LOGCAT_LIMIT = 500;
const logcatLevels: readonly (DeviceLogcatLevel | "all")[] = [
  "all",
  "verbose",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "assert",
  "unknown",
];

function logcatLevelLabel(level: DeviceLogcatLevel | "all"): string {
  switch (level) {
    case "all":
      return "全部级别";
    case "verbose":
      return "详细";
    case "debug":
      return "调试";
    case "info":
      return "信息";
    case "warn":
      return "警告";
    case "error":
      return "错误";
    case "fatal":
      return "严重";
    case "assert":
      return "断言";
    case "unknown":
      return "其他";
  }
}

function logcatLevelCode(level: DeviceLogcatLevel): string {
  switch (level) {
    case "verbose":
      return "V";
    case "debug":
      return "D";
    case "info":
      return "I";
    case "warn":
      return "W";
    case "error":
      return "E";
    case "fatal":
      return "F";
    case "assert":
      return "A";
    case "unknown":
      return "?";
  }
}

function matchesSearch(entry: DeviceLogcatEntry, searchTerm: string): boolean {
  const normalized = searchTerm.trim().toLocaleLowerCase();
  if (normalized.length === 0) {
    return true;
  }

  return [entry.tag, entry.message, entry.timestamp, String(entry.processId ?? "")]
    .filter((value): value is string => value !== undefined)
    .some((value) => value.toLocaleLowerCase().includes(normalized));
}

export function DeviceLogcatPanel({ device }: DeviceLogcatPanelProps): React.JSX.Element {
  const [level, setLevel] = useState<DeviceLogcatLevel | "all">("all");
  const [searchTerm, setSearchTerm] = useState("");
  const logcatQuery = useQuery({
    queryKey: ["device-logcat", device.serial, LOGCAT_LIMIT],
    queryFn: ({ signal }) => fetchDeviceLogcat(device.serial, LOGCAT_LIMIT, signal),
    retry: false,
  });

  const entries = useMemo(
    () =>
      (logcatQuery.data?.entries ?? []).filter(
        (entry) => (level === "all" || entry.level === level) && matchesSearch(entry, searchTerm),
      ),
    [level, logcatQuery.data?.entries, searchTerm],
  );

  return (
    <section className="management-workspace logcat-workspace" aria-label="设备日志">
      <header className="management-heading">
        <div className="management-title-row">
          <ScrollText aria-hidden="true" size={29} strokeWidth={1.7} />
          <h1>设备日志</h1>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="刷新设备日志"
          title="刷新设备日志"
          disabled={logcatQuery.isFetching}
          onClick={() => void logcatQuery.refetch()}
        >
          <RefreshCw aria-hidden="true" size={17} strokeWidth={1.8} />
        </button>
      </header>

      <div className="logcat-toolbar">
        <label className="logcat-search">
          <Search aria-hidden="true" size={17} strokeWidth={1.8} />
          <input
            aria-label="筛选设备日志"
            placeholder="筛选标签、内容或进程号"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
        </label>
        <label className="logcat-level-filter">
          <span>级别</span>
          <select
            aria-label="筛选日志级别"
            value={level}
            onChange={(event) => setLevel(event.target.value as DeviceLogcatLevel | "all")}
          >
            {logcatLevels.map((item) => (
              <option key={item} value={item}>
                {logcatLevelLabel(item)}
              </option>
            ))}
          </select>
        </label>
        {logcatQuery.data !== undefined && (
          <span className="logcat-read-at">已读取 {logcatQuery.data.entries.length} 条</span>
        )}
      </div>

      {logcatQuery.isError && (
        <p className="management-error" role="alert">
          {logcatQuery.error.message}
        </p>
      )}

      {logcatQuery.data === undefined && !logcatQuery.isError ? (
        <p className="management-empty">正在读取设备日志。</p>
      ) : entries.length === 0 ? (
        <p className="management-empty">
          {logcatQuery.data?.entries.length === 0
            ? "设备尚未返回日志。"
            : "没有符合筛选条件的日志。"}
        </p>
      ) : (
        <div className="manager-table-wrap">
          <table className="manager-table logcat-table">
            <thead>
              <tr>
                <th scope="col">时间</th>
                <th scope="col">级别</th>
                <th scope="col">标签</th>
                <th scope="col">进程</th>
                <th scope="col">内容</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={`${entry.timestamp ?? "unknown"}-${entry.processId ?? ""}-${index}`}>
                  <td>{entry.timestamp ?? "-"}</td>
                  <td>
                    <span
                      className={`logcat-level ${entry.level}`}
                      title={logcatLevelLabel(entry.level)}
                    >
                      {logcatLevelCode(entry.level)}
                    </span>
                  </td>
                  <td>
                    <code>{entry.tag ?? "-"}</code>
                  </td>
                  <td>
                    {entry.processId === undefined
                      ? "-"
                      : `${entry.processId}/${entry.threadId ?? "-"}`}
                  </td>
                  <td>
                    <code className="logcat-message">{entry.message || "-"}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
