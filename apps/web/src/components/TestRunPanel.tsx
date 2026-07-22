import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleX,
  Clock3,
  Image,
  LoaderCircle,
  RefreshCw,
  Smartphone,
  Square,
} from "lucide-react";
import { useState } from "react";
import type { TestExecutionRun, TestStepExecution } from "@device-robot/contracts";

import { cancelTestExecution, fetchTestRuns, testStepScreenshotUrl } from "../api/test-execution";

function statusLabel(status: TestExecutionRun["status"] | TestStepExecution["status"]): string {
  switch (status) {
    case "running":
      return "执行中";
    case "succeeded":
      return "通过";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "pending":
      return "等待中";
  }
}

function statusIcon(
  status: TestExecutionRun["status"] | TestStepExecution["status"],
): React.JSX.Element {
  const props = { "aria-hidden": true, size: 15, strokeWidth: 1.9 };
  switch (status) {
    case "succeeded":
      return <CheckCircle2 {...props} />;
    case "failed":
      return <CircleX {...props} />;
    case "running":
      return <LoaderCircle {...props} className="test-run-spinner" />;
    case "cancelled":
      return <CircleX {...props} />;
    case "pending":
      return <Clock3 {...props} />;
  }
}

function dateTime(value: string | undefined): string {
  if (value === undefined) {
    return "--";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function TestStep({
  run,
  step,
  expanded,
  onToggleScreenshot,
}: {
  run: TestExecutionRun;
  step: TestStepExecution;
  expanded: boolean;
  onToggleScreenshot(): void;
}): React.JSX.Element {
  return (
    <li className={`test-step test-step-${step.status}`}>
      <span className="test-step-index">{step.index + 1}</span>
      <div className="test-step-main">
        <div>
          <code>{step.action.action}</code>
          <span className={`test-status test-status-${step.status}`}>
            {statusIcon(step.status)}
            {statusLabel(step.status)}
          </span>
        </div>
        {step.message !== undefined && <p className="test-step-message">{step.message}</p>}
      </div>
      {step.screenshotAvailable && (
        <button
          className="icon-button test-screenshot-button"
          type="button"
          aria-label={expanded ? "收起步骤截图" : "查看步骤截图"}
          title={expanded ? "收起步骤截图" : "查看步骤截图"}
          aria-expanded={expanded}
          onClick={onToggleScreenshot}
        >
          <Image aria-hidden="true" size={16} strokeWidth={1.8} />
        </button>
      )}
      {expanded && step.screenshotAvailable && (
        <img
          className="test-step-screenshot"
          src={testStepScreenshotUrl(run.id, step.index)}
          alt={`步骤 ${step.index + 1} 的设备截图`}
        />
      )}
    </li>
  );
}

export function TestRunPanel(): React.JSX.Element {
  const [expandedScreenshot, setExpandedScreenshot] = useState<string>();
  const queryClient = useQueryClient();
  const runsQuery = useQuery({
    queryKey: ["test-runs"],
    queryFn: ({ signal }) => fetchTestRuns(signal),
    retry: 1,
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => run.status === "running") ? 1_000 : 8_000,
  });
  const cancelMutation = useMutation({
    mutationFn: cancelTestExecution,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["test-runs"] });
    },
  });
  const runs = runsQuery.data?.runs ?? [];
  const error = runsQuery.isError
    ? runsQuery.error.message
    : cancelMutation.isError
      ? cancelMutation.error.message
      : undefined;

  return (
    <section className="management-workspace test-run-panel" aria-label="测试运行">
      <header className="management-heading">
        <div className="management-title-row">
          <CheckCircle2 aria-hidden="true" size={28} strokeWidth={1.7} />
          <div>
            <h1>测试运行</h1>
            <p>已审核的 AI 操作计划会通过 Appium 与 UiAutomator2 在当前设备执行。</p>
          </div>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="刷新测试运行"
          title="刷新测试运行"
          disabled={runsQuery.isFetching}
          onClick={() => void runsQuery.refetch()}
        >
          <RefreshCw aria-hidden="true" size={17} strokeWidth={1.8} />
        </button>
      </header>

      {error !== undefined && (
        <p className="management-error" role="alert">
          {error}
        </p>
      )}

      {runs.length === 0 ? (
        <section className="test-run-empty" aria-label="暂无测试运行">
          <Clock3 aria-hidden="true" size={22} strokeWidth={1.6} />
          <div>
            <strong>暂无测试运行</strong>
            <p>在“AI 与用例”中生成并审核计划后，即可选择执行。</p>
          </div>
        </section>
      ) : (
        <div className="test-run-list">
          {runs.map((run) => {
            const openStep =
              expandedScreenshot ===
              `${run.id}:${run.steps.find((step) => step.screenshotAvailable)?.index ?? -1}`;
            return (
              <article key={run.id} className={`test-run-card test-run-${run.status}`}>
                <header className="test-run-card-header">
                  <div>
                    <div className="test-run-title-row">
                      <h2>{run.name}</h2>
                      <span className={`test-status test-status-${run.status}`}>
                        {statusIcon(run.status)}
                        {statusLabel(run.status)}
                      </span>
                    </div>
                    <p>
                      <Smartphone aria-hidden="true" size={14} strokeWidth={1.8} />
                      {run.deviceSerial}
                      <span>包名：{run.appId}</span>
                    </p>
                  </div>
                  {run.status === "running" && (
                    <button
                      className="icon-button danger-icon-button"
                      type="button"
                      aria-label="取消测试运行"
                      title="取消测试运行"
                      disabled={cancelMutation.isPending}
                      onClick={() => cancelMutation.mutate(run.id)}
                    >
                      <Square aria-hidden="true" size={15} fill="currentColor" strokeWidth={1.8} />
                    </button>
                  )}
                </header>
                <div className="test-run-meta">
                  <span>开始：{dateTime(run.startedAt)}</span>
                  <span>结束：{dateTime(run.finishedAt)}</span>
                </div>
                {run.message !== undefined && <p className="test-run-message">{run.message}</p>}
                <ol className="test-step-list">
                  {run.steps.map((step) => {
                    const screenshotKey = `${run.id}:${step.index}`;
                    return (
                      <TestStep
                        key={screenshotKey}
                        run={run}
                        step={step}
                        expanded={expandedScreenshot === screenshotKey}
                        onToggleScreenshot={() =>
                          setExpandedScreenshot((current) =>
                            current === screenshotKey ? undefined : screenshotKey,
                          )
                        }
                      />
                    );
                  })}
                </ol>
                {openStep && <span className="visually-hidden">已展开步骤截图</span>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
