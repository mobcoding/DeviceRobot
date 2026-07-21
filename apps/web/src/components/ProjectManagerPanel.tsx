import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, FolderOpen, GitBranch, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { AndroidProject, ProjectSource } from "@device-robot/contracts";

import { createProject, fetchProjects, reindexProject } from "../api/projects";

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

export function ProjectManagerPanel(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [source, setSource] = useState<ProjectSource>("local");
  const [localPath, setLocalPath] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
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
  const submitting = createMutation.isPending;
  const value = source === "local" ? localPath : remoteUrl;
  const error = projectsQuery.isError
    ? projectsQuery.error.message
    : createMutation.isError
      ? createMutation.error?.message
      : reindexMutation.isError
        ? reindexMutation.error?.message
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
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
