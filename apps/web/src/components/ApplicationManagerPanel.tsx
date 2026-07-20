import { useMutation, useQuery } from "@tanstack/react-query";
import { AppWindow, Package, Play, RefreshCw, Search, Square, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  AndroidDevice,
  DeviceApplication,
  DeviceApplicationFilter,
  DeviceControlAction,
} from "@device-robot/contracts";

import { executeDeviceAction } from "../api/device-control";
import { fetchDeviceApplications } from "../api/device-management";

type ApplicationManagerPanelProps = {
  device: AndroidDevice;
  onRequestApkInstall(): void;
};

const APPLICATIONS_PER_PAGE = 50;

function sourceLabel(source: DeviceApplication["source"]): string {
  return source === "user" ? "用户安装" : "系统预装";
}

export function ApplicationManagerPanel({
  device,
  onRequestApkInstall,
}: ApplicationManagerPanelProps): React.JSX.Element {
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
    return (applicationsQuery.data?.applications ?? []).filter((application) =>
      application.packageName.toLocaleLowerCase().includes(normalizedSearch),
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

      {(applicationsQuery.isError || actionError !== undefined) && (
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
                <th scope="col">应用包名</th>
                <th scope="col">来源</th>
                <th scope="col">版本号</th>
                <th scope="col">安装路径</th>
                <th scope="col" aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {applications.map((application) => (
                <tr key={application.packageName}>
                  <td>
                    <span className="application-name">
                      <Package aria-hidden="true" size={19} strokeWidth={1.7} />
                      <code>{application.packageName}</code>
                    </span>
                  </td>
                  <td>
                    <span className={`application-source ${application.source}`}>
                      {sourceLabel(application.source)}
                    </span>
                  </td>
                  <td>{application.versionCode ?? "未读取"}</td>
                  <td>
                    <code className="application-path">{application.apkPath ?? "未读取"}</code>
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
