import { useQuery } from "@tanstack/react-query";

import { fetchHealth } from "./api/health";

const navigationItems = [
  { label: "Overview", icon: "OV", active: true },
  { label: "Projects", icon: "PR", active: false },
  { label: "Devices", icon: "DV", active: false },
  { label: "AI conversations", icon: "AI", active: false },
  { label: "Test runs", icon: "TR", active: false },
  { label: "Reports", icon: "RP", active: false },
] as const;

const roadmap = [
  { label: "Workspace foundation", status: "Ready" },
  { label: "ADB and screen control", status: "Planned" },
  { label: "Source-aware AI testing", status: "Planned" },
] as const;

function formatStartedAt(value: string | undefined): string {
  if (value === undefined) {
    return "Not available";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

export function App(): React.JSX.Element {
  const healthQuery = useQuery({
    queryKey: ["agent-health"],
    queryFn: ({ signal }) => fetchHealth(signal),
    retry: 1,
    refetchInterval: 10_000,
  });

  const agentStatus = healthQuery.isPending
    ? "Checking"
    : healthQuery.isError
      ? "Unavailable"
      : healthQuery.data.status === "ok"
        ? "Connected"
        : "Degraded";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            DR
          </span>
          <div>
            <strong>DeviceRobot</strong>
            <span>Local AI testing</span>
          </div>
        </div>

        <nav aria-label="Primary navigation">
          {navigationItems.map((item) => (
            <button
              className={item.active ? "nav-item active" : "nav-item"}
              type="button"
              key={item.label}
            >
              <span className="nav-icon" aria-hidden="true">
                {item.icon}
              </span>
              <span>{item.label}</span>
              {!item.active && <small>Planned</small>}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <span className={`status-dot ${healthQuery.isError ? "error" : ""}`} />
          Agent {agentStatus.toLowerCase()}
        </div>
      </aside>

      <main className="content">
        <header className="page-header">
          <div>
            <p className="eyebrow">Workspace overview</p>
            <h1>Local Android automation, ready to grow.</h1>
            <p className="subtitle">
              DeviceRobot keeps source analysis, device control, execution evidence, and reports on
              this machine.
            </p>
          </div>
          <span className={`connection-badge ${healthQuery.isError ? "error" : ""}`}>
            {agentStatus}
          </span>
        </header>

        {healthQuery.isError && (
          <section className="notice error-notice" role="alert">
            <strong>Local Agent is unavailable.</strong>
            <span>{healthQuery.error.message}</span>
          </section>
        )}

        <section className="metrics" aria-label="Agent status">
          <article className="metric-card featured">
            <span>Agent state</span>
            <strong>{agentStatus}</strong>
            <small>Checked every 10 seconds</small>
          </article>
          <article className="metric-card">
            <span>Agent version</span>
            <strong>{healthQuery.data?.version ?? "—"}</strong>
            <small>Installed runtime</small>
          </article>
          <article className="metric-card">
            <span>Devices</span>
            <strong>—</strong>
            <small>ADB integration is planned</small>
          </article>
          <article className="metric-card">
            <span>Test runs</span>
            <strong>—</strong>
            <small>Execution engine is planned</small>
          </article>
        </section>

        <section className="detail-grid">
          <article className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Runtime details</p>
                <h2>Local Agent</h2>
              </div>
              <span className="panel-chip">localhost only</span>
            </div>
            <dl className="detail-list">
              <div>
                <dt>Started</dt>
                <dd>{formatStartedAt(healthQuery.data?.startedAt)}</dd>
              </div>
              <div>
                <dt>Data directory</dt>
                <dd className="path-value">{healthQuery.data?.dataDirectory ?? "Not available"}</dd>
              </div>
              <div>
                <dt>API endpoint</dt>
                <dd>127.0.0.1:43110</dd>
              </div>
            </dl>
          </article>

          <article className="panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Delivery roadmap</p>
                <h2>Implementation status</h2>
              </div>
            </div>
            <ol className="roadmap">
              {roadmap.map((item, index) => (
                <li key={item.label}>
                  <span className="roadmap-index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="roadmap-label">{item.label}</span>
                  <span
                    className={item.status === "Ready" ? "roadmap-status ready" : "roadmap-status"}
                  >
                    {item.status}
                  </span>
                </li>
              ))}
            </ol>
          </article>
        </section>
      </main>
    </div>
  );
}
