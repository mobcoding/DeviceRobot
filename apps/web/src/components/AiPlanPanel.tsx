import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  CircleX,
  Clock3,
  FileArchive,
  FileText,
  FolderGit2,
  Image,
  KeyRound,
  List,
  ListRestart,
  LoaderCircle,
  MessageSquareText,
  Paperclip,
  Play,
  RefreshCw,
  SendHorizontal,
  ShieldCheck,
  Smartphone,
  Square,
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
  TestExecutionRun,
  TestStepExecution,
  WorkspaceExecutionResponse,
} from "@device-robot/contracts";

import { useAgentUnavailable } from "../agent-availability";
import {
  fetchAiModelStatus,
  fetchAiConversation,
  fetchAiConversations,
  fetchAiModels,
  generateAiPlan,
  testAiModelConfiguration,
} from "../api/ai";
import { fetchProjects } from "../api/projects";
import { discardApk, uploadApk } from "../api/apk";
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
  plan?: AiPlanResponse;
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

function lastAiConversationStorageKey(projectId: string): string {
  return `${LAST_AI_CONVERSATION_STORAGE_PREFIX}${projectId}`;
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
  const [liveUiExecution, setLiveUiExecution] = useState(true);
  const [workspaceExecution, setWorkspaceExecution] = useState(false);
  const [planMenuOpen, setPlanMenuOpen] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [selectedRunId, setSelectedRunId] = useState("");
  const [installableArtifacts, setInstallableArtifacts] = useState<ApkArtifact[]>([]);
  const [lastWorkspaceExecution, setLastWorkspaceExecution] =
    useState<WorkspaceExecutionResponse>();
  const apkInputRef = useRef<HTMLInputElement>(null);
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
  const runsQuery = useQuery({
    queryKey: ["test-runs"],
    queryFn: ({ signal }) => fetchTestRuns(signal),
    retry: 1,
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => run.status === "running") ? 1_000 : 8_000,
  });
  const availableProjects = projectsQuery.data?.projects ?? [];
  const projectId = availableProjects.some((project) => project.id === selectedProjectId)
    ? selectedProjectId
    : (availableProjects[0]?.id ?? "");
  const projects =
    projectId.length === 0
      ? availableProjects
      : [...availableProjects].sort((left, right) => {
          if (left.id === projectId) {
            return -1;
          }
          if (right.id === projectId) {
            return 1;
          }
          return 0;
        });
  const selectedProject = projects.find((project) => project.id === projectId);
  const appIds = applicationIds(selectedProject);
  const appId = appIds[0] ?? "";
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
  const messages: ConversationMessage[] = (conversationDetailQuery.data?.messages ?? []).map(
    (message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      ...(message.plan === undefined ? {} : { plan: message.plan }),
    }),
  );
  useEffect(() => {
    const planIds = messages.flatMap((message) =>
      message.plan === undefined ? [] : [message.plan.plan.id],
    );
    if (planIds.length > 0 && !planIds.includes(selectedPlanId)) {
      setSelectedPlanId(planIds.at(-1) ?? "");
    }
  }, [messages, selectedPlanId]);
  const planMutation = useMutation({
    mutationFn: generateAiPlan,
    onSuccess: async (response, request) => {
      setSelectedPlanId(response.plan.id);
      setGoal("");
      if (request.conversationId !== undefined) {
        await queryClient.invalidateQueries({
          queryKey: ["ai-conversation", request.conversationId],
        });
      }
      if (response.plan.workspaceExecution === true && device !== undefined) {
        workspaceExecutionMutation.mutate({ plan: response.plan, deviceSerial: device.serial });
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
    mutationFn: startTestExecution,
    onSuccess: async (_run, request) => {
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
  const workspaceExecutionMutation = useMutation({
    mutationFn: startWorkspaceExecution,
    onSuccess: (result) => setLastWorkspaceExecution(result),
  });
  const cancelMutation = useMutation({
    mutationFn: cancelTestExecution,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["test-runs"] });
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
    selectedConversationId.length > 0 &&
    (workspaceExecution || appId.length > 0) &&
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
            : planMutation.isError
              ? planMutation.error.message
              : uploadApkMutation.isError
                ? uploadApkMutation.error.message
                : discardApkMutation.isError
                  ? discardApkMutation.error.message
                  : testExecutionMutation.isError
                    ? testExecutionMutation.error.message
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
  const runs = runsQuery.data?.runs ?? [];
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

  const executePlan = (plan: ActionPlan, response: AiPlanResponse): void => {
    if (plan.workspaceExecution === true) {
      if (device === undefined) {
        return;
      }
      workspaceExecutionMutation.mutate({ plan, deviceSerial: device.serial });
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
      plan,
      deviceSerial: device.serial,
      appId: targetAppId,
      name: response.reply.slice(0, 80),
      approved: true,
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
        <div className="ai-test-workspace-grid">
          <aside className="ai-test-project-sidebar" aria-label="测试项目">
            <header>
              <FolderGit2 aria-hidden="true" size={18} strokeWidth={1.8} />
              <div>
                <span>项目</span>
                <h2>测试上下文</h2>
              </div>
            </header>
            <div className="ai-test-project-list">
              {projectsQuery.isPending ? (
                <p>正在加载项目...</p>
              ) : projects.length === 0 ? (
                <p>请先在项目页接入 Android 项目。</p>
              ) : (
                projects.map((project) => {
                  const selected = project.id === projectId;
                  const projectApps = applicationIds(project);
                  return (
                    <button
                      key={project.id}
                      className={`ai-test-project-item${selected ? " selected" : ""}`}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => {
                        saveAiWorkspaceId(LAST_AI_PROJECT_STORAGE_KEY, project.id);
                        onProjectSelectionChange?.(project.id);
                        onConversationSelectionChange?.("");
                        setSelectedProjectId(project.id);
                        setSelectedConversationId("");
                        setSelectedPlanId("");
                      }}
                    >
                      <div className="ai-test-project-title">
                        <strong>{projectLabel(project)}</strong>
                        <span aria-label={`${projectApps.length} 个可测试应用`}>
                          {projectApps.length}
                        </span>
                      </div>
                      <small title={projectApps.join("、")}>
                        {projectApps.length === 0 ? "暂无测试应用" : projectApps.join("、")}
                      </small>
                    </button>
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

          <section className="ai-test-flow" aria-label="实施测试流程">
            <header className="ai-test-flow-heading">
              <div>
                <span className="eyebrow">AI 测试</span>
                <h1>实施测试流程</h1>
                <p>{appId.length === 0 ? "请选择含测试应用的项目后开始。" : appId}</p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="刷新测试流程"
                title="刷新测试流程"
                disabled={
                  conversationsQuery.isFetching ||
                  conversationDetailQuery.isFetching ||
                  runsQuery.isFetching
                }
                onClick={() => {
                  void conversationsQuery.refetch();
                  void conversationDetailQuery.refetch();
                  void runsQuery.refetch();
                }}
              >
                <RefreshCw aria-hidden="true" size={16} strokeWidth={1.8} />
              </button>
            </header>

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

            <div className="ai-test-timeline" aria-label="测试过程">
              {activeRun !== undefined && (
                <section
                  className={`ai-test-active-run ${activeRun.status}`}
                  aria-label="当前测试执行"
                >
                  <header>
                    <div>
                      <span>当前执行</span>
                      <strong>{activeRun.name}</strong>
                    </div>
                    <span className={`test-status test-status-${activeRun.status}`}>
                      {statusIcon(activeRun.status)}
                      {statusLabel(activeRun.status)}
                    </span>
                    <button
                      className="icon-button danger-icon-button"
                      type="button"
                      aria-label="取消当前测试"
                      title="取消当前测试"
                      disabled={cancelMutation.isPending}
                      onClick={() => cancelMutation.mutate(activeRun.id)}
                    >
                      <Square aria-hidden="true" size={13} fill="currentColor" strokeWidth={1.8} />
                    </button>
                  </header>
                  <ol>
                    {activeRun.steps.length === 0 ? (
                      <li className="ai-test-active-run-pending">
                        <LoaderCircle aria-hidden="true" size={15} className="test-run-spinner" />
                        正在启动 Appium 会话并读取首个页面。
                      </li>
                    ) : (
                      activeRun.steps.map((step) => (
                        <li key={`${activeRun.id}:${step.index}`}>
                          <span className="test-step-index">{step.index + 1}</span>
                          <code>{step.action.action}</code>
                          <span className={`test-status test-status-${step.status}`}>
                            {statusIcon(step.status)}
                            {statusLabel(step.status)}
                          </span>
                        </li>
                      ))
                    )}
                  </ol>
                </section>
              )}

              {messages.length === 0 ? (
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
                messages.map((message) => (
                  <article key={message.id} className={`ai-test-message ${message.role}`}>
                    <header>
                      <span>{message.role === "user" ? "测试目标" : "AI 计划"}</span>
                      {message.plan !== undefined && (
                        <button
                          type="button"
                          onClick={() => setSelectedPlanId(message.plan?.plan.id ?? "")}
                        >
                          查看计划
                        </button>
                      )}
                    </header>
                    <p>{message.content}</p>
                  </article>
                ))
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
                  planMutation.mutate({
                    projectId,
                    conversationId: selectedConversationId,
                    ...(device === undefined ? {} : { deviceSerial: device.serial }),
                    appId,
                    ...(installableArtifacts.length === 0
                      ? {}
                      : {
                          installableArtifactIds: installableArtifacts.map(
                            (artifact) => artifact.id,
                          ),
                        }),
                    liveUiExecution,
                    workspaceExecution,
                    goal: goal.trim(),
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
                  <details
                    className="ai-test-plan-mode"
                    open={planMenuOpen}
                    onToggle={(event) => setPlanMenuOpen(event.currentTarget.open)}
                  >
                    <summary>
                      方案
                      <ChevronDown aria-hidden="true" size={14} strokeWidth={1.9} />
                    </summary>
                    <div role="menu" aria-label="测试方案">
                      <button
                        className={liveUiExecution ? "" : "selected"}
                        type="button"
                        role="menuitemradio"
                        aria-checked={!liveUiExecution}
                        disabled={planMutation.isPending}
                        onClick={() => {
                          setLiveUiExecution(false);
                          setWorkspaceExecution(false);
                          setPlanMenuOpen(false);
                        }}
                      >
                        <strong>静态执行</strong>
                        <small>仅按审核后的固定步骤执行。</small>
                      </button>
                      <button
                        className={liveUiExecution ? "selected" : ""}
                        type="button"
                        role="menuitemradio"
                        aria-checked={liveUiExecution}
                        disabled={planMutation.isPending}
                        onClick={() => {
                          setLiveUiExecution(true);
                          setWorkspaceExecution(false);
                          setPlanMenuOpen(false);
                        }}
                      >
                        <strong>自主执行</strong>
                        <small>执行时向 AI 提供实时截图与 UI 层级，逐步自主操作。</small>
                      </button>
                      <button
                        className={workspaceExecution ? "selected" : ""}
                        type="button"
                        role="menuitemradio"
                        aria-checked={workspaceExecution}
                        disabled={planMutation.isPending}
                        onClick={() => {
                          setLiveUiExecution(false);
                          setWorkspaceExecution(true);
                          setPlanMenuOpen(false);
                        }}
                      >
                        <strong>工作区操作</strong>
                        <small>直接执行已授权的应用管理、设备控制和 ADB 操作。</small>
                      </button>
                    </div>
                  </details>
                  <span className="ai-test-plan-mode-label">
                    {workspaceExecution ? "工作区操作" : liveUiExecution ? "自主执行" : "静态执行"}
                  </span>
                </div>
                <button
                  className="primary-command ai-test-composer-submit"
                  type="submit"
                  aria-label="生成操作计划"
                  title="生成操作计划"
                  disabled={!canGenerate || planMutation.isPending}
                >
                  {planMutation.isPending ? (
                    <LoaderCircle aria-hidden="true" size={15} className="test-run-spinner" />
                  ) : (
                    <SendHorizontal aria-hidden="true" size={15} strokeWidth={1.9} />
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
                  <div>
                    <span>ActionPlan 预览</span>
                    <h2>当前测试执行计划</h2>
                  </div>
                </div>
                <em>
                  {selectedExecutionPlan?.workspaceExecution === true
                    ? "已授权执行"
                    : "执行前必须确认"}
                </em>
              </header>
              {selectedPlanResponse === undefined || selectedExecutionPlan === undefined ? (
                <p className="ai-test-inspector-empty">生成计划后，会在此处显示待执行步骤。</p>
              ) : (
                <>
                  <label className="ai-test-plan-picker">
                    <span>计划</span>
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
                  <ol className="ai-test-plan-actions">
                    {selectedExecutionPlan.actions.map((action, index) => (
                      <li key={`${selectedExecutionPlan.id}-${index}`}>
                        <strong>{index + 1}</strong>
                        <code>{actionLabel(action)}</code>
                      </li>
                    ))}
                  </ol>
                  <p className="ai-test-plan-evidence">
                    已引用 {selectedPlanResponse.context.evidence.length} 条源码证据。
                  </p>
                  {selectedExecutionPlan.liveUiExecution !== undefined && (
                    <p className="ai-live-ui-summary">
                      已启用自主执行，运行时会传递实时截图和 UI 层级，最多{" "}
                      {selectedExecutionPlan.liveUiExecution.maxSteps} 步。
                    </p>
                  )}
                  {selectedExecutionPlan.workspaceExecution === true && (
                    <p className="ai-live-ui-summary">
                      工作区操作会直接作用于当前设备，不会自动清除应用数据或启动 Appium。
                    </p>
                  )}
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
                  </footer>
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
                  <h2>测试运行</h2>
                </div>
                <div className="ai-test-run-history-actions">
                  <span>{runs.length} 条</span>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="查看全部测试运行"
                    title="查看全部测试运行"
                    disabled={runs.length === 0}
                    onClick={() => setSelectedRunId(runs[0]?.id ?? "")}
                  >
                    <List aria-hidden="true" size={15} strokeWidth={1.8} />
                  </button>
                </div>
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
                      <div className="ai-test-run-row-actions">
                        <button
                          type="button"
                          aria-label={`查看 ${run.name} 的运行详情`}
                          title="查看运行详情"
                          onClick={() => setSelectedRunId(run.id)}
                        >
                          <FileText aria-hidden="true" size={14} strokeWidth={1.8} />
                        </button>
                        {run.status !== "running" && (
                          <>
                            <a
                              href={testReportHtmlUrl(run.id)}
                              target="_blank"
                              rel="noreferrer"
                              title="查看测试报告"
                            >
                              <FileText aria-hidden="true" size={14} strokeWidth={1.8} />
                            </a>
                            <a href={testReportZipUrl(run.id)} title="导出测试报告 ZIP">
                              <FileArchive aria-hidden="true" size={14} strokeWidth={1.8} />
                            </a>
                          </>
                        )}
                      </div>
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
    </section>
  );
}
