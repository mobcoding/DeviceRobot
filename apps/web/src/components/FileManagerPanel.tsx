import { useQuery } from "@tanstack/react-query";
import {
  ArrowUp,
  ChevronRight,
  File,
  FolderOpen,
  HardDrive,
  House,
  Link2,
  RefreshCw,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { AndroidDevice, DeviceFileEntry } from "@device-robot/contracts";

import { fetchDeviceFiles } from "../api/device-management";

type FileManagerPanelProps = {
  device: AndroidDevice;
};

function fileIcon(entry: DeviceFileEntry): React.JSX.Element {
  const iconProps = { "aria-hidden": true, size: 17, strokeWidth: 1.7 };
  switch (entry.kind) {
    case "directory":
      return <FolderOpen {...iconProps} />;
    case "link":
      return <Link2 {...iconProps} />;
    default:
      return <File {...iconProps} />;
  }
}

function fileKindLabel(entry: DeviceFileEntry): string {
  switch (entry.kind) {
    case "directory":
      return "文件夹";
    case "link":
      return "链接";
    case "other":
      return "其他";
    default:
      return "文件";
  }
}

export function FileManagerPanel({ device }: FileManagerPanelProps): React.JSX.Element {
  const [currentPath, setCurrentPath] = useState<string>();
  const [pathInput, setPathInput] = useState("");
  const filesQuery = useQuery({
    queryKey: ["device-files", device.serial, currentPath],
    queryFn: ({ signal }) => fetchDeviceFiles(device.serial, currentPath, signal),
    enabled: currentPath !== undefined,
    retry: false,
  });

  useEffect(() => {
    setCurrentPath(undefined);
    setPathInput("");
  }, [device.serial]);

  useEffect(() => {
    setPathInput(currentPath ?? "");
  }, [currentPath]);

  const navigateTo = (path: string): void => {
    setCurrentPath(path);
  };

  const submitPath = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const path = pathInput.trim();
    if (path.length > 0) {
      navigateTo(path);
    }
  };

  const currentDirectory = filesQuery.data?.path ?? currentPath;

  return (
    <section className="management-workspace file-manager" aria-label="文件管理器">
      <header className="management-heading">
        <div className="management-title-row">
          <FolderOpen aria-hidden="true" size={29} strokeWidth={1.7} />
          <h1>文件管理器</h1>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="刷新文件列表"
          title="刷新文件列表"
          disabled={currentPath === undefined || filesQuery.isFetching}
          onClick={() => void filesQuery.refetch()}
        >
          <RefreshCw aria-hidden="true" size={17} strokeWidth={1.8} />
        </button>
      </header>

      <div className="manager-toolbar">
        <button
          className="manager-path-home"
          type="button"
          onClick={() => setCurrentPath(undefined)}
          aria-current={currentPath === undefined ? "page" : undefined}
        >
          <House aria-hidden="true" size={16} strokeWidth={1.8} />
          <span>主页</span>
        </button>
        {filesQuery.data?.parentPath !== undefined && (
          <button
            className="icon-button"
            type="button"
            aria-label="返回上级目录"
            title="返回上级目录"
            onClick={() => navigateTo(filesQuery.data?.parentPath ?? "/")}
          >
            <ArrowUp aria-hidden="true" size={17} strokeWidth={1.8} />
          </button>
        )}
        <form className="manager-path-form" onSubmit={submitPath}>
          <input
            aria-label="设备文件路径"
            placeholder="输入绝对路径"
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
          />
          <button type="submit" disabled={pathInput.trim().length === 0}>
            打开
          </button>
        </form>
      </div>

      {filesQuery.isError && (
        <p className="management-error" role="alert">
          {filesQuery.error.message}
        </p>
      )}

      {currentDirectory === undefined ? (
        <div className="manager-home-list">
          <button type="button" onClick={() => navigateTo("/storage/emulated/0")}>
            <HardDrive aria-hidden="true" size={22} strokeWidth={1.6} />
            <span>
              <strong>内部共享存储空间</strong>
              <small>/storage/emulated/0</small>
            </span>
            <ChevronRight aria-hidden="true" size={18} strokeWidth={1.7} />
          </button>
          <button type="button" onClick={() => navigateTo("/")}>
            <span className="filesystem-root" aria-hidden="true">
              /
            </span>
            <span>
              <strong>文件系统根目录</strong>
              <small>/</small>
            </span>
            <ChevronRight aria-hidden="true" size={18} strokeWidth={1.7} />
          </button>
        </div>
      ) : filesQuery.data === undefined ? (
        <p className="management-empty">正在读取 {currentDirectory}</p>
      ) : filesQuery.data.entries.length === 0 ? (
        <p className="management-empty">此目录没有可显示的文件。</p>
      ) : (
        <div className="manager-table-wrap">
          <table className="manager-table file-table">
            <thead>
              <tr>
                <th scope="col">名称</th>
                <th scope="col">类型</th>
                <th scope="col">路径</th>
              </tr>
            </thead>
            <tbody>
              {filesQuery.data.entries.map((entry) => (
                <tr key={entry.path}>
                  <td>
                    {entry.kind === "directory" ? (
                      <button
                        className="file-entry-button"
                        type="button"
                        onClick={() => navigateTo(entry.path)}
                      >
                        {fileIcon(entry)}
                        <span>{entry.name}</span>
                      </button>
                    ) : (
                      <span className="file-entry-label">
                        {fileIcon(entry)}
                        <span>{entry.name}</span>
                      </span>
                    )}
                  </td>
                  <td>{fileKindLabel(entry)}</td>
                  <td>
                    <code>{entry.path}</code>
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
