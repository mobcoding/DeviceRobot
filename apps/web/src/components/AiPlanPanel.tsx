import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CheckCircle2,
  FolderGit2,
  KeyRound,
  ListRestart,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import type { AiPlanResponse, AndroidDevice, AndroidProject } from "@device-robot/contracts";

import {
  fetchAiModelStatus,
  fetchAiModels,
  generateAiPlan,
  testAiModelConfiguration,
} from "../api/ai";
import { fetchProjects } from "../api/projects";

type ConversationMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  plan?: AiPlanResponse;
};

function actionLabel(action: AiPlanResponse["plan"]["actions"][number]): string {
  return action.action;
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

export function AiPlanPanel({ device }: { device: AndroidDevice | undefined }): React.JSX.Element {
  const [goal, setGoal] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [externalDataAcknowledged, setExternalDataAcknowledged] = useState(false);
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
  const projects = projectsQuery.data?.projects ?? [];
  const projectId = selectedProjectId || projects[0]?.id || "";
  const selectedProject = projects.find((project) => project.id === projectId);
  const planMutation = useMutation({
    mutationFn: generateAiPlan,
    onSuccess: (response, request) => {
      setMessages((current) => [
        ...current,
        { id: `${response.plan.id}-user`, role: "user", content: request.goal },
        { id: response.plan.id, role: "assistant", content: response.reply, plan: response },
      ]);
      setGoal("");
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
      await queryClient.invalidateQueries({ queryKey: ["ai-model-status"] });
    },
  });
  const configured = statusQuery.data?.configured === true;
  const canGenerate = configured && projectId.length > 0 && goal.trim().length > 0;
  const showConfiguration = !configured && !statusQuery.isPending && !statusQuery.isError;
  const availableModels = modelListMutation.data?.models ?? [];
  const canFetchModels =
    baseUrl.trim().length > 0 && apiKey.trim().length > 0 && !modelListMutation.isPending;
  const canTestConfiguration =
    canFetchModels &&
    selectedModel.length > 0 &&
    externalDataAcknowledged &&
    !configurationTestMutation.isPending;
  const modelTitle = statusQuery.isError
    ? "模型状态不可用"
    : statusQuery.isPending
      ? "正在检查模型配置"
      : configured
        ? "模型已配置"
        : "模型尚未配置";
  const modelDetail = statusQuery.isError
    ? "无法读取本地 Agent 的模型配置。"
    : configured
      ? `${statusQuery.data?.provider} · ${statusQuery.data?.model}`
      : (statusQuery.data?.reason ?? "正在读取本地 Agent 的模型配置。");
  const error = statusQuery.isError
    ? statusQuery.error.message
    : projectsQuery.isError
      ? projectsQuery.error.message
      : planMutation.isError
        ? planMutation.error.message
        : undefined;
  const configurationError = modelListMutation.isError
    ? modelListMutation.error.message
    : configurationTestMutation.isError
      ? configurationTestMutation.error.message
      : undefined;

  return (
    <section className="management-workspace ai-plan-panel" aria-label="AI 对话与用例">
      <header className="management-heading">
        <div className="management-title-row">
          <Bot aria-hidden="true" size={29} strokeWidth={1.7} />
          <h1>AI 对话与用例</h1>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="刷新模型状态"
          title="刷新模型状态"
          disabled={statusQuery.isFetching}
          onClick={() => void statusQuery.refetch()}
        >
          <RefreshCw aria-hidden="true" size={17} strokeWidth={1.8} />
        </button>
      </header>

      {!showConfiguration && (
        <section
          className={`ai-model-status${configured ? " ready" : ""}${statusQuery.isError ? " error" : ""}`}
          aria-label="模型状态"
        >
          <div className="ai-model-status-main">
            <ShieldCheck aria-hidden="true" size={19} strokeWidth={1.8} />
            <div>
              <span>AI 模型</span>
              <strong>{modelTitle}</strong>
            </div>
          </div>
          <p>{modelDetail}</p>
        </section>
      )}

      {showConfiguration ? (
        <form
          className="ai-configuration-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (canTestConfiguration) {
              configurationTestMutation.mutate({
                baseUrl: baseUrl.trim(),
                apiKey: apiKey.trim(),
                model: selectedModel,
              });
            }
          }}
        >
          <header className="ai-plan-form-heading">
            <div>
              <p className="eyebrow">配置模型</p>
              <h2>连接 OpenAI 兼容服务</h2>
            </div>
            <span className="ai-configuration-status">
              <KeyRound aria-hidden="true" size={16} strokeWidth={1.8} />
              <strong>模型尚未配置</strong>
            </span>
          </header>
          <p className="ai-configuration-intro">
            填写服务地址与 API Key 后拉取可用模型。测试成功后，配置将在当前 Agent
            运行期间用于生成计划；密钥不会返回网页、写入日志或项目文件。
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
                  modelListMutation.mutate({ baseUrl: baseUrl.trim(), apiKey: apiKey.trim() });
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
          {configurationTestMutation.data !== undefined && (
            <p className="ai-configuration-success" role="status">
              <CheckCircle2 aria-hidden="true" size={17} strokeWidth={1.8} />
              {configurationTestMutation.data.message}
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
        <>
          {error !== undefined && (
            <p className="management-error" role="alert">
              {error}
            </p>
          )}
          {configurationTestMutation.data !== undefined && (
            <p className="ai-configuration-success" role="status">
              <CheckCircle2 aria-hidden="true" size={17} strokeWidth={1.8} />
              {configurationTestMutation.data.message}
            </p>
          )}

          <form
            className="ai-plan-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (canGenerate) {
                planMutation.mutate({
                  projectId,
                  ...(device === undefined ? {} : { deviceSerial: device.serial }),
                  goal: goal.trim(),
                });
              }
            }}
          >
            <header className="ai-plan-form-heading">
              <div>
                <p className="eyebrow">新建计划</p>
                <h2>描述你想验证的测试目标</h2>
              </div>
              <span className="ai-plan-safety-note">
                <ShieldCheck aria-hidden="true" size={14} strokeWidth={1.8} />
                仅生成草案，不操作设备
              </span>
            </header>
            <div className="ai-context-grid">
              <label className="ai-context-field">
                <span>
                  <FolderGit2 aria-hidden="true" size={15} strokeWidth={1.8} />
                  项目上下文
                </span>
                <select
                  aria-label="AI 项目上下文"
                  value={projectId}
                  disabled={
                    planMutation.isPending || projectsQuery.isPending || projects.length === 0
                  }
                  onChange={(event) => setSelectedProjectId(event.target.value)}
                >
                  {projectsQuery.isPending ? (
                    <option value="">正在加载项目…</option>
                  ) : projects.length === 0 ? (
                    <option value="">请先接入 Android 项目</option>
                  ) : (
                    projects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {projectLabel(project)}
                      </option>
                    ))
                  )}
                </select>
                <small>
                  {selectedProject === undefined
                    ? "选择项目后，AI 会读取已建立的源码索引。"
                    : selectedProject.sourceIndex === undefined
                      ? "尚无源码索引，生成结果会标注证据不足。"
                      : `已加载 ${selectedProject.sourceIndex.evidence.length} 条源码索引证据。`}
                </small>
              </label>
              <section className="ai-device-context" aria-label="当前测试设备">
                <span>
                  <Smartphone aria-hidden="true" size={15} strokeWidth={1.8} />
                  当前测试设备
                </span>
                <strong>
                  {device === undefined ? "暂未选择设备" : (device.model ?? device.serial)}
                </strong>
                <small>
                  {device === undefined
                    ? "可先生成计划，执行前再绑定设备。"
                    : `序列号：${device.serial}`}
                </small>
              </section>
            </div>
            <label className="ai-goal-field">
              <span>测试目标</span>
              <textarea
                aria-label="测试目标"
                placeholder="例如：为首页登录入口生成一组可审阅的冒烟测试操作。"
                value={goal}
                disabled={planMutation.isPending}
                maxLength={4_000}
                onChange={(event) => setGoal(event.target.value)}
              />
            </label>
            <footer className="ai-plan-actions">
              <span>计划生成后仍需人工确认，当前不会向手机发送操作。</span>
              <button
                className="primary-command"
                type="submit"
                disabled={!canGenerate || planMutation.isPending}
              >
                <Sparkles aria-hidden="true" size={15} strokeWidth={1.9} />
                {planMutation.isPending ? "正在生成计划" : "生成操作计划"}
              </button>
            </footer>
          </form>

          {messages.length === 0 ? (
            <section className="ai-empty-state" aria-label="暂无 AI 计划">
              <Bot aria-hidden="true" size={22} strokeWidth={1.6} />
              <div>
                <strong>暂无操作计划</strong>
                <p>填写测试目标后，AI 将基于真实项目索引生成可审阅的操作计划。</p>
              </div>
            </section>
          ) : (
            <div className="ai-conversation" aria-label="AI 对话记录">
              {messages.map((message) => (
                <article key={message.id} className={`ai-message ${message.role}`}>
                  <strong>{message.role === "user" ? "测试目标" : "AI 计划"}</strong>
                  <p>{message.content}</p>
                  {message.plan !== undefined && (
                    <section className="ai-plan-result" aria-label="ActionPlan 预览">
                      <header>
                        <span>ActionPlan 预览</span>
                        <em>执行前必须确认</em>
                      </header>
                      <ol>
                        {message.plan.plan.actions.map((action, index) => (
                          <li key={`${message.plan?.plan.id}-${index}`}>
                            <strong>{index + 1}</strong>
                            <code>{actionLabel(action)}</code>
                            <pre>{JSON.stringify(action, null, 2)}</pre>
                          </li>
                        ))}
                      </ol>
                      <p>
                        已引用 {message.plan.context.evidence.length} 条源码证据；
                        {message.plan.policy.reason}
                      </p>
                    </section>
                  )}
                </article>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
