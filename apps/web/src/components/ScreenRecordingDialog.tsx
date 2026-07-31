import { LoaderCircle, Video, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ScreenRecordingConfiguration } from "@device-robot/contracts";

type ScreenRecordingDialogProps = {
  configuration: ScreenRecordingConfiguration;
  maxDurationSeconds: number;
  starting: boolean;
  error?: string;
  onCancel(): void;
  onStart(configuration: ScreenRecordingConfiguration): void;
};

export function ScreenRecordingDialog({
  configuration,
  maxDurationSeconds,
  starting,
  error,
  onCancel,
  onStart,
}: ScreenRecordingDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState(configuration);

  useEffect(() => {
    setDraft(configuration);
  }, [configuration]);

  const valid =
    Number.isInteger(draft.bitRateMbps) &&
    draft.bitRateMbps >= 1 &&
    draft.bitRateMbps <= 20 &&
    draft.outputDirectory.trim().length > 0;

  return (
    <div className="modal-backdrop">
      <section
        className="screen-recording-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="screen-recording-title"
      >
        <header>
          <div>
            <Video aria-hidden="true" size={21} strokeWidth={1.8} />
            <h2 id="screen-recording-title">录屏选项</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭录屏选项"
            title="关闭"
            disabled={starting}
            onClick={onCancel}
          >
            <X aria-hidden="true" size={17} strokeWidth={1.8} />
          </button>
        </header>

        <form
          className="screen-recording-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && !starting) {
              onStart({ ...draft, outputDirectory: draft.outputDirectory.trim() });
            }
          }}
        >
          <p>单次录制最长 {Math.round(maxDurationSeconds / 60)} 分钟。</p>

          <label className="screen-recording-field">
            <span>码率 (Mbps)</span>
            <input
              aria-label="录屏码率"
              type="number"
              min="1"
              max="20"
              step="1"
              value={draft.bitRateMbps}
              disabled={starting}
              onChange={(event) => {
                const value = Number.parseInt(event.target.value, 10);
                setDraft((current) => ({ ...current, bitRateMbps: value }));
              }}
            />
          </label>

          <label className="screen-recording-field">
            <span>分辨率（原生）</span>
            <select
              aria-label="录屏分辨率"
              value={draft.resolutionPercent}
              disabled={starting}
              onChange={(event) => {
                setDraft((current) => ({
                  ...current,
                  resolutionPercent: Number.parseInt(event.target.value, 10) as 50 | 75 | 100,
                }));
              }}
            >
              <option value="100">100%</option>
              <option value="75">75%</option>
              <option value="50">50%</option>
            </select>
          </label>

          <label className="screen-recording-checkbox">
            <input
              type="checkbox"
              checked={draft.showTouches}
              disabled={starting}
              onChange={(event) => {
                setDraft((current) => ({ ...current, showTouches: event.target.checked }));
              }}
            />
            <span>显示触点</span>
          </label>

          <label className="screen-recording-field screen-recording-path-field">
            <span>保存到</span>
            <input
              aria-label="录屏保存目录"
              type="text"
              maxLength={1_024}
              value={draft.outputDirectory}
              disabled={starting}
              onChange={(event) => {
                setDraft((current) => ({ ...current, outputDirectory: event.target.value }));
              }}
            />
          </label>

          {error !== undefined && (
            <p className="screen-recording-error" role="alert">
              {error}
            </p>
          )}

          <footer>
            <button
              className="subtle-action dialog-command"
              type="button"
              disabled={starting}
              onClick={onCancel}
            >
              取消
            </button>
            <button
              className="primary-command dialog-command"
              type="submit"
              disabled={!valid || starting}
            >
              {starting ? (
                <LoaderCircle aria-hidden="true" size={15} className="test-run-spinner" />
              ) : (
                <Video aria-hidden="true" size={15} />
              )}
              开始录制
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
