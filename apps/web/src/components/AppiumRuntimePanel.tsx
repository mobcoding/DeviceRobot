import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppiumRuntime } from "@device-robot/contracts";

import { fetchAppiumRuntime, startAppiumRuntime, stopAppiumRuntime } from "../api/appium";

function stateLabel(state: AppiumRuntime["server"]["state"]): string {
  switch (state) {
    case "running":
      return "运行中";
    case "starting":
      return "启动中";
    case "failed":
      return "启动失败";
    default:
      return "未启动";
  }
}

function dependencyLabel(available: boolean): string {
  return available ? "已就绪" : "未就绪";
}

export function AppiumRuntimePanel(): React.JSX.Element {
  const queryClient = useQueryClient();
  const runtimeQuery = useQuery({
    queryKey: ["appium-runtime"],
    queryFn: ({ signal }) => fetchAppiumRuntime(signal),
    retry: 1,
    refetchInterval: 10_000,
  });
  const lifecycleMutation = useMutation({
    mutationFn: async (action: "start" | "stop") =>
      action === "start" ? await startAppiumRuntime() : await stopAppiumRuntime(),
    onSuccess: async (runtime) => {
      queryClient.setQueryData(["appium-runtime"], runtime);
      await queryClient.invalidateQueries({ queryKey: ["appium-runtime"] });
    },
  });
  const runtime = runtimeQuery.data;
  const activeOperation = lifecycleMutation.isPending ? lifecycleMutation.variables : undefined;
  const serverIsRunning =
    runtime?.server.state === "running" || runtime?.server.state === "starting";
  const canStart = runtime?.status === "ready" && !serverIsRunning;

  return (
    <section className="appium-runtime" aria-label="Appium 运行环境">
      <div className="section-heading">
        <div>
          <p className="eyebrow">测试执行基础设施</p>
          <h3>Appium + UiAutomator2</h3>
        </div>
        <div className="appium-runtime-actions">
          <span className={`device-state ${runtime?.status === "ready" ? "ready" : "warning"}`}>
            {runtime?.status === "ready" ? "环境已就绪" : "环境待配置"}
          </span>
          <button
            className="compact-button"
            type="button"
            disabled={lifecycleMutation.isPending || !canStart}
            aria-busy={activeOperation === "start" ? true : undefined}
            onClick={() => lifecycleMutation.mutate("start")}
          >
            {activeOperation === "start" ? "启动中..." : "启动服务"}
          </button>
          <button
            className="compact-button subtle-action"
            type="button"
            disabled={lifecycleMutation.isPending || !serverIsRunning}
            aria-busy={activeOperation === "stop" ? true : undefined}
            onClick={() => lifecycleMutation.mutate("stop")}
          >
            {activeOperation === "stop" ? "停止中..." : "停止服务"}
          </button>
        </div>
      </div>

      {runtimeQuery.isError ? (
        <p className="control-error">{runtimeQuery.error.message}</p>
      ) : runtime === undefined ? (
        <p className="control-empty">正在检查本机 Appium 运行环境...</p>
      ) : (
        <>
          {lifecycleMutation.isError && (
            <p className="control-error" role="alert">
              {lifecycleMutation.error.message}
            </p>
          )}
          <dl className="appium-runtime-list">
            <div>
              <dt>Appium</dt>
              <dd>{dependencyLabel(runtime.appium.available)}</dd>
              <small>{runtime.appium.version ?? runtime.appium.error ?? "未检测到版本"}</small>
            </div>
            <div>
              <dt>UiAutomator2</dt>
              <dd>{dependencyLabel(runtime.uiautomator2.available)}</dd>
              <small>
                {runtime.uiautomator2.version ?? runtime.uiautomator2.error ?? "未检测到 driver"}
              </small>
            </div>
            <div>
              <dt>Java</dt>
              <dd>{dependencyLabel(runtime.java.available)}</dd>
              <small>{runtime.java.version ?? runtime.java.error ?? "未检测到版本"}</small>
            </div>
            <div>
              <dt>Android SDK</dt>
              <dd>{dependencyLabel(runtime.androidSdk.available)}</dd>
              <small>{runtime.androidSdk.path ?? runtime.androidSdk.error ?? "未检测到 SDK"}</small>
            </div>
            <div>
              <dt>本地服务</dt>
              <dd>{stateLabel(runtime.server.state)}</dd>
              <small>
                {runtime.server.host}:{runtime.server.port}
              </small>
            </div>
          </dl>
          {runtime.issues.length > 0 && (
            <ul className="appium-runtime-issues">
              {runtime.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
