import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, FolderOpen, GitBranch, RefreshCw } from "lucide-react";
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
  reindexProject,
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

function revisionLabel(project: AndroidProject): string {
  return project.revision === undefined ? "未检测到 Git 版本" : project.revision.slice(0, 12);
}

function sourceIndexLabel(project: AndroidProject): string {
  return project.sourceIndex === undefined ? "未建立索引" : "索引已就绪";
}

function sourceIndexTime(project: AndroidProject): string | undefined {
  if (project.sourceIndex === undefined) {
    return undefined;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(project.sourceIndex.scannedAt));
}

function evidenceKindLabel(
  kind: NonNullable<AndroidProject["sourceIndex"]>["evidence"][number]["kind"],
): string {
  switch (kind) {
    case "xml-view":
      return "XML 视图";
    case "compose-screen":
      return "Compose";
    case "navigation-destination":
      return "导航";
    case "kotlin-type":
      return "Kotlin";
    case "java-type":
      return "Java";
  }
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
  onRequestBuild,
}: {
  project: AndroidProject;
  data: ProjectBuildData | undefined;
  loading: boolean;
  building: boolean;
  onRequestBuild(target: AndroidBuildTarget): void;
}): React.JSX.Element {
  return (
    <section className="project-build" aria-label={`${project.name} 的构建`}>
      <header>
        <div>
          <strong>Gradle 构建</strong>
          <small>仅使用项目自身的 Gradle Wrapper</small>
          {data !== undefined && (
            <span
              className={
                data.androidSdk.available ? "project-sdk-state ready" : "project-sdk-state"
              }
            >
              {data.androidSdk.available ? "Android SDK 已就绪" : "Android SDK 未发现"}
            </span>
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
          <div className="project-build-targets" aria-label="可构建 Variant">
            {data.targets.map((target) => (
              <span key={`${target.modulePath}-${target.variant}`}>
                <strong>{target.moduleName}</strong>
                <em>{target.variant}</em>
                <code>{target.taskName}</code>
                <button type="button" disabled={building} onClick={() => onRequestBuild(target)}>
                  构建
                </button>
              </span>
            ))}
          </div>
          {data.runs.length > 0 && (
            <div className="project-build-runs" aria-label="构建记录">
              {data.runs.slice(0, 3).map((run) => (
                <span key={run.id} className={`project-build-run ${run.status}`}>
                  <strong>{buildStatusLabel(run.status)}</strong>
                  <code>{run.taskName}</code>
                  {run.message !== undefined && <small>{run.message}</small>}
                  {run.artifactPaths.length > 0 && <em>{run.artifactPaths[0]}</em>}
                </span>
              ))}
            </div>
          )}
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
  const reindexMutation = useMutation({
    mutationFn: reindexProject,
    onSuccess: async () => {
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
  const submitting = createMutation.isPending;
  const value = source === "local" ? localPath : remoteUrl;
  const error = projectsQuery.isError
    ? projectsQuery.error.message
    : createMutation.isError
      ? createMutation.error?.message
      : reindexMutation.isError
        ? reindexMutation.error?.message
        : projectBuildsQuery.isError
          ? projectBuildsQuery.error.message
          : buildMutation.isError
            ? buildMutation.error?.message
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
        接入和重新索引均为只读静态扫描：不会执行 Gradle、构建或修改源码。
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
          {projectsQuery.data?.projects.map((project) => (
            <article key={project.id} className="project-item">
              <header>
                <div>
                  {project.source === "local" ? (
                    <FolderOpen aria-hidden="true" size={20} strokeWidth={1.7} />
                  ) : (
                    <GitBranch aria-hidden="true" size={20} strokeWidth={1.7} />
                  )}
                  <strong>{project.name}</strong>
                  <span className={`project-source ${project.source}`}>
                    {sourceLabel(project.source)}
                  </span>
                </div>
                <span
                  className={project.gradleWrapper ? "project-wrapper ready" : "project-wrapper"}
                >
                  {project.gradleWrapper ? "Gradle Wrapper" : "未检测到 Wrapper"}
                </span>
              </header>
              <dl>
                <div>
                  <dt>位置</dt>
                  <dd>
                    <code>{project.rootPath}</code>
                  </dd>
                </div>
                <div>
                  <dt>版本</dt>
                  <dd>{revisionLabel(project)}</dd>
                </div>
                <div>
                  <dt>模块</dt>
                  <dd>{project.modules.length} 个</dd>
                </div>
              </dl>
              <div className="project-module-list" aria-label={`${project.name} 的模块`}>
                {project.modules.map((module) => (
                  <span key={module.path}>
                    <strong>{module.name}</strong>
                    <small>{module.packageName ?? module.applicationId ?? module.path}</small>
                    {module.variants.length > 0 && <em>{module.variants.join(" · ")}</em>}
                  </span>
                ))}
              </div>
              <section className="project-source-index" aria-label={`${project.name} 的源码索引`}>
                <header>
                  <div>
                    <strong>源码索引</strong>
                    <span
                      className={
                        project.sourceIndex === undefined
                          ? "project-index-state"
                          : "project-index-state ready"
                      }
                    >
                      {sourceIndexLabel(project)}
                    </span>
                    {sourceIndexTime(project) !== undefined && (
                      <small>扫描于 {sourceIndexTime(project)}</small>
                    )}
                  </div>
                  <button
                    className="project-index-button"
                    type="button"
                    disabled={reindexMutation.isPending}
                    onClick={() => reindexMutation.mutate(project.id)}
                  >
                    <RefreshCw aria-hidden="true" size={13} strokeWidth={1.9} />
                    {reindexMutation.isPending && reindexMutation.variables === project.id
                      ? "正在索引"
                      : "重新索引"}
                  </button>
                </header>
                {project.sourceIndex === undefined ? (
                  <p>尚未保存源码索引。重新索引后将提取 XML、Compose、导航和 Kotlin/Java 结构。</p>
                ) : (
                  <>
                    <div className="project-index-summary">
                      <span>
                        <strong>{project.sourceIndex.summary.filesScanned}</strong> 已扫描文件
                      </span>
                      <span>
                        <strong>{project.sourceIndex.summary.xmlViewCount}</strong> XML 视图
                      </span>
                      <span>
                        <strong>{project.sourceIndex.summary.composeScreenCount}</strong> Compose
                      </span>
                      <span>
                        <strong>{project.sourceIndex.summary.navigationDestinationCount}</strong>{" "}
                        导航目标
                      </span>
                      <span>
                        <strong>{project.sourceIndex.summary.typeCount}</strong> 代码类型
                      </span>
                    </div>
                    <div className="project-index-modules" aria-label="模块索引摘要">
                      {project.sourceIndex.modules.map((module) => (
                        <span key={module.path}>
                          <strong>{module.path === "." ? "根项目" : module.path}</strong>
                          <small>
                            {module.sourceFileCount} 源文件 · {module.xmlViewCount} XML ·{" "}
                            {module.composeScreenCount} Compose ·{" "}
                            {module.navigationDestinationCount} 导航
                          </small>
                        </span>
                      ))}
                    </div>
                    {project.sourceIndex.evidence.length > 0 && (
                      <details className="project-index-evidence">
                        <summary>
                          索引证据（
                          {project.sourceIndex.evidence.length > 16
                            ? `显示前 16 / ${project.sourceIndex.evidence.length}`
                            : project.sourceIndex.evidence.length}
                          条）
                        </summary>
                        <ul>
                          {project.sourceIndex.evidence.slice(0, 16).map((evidence) => (
                            <li
                              key={`${evidence.kind}-${evidence.filePath}-${evidence.line}-${evidence.name}`}
                            >
                              <span>{evidenceKindLabel(evidence.kind)}</span>
                              <strong>{evidence.name}</strong>
                              <code>
                                {evidence.filePath}:{evidence.line}
                              </code>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </>
                )}
              </section>
              <ProjectBuildSection
                project={project}
                data={projectBuildsQuery.data?.[project.id]}
                loading={projectBuildsQuery.isFetching}
                building={buildMutation.isPending}
                onRequestBuild={(target) => setPendingBuild({ project, target })}
              />
            </article>
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
