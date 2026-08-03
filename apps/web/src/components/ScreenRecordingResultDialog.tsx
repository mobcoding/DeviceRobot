import { CheckCircle2, FolderOpen, LoaderCircle, X } from "lucide-react";
import type { ScreenRecordingResult } from "@device-robot/contracts";

type ScreenRecordingResultDialogProps = {
  result: ScreenRecordingResult;
  openingLocation: boolean;
  error?: string;
  onClose(): void;
  onOpenLocation(): void;
};

export function ScreenRecordingResultDialog({
  result,
  openingLocation,
  error,
  onClose,
  onOpenLocation,
}: ScreenRecordingResultDialogProps): React.JSX.Element {
  return (
    <div className="modal-backdrop">
      <section
        className="screen-recording-result-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="screen-recording-result-title"
      >
        <header>
          <div>
            <CheckCircle2 aria-hidden="true" size={21} strokeWidth={1.8} />
            <h2 id="screen-recording-result-title">录制完成</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭录制结果"
            title="关闭"
            disabled={openingLocation}
            onClick={onClose}
          >
            <X aria-hidden="true" size={17} strokeWidth={1.8} />
          </button>
        </header>
        <div className="screen-recording-result-content">
          <p>视频已保存</p>
          <code title={result.savedPath}>{result.savedPath}</code>
          {error !== undefined && (
            <p className="screen-recording-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer>
          <button
            className="subtle-action dialog-command"
            type="button"
            disabled={openingLocation}
            onClick={onClose}
          >
            关闭
          </button>
          <button
            className="primary-command dialog-command"
            type="button"
            disabled={openingLocation}
            onClick={onOpenLocation}
          >
            {openingLocation ? (
              <LoaderCircle aria-hidden="true" size={15} className="test-run-spinner" />
            ) : (
              <FolderOpen aria-hidden="true" size={15} />
            )}
            打开保存位置
          </button>
        </footer>
      </section>
    </div>
  );
}
