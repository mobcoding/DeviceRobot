import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, LoaderCircle, Upload, X } from "lucide-react";
import { useState } from "react";
import type { AndroidDevice } from "@device-robot/contracts";

import { uploadDeviceFile } from "../api/device-management";
import { formatBytes, formatDeviceName } from "../ui/formatters";

type FileUploadDialogProps = {
  device: AndroidDevice;
  directory: string;
  file: File;
  onClose(): void;
};

export function FileUploadDialog({
  device,
  directory,
  file,
  onClose,
}: FileUploadDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const [uploadedPath, setUploadedPath] = useState<string>();
  const uploadMutation = useMutation({
    mutationFn: async () => await uploadDeviceFile(device.serial, directory, file),
    onSuccess: async (response) => {
      setUploadedPath(response.path);
      await queryClient.invalidateQueries({ queryKey: ["device-files", device.serial] });
    },
  });

  const uploaded = uploadMutation.isSuccess;
  const close = (): void => {
    if (!uploadMutation.isPending) {
      onClose();
    }
  };

  return (
    <div className="modal-backdrop">
      <section
        className="apk-install-dialog file-upload-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-upload-title"
      >
        <header>
          <div>
            <Upload aria-hidden="true" size={23} strokeWidth={1.7} />
            <h2 id="file-upload-title">上传文件</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭上传窗口"
            title="关闭"
            disabled={uploadMutation.isPending}
            onClick={close}
          >
            <X aria-hidden="true" size={17} strokeWidth={1.8} />
          </button>
        </header>

        <div className="apk-install-content">
          {!uploaded && (
            <dl className="apk-metadata-grid">
              <div>
                <dt>文件</dt>
                <dd>{file.name}</dd>
                <small>{formatBytes(file.size)}</small>
              </div>
              <div>
                <dt>目标设备</dt>
                <dd>{formatDeviceName(device)}</dd>
                <small>{device.serial}</small>
              </div>
              <div className="apk-hash-row">
                <dt>目标目录</dt>
                <dd>
                  <code>{directory}</code>
                </dd>
              </div>
            </dl>
          )}

          {uploadMutation.isPending && (
            <div className="apk-progress" role="status">
              <LoaderCircle aria-hidden="true" size={22} strokeWidth={1.8} />
              <span>正在上传到 {formatDeviceName(device)}</span>
            </div>
          )}

          {uploadMutation.isError && (
            <p className="management-error" role="alert">
              {uploadMutation.error.message}
            </p>
          )}

          {uploaded && (
            <div className="apk-install-success" role="status">
              <CheckCircle2 aria-hidden="true" size={25} strokeWidth={1.8} />
              <div>
                <strong>上传完成</strong>
                <span>{uploadedPath}</span>
              </div>
            </div>
          )}
        </div>

        <footer>
          {!uploaded && (
            <button
              className="subtle-action dialog-command"
              type="button"
              disabled={uploadMutation.isPending}
              onClick={close}
            >
              取消
            </button>
          )}
          {!uploaded && (
            <button
              className="primary-command dialog-command"
              type="button"
              disabled={uploadMutation.isPending}
              onClick={() => uploadMutation.mutate()}
            >
              {uploadMutation.isPending ? "上传中" : "确认上传"}
            </button>
          )}
          {uploaded && (
            <button className="primary-command dialog-command" type="button" onClick={close}>
              完成
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
