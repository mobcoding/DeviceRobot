import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, FolderOpen, GitBranch, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { AndroidProject, ProjectSource } from "@device-robot/contracts";

import { createProject, fetchProjects } from "../api/projects";

function sourceLabel(source: ProjectSource): string {
  return source === "local" ? "本地目录" : "Git 仓库";
}

function revisionLabel(project: AndroidProject): string {
  return project.revision === undefined ? "未检测到 Git 版本" : project.revision.slice(0, 12);
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
  const submitting = createMutation.isPending;
  const value = source === "local" ? localPath : remoteUrl;
  const error = projectsQuery.isError
    ? projectsQuery.error.message
    : createMutation.isError
      ? createMutation.error?.message
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
        接入时仅扫描 Gradle 与 Manifest，不会执行构建或修改源码。
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
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
