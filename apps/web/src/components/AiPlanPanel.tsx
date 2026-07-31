import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowUp,
  CheckCircle2,
  CircleX,
  Clock3,
  FileArchive,
  FilePlus2,
  FileText,
  Folder,
  Image,
  KeyRound,
  ListRestart,
  LoaderCircle,
  MessageSquareText,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Play,
  ShieldCheck,
  Smartphone,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  ActionPlan,
  AgentAction,
  AiPlanResponse,
  ApkArtifact,
  AndroidDevice,
  AndroidProject,
  GenerateAiPlanRequest,
  StartTestExecutionRequest,
  TestExecutionRun,
  TestStepExecution,
  TestSuiteRecord,
  WorkspaceExecutionResponse,
} from "@device-robot/contracts";

import { useAgentUnavailable } from "../agent-availability";
import {
  fetchAiModelStatus,
  fetchAiConversation,
  fetchAiConversations,
  fetchAiModels,
  generateAiPlan,
  removeAiProjectConversation,
  testAiModelConfiguration,
} from "../api/ai";
import { fetchProjects, renameProject } from "../api/projects";
import { discardApk, uploadApk } from "../api/apk";
import { saveExplorationAsTestSuite, startTestSuiteCase } from "../api/test-suites";
import {
  cancelTestExecution,
  fetchTestRuns,
  startTestExecution,
  testStepScreenshotUrl,
} from "../api/test-execution";
import { startWorkspaceExecution } from "../api/workspace-execution";
import { formatDateTime } from "../ui/formatters";
import { TestSuitePanel } from "./TestSuitePanel";

type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  plan?: AiPlanResponse;
};

type PlanGenerationRequest = {
  request: GenerateAiPlanRequest;
  controller: AbortController;
  exchangeId: string;
};

type PendingConversationExchange = {
  id: string;
  projectId: string;
  conversationId: string;
  userMessage: ConversationMessage;
  startedAt: number;
  response?: AiPlanResponse;
};

type ConversationTestExecutionRequest = {
  request: StartTestExecutionRequest;
  projectId: string;
  conversationId: string;
};

type ConversationTestRun = {
  projectId: string;
  conversationId: string;
  run: TestExecutionRun;
};

type ConversationWorkspaceExecutionRequest = {
  id: string;
  plan: ActionPlan;
  deviceSerial: string;
  projectId: string;
  conversationId: string;
};

type ConversationWorkspaceExecution = {
  id: string;
  plan: ActionPlan;
  projectId: string;
  conversationId: string;
  status: "running" | WorkspaceExecutionResponse["status"];
  error?: string;
  result?: WorkspaceExecutionResponse;
};

const LAST_AI_PROJECT_STORAGE_KEY = "device-robot:ai:last-project";
const LAST_AI_CONVERSATION_STORAGE_PREFIX = "device-robot:ai:last-conversation:";

function storedAiWorkspaceId(storageKey: string): string {
  try {
    return globalThis.localStorage.getItem(storageKey)?.trim() ?? "";
  } catch {
    return "";
  }
}

function saveAiWorkspaceId(storageKey: string, value: string): void {
  try {
    globalThis.localStorage.setItem(storageKey, value);
  } catch {
    // Private browsing or browser policy can make local storage unavailable.
  }
}

function removeAiWorkspaceId(storageKey: string): void {
  try {
    globalThis.localStorage.removeItem(storageKey);
  } catch {
    // Private browsing or browser policy can make local storage unavailable.
  }
}

function lastAiConversationStorageKey(projectId: string): string {
  return `${LAST_AI_CONVERSATION_STORAGE_PREFIX}${projectId}`;
}

function formatMessageTime(createdAt: string): string {
  const timestamp = new Date(createdAt);
  if (Number.isNaN(timestamp.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(timestamp)
    .replaceAll(" ", "");
}

function isRequestAborted(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function actionLabel(action: AiPlanResponse["plan"]["actions"][number]): string {
  switch (action.action) {
    case "app.install":
      return "安装 APK";
    case "app.uninstall":
      return "卸载应用";
    case "app.clearData":
      return "清除应用数据";
    case "device.unlock":
      return "唤醒并解锁设备";
    case "adb.shell":
      return `ADB：${action.command}`;
    case "project.build":
      return `构建 ${action.modulePath} ${action.variant}`;
    case "project.installArtifact":
      return "安装项目构建 APK";
    default:
      return action.action;
  }
}

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

function isTestRunInProgress(run: TestExecutionRun): boolean {
  return run.status === "running";
}

function statusIcon(
  status: TestExecutionRun["status"] | TestStepExecution["status"],
): React.JSX.Element {
  const props = { "aria-hidden": true, size: 14, strokeWidth: 1.9 };
  switch (status) {
    case "succeeded":
      return <CheckCircle2 {...props} />;
    case "failed":
    case "cancelled":
      return <CircleX {...props} />;
    case "running":
      return <LoaderCircle {...props} className="test-run-spinner" />;
    case "pending":
      return <Clock3 {...props} />;
  }
}

function testReportHtmlUrl(runId: string): string {
  return `/api/v1/test-runs/${encodeURIComponent(runId)}/report/html`;
}

function testReportZipUrl(runId: string): string {
  return `/api/v1/test-runs/${encodeURIComponent(runId)}/report/zip`;
}

function TestRunStep({
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

function ConversationTestRunCard({
  run,
  plannedActions,
  cancelling,
  onCancel,
}: {
  run: TestExecutionRun;
  plannedActions: readonly AgentAction[];
  cancelling: boolean;
  onCancel(runId: string): void;
}): React.JSX.Element {
  const running = run.status === "running";
  const displayedSteps: readonly TestStepExecution[] =
    run.steps.length > 0 || !running
      ? run.steps
      : plannedActions.map((action, index) => ({
          index,
          action,
          status: "pending" as const,
          screenshotAvailable: false,
        }));

  return (
    <section
      className={`ai-test-active-run ${run.status}`}
      aria-label={running ? "当前测试执行" : "测试执行结果"}
    >
      <header>
        <div>
          <span>{running ? "当前执行" : "执行结果"}</span>
          <strong>{run.name}</strong>
        </div>
        <span className={`test-status test-status-${run.status}`}>
          {statusIcon(run.status)}
          {statusLabel(run.status)}
        </span>
        {running ? (
          <button
            className="icon-button danger-icon-button"
            type="button"
            aria-label="取消当前测试"
            title="取消当前测试"
            disabled={cancelling}
            onClick={() => onCancel(run.id)}
          >
            <Square aria-hidden="true" size={13} fill="currentColor" strokeWidth={1.8} />
          </button>
        ) : (
          <span aria-hidden="true" />
        )}
      </header>
      {run.message !== undefined && <p className="ai-test-active-run-message">{run.message}</p>}
      <ol>
        {displayedSteps.length === 0 ? (
          <li className="ai-test-active-run-pending">
            {running ? (
              <>
                <LoaderCircle aria-hidden="true" size={15} className="test-run-spinner" />
                正在启动 Appium 会话并读取首个页面。
              </>
            ) : (
              "本次执行未记录测试步骤。"
            )}
          </li>
        ) : (
          displayedSteps.map((step) => (
            <li key={`${run.id}:${step.index}`}>
              <span className="test-step-index">{step.index + 1}</span>
              <div>
                <code>{actionLabel(step.action)}</code>
                {step.message !== undefined && (
                  <p className="ai-test-active-run-step-message">{step.message}</p>
                )}
              </div>
              <span className={`test-status test-status-${step.status}`}>
                {statusIcon(step.status)}
                {statusLabel(step.status)}
              </span>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}

function ConversationWorkspaceExecutionCard({
  execution,
}: {
  execution: ConversationWorkspaceExecution;
}): React.JSX.Element {
  const running = execution.status === "running";
  const resultsByIndex = new Map(
    execution.result?.results.map((result) => [result.index, result]) ?? [],
  );

  return (
    <section
      className={`ai-test-active-run ${execution.status}`}
      aria-label={running ? "当前测试执行" : "测试执行结果"}
    >
      <header>
        <div>
          <span>{running ? "当前执行" : "执行结果"}</span>
          <strong>工作区操作</strong>
        </div>
        <span className={`test-status test-status-${execution.status}`}>
          {statusIcon(execution.status)}
          {statusLabel(execution.status)}
        </span>
        <span aria-hidden="true" />
      </header>
      {execution.error !== undefined && (
        <p className="ai-test-active-run-message">{execution.error}</p>
      )}
      <ol>
        {execution.plan.actions.map((action, index) => {
          const result = resultsByIndex.get(index);
          const stepStatus: TestStepExecution["status"] = result?.status ?? "pending";
          return (
            <li key={`${execution.id}:${index}`}>
              <span className="test-step-index">{index + 1}</span>
              <div>
                <code>{actionLabel(action)}</code>
                {result?.message !== undefined && (
                  <p className="ai-test-active-run-step-message">{result.message}</p>
                )}
              </div>
              <span className={`test-status test-status-${stepStatus}`}>
                {statusIcon(stepStatus)}
                {statusLabel(stepStatus)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function TestRunDetailsDialog({
  run,
  runs,
  cancelling,
  onCancel,
  onClose,
  onSelectRun,
}: {
  run: TestExecutionRun;
  runs: readonly TestExecutionRun[];
  cancelling: boolean;
  onCancel(runId: string): void;
  onClose(): void;
  onSelectRun(runId: string): void;
}): React.JSX.Element {
  const [expandedScreenshot, setExpandedScreenshot] = useState<string>();

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="ai-test-run-detail-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="测试运行详情"
      >
        <header>
          <div>
            <span>测试运行</span>
            <h2>测试运行详情</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
          >
            <CircleX aria-hidden="true" size={17} strokeWidth={1.8} />
          </button>
        </header>

        <label className="ai-test-run-detail-picker">
          <span>运行记录</span>
          <select
            aria-label="选择测试运行"
            value={run.id}
            onChange={(event) => onSelectRun(event.target.value)}
          >
            {runs.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {formatDateTime(candidate.startedAt)} · {candidate.name}
              </option>
            ))}
          </select>
        </label>

        <div className="ai-test-run-detail-content">
          <article className={`test-run-card test-run-${run.status}`}>
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
                  disabled={cancelling}
                  onClick={() => onCancel(run.id)}
                >
                  <Square aria-hidden="true" size={15} fill="currentColor" strokeWidth={1.8} />
                </button>
              )}
            </header>
            <div className="test-run-meta">
              <span>开始：{formatDateTime(run.startedAt)}</span>
              <span>结束：{formatDateTime(run.finishedAt)}</span>
            </div>
            {run.message !== undefined && <p className="test-run-message">{run.message}</p>}
            {run.status !== "running" && (
              <div className="test-report-actions">
                <a
                  href={testReportHtmlUrl(run.id)}
                  target="_blank"
                  rel="noreferrer"
                  title="在新页面打开离线测试报告"
                >
                  <FileText aria-hidden="true" size={15} strokeWidth={1.8} />
                  查看报告
                </a>
                <a href={testReportZipUrl(run.id)} title="下载测试报告 ZIP">
                  <FileArchive aria-hidden="true" size={15} strokeWidth={1.8} />
                  导出 ZIP
                </a>
              </div>
            )}
            <ol className="test-step-list">
              {run.steps.length === 0 ? (
                <li className="ai-test-run-detail-empty">尚未记录测试步骤。</li>
              ) : (
                run.steps.map((step) => {
                  const screenshotKey = `${run.id}:${step.index}`;
                  return (
                    <TestRunStep
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
                })
              )}
            </ol>
          </article>
        </div>
      </section>
    </div>
  );
}

function projectLabel(project: AndroidProject): string {
  if (project.remoteUrl !== undefined) {
    try {
      const repositoryName = new URL(project.remoteUrl).pathname
        .split("/")
        .filter((segment) => segment.length > 0)
        .at(-1)
        ?.replace(/\.git$/iu, "");
      if (repositoryName !== undefined && repositoryName.length > 0) {
        return repositoryName;
      }
    } catch {
      // 项目数据已由契约校验，此处仅保留本地名称作为界面降级显示。
    }
  }

  return (
    project.name.replace(/-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu, "") || project.name
  );
}

function applicationIds(project: AndroidProject | undefined): string[] {
  if (project === undefined) {
    return [];
  }
  return [
    ...new Set(
      project.modules
        .filter((module) => module.moduleType === undefined || module.moduleType === "application")
        .flatMap((module) => [module.applicationId, module.packageName])
        .filter((value): value is string => value !== undefined && value.trim().length > 0),
    ),
  ].sort((left, right) => left.localeCompare(right, "en"));
}

function bindPlanToApplication(plan: ActionPlan, appId: string): ActionPlan {
  if (appId.length === 0) {
    return plan;
  }

  const actions: AgentAction[] = plan.actions.map((action) => {
    if (
      action.action === "app.launch" ||
      action.action === "app.stop" ||
      action.action === "device.permission"
    ) {
      return { ...action, appId };
    }
    return action;
  });
  return { ...plan, targetAppId: appId, actions };
}

type AiPlanPanelProps = {
  device: AndroidDevice | undefined;
  initialConversationId?: string;
  initialProjectId?: string;
  onConversationSelectionChange?(conversationId: string): void;
  onProjectSelectionChange?(projectId: string): void;
};

export function AiPlanPanel({
  device,
  initialConversationId,
  initialProjectId,
  onConversationSelectionChange,
  onProjectSelectionChange,
}: AiPlanPanelProps): React.JSX.Element {
  const agentUnavailable = useAgentUnavailable();
  const [goal, setGoal] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState(
    () => initialProjectId || storedAiWorkspaceId(LAST_AI_PROJECT_STORAGE_KEY),
  );
  const [selectedConversationId, setSelectedConversationId] = useState(initialConversationId ?? "");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [editingConfiguration, setEditingConfiguration] = useState(false);
  const [externalDataAcknowledged, setExternalDataAcknowledged] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [savedExplorationSuite, setSavedExplorationSuite] = useState<TestSuiteRecord>();
  const [installableArtifacts, setInstallableArtifacts] = useState<ApkArtifact[]>([]);
  const [lastWorkspaceExecution, setLastWorkspaceExecution] =
    useState<WorkspaceExecutionResponse>();
  const [conversationTestRun, setConversationTestRun] = useState<ConversationTestRun>();
  const [conversationWorkspaceExecution, setConversationWorkspaceExecution] =
    useState<ConversationWorkspaceExecution>();
  const [projectMenuId, setProjectMenuId] = useState<string>();
  const [renamingProject, setRenamingProject] = useState<AndroidProject>();
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const [removingProjectConversation, setRemovingProjectConversation] = useState<AndroidProject>();
  const [pendingConversationExchange, setPendingConversationExchange] =
    useState<PendingConversationExchange>();
  const [thinkingElapsedSeconds, setThinkingElapsedSeconds] = useState(0);
  const apkInputRef = useRef<HTMLInputElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const projectMenuRef = useRef<HTMLDivElement>(null);
  const planRequestAbortControllerRef = useRef<AbortController | undefined>(undefined);
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: ["ai-model-status"],
    queryFn: ({ signal }) => fetchAiModelStatus(signal),
    retry: false,
  });
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: ({ signal }) => fetchProjects(signal),
    retry: false,
  });
  const availableProjects = projectsQuery.data?.projects ?? [];
  const projectId = availableProjects.some((project) => project.id === selectedProjectId)
    ? selectedProjectId
    : (availableProjects[0]?.id ?? "");
  const projects = availableProjects;
  const selectedProject = projects.find((project) => project.id === projectId);
  const appIds = applicationIds(selectedProject);
  const appId = appIds[0] ?? "";
  const projectTestRunsQuery = useQuery({
    queryKey: ["ai-project-test-runs"],
    queryFn: ({ signal }) => fetchTestRuns(undefined, signal),
    enabled: projects.length > 0,
    retry: 1,
    refetchInterval: (query) => (query.state.data?.runs.some(isTestRunInProgress) ? 1_000 : 8_000),
  });
  const runsQuery = useQuery({
    queryKey: ["test-runs", projectId],
    queryFn: ({ signal }) => fetchTestRuns(projectId, signal),
    enabled: projectId.length > 0,
    retry: 1,
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => run.status === "running") ? 1_000 : 8_000,
  });
  const conversationsQuery = useQuery({
    queryKey: ["ai-conversations", projectId],
    queryFn: ({ signal }) => fetchAiConversations(projectId, signal),
    enabled: projectId.length > 0,
    retry: false,
  });
  const conversationDetailQuery = useQuery({
    queryKey: ["ai-conversation", selectedConversationId],
    queryFn: ({ signal }) => fetchAiConversation(selectedConversationId, signal),
    enabled: selectedConversationId.length > 0,
    retry: false,
  });
  useEffect(() => {
    if (statusQuery.data?.baseUrl !== undefined) {
      setBaseUrl((current) => current || statusQuery.data?.baseUrl || "");
    }
    if (statusQuery.data?.model !== undefined) {
      setSelectedModel((current) => current || statusQuery.data?.model || "");
    }
  }, [statusQuery.data?.baseUrl, statusQuery.data?.model]);
  useEffect(() => {
    if (projectMenuId === undefined) {
      return;
    }

    const closeProjectMenu = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && !projectMenuRef.current?.contains(target)) {
        setProjectMenuId(undefined);
      }
    };

    document.addEventListener("pointerdown", closeProjectMenu);
    return () => document.removeEventListener("pointerdown", closeProjectMenu);
  }, [projectMenuId]);
  useEffect(() => {
    if (projectId.length === 0) {
      return;
    }

    if (selectedProjectId !== projectId) {
      setSelectedProjectId(projectId);
    }
    saveAiWorkspaceId(LAST_AI_PROJECT_STORAGE_KEY, projectId);
    onProjectSelectionChange?.(projectId);
  }, [onProjectSelectionChange, projectId, selectedProjectId]);
  useEffect(() => {
    const conversations = conversationsQuery.data?.conversations;
    if (conversations === undefined || projectId.length === 0) {
      return;
    }

    const storedConversationId = storedAiWorkspaceId(lastAiConversationStorageKey(projectId));
    const conversationId = conversations.some(
      (conversation) => conversation.id === selectedConversationId,
    )
      ? selectedConversationId
      : conversations.some((conversation) => conversation.id === storedConversationId)
        ? storedConversationId
        : (conversations[0]?.id ?? "");

    if (conversationId !== selectedConversationId) {
      setSelectedConversationId(conversationId);
    }
    if (conversationId.length > 0) {
      saveAiWorkspaceId(lastAiConversationStorageKey(projectId), conversationId);
    }
    onConversationSelectionChange?.(conversationId);
  }, [
    conversationsQuery.data?.conversations,
    onConversationSelectionChange,
    projectId,
    selectedConversationId,
  ]);
  const activeConversation = conversationsQuery.data?.conversations.find(
    (conversation) =>
      conversation.id === selectedConversationId && conversation.projectId === projectId,
  );
  const conversationMatchesProject =
    activeConversation !== undefined &&
    conversationDetailQuery.data?.conversation.id === selectedConversationId &&
    conversationDetailQuery.data.conversation.projectId === projectId;
  const activeConversationId = conversationMatchesProject ? selectedConversationId : "";
  const messages: ConversationMessage[] = conversationMatchesProject
    ? (conversationDetailQuery.data?.messages ?? []).map((message) => ({
        id: message.id,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        ...(message.plan === undefined ? {} : { plan: message.plan }),
      }))
    : [];
  const pendingExchangeMatchesConversation =
    pendingConversationExchange !== undefined &&
    pendingConversationExchange.projectId === projectId &&
    pendingConversationExchange.conversationId === activeConversationId;
  const persistedPendingUserMessage =
    pendingConversationExchange === undefined
      ? false
      : messages.some(
          (message) =>
            message.role === "user" &&
            message.content === pendingConversationExchange.userMessage.content &&
            Date.parse(message.createdAt) >= pendingConversationExchange.startedAt,
        );
  const persistedPendingAssistantMessage =
    pendingConversationExchange?.response === undefined
      ? false
      : messages.some(
          (message) =>
            message.role === "assistant" &&
            message.plan?.plan.id === pendingConversationExchange.response?.plan.id,
        );
  const visibleMessages = [
    ...messages,
    ...(!pendingExchangeMatchesConversation || persistedPendingUserMessage
      ? []
      : [pendingConversationExchange.userMessage]),
    ...(!pendingExchangeMatchesConversation ||
    pendingConversationExchange.response === undefined ||
    persistedPendingAssistantMessage
      ? []
      : [
          {
            id: `${pendingConversationExchange.id}:assistant`,
            role: "assistant" as const,
            content: pendingConversationExchange.response.reply,
            createdAt: pendingConversationExchange.response.generatedAt,
            plan: pendingConversationExchange.response,
          },
        ]),
  ];
  const thinking =
    pendingExchangeMatchesConversation && pendingConversationExchange.response === undefined;
  const latestMessageId = visibleMessages.at(-1)?.id ?? "";
  useEffect(() => {
    const timeline = workspaceRef.current?.querySelector<HTMLDivElement>(".ai-test-timeline");
    if (timeline === undefined || timeline === null || activeConversationId.length === 0) {
      return;
    }

    timeline.scrollTop = timeline.scrollHeight;
  }, [activeConversationId, latestMessageId, thinking, visibleMessages.length]);
  useEffect(
    () => () => {
      planRequestAbortControllerRef.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (
      pendingConversationExchange === undefined ||
      pendingConversationExchange.response !== undefined
    ) {
      setThinkingElapsedSeconds(0);
      return;
    }

    const updateElapsedSeconds = (): void => {
      setThinkingElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - pendingConversationExchange.startedAt) / 1_000)),
      );
    };

    updateElapsedSeconds();
    const interval = globalThis.setInterval(updateElapsedSeconds, 1_000);
    return () => globalThis.clearInterval(interval);
  }, [pendingConversationExchange]);
  useEffect(() => {
    const planIds = messages.flatMap((message) =>
      message.plan === undefined ? [] : [message.plan.plan.id],
    );
    if (planIds.length > 0 && !planIds.includes(selectedPlanId)) {
      setSelectedPlanId(planIds.at(-1) ?? "");
    }
  }, [messages, selectedPlanId]);
  const planMutation = useMutation({
    mutationFn: async ({ request, controller }: PlanGenerationRequest) =>
      await generateAiPlan(request, controller.signal),
    onSuccess: async (response, { exchangeId, request }) => {
      setPendingConversationExchange((current) =>
        current?.id === exchangeId ? { ...current, response } : current,
      );
      setSelectedPlanId(response.plan.id);
      setSavedExplorationSuite(undefined);
      setGoal("");
      if (request.conversationId !== undefined) {
        await queryClient.invalidateQueries({
          queryKey: ["ai-conversation", request.conversationId],
        });
      }
      setPendingConversationExchange((current) =>
        current?.id === exchangeId ? undefined : current,
      );
      if (response.plan.workspaceExecution === true && device !== undefined) {
        workspaceExecutionMutation.mutate({
          id: crypto.randomUUID(),
          plan: response.plan,
          deviceSerial: device.serial,
          projectId: response.plan.projectId,
          conversationId: request.conversationId ?? activeConversationId,
        });
      }
    },
    onError: (_error, { exchangeId, request }) => {
      setPendingConversationExchange((current) =>
        current?.id === exchangeId ? undefined : current,
      );
      setGoal(request.goal);
    },
    onSettled: (_response, _error, { controller }) => {
      if (planRequestAbortControllerRef.current === controller) {
        planRequestAbortControllerRef.current = undefined;
      }
    },
  });
  const uploadApkMutation = useMutation({
    mutationFn: async (file: File) => await uploadApk(file),
    onSuccess: (artifact) => {
      setInstallableArtifacts((current) =>
        current.some((candidate) => candidate.id === artifact.id)
          ? current
          : [...current, artifact],
      );
    },
  });
  const discardApkMutation = useMutation({
    mutationFn: discardApk,
    onSuccess: (_result, artifactId) => {
      setInstallableArtifacts((current) =>
        current.filter((artifact) => artifact.id !== artifactId),
      );
    },
  });
  const modelListMutation = useMutation({
    mutationFn: fetchAiModels,
    onSuccess: (response) => {
      setSelectedModel((current) =>
        current.length > 0 && response.models.includes(current)
          ? current
          : (response.models[0] ?? ""),
      );
    },
  });
  const configurationTestMutation = useMutation({
    mutationFn: testAiModelConfiguration,
    onSuccess: async () => {
      setApiKey("");
      setEditingConfiguration(false);
      await queryClient.invalidateQueries({ queryKey: ["ai-model-status"] });
    },
  });
  const workspaceModelSelectionMutation = useMutation({
    mutationFn: async (model: string) => await testAiModelConfiguration({ model }),
    onSuccess: async (response) => {
      setSelectedModel(response.model);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["ai-model-status"] }),
        queryClient.invalidateQueries({ queryKey: ["ai-workspace-models"] }),
      ]);
    },
  });
  const testExecutionMutation = useMutation({
    mutationFn: async ({ request }: ConversationTestExecutionRequest) =>
      await startTestExecution(request),
    onSuccess: async (run, { conversationId, projectId, request }) => {
      setConversationWorkspaceExecution(undefined);
      setConversationTestRun({ projectId, conversationId, run });
      const consumedArtifactIds = new Set(
        request.plan.actions.flatMap((action) =>
          action.action === "app.install" ? [action.artifactId] : [],
        ),
      );
      if (consumedArtifactIds.size > 0) {
        setInstallableArtifacts((current) =>
          current.filter((artifact) => !consumedArtifactIds.has(artifact.id)),
        );
      }
      await queryClient.invalidateQueries({ queryKey: ["test-runs"] });
    },
  });
  const saveExplorationMutation = useMutation({
    mutationFn: async (input: { runId: string; name: string }) =>
      await saveExplorationAsTestSuite(projectId, input),
    onSuccess: async (suite) => {
      setSavedExplorationSuite(suite);
      await queryClient.invalidateQueries({ queryKey: ["test-suites", projectId] });
    },
  });
  const offlineRegressionMutation = useMutation({
    mutationFn: async (input: { suiteId: string; caseId: string; deviceSerial: string }) =>
      await startTestSuiteCase(projectId, input.suiteId, input.caseId, {
        deviceSerial: input.deviceSerial,
        approved: true,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["test-runs"] });
    },
  });
  const workspaceExecutionMutation = useMutation({
    mutationFn: async ({ plan, deviceSerial }: ConversationWorkspaceExecutionRequest) =>
      await startWorkspaceExecution({ plan, deviceSerial }),
    onMutate: ({ id, plan, projectId, conversationId }) => {
      setConversationTestRun(undefined);
      setConversationWorkspaceExecution({
        id,
        plan,
        projectId,
        conversationId,
        status: "running",
      });
    },
    onSuccess: (result, { id }) => {
      setLastWorkspaceExecution(result);
      setConversationWorkspaceExecution((current) =>
        current?.id === id ? { ...current, status: result.status, result } : current,
      );
    },
    onError: (error, { id }) => {
      setConversationWorkspaceExecution((current) =>
        current?.id === id
          ? {
              ...current,
              status: "failed",
              error: error instanceof Error ? error.message : "工作区操作失败。",
            }
          : current,
      );
    },
  });
  const cancelMutation = useMutation({
    mutationFn: cancelTestExecution,
    onSuccess: async (run) => {
      setConversationTestRun((current) =>
        current?.run.id === run.id ? { ...current, run } : current,
      );
      await queryClient.invalidateQueries({ queryKey: ["test-runs"] });
    },
  });
  const renameProjectMutation = useMutation({
    mutationFn: async (input: { projectId: string; name: string }) =>
      await renameProject(input.projectId, { name: input.name }),
    onSuccess: async () => {
      setProjectMenuId(undefined);
      setRenamingProject(undefined);
      setProjectNameDraft("");
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const removeConversationMutation = useMutation({
    mutationFn: removeAiProjectConversation,
    onSuccess: async (_result, removedProjectId) => {
      removeAiWorkspaceId(lastAiConversationStorageKey(removedProjectId));
      if (removedProjectId === projectId) {
        onConversationSelectionChange?.("");
        setSelectedConversationId("");
        setSelectedPlanId("");
        setSelectedRunId("");
        setSavedExplorationSuite(undefined);
        setLastWorkspaceExecution(undefined);
      }
      setProjectMenuId(undefined);
      setRemovingProjectConversation(undefined);
      queryClient.removeQueries({ queryKey: ["ai-conversations", removedProjectId] });
      await queryClient.invalidateQueries({ queryKey: ["ai-conversations", removedProjectId] });
    },
  });
  const configured = statusQuery.data?.configured === true;
  const workspaceModelsQuery = useQuery({
    queryKey: ["ai-workspace-models", statusQuery.data?.baseUrl],
    queryFn: async () => await fetchAiModels({}),
    enabled: configured && !editingConfiguration,
    retry: false,
  });
  const canGenerate =
    configured &&
    projectId.length > 0 &&
    activeConversationId.length > 0 &&
    appId.length > 0 &&
    goal.trim().length > 0 &&
    !uploadApkMutation.isPending;
  const showConfiguration =
    (!configured || editingConfiguration) && !statusQuery.isPending && !statusQuery.isError;
  const availableModels = modelListMutation.data?.models ?? [];
  const workspaceModels = Array.from(
    new Set(
      [statusQuery.data?.model, ...(workspaceModelsQuery.data?.models ?? [])].filter(
        (model): model is string => model !== undefined,
      ),
    ),
  );
  const workspaceModel =
    workspaceModelSelectionMutation.isPending && selectedModel.length > 0
      ? selectedModel
      : (statusQuery.data?.model ?? selectedModel);
  const canFetchModels =
    baseUrl.trim().length > 0 &&
    (apiKey.trim().length > 0 || configured) &&
    !modelListMutation.isPending;
  const canTestConfiguration =
    canFetchModels &&
    selectedModel.length > 0 &&
    (externalDataAcknowledged || configured) &&
    !configurationTestMutation.isPending;
  const error = agentUnavailable
    ? undefined
    : statusQuery.isError
      ? statusQuery.error.message
      : projectsQuery.isError
        ? projectsQuery.error.message
        : conversationsQuery.isError
          ? conversationsQuery.error.message
          : conversationDetailQuery.isError
            ? conversationDetailQuery.error.message
            : planMutation.isError && !isRequestAborted(planMutation.error)
              ? planMutation.error.message
              : uploadApkMutation.isError
                ? uploadApkMutation.error.message
                : discardApkMutation.isError
                  ? discardApkMutation.error.message
                  : testExecutionMutation.isError
                    ? testExecutionMutation.error.message
                    : saveExplorationMutation.isError
                      ? saveExplorationMutation.error.message
                      : offlineRegressionMutation.isError
                        ? offlineRegressionMutation.error.message
                        : workspaceExecutionMutation.isError
                          ? workspaceExecutionMutation.error.message
                          : undefined;
  const configurationError = agentUnavailable
    ? undefined
    : modelListMutation.isError
      ? modelListMutation.error.message
      : configurationTestMutation.isError
        ? configurationTestMutation.error.message
        : undefined;
  const runs = (runsQuery.data?.runs ?? []).filter((run) => run.projectId === projectId);
  const projectsWithActiveTests = new Set(
    [
      ...(projectTestRunsQuery.data?.runs ?? []),
      ...runs,
      ...(conversationTestRun === undefined ? [] : [conversationTestRun.run]),
    ]
      .filter(isTestRunInProgress)
      .map((run) => run.projectId),
  );
  const latestPlanMessage = [...messages].reverse().find((message) => message.plan !== undefined);
  const selectedPlanResponse =
    messages.find((message) => message.plan?.plan.id === selectedPlanId)?.plan ??
    latestPlanMessage?.plan;
  const selectedExecutionPlan =
    selectedPlanResponse === undefined
      ? undefined
      : selectedPlanResponse.plan.workspaceExecution === true
        ? selectedPlanResponse.plan
        : bindPlanToApplication(
            selectedPlanResponse.plan,
            selectedPlanResponse.plan.targetAppId ?? appId,
          );
  const activeRun = runs.find((run) => run.status === "running");
  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const currentConversationRun =
    conversationTestRun !== undefined &&
    conversationTestRun.projectId === projectId &&
    conversationTestRun.conversationId === activeConversationId
      ? (runs.find((run) => run.id === conversationTestRun.run.id) ?? conversationTestRun.run)
      : undefined;
  // Test execution belongs to the selected project. The conversation detail and selected plan
  // load independently, so neither may be used as a prerequisite for showing its latest run.
  const timelineTestRun = currentConversationRun ?? activeRun ?? runs[0];
  const timelineTestPlanActions =
    timelineTestRun === undefined
      ? []
      : (messages.find((message) => message.plan?.plan.id === timelineTestRun.planId)?.plan?.plan
          .actions ?? []);
  const timelineWorkspaceExecution =
    conversationWorkspaceExecution !== undefined &&
    conversationWorkspaceExecution.projectId === projectId &&
    conversationWorkspaceExecution.conversationId === activeConversationId
      ? conversationWorkspaceExecution
      : undefined;
  const timelineExecutionVersion =
    timelineTestRun !== undefined
      ? [
          timelineTestRun.id,
          timelineTestRun.status,
          timelineTestRun.message ?? "",
          ...timelineTestRun.steps.map(
            (step) => `${step.index}:${step.status}:${step.message ?? ""}`,
          ),
        ].join("|")
      : timelineWorkspaceExecution === undefined
        ? ""
        : [
            timelineWorkspaceExecution.id,
            timelineWorkspaceExecution.status,
            timelineWorkspaceExecution.error ?? "",
            ...timelineWorkspaceExecution.plan.actions.map((action, index) => {
              const result = timelineWorkspaceExecution.result?.results.find(
                (candidate) => candidate.index === index,
              );
              return `${action.action}:${result?.status ?? "pending"}:${result?.message ?? ""}`;
            }),
          ].join("|");
  useEffect(() => {
    const timeline = workspaceRef.current?.querySelector<HTMLDivElement>(".ai-test-timeline");
    if (timeline !== undefined && timeline !== null && timelineExecutionVersion.length > 0) {
      timeline.scrollTop = timeline.scrollHeight;
    }
  }, [timelineExecutionVersion]);
  const completedExplorationRun =
    selectedExecutionPlan?.liveUiExecution === undefined
      ? undefined
      : runs.find(
          (run) =>
            run.planId === selectedExecutionPlan.id &&
            run.status === "succeeded" &&
            run.executionMode === "ai-exploration",
        );
  const savedExplorationCase =
    completedExplorationRun === undefined
      ? undefined
      : savedExplorationSuite?.suite.cases.find(
          (testCase) => testCase.id === `exploration-${completedExplorationRun.id}`,
        );

  const executePlan = (plan: ActionPlan, response: AiPlanResponse): void => {
    if (plan.workspaceExecution === true) {
      if (device === undefined) {
        return;
      }
      workspaceExecutionMutation.mutate({
        id: crypto.randomUUID(),
        plan,
        deviceSerial: device.serial,
        projectId,
        conversationId: activeConversationId,
      });
      return;
    }
    const targetAppId = plan.targetAppId ?? appId;
    if (
      device === undefined ||
      targetAppId.length === 0 ||
      !globalThis.confirm(
        `确认在 ${device.model ?? device.serial} 上执行该计划？执行前将清除 ${targetAppId} 的应用数据。${
          plan.liveUiExecution === undefined
            ? ""
            : "执行期间会把当前页面的 UI 文本、控件标识和坐标发送至已配置的 AI 服务，以实时推进测试目标。"
        }`,
      )
    ) {
      return;
    }

    testExecutionMutation.mutate({
      projectId,
      conversationId: activeConversationId,
      request: {
        plan,
        deviceSerial: device.serial,
        appId: targetAppId,
        name: response.reply.slice(0, 80),
        approved: true,
      },
    });
  };

  const stageApk = (file: File | undefined): void => {
    if (file === undefined || uploadApkMutation.isPending) {
      return;
    }
    uploadApkMutation.mutate(file);
  };

  return (
    <section className="management-workspace ai-test-workspace" aria-label="AI 测试工作台">
      {showConfiguration ? (
        <form
          className="ai-configuration-form ai-workspace-configuration"
          onSubmit={(event) => {
            event.preventDefault();
            if (canTestConfiguration) {
              configurationTestMutation.mutate({
                baseUrl: baseUrl.trim(),
                ...(apiKey.trim().length === 0 ? {} : { apiKey: apiKey.trim() }),
                model: selectedModel,
              });
            }
          }}
        >
          <header className="ai-plan-form-heading">
            <div>
              <p className="eyebrow">AI 测试工作台</p>
              <h2>连接 OpenAI 兼容服务</h2>
            </div>
            <span className="ai-configuration-status">
              <KeyRound aria-hidden="true" size={16} strokeWidth={1.8} />
              <strong>{configured ? "切换已保存模型" : "模型尚未配置"}</strong>
            </span>
            {configured && (
              <button
                className="ai-secondary-command"
                type="button"
                onClick={() => setEditingConfiguration(false)}
              >
                取消
              </button>
            )}
          </header>
          <p className="ai-configuration-intro">
            填写服务地址与 API Key 后拉取可用模型。地址和模型会保存在本机；API Key 使用当前 Windows
            用户的凭据保护，且不会返回网页、写入日志或项目文件。
          </p>
          <div className="ai-configuration-fields">
            <label className="ai-config-field">
              <span>Base URL</span>
              <input
                aria-label="Base URL"
                type="url"
                inputMode="url"
                autoComplete="url"
                placeholder="https://api.openai.com/v1"
                value={baseUrl}
                disabled={configurationTestMutation.isPending}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                  setSelectedModel("");
                  modelListMutation.reset();
                  configurationTestMutation.reset();
                }}
              />
            </label>
            <label className="ai-config-field">
              <span>API Key</span>
              <input
                aria-label="API Key"
                type="password"
                autoComplete="new-password"
                placeholder="请输入 API Key"
                value={apiKey}
                disabled={configurationTestMutation.isPending}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setSelectedModel("");
                  modelListMutation.reset();
                  configurationTestMutation.reset();
                }}
              />
              {configured && apiKey.length === 0 && <small>已安全保存；留空即可切换模型。</small>}
            </label>
            <div className="ai-model-picker">
              <label className="ai-config-field">
                <span>模型</span>
                <select
                  aria-label="AI 模型"
                  value={selectedModel}
                  disabled={availableModels.length === 0 || configurationTestMutation.isPending}
                  onChange={(event) => {
                    setSelectedModel(event.target.value);
                    configurationTestMutation.reset();
                  }}
                >
                  {availableModels.length === 0 ? (
                    <option value="">请先拉取模型</option>
                  ) : (
                    availableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))
                  )}
                </select>
              </label>
              <button
                className="ai-secondary-command"
                type="button"
                disabled={!canFetchModels || configurationTestMutation.isPending}
                onClick={() => {
                  modelListMutation.mutate({
                    baseUrl: baseUrl.trim(),
                    ...(apiKey.trim().length === 0 ? {} : { apiKey: apiKey.trim() }),
                  });
                }}
              >
                <ListRestart aria-hidden="true" size={16} strokeWidth={1.8} />
                {modelListMutation.isPending ? "正在拉取模型" : "拉取模型"}
              </button>
            </div>
          </div>
          <label className="ai-data-acknowledgement">
            <input
              type="checkbox"
              checked={externalDataAcknowledged}
              disabled={configurationTestMutation.isPending}
              onChange={(event) => setExternalDataAcknowledged(event.target.checked)}
            />
            <span>
              我理解：生成操作计划时，测试目标、项目模块和源码索引证据会发送至所配置的 AI 服务。
            </span>
          </label>
          {configurationError !== undefined && (
            <p className="management-error ai-configuration-error" role="alert">
              {configurationError}
            </p>
          )}
          <footer className="ai-configuration-actions">
            <span>选择模型后，可通过一次最小 Chat Completions 请求验证连接。</span>
            <button className="primary-command" type="submit" disabled={!canTestConfiguration}>
              <CheckCircle2 aria-hidden="true" size={16} strokeWidth={1.8} />
              {configurationTestMutation.isPending ? "正在测试配置" : "测试并应用配置"}
            </button>
          </footer>
        </form>
      ) : (
        <div ref={workspaceRef} className="ai-test-workspace-grid">
          <aside className="ai-test-project-sidebar" aria-label="测试项目">
            <header>
              <h2>项目</h2>
            </header>
            <div className="ai-test-project-list">
              {projectsQuery.isPending ? (
                <p>正在加载项目...</p>
              ) : projects.length === 0 ? (
                <p>请先在项目页接入 Android 项目。</p>
              ) : (
                projects.map((project) => {
                  const selected = project.id === projectId;
                  const testRunning = projectsWithActiveTests.has(project.id);
                  return (
                    <article
                      key={project.id}
                      className={`ai-test-project-item${selected ? " selected" : ""}${
                        projectMenuId === project.id ? " menu-open" : ""
                      }`}
                    >
                      <button
                        className="ai-test-project-select"
                        type="button"
                        aria-pressed={selected}
                        onClick={() => {
                          saveAiWorkspaceId(LAST_AI_PROJECT_STORAGE_KEY, project.id);
                          onProjectSelectionChange?.(project.id);
                          onConversationSelectionChange?.("");
                          setSelectedProjectId(project.id);
                          setSelectedConversationId("");
                          setSelectedPlanId("");
                          setSelectedRunId("");
                          setSavedExplorationSuite(undefined);
                          setLastWorkspaceExecution(undefined);
                        }}
                      >
                        <Folder aria-hidden="true" size={16} strokeWidth={1.8} />
                        <strong title={projectLabel(project)}>{projectLabel(project)}</strong>
                      </button>
                      {testRunning ? (
                        <span
                          className="ai-test-project-running"
                          role="status"
                          aria-label={`${projectLabel(project)} 测试正在执行`}
                          title="测试正在执行"
                        >
                          <LoaderCircle aria-hidden="true" size={15} className="test-run-spinner" />
                        </span>
                      ) : (
                        <div
                          ref={projectMenuId === project.id ? projectMenuRef : undefined}
                          className="ai-test-project-actions"
                        >
                          <button
                            className="icon-button ai-test-project-more"
                            type="button"
                            aria-label={`${project.name} 的更多项目操作`}
                            aria-expanded={projectMenuId === project.id}
                            aria-haspopup="menu"
                            title="更多项目操作"
                            onClick={() =>
                              setProjectMenuId((current) =>
                                current === project.id ? undefined : project.id,
                              )
                            }
                          >
                            <MoreHorizontal aria-hidden="true" size={17} strokeWidth={2} />
                          </button>
                          {projectMenuId === project.id && (
                            <div
                              className="ai-test-project-menu"
                              role="menu"
                              aria-label={`${project.name} 的项目操作`}
                            >
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setProjectMenuId(undefined);
                                  setProjectNameDraft(project.name);
                                  setRenamingProject(project);
                                }}
                              >
                                <Pencil aria-hidden="true" size={15} strokeWidth={1.9} />
                                编辑项目名称
                              </button>
                              <button
                                className="ai-test-project-menu-danger"
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setProjectMenuId(undefined);
                                  setRemovingProjectConversation(project);
                                }}
                              >
                                <Trash2 aria-hidden="true" size={15} strokeWidth={1.9} />
                                移除项目会话
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </article>
                  );
                })
              )}
            </div>
            {!agentUnavailable && (
              <section className="ai-test-model-context" aria-label="模型状态">
                <ShieldCheck aria-hidden="true" size={16} strokeWidth={1.8} />
                <div className="ai-test-model-picker">
                  <span>AI 模型</span>
                  <select
                    aria-label="选择 AI 模型"
                    value={workspaceModel}
                    disabled={
                      workspaceModelsQuery.isPending || workspaceModelSelectionMutation.isPending
                    }
                    onChange={(event) => {
                      const model = event.target.value;
                      if (model === statusQuery.data?.model) {
                        return;
                      }

                      setSelectedModel(model);
                      workspaceModelSelectionMutation.mutate(model);
                    }}
                  >
                    {workspaceModels.length === 0 ? (
                      <option value="">没有可用模型</option>
                    ) : (
                      workspaceModels.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))
                    )}
                  </select>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="更换模型"
                  title="更换模型"
                  onClick={() => {
                    setEditingConfiguration(true);
                    configurationTestMutation.reset();
                  }}
                >
                  <KeyRound aria-hidden="true" size={15} strokeWidth={1.8} />
                </button>
              </section>
            )}
          </aside>

          <section className="ai-test-flow" aria-label="AI 会话">
            <div className="ai-test-flow-notices">
              {error !== undefined && (
                <p className="management-error ai-test-workspace-error" role="alert">
                  {error}
                </p>
              )}
              {configurationTestMutation.data !== undefined && (
                <p className="ai-configuration-success" role="status">
                  <CheckCircle2 aria-hidden="true" size={16} strokeWidth={1.8} />
                  {configurationTestMutation.data.message}
                </p>
              )}
            </div>

            <div className="ai-test-timeline" aria-label="测试过程">
              {visibleMessages.length === 0 &&
              !thinking &&
              timelineTestRun === undefined &&
              timelineWorkspaceExecution === undefined ? (
                <section className="ai-test-flow-empty" aria-label="暂无 AI 计划">
                  <MessageSquareText aria-hidden="true" size={24} strokeWidth={1.6} />
                  <div>
                    <strong>从一个测试目标开始</strong>
                    <p>
                      AI 会先生成可审阅计划；默认的自主执行会读取手机实时画面和 UI
                      层级，逐步完成目标。
                    </p>
                  </div>
                </section>
              ) : (
                <>
                  {visibleMessages.map((message) => (
                    <article key={message.id} className={`ai-test-message ${message.role}`}>
                      <p>{message.content}</p>
                      {(message.role === "user" || message.role === "assistant") && (
                        <time className="ai-test-message-time" dateTime={message.createdAt}>
                          {formatMessageTime(message.createdAt)}
                        </time>
                      )}
                    </article>
                  ))}
                  {timelineTestRun !== undefined && (
                    <ConversationTestRunCard
                      run={timelineTestRun}
                      plannedActions={timelineTestPlanActions}
                      cancelling={cancelMutation.isPending}
                      onCancel={(runId) => cancelMutation.mutate(runId)}
                    />
                  )}
                  {timelineTestRun === undefined && timelineWorkspaceExecution !== undefined && (
                    <ConversationWorkspaceExecutionCard execution={timelineWorkspaceExecution} />
                  )}
                  {thinking && (
                    <article
                      className="ai-test-message assistant ai-test-message-thinking"
                      role="status"
                      aria-label="AI 正在思考"
                    >
                      <LoaderCircle aria-hidden="true" size={15} className="test-run-spinner" />
                      <span>思考中</span>
                      <time>已处理 {thinkingElapsedSeconds}s</time>
                    </article>
                  )}
                </>
              )}
            </div>

            <form
              className="ai-test-composer"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                stageApk(event.dataTransfer.files.item(0) ?? undefined);
              }}
              onSubmit={(event) => {
                event.preventDefault();
                if (canGenerate) {
                  const controller = new AbortController();
                  const exchangeId = crypto.randomUUID();
                  const submittedGoal = goal.trim();
                  const submittedAt = Date.now();
                  planRequestAbortControllerRef.current = controller;
                  setPendingConversationExchange({
                    id: exchangeId,
                    projectId,
                    conversationId: activeConversationId,
                    userMessage: {
                      id: `${exchangeId}:user`,
                      role: "user",
                      content: submittedGoal,
                      createdAt: new Date(submittedAt).toISOString(),
                    },
                    startedAt: submittedAt,
                  });
                  setGoal("");
                  planMutation.mutate({
                    controller,
                    exchangeId,
                    request: {
                      projectId,
                      conversationId: activeConversationId,
                      ...(device === undefined ? {} : { deviceSerial: device.serial }),
                      appId,
                      ...(installableArtifacts.length === 0
                        ? {}
                        : {
                            installableArtifactIds: installableArtifacts.map(
                              (artifact) => artifact.id,
                            ),
                          }),
                      liveUiExecution: true,
                      workspaceExecution: false,
                      goal: submittedGoal,
                    },
                  });
                }
              }}
            >
              <textarea
                aria-label="测试目标"
                placeholder="描述要验证的流程、关键页面和预期结果..."
                value={goal}
                disabled={planMutation.isPending}
                maxLength={4_000}
                onChange={(event) => setGoal(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
                    return;
                  }

                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }}
              />
              <input
                ref={apkInputRef}
                className="ai-test-apk-input"
                type="file"
                accept=".apk,application/vnd.android.package-archive"
                aria-label="添加 APK"
                tabIndex={-1}
                onChange={(event) => {
                  stageApk(event.target.files?.item(0) ?? undefined);
                  event.currentTarget.value = "";
                }}
              />
              {(installableArtifacts.length > 0 || uploadApkMutation.isPending) && (
                <div className="ai-test-apk-attachments" aria-label="可安装 APK">
                  {installableArtifacts.map((artifact) => (
                    <span key={artifact.id}>
                      <strong>{artifact.fileName}</strong>
                      <small>{artifact.metadata.packageName}</small>
                      <button
                        type="button"
                        aria-label={`移除 ${artifact.fileName}`}
                        title="移除 APK"
                        disabled={discardApkMutation.isPending}
                        onClick={() => discardApkMutation.mutate(artifact.id)}
                      >
                        <X aria-hidden="true" size={13} strokeWidth={2} />
                      </button>
                    </span>
                  ))}
                  {uploadApkMutation.isPending && (
                    <span className="ai-test-apk-uploading">
                      <LoaderCircle aria-hidden="true" size={13} className="test-run-spinner" />
                      正在解析 APK
                    </span>
                  )}
                </div>
              )}
              <footer>
                <div className="ai-test-composer-actions">
                  <button
                    className="icon-button ai-test-attach-apk"
                    type="button"
                    aria-label="添加 APK"
                    title="添加 APK"
                    disabled={uploadApkMutation.isPending || planMutation.isPending}
                    onClick={() => apkInputRef.current?.click()}
                  >
                    <Paperclip aria-hidden="true" size={15} strokeWidth={1.9} />
                  </button>
                </div>
                <button
                  className="primary-command ai-test-composer-submit"
                  type={planMutation.isPending ? "button" : "submit"}
                  aria-label={planMutation.isPending ? "停止生成" : "生成操作计划"}
                  title={planMutation.isPending ? "停止生成" : "生成操作计划"}
                  disabled={planMutation.isPending ? false : !canGenerate}
                  onClick={
                    planMutation.isPending
                      ? () => planRequestAbortControllerRef.current?.abort()
                      : undefined
                  }
                >
                  {planMutation.isPending ? (
                    <Square aria-hidden="true" size={13} fill="currentColor" strokeWidth={2} />
                  ) : (
                    <ArrowUp aria-hidden="true" size={16} strokeWidth={2.2} />
                  )}
                </button>
              </footer>
            </form>
          </section>

          <aside className="ai-test-inspector" aria-label="当前测试计划与测试内容">
            <section className="ai-test-plan-inspector" aria-label="当前测试执行计划">
              <header>
                <div>
                  <Activity aria-hidden="true" size={17} strokeWidth={1.8} />
                  <h2>当前计划</h2>
                </div>
                <span className="ai-test-plan-approval">
                  {selectedExecutionPlan?.workspaceExecution === true
                    ? "已授权执行"
                    : "执行前必须确认"}
                </span>
              </header>
              {selectedPlanResponse === undefined || selectedExecutionPlan === undefined ? (
                <p className="ai-test-inspector-empty">生成计划后，会在此处显示待执行步骤。</p>
              ) : (
                <>
                  <label className="ai-test-plan-picker">
                    <select
                      aria-label="当前测试计划"
                      value={selectedPlanResponse.plan.id}
                      onChange={(event) => setSelectedPlanId(event.target.value)}
                    >
                      {messages
                        .filter((message) => message.plan !== undefined)
                        .map((message, index) => (
                          <option key={message.plan?.plan.id} value={message.plan?.plan.id}>
                            计划 {index + 1} · {message.plan?.plan.actions.length} 个步骤
                          </option>
                        ))}
                    </select>
                  </label>
                  <p className="ai-test-plan-summary">
                    <span>{selectedExecutionPlan.actions.length} 个步骤</span>
                    <span>{selectedPlanResponse.context.evidence.length} 条源码证据</span>
                    {selectedExecutionPlan.liveUiExecution !== undefined && <span>实时 UI</span>}
                    {selectedExecutionPlan.workspaceExecution === true && <span>工作区操作</span>}
                  </p>
                  <ol className="ai-test-plan-actions">
                    {selectedExecutionPlan.actions.map((action, index) => (
                      <li key={`${selectedExecutionPlan.id}-${index}`}>
                        <strong>{index + 1}</strong>
                        <code>{actionLabel(action)}</code>
                      </li>
                    ))}
                  </ol>
                  <footer className="ai-test-plan-execution">
                    <code>
                      {selectedExecutionPlan.workspaceExecution === true
                        ? (device?.model ?? device?.serial ?? "未选择设备")
                        : (selectedExecutionPlan.targetAppId ?? appId)}
                    </code>
                    <button
                      className="primary-command"
                      type="button"
                      disabled={
                        device === undefined ||
                        (selectedExecutionPlan.workspaceExecution !== true &&
                          (selectedExecutionPlan.targetAppId ?? appId).length === 0) ||
                        testExecutionMutation.isPending ||
                        workspaceExecutionMutation.isPending ||
                        activeRun !== undefined
                      }
                      onClick={() => executePlan(selectedExecutionPlan, selectedPlanResponse)}
                    >
                      <Play aria-hidden="true" size={14} strokeWidth={1.9} />
                      {testExecutionMutation.isPending || workspaceExecutionMutation.isPending
                        ? "正在启动"
                        : "执行计划"}
                    </button>
                    {completedExplorationRun !== undefined && (
                      <button
                        className="ai-secondary-command"
                        type="button"
                        disabled={
                          saveExplorationMutation.isPending ||
                          savedExplorationCase !== undefined ||
                          activeRun !== undefined
                        }
                        onClick={() =>
                          saveExplorationMutation.mutate({
                            runId: completedExplorationRun.id,
                            name: selectedPlanResponse.reply.slice(0, 80),
                          })
                        }
                      >
                        <FilePlus2 aria-hidden="true" size={14} strokeWidth={1.9} />
                        {saveExplorationMutation.isPending
                          ? "正在保存"
                          : savedExplorationCase === undefined
                            ? "保存为 DSL 用例"
                            : "已保存为 DSL"}
                      </button>
                    )}
                    {savedExplorationSuite !== undefined && savedExplorationCase !== undefined && (
                      <button
                        className="primary-command"
                        type="button"
                        disabled={
                          device === undefined ||
                          offlineRegressionMutation.isPending ||
                          activeRun !== undefined
                        }
                        title="使用本地 DSL 固定步骤执行，不会请求 AI 模型"
                        onClick={() => {
                          if (
                            device !== undefined &&
                            globalThis.confirm(
                              `确认在 ${device.model ?? device.serial} 上执行本地 DSL 回归吗？执行过程不会调用 AI 模型。`,
                            )
                          ) {
                            offlineRegressionMutation.mutate({
                              suiteId: savedExplorationSuite.id,
                              caseId: savedExplorationCase.id,
                              deviceSerial: device.serial,
                            });
                          }
                        }}
                      >
                        <Play aria-hidden="true" size={14} fill="currentColor" strokeWidth={1.9} />
                        {offlineRegressionMutation.isPending ? "正在启动" : "本地回归"}
                      </button>
                    )}
                  </footer>
                  {savedExplorationSuite !== undefined && savedExplorationCase !== undefined && (
                    <p className="ai-test-plan-evidence" role="status">
                      已保存到“{savedExplorationSuite.suite.suite.name}” v
                      {savedExplorationSuite.suite.suite.version}。后续执行仅使用本地 DSL，不会调用
                      AI。
                    </p>
                  )}
                  {lastWorkspaceExecution !== undefined &&
                    lastWorkspaceExecution.projectId === selectedExecutionPlan.projectId && (
                      <p className="ai-test-plan-evidence" role="status">
                        {lastWorkspaceExecution.status === "succeeded"
                          ? `工作区操作完成：${lastWorkspaceExecution.results.length} 个动作。`
                          : `工作区操作失败：${lastWorkspaceExecution.results.at(-1)?.message ?? "未知错误"}`}
                      </p>
                    )}
                </>
              )}
            </section>

            <section className="ai-test-run-history" aria-label="最近测试运行">
              <header>
                <div>
                  <Clock3 aria-hidden="true" size={17} strokeWidth={1.8} />
                  <h2>最近运行</h2>
                </div>
                <button
                  className="ai-test-run-history-all"
                  type="button"
                  aria-label="查看全部测试运行"
                  disabled={runs.length === 0}
                  onClick={() => setSelectedRunId(runs[0]?.id ?? "")}
                >
                  全部 {runs.length}
                </button>
              </header>
              {runs.length === 0 ? (
                <p>暂无测试运行。</p>
              ) : (
                <ol>
                  {runs.slice(0, 3).map((run) => (
                    <li key={run.id}>
                      <div>
                        <strong>{run.name}</strong>
                        <small>{formatDateTime(run.startedAt)}</small>
                      </div>
                      <span className={`test-status test-status-${run.status}`}>
                        {statusIcon(run.status)}
                        {statusLabel(run.status)}
                      </span>
                      <button
                        className="ai-test-run-detail-button"
                        type="button"
                        aria-label={`查看 ${run.name} 的运行详情`}
                        onClick={() => setSelectedRunId(run.id)}
                      >
                        详情
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <TestSuitePanel device={device} projectId={projectId} />
          </aside>
        </div>
      )}
      {selectedRun !== undefined && (
        <TestRunDetailsDialog
          key={selectedRun.id}
          run={selectedRun}
          runs={runs}
          cancelling={cancelMutation.isPending}
          onCancel={(runId) => cancelMutation.mutate(runId)}
          onClose={() => setSelectedRunId("")}
          onSelectRun={setSelectedRunId}
        />
      )}
      {renamingProject !== undefined && (
        <div className="modal-backdrop" role="presentation">
          <form
            className="project-build-dialog ai-test-project-dialog"
            aria-label="编辑项目名称"
            onSubmit={(event) => {
              event.preventDefault();
              const name = projectNameDraft.trim();
              if (name.length > 0) {
                renameProjectMutation.mutate({ projectId: renamingProject.id, name });
              }
            }}
          >
            <h2>编辑项目名称</h2>
            <label className="ai-test-project-name-field">
              <span>项目名称</span>
              <input
                autoFocus
                maxLength={256}
                value={projectNameDraft}
                disabled={renameProjectMutation.isPending}
                onChange={(event) => setProjectNameDraft(event.target.value)}
              />
            </label>
            {renameProjectMutation.isError && (
              <p className="management-error" role="alert">
                {renameProjectMutation.error.message}
              </p>
            )}
            <footer>
              <button
                type="button"
                disabled={renameProjectMutation.isPending}
                onClick={() => {
                  setRenamingProject(undefined);
                  setProjectNameDraft("");
                  renameProjectMutation.reset();
                }}
              >
                取消
              </button>
              <button
                className="primary-command"
                type="submit"
                disabled={renameProjectMutation.isPending || projectNameDraft.trim().length === 0}
              >
                {renameProjectMutation.isPending ? "正在保存" : "保存"}
              </button>
            </footer>
          </form>
        </div>
      )}
      {removingProjectConversation !== undefined && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="project-build-dialog project-delete-dialog ai-test-project-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="确认移除项目会话"
          >
            <h2>移除项目会话</h2>
            <p>
              确定移除 <strong>{removingProjectConversation.name}</strong> 的 AI 会话吗？
            </p>
            <p>这会清除该项目的 AI 对话、计划和上下文，不会删除项目、源码、构建产物或测试记录。</p>
            {removeConversationMutation.isError && (
              <p className="management-error" role="alert">
                {removeConversationMutation.error.message}
              </p>
            )}
            <footer>
              <button
                type="button"
                disabled={removeConversationMutation.isPending}
                onClick={() => {
                  setRemovingProjectConversation(undefined);
                  removeConversationMutation.reset();
                }}
              >
                取消
              </button>
              <button
                className="project-delete-command"
                type="button"
                disabled={removeConversationMutation.isPending}
                onClick={() => removeConversationMutation.mutate(removingProjectConversation.id)}
              >
                {removeConversationMutation.isPending ? "正在移除" : "移除会话"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
