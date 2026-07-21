import { useMutation, useQuery } from "@tanstack/react-query";
import { Bot, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { useState } from "react";
import type { AiPlanResponse, AndroidDevice } from "@device-robot/contracts";

import { fetchAiModelStatus, generateAiPlan } from "../api/ai";
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

export function AiPlanPanel({ device }: { device: AndroidDevice | undefined }): React.JSX.Element {
  const [goal, setGoal] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
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
  const projectId = selectedProjectId || projectsQuery.data?.projects[0]?.id || "";
  const selectedProject = projectsQuery.data?.projects.find((project) => project.id === projectId);
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
  const configured = statusQuery.data?.configured === true;
  const canGenerate = configured && projectId.length > 0 && goal.trim().length > 0;
  const error = statusQuery.isError
    ? statusQuery.error.message
    : projectsQuery.isError
      ? projectsQuery.error.message
      : planMutation.isError
        ? planMutation.error.message
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

      <section className={`ai-model-status${configured ? " ready" : ""}`} aria-label="模型状态">
        <ShieldCheck aria-hidden="true" size={18} strokeWidth={1.8} />
        <div>
          <strong>{configured ? "模型已配置" : "模型尚未配置"}</strong>
          <span>
            {configured
              ? `${statusQuery.data?.provider} · ${statusQuery.data?.model}`
              : (statusQuery.data?.reason ?? "正在检查本地模型配置。")}
          </span>
        </div>
      </section>
      {!configured && statusQuery.data !== undefined && (
        <p className="ai-config-hint">
          请在启动 Agent 的环境中设置 <code>AIMOBILETESTER_AI_BASE_URL</code>、
          <code>AIMOBILETESTER_AI_API_KEY</code> 和 <code>AIMOBILETESTER_AI_MODEL</code>
          。密钥不会返回到网页。
        </p>
      )}

      {error !== undefined && (
        <p className="management-error" role="alert">
          {error}
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
        <label>
          <span>项目上下文</span>
          <select
            aria-label="AI 项目上下文"
            value={projectId}
            disabled={planMutation.isPending || projectsQuery.data?.projects.length === 0}
            onChange={(event) => setSelectedProjectId(event.target.value)}
          >
            {projectsQuery.data?.projects.length === 0 ? (
              <option value="">请先接入 Android 项目</option>
            ) : (
              projectsQuery.data?.projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))
            )}
          </select>
          {selectedProject !== undefined && (
            <small>
              {selectedProject.sourceIndex === undefined
                ? "尚无源码索引，AI 会明确标注证据不足。"
                : `已加载 ${selectedProject.sourceIndex.evidence.length} 条源码索引证据。`}
            </small>
          )}
        </label>
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
        <div className="ai-plan-actions">
          <span>
            {device === undefined
              ? "未绑定设备：仅生成计划"
              : `已绑定设备：${device.model ?? device.serial}`}
          </span>
          <button
            className="primary-command"
            type="submit"
            disabled={!canGenerate || planMutation.isPending}
          >
            <Sparkles aria-hidden="true" size={15} strokeWidth={1.9} />
            {planMutation.isPending ? "正在生成计划" : "生成操作计划"}
          </button>
        </div>
      </form>

      {messages.length === 0 ? (
        <p className="management-empty">
          提交测试目标后，AI 将基于真实项目索引生成可审阅的操作计划。
        </p>
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
    </section>
  );
}
