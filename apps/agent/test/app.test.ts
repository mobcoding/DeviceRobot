import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healthResponseSchema } from "@device-robot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentApp } from "../src/app.js";

const temporaryDirectories: string[] = [];

function createTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "device-robot-agent-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("DeviceRobot Agent", () => {
  it("initializes the database and returns a contract-valid health response", async () => {
    const root = createTemporaryRoot();
    const { app, paths } = await createAgentApp({ localAppData: root });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/health",
      headers: { host: "127.0.0.1:43110" },
    });

    expect(response.statusCode).toBe(200);
    expect(healthResponseSchema.safeParse(response.json()).success).toBe(true);
    expect(readFileSync(paths.database).byteLength).toBeGreaterThan(0);
    await app.close();

    const reopened = await createAgentApp({ localAppData: root });
    const migrationCount = reopened.database.sqlite
      .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
      .get() as { count: number };
    expect(migrationCount.count).toBe(7);
    await reopened.app.close();
  });

  it("rejects non-loopback hosts", async () => {
    const { app } = await createAgentApp({ localAppData: createTemporaryRoot() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/health",
      headers: { host: "192.168.1.10:43110" },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("rejects cross-origin browser requests", async () => {
    const { app } = await createAgentApp({ localAppData: createTemporaryRoot() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/health",
      headers: {
        host: "127.0.0.1:43110",
        origin: "https://example.com",
      },
    });

    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("allows a loopback Vite development origin on a different port", async () => {
    const { app } = await createAgentApp({ localAppData: createTemporaryRoot() });
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/system/health",
      headers: {
        host: "127.0.0.1:43110",
        origin: "http://127.0.0.1:5173",
      },
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("returns devices from the injected discovery service", async () => {
    const { app } = await createAgentApp({
      localAppData: createTemporaryRoot(),
      deviceService: {
        listDevices: async () => ({
          adb: { available: true, executable: "adb", version: "37.0.0" },
          devices: [
            {
              serial: "device-1",
              state: "device",
              connection: "usb",
              model: "Pixel 3 XL",
              androidVersion: "12",
              apiLevel: 31,
            },
          ],
          refreshedAt: "2026-07-20T10:00:00.000Z",
        }),
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/devices",
      headers: { host: "127.0.0.1:43110" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      adb: { available: true },
      devices: [{ serial: "device-1", model: "Pixel 3 XL" }],
    });
    await app.close();
  });

  it("lists and registers projects through contract-validated routes", async () => {
    const project = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      name: "Example",
      source: "local" as const,
      rootPath: "C:\\Github\\Example",
      gradleWrapper: true,
      modules: [
        {
          name: "app",
          path: "app",
          buildFile: "app/build.gradle.kts",
          packageName: "com.example.app",
          variants: ["debug", "release"],
        },
      ],
      createdAt: "2026-07-21T10:00:00.000Z",
      updatedAt: "2026-07-21T10:00:00.000Z",
    };
    const add = vi.fn(async () => project);
    const reindex = vi.fn(async () => project);
    const buildRun = {
      id: "223e4567-e89b-12d3-a456-426614174000",
      projectId: project.id,
      modulePath: "app",
      variant: "debug",
      taskName: ":app:assembleDebug",
      status: "running" as const,
      logPath: "C:\\logs\\build.log",
      artifactPaths: [],
      startedAt: "2026-07-21T10:00:00.000Z",
    };
    const startBuild = vi.fn(async () => buildRun);
    const aiPlan = {
      reply: "已生成首页检查计划。",
      plan: {
        id: "323e4567-e89b-12d3-a456-426614174000",
        projectId: project.id,
        actions: [{ action: "ui.wait" as const, durationMs: 500 }],
        requiresApproval: true,
      },
      policy: {
        allowed: true,
        requiresApproval: true,
        reason: "AI 生成的计划仅供预览。",
        warnings: [],
      },
      context: { projectName: project.name, sourceIndexAvailable: false, evidence: [] },
      generatedAt: "2026-07-21T10:00:00.000Z",
    };
    const generateAiPlan = vi.fn(async () => aiPlan);
    const listAiModels = vi.fn(async () => ({
      provider: "openai-compatible" as const,
      models: ["test-model"],
    }));
    const testAiConfiguration = vi.fn(async () => ({
      provider: "openai-compatible" as const,
      baseUrl: "https://model.example/v1",
      model: "test-model",
      message: "模型连接成功，已应用到当前本地 Agent。",
    }));
    const { app } = await createAgentApp({
      localAppData: createTemporaryRoot(),
      projectService: { list: async () => [project], add, reindex },
      projectBuildService: {
        listTargets: async () => ({
          projectId: project.id,
          gradleWrapper: true,
          androidSdk: {
            available: true,
            path: "D:\\Android\\Sdk",
            source: "environment" as const,
            requiredPackages: ["platform-tools"],
            missingPackages: [],
          },
          targets: [
            {
              modulePath: "app",
              moduleName: "app",
              variant: "debug",
              taskName: ":app:assembleDebug",
            },
          ],
        }),
        installSdk: async () => ({
          available: true,
          path: "D:\\Android\\Sdk",
          source: "environment" as const,
          requiredPackages: ["platform-tools"],
          missingPackages: [],
        }),
        listRuns: async () => ({ projectId: project.id, runs: [buildRun] }),
        getArtifact: async () => {
          throw new Error("No build artifact is configured for this route test.");
        },
        start: startBuild,
        dispose: async () => {},
      },
      aiPlanService: {
        status: async () => ({
          configured: true,
          provider: "openai-compatible" as const,
          baseUrl: "https://model.example/v1",
          model: "test-model",
        }),
        listModels: listAiModels,
        testConfiguration: testAiConfiguration,
        generate: generateAiPlan,
      },
    });
    const headers = { host: "127.0.0.1:43110" };

    try {
      const listed = await app.inject({ method: "GET", url: "/api/v1/projects", headers });
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers,
        payload: { source: "local", rootPath: "C:\\Github\\Example" },
      });
      const indexed = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/index`,
        headers,
      });
      const targets = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/builds/targets`,
        headers,
      });
      const sdkInstall = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/android-sdk/install`,
        headers,
        payload: { approved: true },
      });
      const runs = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/builds`,
        headers,
      });
      const build = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/builds`,
        headers,
        payload: { modulePath: "app", variant: "debug", approved: true },
      });
      const aiStatus = await app.inject({ method: "GET", url: "/api/v1/ai/status", headers });
      const aiModels = await app.inject({
        method: "POST",
        url: "/api/v1/ai/models",
        headers,
        payload: { baseUrl: "https://model.example/v1", apiKey: "test-key" },
      });
      const invalidAiModels = await app.inject({
        method: "POST",
        url: "/api/v1/ai/models",
        headers,
        payload: { baseUrl: "not a url" },
      });
      const aiConfiguration = await app.inject({
        method: "POST",
        url: "/api/v1/ai/config/test",
        headers,
        payload: {
          baseUrl: "https://model.example/v1",
          apiKey: "test-key",
          model: "test-model",
        },
      });
      const aiGenerated = await app.inject({
        method: "POST",
        url: "/api/v1/ai/plans",
        headers,
        payload: { projectId: project.id, goal: "检查首页" },
      });

      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toMatchObject({ projects: [{ name: "Example" }] });
      expect(created.statusCode).toBe(200);
      expect(indexed.statusCode).toBe(200);
      expect(targets.statusCode).toBe(200);
      expect(sdkInstall.statusCode).toBe(200);
      expect(runs.statusCode).toBe(200);
      expect(build.statusCode).toBe(200);
      expect(aiStatus.statusCode).toBe(200);
      expect(aiModels.statusCode).toBe(200);
      expect(invalidAiModels.statusCode).toBe(400);
      expect(aiConfiguration.statusCode).toBe(200);
      expect(aiGenerated.statusCode).toBe(200);
      expect(aiModels.headers["cache-control"]).toBe("no-store");
      expect(aiConfiguration.headers["cache-control"]).toBe("no-store");
      expect(invalidAiModels.json()).toEqual({ error: "请填写有效的 Base URL 和 API Key。" });
      expect(created.json()).toMatchObject({ modules: [{ packageName: "com.example.app" }] });
      expect(add).toHaveBeenCalledWith({ source: "local", rootPath: "C:\\Github\\Example" });
      expect(reindex).toHaveBeenCalledWith(project.id);
      expect(startBuild).toHaveBeenCalledWith(project.id, {
        modulePath: "app",
        variant: "debug",
        approved: true,
      });
      expect(generateAiPlan).toHaveBeenCalledWith({ projectId: project.id, goal: "检查首页" });
      expect(listAiModels).toHaveBeenCalledWith({
        baseUrl: "https://model.example/v1",
        apiKey: "test-key",
      });
      expect(testAiConfiguration).toHaveBeenCalledWith({
        baseUrl: "https://model.example/v1",
        apiKey: "test-key",
        model: "test-model",
      });
      expect(aiConfiguration.json()).not.toHaveProperty("apiKey");
    } finally {
      await app.close();
    }
  });

  it("serves read-only file, application, and Logcat management data", async () => {
    const { app } = await createAgentApp({
      localAppData: createTemporaryRoot(),
      deviceManagementService: {
        listFiles: async (serial, path) => ({
          serial,
          path: path ?? "/storage/emulated/0",
          entries: [
            {
              name: "Download",
              path: "/storage/emulated/0/Download",
              kind: "directory" as const,
            },
          ],
          readAt: "2026-07-20T10:00:00.000Z",
        }),
        listApplications: async (serial, filter = "all") => ({
          serial,
          filter,
          applications: [
            {
              packageName: "com.example.app",
              source: "user" as const,
              apkPath: "/data/app/com.example.app/base.apk",
              versionCode: "42",
            },
          ],
          readAt: "2026-07-20T10:00:00.000Z",
        }),
        readLogcat: async (serial) => ({
          serial,
          entries: [
            {
              timestamp: "07-21 10:00:00.123",
              processId: 1000,
              threadId: 1001,
              level: "info" as const,
              tag: "ActivityManager",
              message: "Displayed com.example.app",
            },
          ],
          readAt: "2026-07-21T10:00:00.000Z",
        }),
      },
    });
    const headers = { host: "127.0.0.1:43110" };

    try {
      const files = await app.inject({
        method: "GET",
        url: "/api/v1/devices/device-1/files?path=%2Fstorage%2Femulated%2F0",
        headers,
      });
      const applications = await app.inject({
        method: "GET",
        url: "/api/v1/devices/device-1/applications?filter=user",
        headers,
      });
      const logcat = await app.inject({
        method: "GET",
        url: "/api/v1/devices/device-1/logcat?limit=120",
        headers,
      });

      expect(files.statusCode).toBe(200);
      expect(files.json()).toMatchObject({
        path: "/storage/emulated/0",
        entries: [{ kind: "directory" }],
      });
      expect(applications.statusCode).toBe(200);
      expect(applications.json()).toMatchObject({
        filter: "user",
        applications: [{ packageName: "com.example.app", source: "user" }],
      });
      expect(logcat.statusCode).toBe(200);
      expect(logcat.json()).toMatchObject({
        entries: [{ level: "info", tag: "ActivityManager" }],
      });
    } finally {
      await app.close();
    }
  });

  it("uploads and downloads device files through bounded routes", async () => {
    const root = createTemporaryRoot();
    const downloadedFile = join(root, "downloaded.txt");
    writeFileSync(downloadedFile, "device file");
    const upload = vi.fn(
      async (
        _serial: string,
        _directory: string | undefined,
        _fileName: string,
        stream: NodeJS.ReadableStream,
      ) => {
        for await (const chunk of stream) {
          void chunk;
        }
        return {
          serial: "device-1",
          fileName: "notes.txt",
          path: "/storage/emulated/0/Download/notes.txt",
          sizeBytes: 11,
          transferredAt: "2026-07-21T10:00:00.000Z",
        };
      },
    );
    const download = vi.fn(async () => ({
      fileName: "notes.txt",
      filePath: downloadedFile,
      sizeBytes: 11,
      dispose: async () => undefined,
    }));
    const { app } = await createAgentApp({
      localAppData: root,
      deviceFileTransferService: { upload, download },
    });
    const boundary = "device-robot-file-transfer-boundary";
    const payload = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="notes.txt"',
        "Content-Type: text/plain",
        "",
        "device file",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
    const headers = { host: "127.0.0.1:43110" };

    try {
      const uploadResponse = await app.inject({
        method: "POST",
        url: "/api/v1/devices/device-1/files/upload?path=%2Fstorage%2Femulated%2F0%2FDownload",
        headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      const downloadResponse = await app.inject({
        method: "GET",
        url: "/api/v1/devices/device-1/files/download?path=%2Fstorage%2Femulated%2F0%2FDownload%2Fnotes.txt",
        headers,
      });

      expect(uploadResponse.statusCode).toBe(200);
      expect(uploadResponse.json()).toMatchObject({
        path: "/storage/emulated/0/Download/notes.txt",
      });
      expect(upload).toHaveBeenCalledWith(
        "device-1",
        "/storage/emulated/0/Download",
        "notes.txt",
        expect.anything(),
      );
      expect(downloadResponse.statusCode).toBe(200);
      expect(downloadResponse.body).toBe("device file");
      expect(downloadResponse.headers["content-disposition"]).toContain("attachment");
      expect(download).toHaveBeenCalledWith("device-1", "/storage/emulated/0/Download/notes.txt");
    } finally {
      await app.close();
    }
  });

  it("stages and installs an uploaded APK through bounded routes", async () => {
    const artifact = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      fileName: "sample.apk",
      sizeBytes: 132,
      sha256: "a".repeat(64),
      uploadedAt: "2026-07-20T10:00:00.000Z",
      metadata: {
        packageName: "com.example.app",
        versionName: "1.2.3",
        versionCode: "42",
      },
    };
    const stage = vi.fn(async (_fileName: string, stream: NodeJS.ReadableStream) => {
      for await (const chunk of stream) {
        // Consume the multipart stream before returning the staged artifact.
        void chunk;
      }
      return artifact;
    });
    const install = vi.fn(async (serial: string, artifactId: string) => ({
      status: "installed" as const,
      serial,
      artifactId,
      packageName: "com.example.app",
      startedAt: "2026-07-20T10:01:00.000Z",
      finishedAt: "2026-07-20T10:01:02.000Z",
      message: "Success",
    }));
    const discard = vi.fn(async () => undefined);
    const { app } = await createAgentApp({
      localAppData: createTemporaryRoot(),
      apkArtifactService: { stage, install, discard },
    });
    const boundary = "device-robot-apk-boundary";
    const payload = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="apk"; filename="sample.apk"',
        "Content-Type: application/vnd.android.package-archive",
        "",
        "PK-test-apk",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
    const headers = { host: "127.0.0.1:43110" };

    try {
      const upload = await app.inject({
        method: "POST",
        url: "/api/v1/apks",
        headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload,
      });
      const installation = await app.inject({
        method: "POST",
        url: `/api/v1/devices/device-1/apks/${artifact.id}/install`,
        headers,
        payload: { replaceExisting: true, allowTestPackage: true },
      });
      const deletion = await app.inject({
        method: "DELETE",
        url: `/api/v1/apks/${artifact.id}`,
        headers,
      });

      expect(upload.statusCode).toBe(200);
      expect(upload.json()).toMatchObject({ id: artifact.id, fileName: "sample.apk" });
      expect(stage).toHaveBeenCalledWith("sample.apk", expect.anything());
      expect(installation.statusCode).toBe(200);
      expect(installation.json()).toMatchObject({ status: "installed", serial: "device-1" });
      expect(install).toHaveBeenCalledWith("device-1", artifact.id, {
        replaceExisting: true,
        allowTestPackage: true,
      });
      expect(deletion.statusCode).toBe(204);
      expect(discard).toHaveBeenCalledWith(artifact.id);
    } finally {
      await app.close();
    }
  });

  it("downloads and installs only recorded APK artifacts from completed project builds", async () => {
    const root = createTemporaryRoot();
    const artifactPath = join(root, "app-debug.apk");
    writeFileSync(artifactPath, "apk");
    const projectId = "123e4567-e89b-12d3-a456-426614174000";
    const buildId = "223e4567-e89b-12d3-a456-426614174000";
    const getArtifact = vi.fn(async () => ({
      fileName: "app-debug.apk",
      filePath: artifactPath,
      sizeBytes: 3,
    }));
    const artifact = {
      id: "323e4567-e89b-12d3-a456-426614174000",
      fileName: "app-debug.apk",
      sizeBytes: 3,
      sha256: "a".repeat(64),
      uploadedAt: "2026-07-22T10:00:00.000Z",
      metadata: { packageName: "com.example.app", versionCode: "42" },
    };
    const stage = vi.fn(async (_fileName: string, stream: NodeJS.ReadableStream) => {
      for await (const chunk of stream) {
        void chunk;
      }
      return artifact;
    });
    const install = vi.fn(async (serial: string, artifactId: string) => ({
      status: "installed" as const,
      serial,
      artifactId,
      packageName: "com.example.app",
      startedAt: "2026-07-22T10:01:00.000Z",
      finishedAt: "2026-07-22T10:01:02.000Z",
      message: "Success",
    }));
    const { app } = await createAgentApp({
      localAppData: root,
      projectBuildService: {
        listTargets: async () => {
          throw new Error("Not used");
        },
        installSdk: async () => {
          throw new Error("Not used");
        },
        listRuns: async () => ({ projectId, runs: [] }),
        getArtifact,
        start: async () => {
          throw new Error("Not used");
        },
        dispose: async () => {},
      },
      apkArtifactService: { stage, install, discard: async () => {} },
    });
    const headers = { host: "127.0.0.1:43110" };

    try {
      const download = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${projectId}/builds/${buildId}/artifacts/0/download`,
        headers,
      });
      const installation = await app.inject({
        method: "POST",
        url: `/api/v1/devices/device-1/projects/${projectId}/builds/${buildId}/artifacts/0/install`,
        headers,
        payload: { replaceExisting: true, allowTestPackage: true },
      });

      expect(download.statusCode).toBe(200);
      expect(download.body).toBe("apk");
      expect(download.headers["content-type"]).toContain("application/vnd.android.package-archive");
      expect(download.headers["content-disposition"]).toContain("attachment");
      expect(installation.statusCode).toBe(200);
      expect(installation.json()).toMatchObject({
        status: "installed",
        serial: "device-1",
        packageName: "com.example.app",
      });
      expect(getArtifact).toHaveBeenNthCalledWith(1, projectId, buildId, 0);
      expect(getArtifact).toHaveBeenNthCalledWith(2, projectId, buildId, 0);
      expect(stage).toHaveBeenCalledWith("app-debug.apk", expect.anything());
      expect(install).toHaveBeenCalledWith("device-1", artifact.id, {
        replaceExisting: true,
        allowTestPackage: true,
      });
    } finally {
      await app.close();
    }
  });

  it("serves device control data and records action audits", async () => {
    const { app } = await createAgentApp({
      localAppData: createTemporaryRoot(),
      deviceControlService: {
        captureScreenshot: async () =>
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        readUiTree: async (serial) => ({
          serial,
          xml: '<?xml version="1.0"?><hierarchy />',
          capturedAt: "2026-07-20T10:00:00.000Z",
        }),
        execute: async () => ({
          startedAt: "2026-07-20T10:00:00.000Z",
          finishedAt: "2026-07-20T10:00:01.000Z",
          message: "completed",
        }),
      },
    });
    const headers = { host: "127.0.0.1:43110" };

    try {
      const screenshot = await app.inject({
        method: "GET",
        url: "/api/v1/devices/device-1/screenshot",
        headers,
      });
      const tree = await app.inject({
        method: "GET",
        url: "/api/v1/devices/device-1/ui-tree",
        headers,
      });
      const action = await app.inject({
        method: "POST",
        url: "/api/v1/devices/device-1/actions",
        headers,
        payload: { action: "ui.back" },
      });
      const history = await app.inject({
        method: "GET",
        url: "/api/v1/devices/device-1/actions",
        headers,
      });

      expect(screenshot.statusCode).toBe(200);
      expect(screenshot.headers["content-type"]).toContain("image/png");
      expect(tree.json()).toMatchObject({ serial: "device-1" });
      expect((tree.json() as { xml: string }).xml).toMatch(/^<\?xml/);
      expect(action.json()).toMatchObject({ serial: "device-1", action: { action: "ui.back" } });
      expect(history.json()).toMatchObject({
        serial: "device-1",
        actions: [{ success: true, action: { action: "ui.back" } }],
      });
    } finally {
      await app.close();
    }
  });
});
