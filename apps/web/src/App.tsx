import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { fetchHealth } from "./api/health";

const viewIds = ["overview", "projects", "devices", "conversations", "runs", "reports"] as const;
type ViewId = (typeof viewIds)[number];

type NavigationItem = {
  id: ViewId;
  label: string;
  icon: string;
  status?: "Planned";
};

const navigationItems: readonly NavigationItem[] = [
  { id: "overview", label: "Overview", icon: "OV" },
  { id: "projects", label: "Projects", icon: "PR", status: "Planned" },
  { id: "devices", label: "Devices", icon: "DV", status: "Planned" },
  { id: "conversations", label: "AI conversations", icon: "AI", status: "Planned" },
  { id: "runs", label: "Test runs", icon: "TR", status: "Planned" },
  { id: "reports", label: "Reports", icon: "RP", status: "Planned" },
];

const roadmap = [
  { label: "Workspace foundation", status: "Ready" },
  { label: "ADB and screen control", status: "Planned" },
  { label: "Source-aware AI testing", status: "Planned" },
] as const;

const plannedViews: Record<Exclude<ViewId, "overview">, PlannedViewContent> = {
  projects: {
    eyebrow: "Repository intelligence",
    title: "Projects",
    description: "No Android projects are configured on this machine.",
    milestone: "Source analysis",
    capabilities: [
      "Local and Git repositories",
      "Gradle variants",
      "XML View and Compose indexing",
    ],
  },
  devices: {
    eyebrow: "Local hardware",
    title: "Devices",
    description: "ADB device discovery is not connected yet.",
    milestone: "Device control",
    capabilities: ["USB authorization", "Live screen control", "APK, files, and logcat"],
  },
  conversations: {
    eyebrow: "Agent workspace",
    title: "AI conversations",
    description: "There are no AI conversations in this workspace.",
    milestone: "AI testing",
    capabilities: ["Source-aware planning", "Structured actions", "Approval and trust policy"],
  },
  runs: {
    eyebrow: "Deterministic execution",
    title: "Test runs",
    description: "No test runs have been started.",
    milestone: "Execution engine",
    capabilities: ["Appium workers", "Bounded locator healing", "Device matrix and sharding"],
  },
  reports: {
    eyebrow: "Local evidence",
    title: "Reports",
    description: "No reports have been generated.",
    milestone: "Reporting",
    capabilities: ["Offline HTML", "Screenshots and UI trees", "ADB and Appium audit"],
  },
};

type PlannedViewContent = {
  eyebrow: string;
  title: string;
  description: string;
  milestone: string;
  capabilities: readonly string[];
};

function isViewId(value: string): value is ViewId {
  return viewIds.some((viewId) => viewId === value);
}

function readViewFromHash(): ViewId {
  const value = globalThis.location.hash.replace(/^#/, "");
  return isViewId(value) ? value : "overview";
}

function formatStartedAt(value: string | undefined): string {
  if (value === undefined) {
    return "Not available";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(new Date(value));
}

function PlannedView({ content }: { content: PlannedViewContent }): React.JSX.Element {
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">{content.eyebrow}</p>
          <h1>{content.title}</h1>
          <p className="subtitle">{content.description}</p>
        </div>
        <span className="connection-badge planned">Planned</span>
      </header>

      <section className="planned-layout" aria-label={`${content.title} status`}>
        <article className="panel empty-state">
          <span className="empty-state-mark" aria-hidden="true">
            {content.title.slice(0, 2).toUpperCase()}
          </span>
          <p className="eyebrow">Current state</p>
          <h2>{content.description}</h2>
          <p>
            The workspace foundation is ready. This area will activate in the {content.milestone}{" "}
            milestone.
          </p>
        </article>

        <article className="panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Planned scope</p>
              <h2>{content.milestone}</h2>
            </div>
          </div>
          <ul className="capability-list">
            {content.capabilities.map((capability) => (
              <li key={capability}>{capability}</li>
            ))}
          </ul>
        </article>
      </section>
    </>
  );
}

function Overview({ agentStatus, healthQuery }: OverviewProps): React.JSX.Element {
  return (
    <>
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

      <section className="metrics" aria-label="Agent status">
        <article className="metric-card featured">
          <span>Agent state</span>
          <strong>{agentStatus}</strong>
          <small>Checked every 10 seconds</small>
        </article>
        <article className="metric-card">
          <span>Agent version</span>
          <strong>{healthQuery.data?.version ?? "--"}</strong>
          <small>Installed runtime</small>
        </article>
        <article className="metric-card">
          <span>Devices</span>
          <strong>--</strong>
          <small>ADB integration is planned</small>
        </article>
        <article className="metric-card">
          <span>Test runs</span>
          <strong>--</strong>
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
    </>
  );
}

type HealthQuery = ReturnType<typeof useHealthQuery>;
type OverviewProps = {
  agentStatus: string;
  healthQuery: HealthQuery;
};

function useHealthQuery() {
  return useQuery({
    queryKey: ["agent-health"],
    queryFn: ({ signal }) => fetchHealth(signal),
    retry: 1,
    refetchInterval: 10_000,
  });
}

export function App(): React.JSX.Element {
  const healthQuery = useHealthQuery();
  const [activeView, setActiveView] = useState<ViewId>(readViewFromHash);

  useEffect(() => {
    const handleHashChange = (): void => setActiveView(readViewFromHash());
    globalThis.addEventListener("hashchange", handleHashChange);
    return () => globalThis.removeEventListener("hashchange", handleHashChange);
  }, []);

  const agentStatus = healthQuery.isPending
    ? "Checking"
    : healthQuery.isError
      ? "Unavailable"
      : healthQuery.data.status === "ok"
        ? "Connected"
        : "Degraded";

  const navigate = (viewId: ViewId): void => {
    setActiveView(viewId);
    globalThis.location.hash = viewId;
  };

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
          {navigationItems.map((item) => {
            const isActive = item.id === activeView;
            return (
              <button
                aria-current={isActive ? "page" : undefined}
                className={isActive ? "nav-item active" : "nav-item"}
                type="button"
                key={item.id}
                onClick={() => navigate(item.id)}
              >
                <span className="nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
                <span>{item.label}</span>
                {item.status !== undefined && <small>{item.status}</small>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <span className={`status-dot ${healthQuery.isError ? "error" : ""}`} />
          Agent {agentStatus.toLowerCase()}
        </div>
      </aside>

      <main className="content">
        {healthQuery.isError && (
          <section className="notice error-notice" role="alert">
            <strong>Local Agent is unavailable.</strong>
            <span>{healthQuery.error.message}</span>
          </section>
        )}

        {activeView === "overview" ? (
          <Overview agentStatus={agentStatus} healthQuery={healthQuery} />
        ) : (
          <PlannedView content={plannedViews[activeView]} />
        )}
      </main>
    </div>
  );
}
