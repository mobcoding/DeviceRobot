import {
  type Query,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  ChevronDown,
  Download,
  FileArchive,
  FolderGit2,
  FolderOpen,
  GitBranch,
  PackageCheck,
  Play,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import type {
  AndroidBuildTarget,
  AndroidDevice,
  AndroidProject,
  AndroidSdkInfo,
  ProjectBuildRun,
  ProjectSource,
} from "@device-robot/contracts";

import {
  createProject,
  fetchProjectBuildLog,
  fetchProjectBuildRuns,
  fetchProjectBuildTargets,
  fetchProjects,
  installProjectAndroidSdk,
  installProjectBuildArtifact,
  projectBuildArtifactDownloadUrl,
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

type ProjectArtifactInstall = {
  serial: string;
  projectId: string;
  buildId: string;
  artifactIndex: number;
  uninstallExisting: boolean;
};

type InstalledProjectArtifact = ProjectArtifactInstall & {
  packageName: string;
};

type ProjectBuildModule = {
  modulePath: string;
  moduleName: string;
  targets: AndroidBuildTarget[];
};

function sourceLabel(source: ProjectSource): string {
  return source === "local" ? "本地目录" : "Git 仓库";
}

function artifactName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function artifactDisplayName(run: ProjectBuildRun, path: string, index: number): string {
  return run.artifactNames?.[index] ?? artifactName(path);
}

function BuildFailureMessage({
  message,
  onViewDetails,
}: {
  message: string;
  onViewDetails(): void;
}): React.JSX.Element {
  return (
    <div className="project-build-failure">
      <p>{message}</p>
      <button type="button" onClick={onViewDetails}>
        查看详情
      </button>
    </div>
  );
}

function groupBuildTargets(targets: AndroidBuildTarget[]): ProjectBuildModule[] {
  const modules = new Map<string, ProjectBuildModule>();
  for (const target of targets) {
    const current = modules.get(target.modulePath);
    if (current === undefined) {
      modules.set(target.modulePath, {
        modulePath: target.modulePath,
        moduleName: target.moduleName,
        targets: [target],
      });
    } else {
      current.targets.push(target);
    }
  }
  return [...modules.values()];
}

function ProjectBuildSection({
  project,
  data,
  loading,
  loadingProgress,
  building,
  installing,
  device,
  installingArtifact,
  installedArtifact,
  onRequestBuild,
  onViewFailure,
  onInstallSdk,
  onInstallArtifact,
}: {
  project: AndroidProject;
  data: ProjectBuildData | undefined;
  loading: boolean;
  loadingProgress: number;
  building: boolean;
  installing: boolean;
  device: AndroidDevice | undefined;
  installingArtifact?: Pick<ProjectArtifactInstall, "buildId" | "artifactIndex">;
  installedArtifact: InstalledProjectArtifact | undefined;
  onRequestBuild(target: AndroidBuildTarget): void;
  onViewFailure(run: ProjectBuildRun): void;
  onInstallSdk(projectId: string): void;
  onInstallArtifact(run: ProjectBuildRun, artifactIndex: number): void;
}): React.JSX.Element {
  const [selectedTaskByModule, setSelectedTaskByModule] = useState<Record<string, string>>({});
  const sdkReady =
    data !== undefined && data.androidSdk.available && data.androidSdk.missingPackages.length === 0;
  const selectedModules = groupBuildTargets(data?.targets ?? []).flatMap((module) => {
    const selectedTarget =
      module.targets.find(
        (target) => target.taskName === selectedTaskByModule[module.modulePath],
      ) ?? module.targets[0];
    return selectedTarget === undefined ? [] : [{ module, target: selectedTarget }];
  });
  const recentRuns = [...(data?.runs ?? [])]
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())
    .slice(0, 2);
  const recentArtifacts = recentRuns.flatMap((run) =>
    run.artifactPaths.map((artifactPath, artifactIndex) => ({ run, artifactPath, artifactIndex })),
  );
  const recentFailures = recentRuns.filter(
    (run) => run.status === "failed" && run.message !== undefined,
  );
  const hasPendingRun = (data?.runs ?? []).some(
    (run) => run.status === "queued" || run.status === "running",
  );
  const isBuilding = building || hasPendingRun;
  return (
    <section className="project-build" aria-label={`${project.name} 的构建`}>
      {data !== undefined && !sdkReady && (
        <div className="project-build-runtime">
          <span className="project-sdk-state">Android SDK 需要准备</span>
          <button
            className="project-sdk-install"
            type="button"
            disabled={installing || isBuilding}
            onClick={() => onInstallSdk(project.id)}
          >
            <Download aria-hidden="true" size={13} strokeWidth={1.9} />
            {installing ? "正在安装" : "安装所需 SDK"}
          </button>
        </div>
      )}
      {!project.gradleWrapper ? (
        <p>未检测到 Gradle Wrapper，已禁用构建操作。</p>
      ) : loading ? (
        <div className="project-build-loading" role="status">
          <div>
            <span>正在加载构建信息</span>
            <strong>{loadingProgress}%</strong>
          </div>
          <progress
            aria-label={`${project.name} 构建信息加载进度`}
            max={100}
            value={loadingProgress}
          />
        </div>
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
          <div className="project-build-targets" aria-label="可构建模块">
            {selectedModules.map(({ module, target: selectedTarget }) => {
              return (
                <article key={module.modulePath} className="project-build-target">
                  <div className="project-build-control-row">
                    <label className="project-build-variant">
                      <span>构建变体</span>
                      <span className="project-build-variant-select">
                        <select
                          aria-label={`${module.moduleName} 构建变体`}
                          value={selectedTarget.taskName}
                          disabled={isBuilding || installing}
                          onChange={(event) =>
                            setSelectedTaskByModule((current) => ({
                              ...current,
                              [module.modulePath]: event.target.value,
                            }))
                          }
                        >
                          {module.targets.map((target) => (
                            <option key={target.taskName} value={target.taskName}>
                              {target.variant}
                            </option>
                          ))}
                        </select>
                        <ChevronDown aria-hidden="true" size={18} strokeWidth={2.2} />
                      </span>
                    </label>
                    <button
                      className="project-build-launch"
                      type="button"
                      disabled={isBuilding || installing || !sdkReady}
                      aria-label={`构建 ${module.moduleName} ${selectedTarget.variant}`}
                      onClick={() => onRequestBuild(selectedTarget)}
                    >
                      <Play aria-hidden="true" size={17} strokeWidth={2} fill="currentColor" />
                      <span>{isBuilding ? "构建中" : "构建"}</span>
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          <div className="project-build-history" aria-label="最近构建记录">
            {recentRuns.length === 0 ? (
              <p className="project-build-empty">尚未执行构建。</p>
            ) : (
              <>
                {recentArtifacts.length > 0 && (
                  <div className="project-build-artifacts" aria-label="APK 构建产物">
                    {recentArtifacts.map(({ run, artifactPath, artifactIndex }) => {
                      const name = artifactDisplayName(run, artifactPath, artifactIndex);
                      const installationMatches =
                        installedArtifact?.serial === device?.serial &&
                        installedArtifact?.buildId === run.id &&
                        installedArtifact.artifactIndex === artifactIndex;
                      const installationInProgress =
                        installingArtifact?.buildId === run.id &&
                        installingArtifact.artifactIndex === artifactIndex;
                      return (
                        <div className="project-build-artifact" key={`${run.id}:${artifactPath}`}>
                          <div className="project-build-artifact-file">
                            <FileArchive aria-hidden="true" size={21} strokeWidth={1.8} />
                            <code title={artifactPath}>{name}</code>
                          </div>
                          <div className="project-build-artifact-actions">
                            <a
                              className="project-artifact-command export"
                              href={projectBuildArtifactDownloadUrl(
                                project.id,
                                run.id,
                                artifactIndex,
                              )}
                              download={name}
                              aria-label={`导出 ${name}`}
                            >
                              <Download aria-hidden="true" size={15} strokeWidth={1.9} />
                              <span>导出</span>
                            </a>
                            <button
                              className="project-artifact-command"
                              type="button"
                              aria-label={`安装 ${name} 到当前设备`}
                              disabled={device === undefined || installingArtifact !== undefined}
                              title={
                                device === undefined ? "请先在顶部选择可用设备" : "安装到当前设备"
                              }
                              onClick={() => onInstallArtifact(run, artifactIndex)}
                            >
                              <PackageCheck aria-hidden="true" size={15} strokeWidth={1.9} />
                              <span>{installationInProgress ? "安装中" : "安装"}</span>
                            </button>
                          </div>
                          {installationMatches && (
                            <small className="project-artifact-installed" role="status">
                              已安装 {installedArtifact.packageName}
                            </small>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {hasPendingRun && (
                  <p className="project-build-progress">
                    构建任务正在执行，完成后 APK 会出现在此处。
                  </p>
                )}
                {recentFailures.map((run) => (
                  <BuildFailureMessage
                    key={run.id}
                    message={run.message!}
                    onViewDetails={() => onViewFailure(run)}
                  />
                ))}
                {recentArtifacts.length === 0 && !hasPendingRun && recentFailures.length === 0 && (
                  <p className="project-build-empty">最近两次构建未生成 APK。</p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function ProjectManagerPanel({
  device,
}: {
  device: AndroidDevice | undefined;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [source, setSource] = useState<ProjectSource>("local");
  const [localPath, setLocalPath] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [pendingBuild, setPendingBuild] = useState<PendingBuild>();
  const [failureDetail, setFailureDetail] = useState<{
    project: AndroidProject;
    run: ProjectBuildRun;
  }>();
  const [installedArtifact, setInstalledArtifact] = useState<InstalledProjectArtifact>();
  const [pendingSignatureConflict, setPendingSignatureConflict] =
    useState<ProjectArtifactInstall>();
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
  const projectBuildQueries = useQueries({
    queries: projectIds.map((projectId) => ({
      queryKey: ["project-build-data", projectId],
      queryFn: async ({ signal }): Promise<ProjectBuildData> => {
        const [targets, runs] = await Promise.all([
          fetchProjectBuildTargets(projectId, signal),
          fetchProjectBuildRuns(projectId, signal),
        ]);
        return { targets: targets.targets, runs: runs.runs, androidSdk: targets.androidSdk };
      },
      refetchInterval: (
        query: Query<ProjectBuildData, Error, ProjectBuildData, readonly unknown[]>,
      ) =>
        query.state.data?.runs.some((run) => run.status === "queued" || run.status === "running")
          ? 2_000
          : false,
    })),
  });
  const buildQueryByProjectId = new Map(
    projectIds.map((projectId, index) => [projectId, projectBuildQueries[index]!]),
  );
  const loadedBuildProjectCount = projectBuildQueries.filter(
    (query) => query.data !== undefined || query.isError,
  ).length;
  const buildLoadingProgress =
    projectBuildQueries.length === 0
      ? 0
      : Math.round((loadedBuildProjectCount / projectBuildQueries.length) * 100);
  const projectBuildsRefreshing = projectBuildQueries.some((query) => query.isFetching);
  const projectBuildError = projectBuildQueries.find((query) => query.isError)?.error;
  const buildLogQuery = useQuery({
    queryKey: ["project-build-log", failureDetail?.project.id, failureDetail?.run.id],
    enabled: failureDetail !== undefined,
    retry: false,
    queryFn: async ({ signal }) => {
      if (failureDetail === undefined) {
        throw new Error("未选择构建失败记录。");
      }
      return await fetchProjectBuildLog(failureDetail.project.id, failureDetail.run.id, signal);
    },
  });
  const buildMutation = useMutation({
    mutationFn: async (request: PendingBuild) =>
      await startProjectBuild(request.project.id, {
        modulePath: request.target.modulePath,
        variant: request.target.variant,
        approved: true,
      }),
    onSuccess: (run, request) => {
      setPendingBuild(undefined);
      queryClient.setQueryData<ProjectBuildData>(
        ["project-build-data", request.project.id],
        (current) =>
          current === undefined
            ? current
            : {
                ...current,
                runs: [run, ...current.runs.filter((candidate) => candidate.id !== run.id)],
              },
      );
      void queryClient.invalidateQueries({ queryKey: ["project-build-data", request.project.id] });
    },
  });
  const installSdkMutation = useMutation({
    mutationFn: async (projectId: string) =>
      await installProjectAndroidSdk(projectId, { approved: true }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["project-build-data"] });
    },
  });
  const installArtifactMutation = useMutation({
    mutationFn: async (request: ProjectArtifactInstall) =>
      await installProjectBuildArtifact(
        request.serial,
        request.projectId,
        request.buildId,
        request.artifactIndex,
        {
          replaceExisting: true,
          allowTestPackage: true,
          uninstallExisting: request.uninstallExisting,
        },
      ),
    onSuccess: async (response, request) => {
      setPendingSignatureConflict(undefined);
      setInstalledArtifact({ ...request, packageName: response.packageName });
      await queryClient.invalidateQueries({ queryKey: ["device-applications", request.serial] });
    },
    onError: (error, request) => {
      if (error.message.includes("签名不同")) {
        setPendingSignatureConflict(request);
      }
    },
  });
  const submitting = createMutation.isPending;
  const value = source === "local" ? localPath : remoteUrl;
  const error = projectsQuery.isError
    ? projectsQuery.error.message
    : createMutation.isError
      ? createMutation.error?.message
      : projectBuildError !== undefined
        ? projectBuildError.message
        : buildMutation.isError
          ? buildMutation.error?.message
          : installSdkMutation.isError
            ? installSdkMutation.error?.message
            : installArtifactMutation.isError && pendingSignatureConflict === undefined
              ? installArtifactMutation.error?.message
              : undefined;
  const pendingBuildSubmitting =
    pendingBuild !== undefined &&
    buildMutation.isPending &&
    buildMutation.variables?.project.id === pendingBuild.project.id;

  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (value.trim().length > 0) {
      createMutation.mutate();
    }
  };

  const installArtifact = (
    project: AndroidProject,
    run: ProjectBuildRun,
    artifactIndex: number,
  ): void => {
    if (device === undefined) {
      return;
    }
    installArtifactMutation.reset();
    installArtifactMutation.mutate({
      serial: device.serial,
      projectId: project.id,
      buildId: run.id,
      artifactIndex,
      uninstallExisting: false,
    });
  };

  const uninstallAndInstallArtifact = (): void => {
    if (pendingSignatureConflict === undefined) {
      return;
    }
    installArtifactMutation.reset();
    installArtifactMutation.mutate({ ...pendingSignatureConflict, uninstallExisting: true });
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
          disabled={projectsQuery.isFetching || projectBuildsRefreshing}
          onClick={() => {
            void projectsQuery.refetch();
            void Promise.all(projectBuildQueries.map(async (query) => await query.refetch()));
          }}
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
          {projectsQuery.data?.projects.map((project) => (
            <article key={project.id} className="project-item">
              <header className="project-summary">
                <span className="project-summary-heading">
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
              </header>
              <ProjectBuildSection
                project={project}
                data={buildQueryByProjectId.get(project.id)?.data}
                loading={buildQueryByProjectId.get(project.id)?.isLoading ?? false}
                loadingProgress={buildLoadingProgress}
                building={
                  buildMutation.isPending && buildMutation.variables?.project.id === project.id
                }
                installing={installSdkMutation.isPending}
                device={device}
                {...(installArtifactMutation.isPending &&
                installArtifactMutation.variables !== undefined
                  ? {
                      installingArtifact: {
                        buildId: installArtifactMutation.variables.buildId,
                        artifactIndex: installArtifactMutation.variables.artifactIndex,
                      },
                    }
                  : {})}
                installedArtifact={installedArtifact}
                onRequestBuild={(target) => setPendingBuild({ project, target })}
                onViewFailure={(run) => setFailureDetail({ project, run })}
                onInstallSdk={(projectId) => installSdkMutation.mutate(projectId)}
                onInstallArtifact={(run, artifactIndex) =>
                  installArtifact(project, run, artifactIndex)
                }
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
                disabled={pendingBuildSubmitting}
                onClick={() => setPendingBuild(undefined)}
              >
                取消
              </button>
              <button
                className="primary-command"
                type="button"
                disabled={pendingBuildSubmitting}
                onClick={() => buildMutation.mutate(pendingBuild)}
              >
                {pendingBuildSubmitting ? "正在启动构建" : "确认构建"}
              </button>
            </footer>
          </section>
        </div>
      )}
      {failureDetail !== undefined && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="project-build-dialog project-build-log-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="构建失败详情"
          >
            <h2>构建失败详情</h2>
            <p>
              {failureDetail.project.name} 的构建任务
              <code>{failureDetail.run.taskName}</code>
            </p>
            {buildLogQuery.isLoading ? (
              <p role="status">正在读取构建日志。</p>
            ) : (
              <>
                {buildLogQuery.isError && (
                  <p className="project-build-log-notice">
                    完整日志暂不可用，以下显示构建失败摘要。
                  </p>
                )}
                {buildLogQuery.data?.truncated && (
                  <p className="project-build-log-notice">日志过长，以下仅显示末尾 1 MB。</p>
                )}
                <pre className="project-build-log">
                  {buildLogQuery.data?.content ?? failureDetail.run.message ?? "未生成构建日志。"}
                </pre>
              </>
            )}
            <footer>
              <button type="button" onClick={() => setFailureDetail(undefined)}>
                关闭
              </button>
            </footer>
          </section>
        </div>
      )}
      {pendingSignatureConflict !== undefined && (
        <div className="modal-backdrop" role="presentation">
          <section
            className="project-build-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="确认卸载旧版本后安装"
          >
            <h2>签名不一致</h2>
            <p>
              当前设备已安装同包名但签名不同的应用。继续将先卸载旧版本，再安装本次构建的
              APK；旧应用的本地数据将被删除。
            </p>
            <footer>
              <button
                type="button"
                disabled={installArtifactMutation.isPending}
                onClick={() => {
                  setPendingSignatureConflict(undefined);
                  installArtifactMutation.reset();
                }}
              >
                取消
              </button>
              <button
                className="primary-command"
                type="button"
                disabled={installArtifactMutation.isPending}
                onClick={uninstallAndInstallArtifact}
              >
                {installArtifactMutation.isPending ? "正在卸载并安装" : "卸载旧版本后安装"}
              </button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
