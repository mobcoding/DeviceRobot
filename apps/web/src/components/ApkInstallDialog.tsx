import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, LoaderCircle, PackageCheck, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AndroidDevice, ApkArtifact } from "@device-robot/contracts";

import { discardApk, installApk, uploadApk } from "../api/apk";
import { formatBytes, formatDeviceName } from "../ui/formatters";

type ApkInstallDialogProps = {
  device: AndroidDevice;
  file?: File;
  initialError?: string;
  onClose(): void;
};

export function ApkInstallDialog({
  device,
  file,
  initialError,
  onClose,
}: ApkInstallDialogProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const artifactRef = useRef<ApkArtifact | undefined>(undefined);
  const installedRef = useRef(false);
  const [artifact, setArtifact] = useState<ApkArtifact>();
  const [uploadError, setUploadError] = useState<string>(initialError ?? "");
  const [uploading, setUploading] = useState(file !== undefined && initialError === undefined);
  const [replaceExisting, setReplaceExisting] = useState(true);
  const [allowTestPackage, setAllowTestPackage] = useState(true);

  useEffect(() => {
    if (file === undefined || initialError !== undefined) {
      return undefined;
    }

    const controller = new AbortController();
    let disposed = false;
    void uploadApk(file, controller.signal)
      .then((uploadedArtifact) => {
        if (disposed) {
          void discardApk(uploadedArtifact.id);
          return;
        }
        artifactRef.current = uploadedArtifact;
        setArtifact(uploadedArtifact);
        setUploading(false);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setUploadError(error instanceof Error ? error.message : "APK 上传失败。");
          setUploading(false);
        }
      });

    return () => {
      disposed = true;
      controller.abort();
      if (artifactRef.current !== undefined && !installedRef.current) {
        void discardApk(artifactRef.current.id);
      }
    };
  }, [file, initialError]);

  const installMutation = useMutation({
    mutationFn: async () => {
      if (artifact === undefined) {
        throw new Error("APK 尚未完成上传。");
      }
      return await installApk(device.serial, artifact.id, {
        replaceExisting,
        allowTestPackage,
        uninstallExisting: false,
      });
    },
    onSuccess: async () => {
      installedRef.current = true;
      await queryClient.invalidateQueries({ queryKey: ["device-applications", device.serial] });
    },
  });

  const close = (): void => {
    if (installMutation.isPending) {
      return;
    }
    onClose();
  };

  const error =
    uploadError || (installMutation.isError ? installMutation.error.message : undefined);
  const installed = installMutation.isSuccess;

  return (
    <div className="modal-backdrop">
      <section
        className="apk-install-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="apk-install-title"
      >
        <header>
          <div>
            <PackageCheck aria-hidden="true" size={23} strokeWidth={1.7} />
            <h2 id="apk-install-title">安装 APK</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭安装窗口"
            title="关闭"
            disabled={installMutation.isPending}
            onClick={close}
          >
            <X aria-hidden="true" size={17} strokeWidth={1.8} />
          </button>
        </header>

        <div className="apk-install-content">
          {uploading && (
            <div className="apk-progress" role="status">
              <LoaderCircle aria-hidden="true" size={22} strokeWidth={1.8} />
              <span>正在上传并解析 {file?.name}</span>
            </div>
          )}

          {error !== undefined && error.length > 0 && (
            <p className="management-error" role="alert">
              {error}
            </p>
          )}

          {artifact !== undefined && !installed && (
            <>
              <dl className="apk-metadata-grid">
                <div>
                  <dt>应用</dt>
                  <dd>{artifact.metadata.applicationLabel ?? artifact.metadata.packageName}</dd>
                  <small>{artifact.metadata.packageName}</small>
                </div>
                <div>
                  <dt>版本</dt>
                  <dd>{artifact.metadata.versionName ?? "未声明"}</dd>
                  <small>
                    versionCode {artifact.metadata.versionCode}
                    {artifact.metadata.minSdkVersion === undefined
                      ? ""
                      : ` · SDK ${artifact.metadata.minSdkVersion}-${artifact.metadata.targetSdkVersion ?? "?"}`}
                  </small>
                </div>
                <div>
                  <dt>文件</dt>
                  <dd>{artifact.fileName}</dd>
                  <small>{formatBytes(artifact.sizeBytes)}</small>
                </div>
                <div>
                  <dt>目标设备</dt>
                  <dd>{formatDeviceName(device)}</dd>
                  <small>{device.serial}</small>
                </div>
                <div className="apk-hash-row">
                  <dt>SHA-256</dt>
                  <dd>
                    <code>{artifact.sha256}</code>
                  </dd>
                </div>
              </dl>

              <div className="apk-install-options">
                <label>
                  <input
                    type="checkbox"
                    checked={replaceExisting}
                    onChange={(event) => setReplaceExisting(event.target.checked)}
                  />
                  <span>覆盖已安装版本</span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={allowTestPackage}
                    onChange={(event) => setAllowTestPackage(event.target.checked)}
                  />
                  <span>允许测试 APK</span>
                </label>
              </div>
            </>
          )}

          {installMutation.isPending && (
            <div className="apk-progress" role="status">
              <LoaderCircle aria-hidden="true" size={22} strokeWidth={1.8} />
              <span>正在安装到 {formatDeviceName(device)}</span>
            </div>
          )}

          {installed && (
            <div className="apk-install-success" role="status">
              <CheckCircle2 aria-hidden="true" size={25} strokeWidth={1.8} />
              <div>
                <strong>安装完成</strong>
                <span>{artifact?.metadata.packageName}</span>
              </div>
            </div>
          )}
        </div>

        <footer>
          {!installed && (
            <button
              className="subtle-action dialog-command"
              type="button"
              disabled={installMutation.isPending}
              onClick={close}
            >
              取消
            </button>
          )}
          {artifact !== undefined && !installed && (
            <button
              className="primary-command dialog-command"
              type="button"
              disabled={installMutation.isPending}
              onClick={() => installMutation.mutate()}
            >
              {installMutation.isPending ? "安装中" : "安装"}
            </button>
          )}
          {installed && (
            <button className="primary-command dialog-command" type="button" onClick={close}>
              完成
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
