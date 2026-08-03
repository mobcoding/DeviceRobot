import { useMutation } from "@tanstack/react-query";
import { CircleHelp, Eraser, LoaderCircle, Maximize2, Minimize2, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AndroidDevice } from "@device-robot/contracts";

import { useAgentUnavailable } from "../agent-availability";
import { executeDeviceTerminalCommand } from "../api/device-terminal";

type DeviceTerminalPanelProps = {
  device: AndroidDevice;
};

type TerminalEntry = {
  id: number;
  command: string;
  output: string;
  exitCode?: number;
};

function terminalPrompt(device: AndroidDevice): string {
  const name = device.model?.trim().replaceAll(/\s+/gu, "-").toLocaleLowerCase();
  return `${name?.length ? name : "android"}:/ $`;
}

export function DeviceTerminalPanel({ device }: DeviceTerminalPanelProps): React.JSX.Element {
  const agentUnavailable = useAgentUnavailable();
  const [command, setCommand] = useState("");
  const [entries, setEntries] = useState<readonly TerminalEntry[]>([]);
  const [history, setHistory] = useState<readonly string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | undefined>();
  const [helpOpen, setHelpOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const frameRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const outputEndRef = useRef<HTMLDivElement>(null);
  const prompt = terminalPrompt(device);
  const commandMutation = useMutation({
    mutationFn: async (value: string) => await executeDeviceTerminalCommand(device.serial, value),
  });

  useEffect(() => {
    const onFullscreenChange = (): void =>
      setFullscreen(document.fullscreenElement === frameRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    outputEndRef.current?.scrollIntoView?.({ block: "end" });
  }, [entries, commandMutation.isPending]);

  const submit = (): void => {
    const value = command.trim();
    if (value.length === 0 || commandMutation.isPending || agentUnavailable) {
      return;
    }

    setCommand("");
    setHistoryIndex(undefined);
    setHistory((current) => [value, ...current.filter((item) => item !== value)].slice(0, 100));
    commandMutation.mutate(value, {
      onSuccess: (response) => {
        setEntries((current) => [
          ...current,
          {
            id: Date.now(),
            command: response.command,
            output: response.output,
            exitCode: response.exitCode,
          },
        ]);
      },
      onError: (error) => {
        setEntries((current) => [
          ...current,
          {
            id: Date.now(),
            command: value,
            output: error instanceof Error ? error.message : "终端命令执行失败。",
          },
        ]);
      },
    });
  };

  const cycleHistory = (direction: -1 | 1): void => {
    if (history.length === 0) {
      return;
    }
    const nextIndex =
      historyIndex === undefined
        ? direction === -1
          ? 0
          : undefined
        : Math.min(Math.max(historyIndex + direction, 0), history.length);
    setHistoryIndex(nextIndex);
    setCommand(
      nextIndex === undefined || nextIndex === history.length ? "" : (history[nextIndex] ?? ""),
    );
  };

  const toggleFullscreen = async (): Promise<void> => {
    if (document.fullscreenElement === frameRef.current) {
      await document.exitFullscreen();
      return;
    }
    await frameRef.current?.requestFullscreen();
  };

  return (
    <section ref={frameRef} className="terminal-workspace" aria-label="终端">
      <header className="terminal-heading">
        <div className="management-title-row">
          <Terminal aria-hidden="true" size={29} strokeWidth={1.7} />
          <h1>终端</h1>
        </div>
        <div className="terminal-actions">
          <button
            className="icon-button"
            type="button"
            aria-label="终端帮助"
            title="终端帮助"
            onClick={() => setHelpOpen(true)}
          >
            <CircleHelp aria-hidden="true" size={18} strokeWidth={1.8} />
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label={fullscreen ? "退出全屏" : "全屏终端"}
            title={fullscreen ? "退出全屏" : "全屏终端"}
            onClick={() => void toggleFullscreen()}
          >
            {fullscreen ? (
              <Minimize2 aria-hidden="true" size={18} strokeWidth={1.8} />
            ) : (
              <Maximize2 aria-hidden="true" size={18} strokeWidth={1.8} />
            )}
          </button>
          <button
            className="icon-button"
            type="button"
            aria-label="清除终端输出"
            title="清除终端输出"
            disabled={entries.length === 0}
            onClick={() => {
              setEntries([]);
              inputRef.current?.focus();
            }}
          >
            <Eraser aria-hidden="true" size={18} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      <div className="terminal-surface" onClick={() => inputRef.current?.focus()}>
        <div className="terminal-scroll" role="log" aria-live="polite">
          {entries.map((entry) => (
            <div key={entry.id} className="terminal-entry">
              <div className="terminal-command-line">
                <span className="terminal-prompt">{prompt}</span>
                <code>{entry.command}</code>
              </div>
              {entry.output.length > 0 && (
                <pre className={entry.exitCode === 0 ? "terminal-output" : "terminal-output error"}>
                  {entry.output}
                </pre>
              )}
              {entry.exitCode !== undefined && entry.exitCode !== 0 && (
                <p className="terminal-exit-code">进程退出码：{entry.exitCode}</p>
              )}
            </div>
          ))}
          {commandMutation.isPending && (
            <div className="terminal-running" aria-label="正在执行终端命令">
              <LoaderCircle aria-hidden="true" size={15} strokeWidth={1.8} />
              <span>正在执行</span>
            </div>
          )}
          <div className="terminal-command-line terminal-active-line">
            <span className="terminal-prompt">{prompt}</span>
            <input
              ref={inputRef}
              aria-label="终端命令"
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              disabled={commandMutation.isPending || agentUnavailable}
              spellCheck={false}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  cycleHistory(-1);
                } else if (event.key === "ArrowDown") {
                  event.preventDefault();
                  cycleHistory(1);
                }
              }}
            />
          </div>
          <div ref={outputEndRef} />
        </div>
      </div>

      {helpOpen && (
        <div
          className="terminal-help-backdrop"
          role="presentation"
          onMouseDown={() => setHelpOpen(false)}
        >
          <section
            className="terminal-help"
            role="dialog"
            aria-label="终端帮助"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2>终端</h2>
            <code>getprop ro.product.model</code>
            <code>pm list packages</code>
            <code>logcat -d -t 100</code>
            <button type="button" onClick={() => setHelpOpen(false)}>
              关闭
            </button>
          </section>
        </div>
      )}
    </section>
  );
}
