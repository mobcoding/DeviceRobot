import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Download, FolderGit2, FolderOpen, GitBranch, RefreshCw } from "lucide-react";
import { useState } from "react";
import type {
  AndroidBuildTarget,
  AndroidProject,
  AndroidSdkInfo,
  ProjectBuildRun,
  ProjectSource,
} from "@device-robot/contracts";

import {
  createProject,
  fetchProjectBuildRuns,
  fetchProjectBuildTargets,
  fetchProjects,
  installProjectAndroidSdk,
  startProjectBuild,
} from "../api/projects";

type ProjectBuildData = {
  targets: AndroidBuildTarget[];
  runs: ProjectBuildRun[];
  androidSdk: AndroidSdkInfo;
};

type PendingBuild = {
  project: AndroidProject;
  target: AndroidBuildTarget;
};

function sourceLabel(source: ProjectSource): string {
  return source === "local" ? "本地目录" : "Git 仓库";
}

function buildStatusLabel(status: ProjectBuildRun["status"]): string {
  switch (status) {
    case "running":
      return "构建中";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

function ProjectBuildSection({
  project,
  data,
  loading,
  building,
  installing,
  onRequestBuild,
  onInstallSdk,
}: {
  project: AndroidProject;
  data: ProjectBuildData | undefined;
  loading: boolean;
  building: boolean;
  installing: boolean;
  onRequestBuild(target: AndroidBuildTarget): void;
  onInstallSdk(projectId: string): void;
}): React.JSX.Element {
  const sdkReady =
    data !== undefined && data.androidSdk.available && data.androidSdk.missingPackages.length === 0;
  const latestRunsByTask = new Map<string, ProjectBuildRun>();
  for (const run of data?.runs ?? []) {
    const current = latestRunsByTask.get(run.taskName);
    if (current === undefined || new Date(run.startedAt) > new Date(current.startedAt)) {
      latestRunsByTask.set(run.taskName, run);
    }
  }
  return (
    <section className="project-build" aria-label={`${project.name} 的构建`}>
      <header>
        <div>
          <strong>Gradle 构建</strong>
          <small>仅使用项目自身的 Gradle Wrapper</small>
          {data !== undefined && (
            <span className={sdkReady ? "project-sdk-state ready" : "project-sdk-state"}>
              {sdkReady ? "Android SDK 已就绪" : "Android SDK 需要准备"}
            </span>
          )}
          {data !== undefined && !sdkReady && (
            <button
              className="project-sdk-install"
              type="button"
              disabled={installing || building}
              onClick={() => onInstallSdk(project.id)}
            >
              <Download aria-hidden="true" size={13} strokeWidth={1.9} />
              {installing ? "正在安装" : "安装所需 SDK"}
            </button>
          )}
        </div>
      </header>
      {!project.gradleWrapper ? (
        <p>未检测到 Gradle Wrapper，已禁用构建操作。</p>
      ) : loading ? (
        <p>正在发现可构建的 Variant。</p>
      ) : data === undefined ? (
        <p>暂时无法读取构建信息。</p>
      ) : data.targets.length === 0 ? (
        <p>未从 Gradle 配置中发现可构建的 Variant。</p>
      ) : (
        <>
          {!sdkReady && (
            <p>
              {installing
                ? "正在准备 Android SDK，请保持此页面打开。"
                : `构建需要：${data.androidSdk.missingPackages.join("、")}`}
            </p>
          )}
          <div className="project-build-targets" aria-label="可构建 Variant">
            {data.targets.map((target) => {
              const latestRun = latestRunsByTask.get(target.taskName);
              return (
                <article
                  key={`${target.modulePath}-${target.variant}`}
                  className="project-build-target"
                >
                  <header>
                    <div>
                      <strong>{target.moduleName}</strong>
                      <em>{target.variant}</em>
                    </div>
                    <button
                      type="button"
                      disabled={building || installing || !sdkReady}
                      onClick={() => onRequestBuild(target)}
                    >
                      构建
                    </button>
                  </header>
                  <code>{target.taskName}</code>
                  <div className={`project-build-status ${latestRun?.status ?? "idle"}`}>
                    <strong>
                      {latestRun === undefined ? "尚未构建" : buildStatusLabel(latestRun.status)}
                    </strong>
                    <small>{latestRun?.message ?? "暂无构建记录"}</small>
                    {latestRun?.artifactPaths[0] !== undefined && (
                      <em>{latestRun.artifactPaths[0]}</em>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

export function ProjectManagerPanel(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [source, setSource] = useState<ProjectSource>("local");
  const [localPath, setLocalPath] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [pendingBuild, setPendingBuild] = useState<PendingBuild>();
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>();
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: ({ signal }) => fetchProjects(signal),
    retry: false,
  });
  const createMutation = useMutation({
    mutationFn: async () =>
      await createProject(
        source === "local"
          ? { source, rootPath: localPath.trim() }
          : { source, remoteUrl: remoteUrl.trim() },
      ),
    onSuccess: async () => {
      setLocalPath("");
      setRemoteUrl("");
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const projectIds = projectsQuery.data?.projects.map((project) => project.id) ?? [];
  const projectBuildsQuery = useQuery({
    queryKey: ["project-build-data", projectIds],
    enabled: projectIds.length > 0,
    queryFn: async ({ signal }): Promise<Record<string, ProjectBuildData>> =>
      Object.fromEntries(
        await Promise.all(
          projectIds.map(async (projectId) => {
            const [targets, runs] = await Promise.all([
              fetchProjectBuildTargets(projectId, signal),
              fetchProjectBuildRuns(projectId, signal),
            ]);
            return [
              projectId,
              { targets: targets.targets, runs: runs.runs, androidSdk: targets.androidSdk },
            ] as const;
          }),
        ),
      ),
  });
  const buildMutation = useMutation({
    mutationFn: async (request: PendingBuild) =>
      await startProjectBuild(request.project.id, {
        modulePath: request.target.modulePath,
        variant: request.target.variant,
        approved: true,
      }),
    onSuccess: async () => {
      setPendingBuild(undefined);
      await queryClient.invalidateQueries({ queryKey: ["project-build-data"] });
    },
  });
  const installSdkMutation = useMutation({
    mutationFn: async (projectId: string) =>
      await installProjectAndroidSdk(projectId, { approved: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["project-build-data"] });
    },
  });
  const submitting = createMutation.isPending;
  const value = source === "local" ? localPath : remoteUrl;
  const error = projectsQuery.isError
    ? projectsQuery.error.message
    : createMutation.isError
      ? createMutation.error?.message
      : projectBuildsQuery.isError
        ? projectBuildsQuery.error.message
        : buildMutation.isError
          ? buildMutation.error?.message
          : installSdkMutation.isError
            ? installSdkMutation.error?.message
            : undefined;

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (value.trim().length > 0) {
      createMutation.mutate();
    }
  };

  return (
    <section className="management-workspace project-manager" aria-label="项目管理">
      <header className="management-heading">
        <div className="management-title-row">
          <FolderGit2 aria-hidden="true" size={29} strokeWidth={1.7} />
          <h1>项目管理</h1>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label="刷新项目列表"
          title="刷新项目列表"
          disabled={projectsQuery.isFetching}
          onClick={() => void projectsQuery.refetch()}
        >
          <RefreshCw aria-hidden="true" size={17} strokeWidth={1.8} />
        </button>
      </header>

      <form className="project-connect-form" onSubmit={submit}>
        <label className="project-source-field">
          <span>接入方式</span>
          <select
            aria-label="项目接入方式"
            value={source}
            disabled={submitting}
            onChange={(event) => setSource(event.target.value as ProjectSource)}
          >
            <option value="local">本地目录</option>
            <option value="git">HTTPS Git 仓库</option>
          </select>
        </label>
        <label className="project-path-field">
          <span>{source === "local" ? "项目目录" : "仓库地址"}</span>
          <input
            aria-label={source === "local" ? "本地项目目录" : "Git 仓库地址"}
            placeholder={
              source === "local"
                ? "例如 C:\\Github\\AndroidProject"
                : "例如 https://github.com/organization/android-project.git"
            }
            value={value}
            disabled={submitting}
            onChange={(event) => {
              if (source === "local") {
                setLocalPath(event.target.value);
              } else {
                setRemoteUrl(event.target.value);
              }
            }}
          />
        </label>
        <button
          className="primary-command"
          type="submit"
          disabled={submitting || value.trim().length === 0}
        >
          {submitting ? "正在接入" : "接入项目"}
        </button>
      </form>
      <p className="project-connect-hint">
        接入项目为只读静态扫描：不会执行 Gradle、构建或修改源码。
      </p>

      {error !== undefined && (
        <p className="management-error" role="alert">
          {error}
        </p>
      )}

      {projectsQuery.data === undefined && !projectsQuery.isError ? (
        <p className="management-empty">正在读取已接入项目。</p>
      ) : projectsQuery.data?.projects.length === 0 ? (
        <p className="management-empty">尚未接入 Android 项目。</p>
      ) : (
        <div className="project-list">
          {projectsQuery.data?.projects.map((project, index) => (
            <details
              key={project.id}
              className="project-item"
              open={
                expandedProjectIds === undefined ? index === 0 : expandedProjectIds.has(project.id)
              }
              onToggle={(event) => {
                const open = event.currentTarget.open;
                setExpandedProjectIds((current) => {
                  const next = new Set(
                    current ?? projectsQuery.data?.projects.slice(0, 1).map(({ id }) => id),
                  );
                  if (open) {
                    next.add(project.id);
                  } else {
                    next.delete(project.id);
                  }
                  return next;
                });
              }}
            >
              <summary className="project-summary">
                <span className="project-summary-heading">
                  <ChevronRight
                    className="project-disclosure-icon"
                    aria-hidden="true"
                    size={16}
                    strokeWidth={2}
                  />
                  {project.source === "local" ? (
                    <FolderOpen aria-hidden="true" size={20} strokeWidth={1.7} />
                  ) : (
                    <GitBranch aria-hidden="true" size={20} strokeWidth={1.7} />
                  )}
                  <strong title={project.name}>{project.name}</strong>
                  <span className={`project-source ${project.source}`}>
                    {sourceLabel(project.source)}
                  </span>
                </span>
              </summary>
              <ProjectBuildSection
                project={project}
                data={projectBuildsQuery.data?.[project.id]}
                loading={projectBuildsQuery.isFetching}
                building={buildMutation.isPending}
                installing={installSdkMutation.isPending}
                onRequestBuild={(target) => setPendingBuild({ project, target })}
                onInstallSdk={(projectId) => installSdkMutation.mutate(projectId)}
              />
            </details>
          ))}
        </div>
      )}
      {pendingBuild !== undefined && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="project-build-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="确认构建"
          >
            <h2>确认构建</h2>
            <p>
              将执行 <strong>{pendingBuild.project.name}</strong> 的 Gradle Wrapper
              任务。构建会写入该项目的
              <code> build/ </code>输出目录，日志保存在本地 Agent 数据目录。
            </p>
            <code className="project-build-command">{pendingBuild.target.taskName}</code>
            <footer>
              <button
                type="button"
                disabled={buildMutation.isPending}
                onClick={() => setPendingBuild(undefined)}
              >
                取消
              </button>
              <button
                className="primary-command"
                type="button"
                disabled={buildMutation.isPending}
                onClick={() => buildMutation.mutate(pendingBuild)}
              >
                {buildMutation.isPending ? "正在启动构建" : "确认构建"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
