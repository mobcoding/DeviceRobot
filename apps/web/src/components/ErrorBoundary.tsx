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
          <p className="eyebrow">UI failure</p>
          <h1>DeviceRobot could not render this page.</h1>
          <p>{this.state.error.message}</p>
          <button type="button" onClick={() => globalThis.location.reload()}>
            Reload application
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}
