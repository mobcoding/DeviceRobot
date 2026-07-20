import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryProps = {
  children: ReactNode;
};

type ErrorBoundaryState = {
  error?: Error;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = {};

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("DeviceRobot Web UI crashed", error, errorInfo);
  }

  public override render(): ReactNode {
    if (this.state.error !== undefined) {
      return (
        <main className="fatal-error">
          <p className="eyebrow">界面错误</p>
          <h1>DeviceRobot 无法渲染此页面。</h1>
          <p>请刷新页面后重试。如问题持续出现，请查看本地 Agent 日志。</p>
          <button type="button" onClick={() => globalThis.location.reload()}>
            重新加载应用
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}
