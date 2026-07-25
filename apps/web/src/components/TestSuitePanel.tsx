import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCode2, Play, Upload } from "lucide-react";
import { useRef, useState } from "react";
import type { AndroidDevice } from "@device-robot/contracts";

import { useAgentUnavailable } from "../agent-availability";
import { fetchProjects } from "../api/projects";
import { fetchTestSuites, importTestSuite, startTestSuiteCase } from "../api/test-suites";

function casePriorityClass(priority: "P0" | "P1" | "P2" | "P3"): string {
  return `test-suite-priority ${priority.toLowerCase()}`;
}

export function TestSuitePanel({
  device,
  projectId: inheritedProjectId,
}: {
  device: AndroidDevice | undefined;
  projectId?: string;
}): React.JSX.Element {
  const agentUnavailable = useAgentUnavailable();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const projectsQuery = useQuery({
    queryKey: ["projects"],
    queryFn: ({ signal }) => fetchProjects(signal),
    retry: 1,
  });
  const projects = projectsQuery.data?.projects ?? [];
  const projectId = (inheritedProjectId ?? selectedProjectId) || projects[0]?.id || "";
  const suitesQuery = useQuery({
    queryKey: ["test-suites", projectId],
    enabled: projectId.length > 0,
    queryFn: ({ signal }) => fetchTestSuites(projectId, signal),
    retry: 1,
  });
  const importMutation = useMutation({
    mutationFn: async (file: File) => await importTestSuite(projectId, file),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["test-suites", projectId] });
    },
  });
  const startCaseMutation = useMutation({
    mutationFn: async (input: { suiteId: string; caseId: string }) => {
      if (device === undefined) {
        throw new Error("请先在顶部选择可自动化设备。");
      }
      return await startTestSuiteCase(projectId, input.suiteId, input.caseId, {
        deviceSerial: device.serial,
        approved: true,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["test-runs"] });
      await queryClient.invalidateQueries({ queryKey: ["test-suites", projectId] });
    },
  });
  const error = agentUnavailable
    ? undefined
    : projectsQuery.isError
      ? projectsQuery.error.message
      : suitesQuery.isError
        ? suitesQuery.error.message
        : importMutation.isError
          ? importMutation.error.message
          : startCaseMutation.isError
            ? startCaseMutation.error.message
            : undefined;

  return (
    <section className="test-suite-panel" aria-label="DSL 测试用例">
      <header className="test-suite-heading">
        <div>
          <FileCode2 aria-hidden="true" size={20} strokeWidth={1.8} />
          <div>
            <h2>DSL 测试用例</h2>
            <p>
              {device === undefined ? "未选择设备" : `当前设备：${device.model ?? device.serial}`}
            </p>
          </div>
        </div>
        <div className="test-suite-import">
          {inheritedProjectId === undefined && (
            <label>
              <span>测试项目</span>
              <select
                aria-label="DSL 测试项目"
                value={projectId}
                disabled={projects.length === 0 || importMutation.isPending}
                onChange={(event) => setSelectedProjectId(event.target.value)}
              >
                {projects.length === 0 ? (
                  <option value="">未接入项目</option>
                ) : (
                  projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))
                )}
              </select>
            </label>
          )}
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            aria-label="导入 DSL 文件"
            accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file !== undefined) {
                importMutation.mutate(file);
              }
            }}
          />
          <button
            className="test-suite-import-button"
            type="button"
            disabled={projectId.length === 0 || importMutation.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload aria-hidden="true" size={15} strokeWidth={1.9} />
            {importMutation.isPending ? "正在导入" : "导入 DSL"}
          </button>
        </div>
      </header>

      {error !== undefined && (
        <p className="management-error" role="alert">
          {error}
        </p>
      )}

      {suitesQuery.isLoading ? (
        <p className="test-suite-empty">正在读取测试用例。</p>
      ) : (suitesQuery.data?.suites.length ?? 0) === 0 ? (
        <p className="test-suite-empty">尚未导入 DSL 测试用例。</p>
      ) : (
        <div className="test-suite-list">
          {suitesQuery.data?.suites.map((suite) => (
            <article key={suite.id} className="test-suite-item">
              <header>
                <div>
                  <strong>{suite.suite.suite.name}</strong>
                  <span>{suite.suite.suite.sourceRevision}</span>
                </div>
                <code>{suite.suite.appId}</code>
              </header>
              <ol>
                {suite.suite.cases.map((testCase) => (
                  <li key={testCase.id}>
                    <span className={casePriorityClass(testCase.priority)}>
                      {testCase.priority}
                    </span>
                    <div>
                      <strong>{testCase.name}</strong>
                      <small>{testCase.steps.length} 个步骤</small>
                    </div>
                    <button
                      className="test-suite-run-button"
                      type="button"
                      disabled={device === undefined || startCaseMutation.isPending}
                      title={device === undefined ? "请先选择可自动化设备" : "执行测试用例"}
                      onClick={() => {
                        if (
                          device !== undefined &&
                          globalThis.confirm(
                            `确认在 ${device.model ?? device.serial} 上执行“${testCase.name}”吗？执行前将清除 ${suite.suite.appId} 的应用数据。`,
                          )
                        ) {
                          startCaseMutation.mutate({ suiteId: suite.id, caseId: testCase.id });
                        }
                      }}
                    >
                      <Play aria-hidden="true" size={14} fill="currentColor" strokeWidth={1.9} />
                      {startCaseMutation.isPending ? "启动中" : "执行"}
                    </button>
                  </li>
                ))}
              </ol>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
