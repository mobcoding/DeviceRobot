import { useMutation, useQuery } from "@tanstack/react-query";
import { AppWindow, Play, RefreshCw, Search, Square, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  AndroidDevice,
  DeviceApplication,
  DeviceApplicationFilter,
  DeviceControlAction,
} from "@device-robot/contracts";

import { useAgentUnavailable } from "../agent-availability";
import { executeDeviceAction } from "../api/device-control";
import { deviceApplicationIconUrl, fetchDeviceApplications } from "../api/device-management";

type ApplicationManagerPanelProps = {
  device: AndroidDevice;
  onRequestApkInstall(): void;
};

const APPLICATIONS_PER_PAGE = 50;

function formatApplicationSize(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) {
    return "未读取";
  }
  if (sizeBytes < 1_024) {
    return `${sizeBytes} B`;
  }

  const units = ["KB", "MB", "GB"];
  let value = sizeBytes / 1_024;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  return `${value.toLocaleString("zh-CN", {
    maximumFractionDigits: value >= 10 ? 0 : 1,
  })} ${units[unitIndex]}`;
}

function formatLastUsedAt(lastUsedAt: string | undefined): string {
  if (lastUsedAt === undefined) {
    return "未记录";
  }

  const date = new Date(lastUsedAt);
  if (Number.isNaN(date.valueOf())) {
    return "未记录";
  }
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function sourceLabel(source: DeviceApplication["source"]): string {
  return source === "user" ? "用户" : "系统";
}

function applicationDisplayName(application: DeviceApplication): string {
  const lastSegment = application.packageName.split(".").at(-1) ?? application.packageName;
  const spaced = lastSegment.replaceAll(/([a-z])([A-Z])/gu, "$1 $2").replaceAll(/[_-]+/gu, " ");
  return spaced.length === 0 ? application.packageName : spaced;
}

function ApplicationIcon({
  serial,
  application,
}: {
  serial: string;
  application: DeviceApplication;
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const displayName = applicationDisplayName(application);

  useEffect(() => {
    setFailed(false);
  }, [serial, application.packageName]);

  return (
    <span className="application-icon-shell">
      {!failed ? (
        <img
          className="application-icon-image"
          src={deviceApplicationIconUrl(serial, application.packageName)}
          alt={`${displayName} 图标`}
          width={36}
          height={36}
          decoding="async"
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="application-icon-fallback" aria-label={`${displayName} 默认图标`}>
          {displayName.slice(0, 1).toLocaleUpperCase()}
        </span>
      )}
    </span>
  );
}

export function ApplicationManagerPanel({
  device,
  onRequestApkInstall,
}: ApplicationManagerPanelProps): React.JSX.Element {
  const agentUnavailable = useAgentUnavailable();
  const [filter, setFilter] = useState<DeviceApplicationFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(0);
  const applicationsQuery = useQuery({
    queryKey: ["device-applications", device.serial, filter],
    queryFn: ({ signal }) => fetchDeviceApplications(device.serial, filter, signal),
    retry: false,
  });
  const actionMutation = useMutation({
    mutationFn: async (action: DeviceControlAction) =>
      await executeDeviceAction(device.serial, action),
  });

  const filteredApplications = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLocaleLowerCase();
    return (applicationsQuery.data?.applications ?? []).filter(
      (application) =>
        application.packageName.toLocaleLowerCase().includes(normalizedSearch) ||
        applicationDisplayName(application).toLocaleLowerCase().includes(normalizedSearch),
    );
  }, [applicationsQuery.data?.applications, searchTerm]);
  const pageCount = Math.max(1, Math.ceil(filteredApplications.length / APPLICATIONS_PER_PAGE));
  const currentPage = Math.min(page, pageCount - 1);
  const applications = filteredApplications.slice(
    currentPage * APPLICATIONS_PER_PAGE,
    (currentPage + 1) * APPLICATIONS_PER_PAGE,
  );

  useEffect(() => {
    setPage(0);
  }, [device.serial, filter, searchTerm]);

  const actionError = actionMutation.isError ? actionMutation.error.message : undefined;

  return (
    <section className="management-workspace application-manager" aria-label="应用管理器">
      <header className="management-heading">
        <div className="management-title-row">
          <AppWindow aria-hidden="true" size={29} strokeWidth={1.7} />
          <h1>应用管理器</h1>
        </div>
        <div className="management-heading-actions">
          <button className="primary-command" type="button" onClick={onRequestApkInstall}>
            <Upload aria-hidden="true" size={16} strokeWidth={1.8} />
            <span>安装 APK</span>
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="刷新应用列表"
            title="刷新应用列表"
            disabled={applicationsQuery.isFetching}
            onClick={() => void applicationsQuery.refetch()}
          >
            <RefreshCw aria-hidden="true" size={17} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      <div className="application-toolbar">
        <label className="application-search">
          <Search aria-hidden="true" size={17} strokeWidth={1.8} />
          <input
            aria-label="搜索应用包名"
            placeholder="按包名筛选"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />
        </label>
        <label className="application-filter">
          <span>筛选</span>
          <select
            aria-label="应用来源筛选"
            value={filter}
            onChange={(event) => setFilter(event.target.value as DeviceApplicationFilter)}
          >
            <option value="all">全部应用</option>
            <option value="user">用户安装</option>
            <option value="system">系统预装</option>
          </select>
        </label>
      </div>

      {!agentUnavailable && (applicationsQuery.isError || actionError !== undefined) && (
        <p className="management-error" role="alert">
          {applicationsQuery.isError ? applicationsQuery.error.message : actionError}
        </p>
      )}

      {applicationsQuery.data === undefined ? (
        <p className="management-empty">正在读取设备应用列表。</p>
      ) : filteredApplications.length === 0 ? (
        <p className="management-empty">没有符合筛选条件的应用。</p>
      ) : (
        <div className="manager-table-wrap">
          <table className="manager-table applications-table">
            <thead>
              <tr>
                <th scope="col">应用</th>
                <th scope="col">来源</th>
                <th scope="col">大小</th>
                <th scope="col">最后使用时间</th>
                <th scope="col">包名</th>
                <th scope="col" aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {applications.map((application) => (
                <tr key={application.packageName}>
                  <td>
                    <div className="application-identity">
                      <ApplicationIcon serial={device.serial} application={application} />
                      <div>
                        <strong>{applicationDisplayName(application)}</strong>
                        <span>
                          版本 {application.versionName ?? "未读取"} · 版本代码{" "}
                          {application.versionCode ?? "未读取"}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`application-source ${application.source}`}>
                      {sourceLabel(application.source)}
                    </span>
                  </td>
                  <td>
                    <span className="application-size">
                      {formatApplicationSize(application.sizeBytes)}
                    </span>
                  </td>
                  <td>
                    <time className="application-last-used-at" dateTime={application.lastUsedAt}>
                      {formatLastUsedAt(application.lastUsedAt)}
                    </time>
                  </td>
                  <td>
                    <code className="application-package-name">{application.packageName}</code>
                  </td>
                  <td>
                    <div className="application-actions">
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`启动 ${application.packageName}`}
                        title="启动应用"
                        disabled={actionMutation.isPending}
                        onClick={() =>
                          actionMutation.mutate({
                            action: "app.launch",
                            appId: application.packageName,
                          })
                        }
                      >
                        <Play aria-hidden="true" size={15} fill="currentColor" strokeWidth={1.8} />
                      </button>
                      <button
                        className="icon-button"
                        type="button"
                        aria-label={`停止 ${application.packageName}`}
                        title="停止应用"
                        disabled={actionMutation.isPending}
                        onClick={() =>
                          actionMutation.mutate({
                            action: "app.stop",
                            appId: application.packageName,
                          })
                        }
                      >
                        <Square
                          aria-hidden="true"
                          size={14}
                          fill="currentColor"
                          strokeWidth={1.8}
                        />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filteredApplications.length > 0 && (
        <div className="manager-pagination" aria-label="应用列表分页">
          <span>
            {filteredApplications.length} 个应用，第 {currentPage + 1} / {pageCount} 页
          </span>
          <div>
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
            >
              上一页
            </button>
            <button
              type="button"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            >
              下一页
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
