import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";
import fastifyWebsocket from "@fastify/websocket";
import { ensureAgentDirectories, resolveAgentPaths, type AgentPaths } from "@device-robot/config";
import {
  deviceActionHistoryResponseSchema,
  deviceActionResultSchema,
  apkArtifactSchema,
  apkInstallRequestSchema,
  apkInstallResponseSchema,
  deviceApplicationFilterSchema,
  deviceApplicationListResponseSchema,
  deviceControlActionSchema,
  deviceFileListResponseSchema,
  deviceFileTransferResponseSchema,
  deviceListResponseSchema,
  deviceLogcatResponseSchema,
  deviceUiTreeResponseSchema,
  healthResponseSchema,
  appiumRuntimeSchema,
  androidSdkInfoSchema,
  androidBuildTargetListResponseSchema,
  androidProjectSchema,
  aiModelConnectionTestRequestSchema,
  aiModelConnectionTestResponseSchema,
  aiModelListRequestSchema,
  aiModelListResponseSchema,
  aiModelStatusSchema,
  aiPlanResponseSchema,
  createProjectRequestSchema,
  projectListResponseSchema,
  projectBuildRunListResponseSchema,
  projectBuildRunSchema,
  generateAiPlanRequestSchema,
  installAndroidSdkRequestSchema,
  startProjectBuildRequestSchema,
} from "@device-robot/contracts";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from "fastify";

import { openDatabase, type DatabaseHandle } from "./db/database.js";
import {
  apkArtifactLimits,
  ApkArtifactError,
  LocalApkArtifactService,
  type ApkArtifactService,
} from "./apks/apk-artifact-service.js";
import { SqliteApkInstallAuditStore } from "./apks/apk-install-audit-store.js";
import {
  AdbDeviceControlService,
  DeviceControlError,
  type DeviceControlService,
} from "./devices/adb-device-control-service.js";
import { AdbDeviceService, type DeviceDiscoveryService } from "./devices/adb-device-service.js";
import {
  AdbDeviceManagementService,
  type DeviceManagementService,
} from "./devices/adb-device-management-service.js";
import {
  AdbDeviceFileTransferService,
  FileTransferError,
  type DeviceFileTransferService,
} from "./files/adb-device-file-transfer-service.js";
import {
  createFailedActionAudit,
  SqliteDeviceActionAuditStore,
  type DeviceActionAuditStore,
} from "./devices/device-action-audit-store.js";
import { isAllowedOrigin, isLoopbackHost } from "./security/loopback.js";
import { AppiumRuntimeError, AppiumRuntimeService } from "./appium/appium-runtime-service.js";
import {
  AdbScrcpyStreamService,
  parseScrcpyControlCommand,
  type ScrcpyStreamService,
} from "./scrcpy/scrcpy-stream-service.js";
import {
  LocalProjectService,
  ProjectError,
  type ProjectService,
} from "./projects/project-service.js";
import { SqliteProjectStore } from "./projects/project-store.js";
import {
  LocalProjectBuildService,
  ProjectBuildError,
  type ProjectBuildService,
} from "./projects/project-build-service.js";
import { SqliteProjectBuildStore } from "./projects/project-build-store.js";
import { AiPlanError, LocalAiPlanService, type AiPlanService } from "./ai/ai-plan-service.js";
import { SqliteAiConfigurationStore } from "./ai/ai-configuration-store.js";
import { WindowsDpapiSecretProtector } from "./ai/ai-secret-protector.js";

export const AGENT_VERSION = "0.1.0";
const WEBSOCKET_OPEN = 1;

export type CreateAgentAppOptions = {
  paths?: AgentPaths;
  localAppData?: string;
  logger?: FastifyServerOptions["logger"];
  serveWeb?: boolean;
  webRoot?: string;
  deviceService?: DeviceDiscoveryService;
  deviceControlService?: DeviceControlService;
  deviceManagementService?: DeviceManagementService;
  deviceFileTransferService?: DeviceFileTransferService;
  projectService?: ProjectService;
  projectBuildService?: ProjectBuildService;
  aiPlanService?: AiPlanService;
  apkArtifactService?: ApkArtifactService;
  deviceActionAuditStore?: DeviceActionAuditStore;
  appiumRuntimeService?: AppiumRuntimeService;
  scrcpyStreamService?: ScrcpyStreamService;
};

export type AgentApp = {
  app: FastifyInstance;
  database: DatabaseHandle;
  paths: AgentPaths;
  deviceService: DeviceDiscoveryService;
  deviceControlService: DeviceControlService;
  deviceManagementService: DeviceManagementService;
  deviceFileTransferService: DeviceFileTransferService;
  projectService: ProjectService;
  projectBuildService: ProjectBuildService;
  aiPlanService: AiPlanService;
  apkArtifactService: ApkArtifactService;
  deviceActionAuditStore: DeviceActionAuditStore;
  appiumRuntimeService: AppiumRuntimeService;
  scrcpyStreamService: ScrcpyStreamService;
};

function defaultWebRoot(): string {
  return resolve(import.meta.dirname, "../../web/dist");
}

function parseSerial(params: unknown): string {
  if (typeof params !== "object" || params === null) {
    throw new DeviceControlError("A device serial is required", 400);
  }

  const serial = (params as Record<string, unknown>).serial;
  if (typeof serial !== "string" || serial.trim().length === 0 || serial.length > 256) {
    throw new DeviceControlError("A valid device serial is required", 400);
  }

  return serial;
}

function parseArtifactId(params: unknown): string {
  if (typeof params !== "object" || params === null) {
    throw new ApkArtifactError("缺少 APK 上传记录。", 400);
  }

  const artifactId = (params as Record<string, unknown>).artifactId;
  if (
    typeof artifactId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(artifactId)
  ) {
    throw new ApkArtifactError("APK 上传记录无效。", 400);
  }
  return artifactId;
}

function parseProjectId(params: unknown): string {
  if (typeof params !== "object" || params === null) {
    throw new ProjectError("缺少项目编号。", 400);
  }

  const projectId = (params as Record<string, unknown>).projectId;
  if (
    typeof projectId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(projectId)
  ) {
    throw new ProjectError("项目编号无效。", 400);
  }
  return projectId;
}

function parseBuildId(params: unknown): string {
  if (typeof params !== "object" || params === null) {
    throw new ProjectBuildError("缺少构建记录编号。", 400);
  }
  const buildId = (params as Record<string, unknown>).buildId;
  if (
    typeof buildId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      buildId,
    )
  ) {
    throw new ProjectBuildError("构建记录编号无效。", 400);
  }
  return buildId;
}

function parseBuildArtifactIndex(params: unknown): number {
  if (typeof params !== "object" || params === null) {
    throw new ProjectBuildError("缺少构建产物编号。", 400);
  }
  const value = (params as Record<string, unknown>).artifactIndex;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new ProjectBuildError("构建产物编号无效。", 400);
  }
  const artifactIndex = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(artifactIndex) || artifactIndex > 99) {
    throw new ProjectBuildError("构建产物编号无效。", 400);
  }
  return artifactIndex;
}

function controlErrorReply(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof DeviceControlError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "Device control request failed";
  return reply.code(500).send({ error: message });
}

function parseFilePath(query: unknown): string | undefined {
  if (typeof query !== "object" || query === null) {
    return undefined;
  }

  const path = (query as Record<string, unknown>).path;
  if (path === undefined) {
    return undefined;
  }

  if (typeof path !== "string") {
    throw new DeviceControlError("A valid device path is required", 400);
  }

  return path;
}

function parseRequiredFilePath(query: unknown): string {
  const path = parseFilePath(query);
  if (path === undefined) {
    throw new FileTransferError("请选择设备文件。", 400);
  }
  return path;
}

function parseApplicationFilter(
  query: unknown,
): ReturnType<typeof deviceApplicationFilterSchema.parse> {
  if (typeof query !== "object" || query === null) {
    return "all";
  }

  const filter = (query as Record<string, unknown>).filter;
  if (filter === undefined) {
    return "all";
  }

  try {
    return deviceApplicationFilterSchema.parse(filter);
  } catch {
    throw new DeviceControlError("The application filter is invalid", 400);
  }
}

function parseLogcatLimit(query: unknown): number | undefined {
  if (typeof query !== "object" || query === null) {
    return undefined;
  }

  const limit = (query as Record<string, unknown>).limit;
  if (limit === undefined) {
    return undefined;
  }

  if (typeof limit !== "string" || !/^\d+$/u.test(limit)) {
    throw new DeviceControlError("The logcat limit is invalid", 400);
  }

  const parsed = Number.parseInt(limit, 10);
  if (parsed < 10 || parsed > 1_000) {
    throw new DeviceControlError("The logcat limit must be between 10 and 1000", 400);
  }

  return parsed;
}

function parseAiModelListRequest(body: unknown): ReturnType<typeof aiModelListRequestSchema.parse> {
  try {
    return aiModelListRequestSchema.parse(body);
  } catch {
    throw new AiPlanError("请填写有效的 Base URL 和 API Key。", 400);
  }
}

function parseAiModelConnectionTestRequest(
  body: unknown,
): ReturnType<typeof aiModelConnectionTestRequestSchema.parse> {
  try {
    return aiModelConnectionTestRequestSchema.parse(body);
  } catch {
    throw new AiPlanError("请填写有效的 Base URL、API Key 并选择模型。", 400);
  }
}

function appiumErrorReply(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AppiumRuntimeError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "Appium runtime request failed";
  return reply.code(500).send({ error: message });
}

function apkErrorReply(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ApkArtifactError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "APK 请求失败";
  return reply.code(500).send({ error: message });
}

function fileTransferErrorReply(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof FileTransferError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "设备文件传输失败。";
  return reply.code(500).send({ error: message });
}

function projectErrorReply(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ProjectError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "项目请求失败。";
  return reply.code(500).send({ error: message });
}

function projectBuildErrorReply(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ProjectBuildError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "项目构建请求失败。";
  return reply.code(500).send({ error: message });
}

function aiPlanErrorReply(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AiPlanError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "AI 计划请求失败。";
  return reply.code(500).send({ error: message });
}

export async function createAgentApp(options: CreateAgentAppOptions = {}): Promise<AgentApp> {
  const paths = options.paths ?? resolveAgentPaths(options.localAppData);
  ensureAgentDirectories(paths);
  const database = openDatabase(paths.database);
  const startedAt = new Date().toISOString();
  const webRoot = options.webRoot ?? defaultWebRoot();
  const shouldServeWeb = options.serveWeb ?? false;
  const webAvailable = shouldServeWeb && existsSync(webRoot);
  const deviceService = options.deviceService ?? new AdbDeviceService();
  const deviceControlService =
    options.deviceControlService ?? new AdbDeviceControlService({ deviceService });
  const deviceManagementService =
    options.deviceManagementService ?? new AdbDeviceManagementService({ deviceService });
  const deviceFileTransferService =
    options.deviceFileTransferService ?? new AdbDeviceFileTransferService({ paths, deviceService });
  const projectStore = new SqliteProjectStore(database.sqlite);
  const projectService =
    options.projectService ?? new LocalProjectService({ paths, store: projectStore });
  const projectBuildService =
    options.projectBuildService ??
    new LocalProjectBuildService({
      paths,
      projectStore,
      buildStore: new SqliteProjectBuildStore(database.sqlite),
    });
  const aiPlanService =
    options.aiPlanService ??
    new LocalAiPlanService({
      projectStore,
      configurationStore: new SqliteAiConfigurationStore(database.sqlite),
      secretProtector: new WindowsDpapiSecretProtector(),
    });
  const apkArtifactService =
    options.apkArtifactService ??
    new LocalApkArtifactService({
      paths,
      deviceService,
      auditStore: new SqliteApkInstallAuditStore(database.sqlite),
    });
  const deviceActionAuditStore =
    options.deviceActionAuditStore ?? new SqliteDeviceActionAuditStore(database.sqlite);
  const appiumRuntimeService = options.appiumRuntimeService ?? new AppiumRuntimeService({ paths });
  const scrcpyStreamService =
    options.scrcpyStreamService ?? new AdbScrcpyStreamService({ paths, deviceService });

  const app = Fastify({
    logger: options.logger ?? false,
  });

  await app.register(fastifyWebsocket);
  await app.register(fastifyMultipart, {
    limits: {
      files: 1,
      fields: 0,
      parts: 1,
      fileSize: apkArtifactLimits.maxFileSizeBytes,
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!isLoopbackHost(request.headers.host)) {
      return reply.code(403).send({ error: "Only localhost requests are accepted" });
    }

    if (!isAllowedOrigin(request.headers.origin, request.headers.host)) {
      return reply.code(403).send({ error: "Cross-origin requests are not accepted" });
    }
  });

  app.get("/api/v1/system/health", async () => {
    database.sqlite.prepare("SELECT 1").get();

    return healthResponseSchema.parse({
      status: shouldServeWeb && !webAvailable ? "degraded" : "ok",
      version: AGENT_VERSION,
      startedAt,
      dataDirectory: paths.root,
    });
  });

  app.get("/api/v1/devices", async () => {
    return deviceListResponseSchema.parse(await deviceService.listDevices());
  });

  app.get("/api/v1/projects", async () => {
    return projectListResponseSchema.parse({ projects: await projectService.list() });
  });

  app.post("/api/v1/projects", async (request, reply) => {
    try {
      return androidProjectSchema.parse(
        await projectService.add(createProjectRequestSchema.parse(request.body)),
      );
    } catch (error) {
      return projectErrorReply(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/index", async (request, reply) => {
    try {
      return androidProjectSchema.parse(
        await projectService.reindex(parseProjectId(request.params)),
      );
    } catch (error) {
      return projectErrorReply(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/builds/targets", async (request, reply) => {
    try {
      return androidBuildTargetListResponseSchema.parse(
        await projectBuildService.listTargets(parseProjectId(request.params)),
      );
    } catch (error) {
      return projectBuildErrorReply(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/android-sdk/install", async (request, reply) => {
    try {
      installAndroidSdkRequestSchema.parse(request.body);
      return androidSdkInfoSchema.parse(
        await projectBuildService.installSdk(parseProjectId(request.params)),
      );
    } catch (error) {
      return projectBuildErrorReply(reply, error);
    }
  });

  app.get("/api/v1/projects/:projectId/builds", async (request, reply) => {
    try {
      return projectBuildRunListResponseSchema.parse(
        await projectBuildService.listRuns(parseProjectId(request.params)),
      );
    } catch (error) {
      return projectBuildErrorReply(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/builds", async (request, reply) => {
    try {
      return projectBuildRunSchema.parse(
        await projectBuildService.start(
          parseProjectId(request.params),
          startProjectBuildRequestSchema.parse(request.body),
        ),
      );
    } catch (error) {
      return projectBuildErrorReply(reply, error);
    }
  });

  app.get(
    "/api/v1/projects/:projectId/builds/:buildId/artifacts/:artifactIndex/download",
    async (request, reply) => {
      try {
        const artifact = await projectBuildService.getArtifact(
          parseProjectId(request.params),
          parseBuildId(request.params),
          parseBuildArtifactIndex(request.params),
        );
        reply.header("Content-Type", "application/vnd.android.package-archive");
        reply.header(
          "Content-Disposition",
          `attachment; filename="build.apk"; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`,
        );
        reply.header("Content-Length", String(artifact.sizeBytes));
        return reply.send(createReadStream(artifact.filePath));
      } catch (error) {
        return projectBuildErrorReply(reply, error);
      }
    },
  );

  app.post(
    "/api/v1/devices/:serial/projects/:projectId/builds/:buildId/artifacts/:artifactIndex/install",
    async (request, reply) => {
      try {
        const artifact = await projectBuildService.getArtifact(
          parseProjectId(request.params),
          parseBuildId(request.params),
          parseBuildArtifactIndex(request.params),
        );
        const stagedArtifact = await apkArtifactService.stage(
          artifact.fileName,
          createReadStream(artifact.filePath),
        );
        return apkInstallResponseSchema.parse(
          await apkArtifactService.install(
            parseSerial(request.params),
            stagedArtifact.id,
            apkInstallRequestSchema.parse(request.body ?? {}),
          ),
        );
      } catch (error) {
        return error instanceof ProjectBuildError
          ? projectBuildErrorReply(reply, error)
          : apkErrorReply(reply, error);
      }
    },
  );

  app.get("/api/v1/ai/status", async () => {
    return aiModelStatusSchema.parse(await aiPlanService.status());
  });

  app.post("/api/v1/ai/models", async (request, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      return aiModelListResponseSchema.parse(
        await aiPlanService.listModels(parseAiModelListRequest(request.body)),
      );
    } catch (error) {
      return aiPlanErrorReply(reply, error);
    }
  });

  app.post("/api/v1/ai/config/test", async (request, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      return aiModelConnectionTestResponseSchema.parse(
        await aiPlanService.testConfiguration(parseAiModelConnectionTestRequest(request.body)),
      );
    } catch (error) {
      return aiPlanErrorReply(reply, error);
    }
  });

  app.post("/api/v1/ai/plans", async (request, reply) => {
    try {
      return aiPlanResponseSchema.parse(
        await aiPlanService.generate(generateAiPlanRequestSchema.parse(request.body)),
      );
    } catch (error) {
      return aiPlanErrorReply(reply, error);
    }
  });

  app.post("/api/v1/apks", async (request, reply) => {
    try {
      const file = await request.file();
      if (file === undefined) {
        throw new ApkArtifactError("请选择要上传的 APK 文件。", 400);
      }
      return apkArtifactSchema.parse(await apkArtifactService.stage(file.filename, file.file));
    } catch (error) {
      return apkErrorReply(reply, error);
    }
  });

  app.delete("/api/v1/apks/:artifactId", async (request, reply) => {
    try {
      await apkArtifactService.discard(parseArtifactId(request.params));
      return reply.code(204).send();
    } catch (error) {
      return apkErrorReply(reply, error);
    }
  });

  app.post("/api/v1/devices/:serial/apks/:artifactId/install", async (request, reply) => {
    try {
      const response = await apkArtifactService.install(
        parseSerial(request.params),
        parseArtifactId(request.params),
        apkInstallRequestSchema.parse(request.body ?? {}),
      );
      return apkInstallResponseSchema.parse(response);
    } catch (error) {
      return apkErrorReply(reply, error);
    }
  });

  app.get("/api/v1/devices/:serial/files", async (request, reply) => {
    try {
      const response = await deviceManagementService.listFiles(
        parseSerial(request.params),
        parseFilePath(request.query),
      );
      return deviceFileListResponseSchema.parse(response);
    } catch (error) {
      return controlErrorReply(reply, error);
    }
  });

  app.post("/api/v1/devices/:serial/files/upload", async (request, reply) => {
    try {
      const file = await request.file();
      if (file === undefined) {
        throw new FileTransferError("请选择要上传的文件。", 400);
      }
      return deviceFileTransferResponseSchema.parse(
        await deviceFileTransferService.upload(
          parseSerial(request.params),
          parseFilePath(request.query),
          file.filename,
          file.file,
        ),
      );
    } catch (error) {
      return fileTransferErrorReply(reply, error);
    }
  });

  app.get("/api/v1/devices/:serial/files/download", async (request, reply) => {
    try {
      const download = await deviceFileTransferService.download(
        parseSerial(request.params),
        parseRequiredFilePath(request.query),
      );
      const stream = createReadStream(download.filePath);
      let disposed = false;
      const dispose = (): void => {
        if (!disposed) {
          disposed = true;
          void download.dispose();
        }
      };
      stream.once("close", dispose);
      stream.once("error", dispose);
      reply.raw.once("close", dispose);

      return reply
        .header("Cache-Control", "no-store")
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(download.fileName)}`,
        )
        .header("Content-Length", String(download.sizeBytes))
        .type("application/octet-stream")
        .send(stream);
    } catch (error) {
      return fileTransferErrorReply(reply, error);
    }
  });

  app.get("/api/v1/devices/:serial/applications", async (request, reply) => {
    try {
      const response = await deviceManagementService.listApplications(
        parseSerial(request.params),
        parseApplicationFilter(request.query),
      );
      return deviceApplicationListResponseSchema.parse(response);
    } catch (error) {
      return controlErrorReply(reply, error);
    }
  });

  app.get("/api/v1/devices/:serial/logcat", async (request, reply) => {
    try {
      const response = await deviceManagementService.readLogcat(
        parseSerial(request.params),
        parseLogcatLimit(request.query),
      );
      return deviceLogcatResponseSchema.parse(response);
    } catch (error) {
      return controlErrorReply(reply, error);
    }
  });

  app.get("/api/v1/appium/runtime", async () => {
    return appiumRuntimeSchema.parse(await appiumRuntimeService.inspect());
  });

  app.post("/api/v1/appium/runtime/start", async (_request, reply) => {
    try {
      return appiumRuntimeSchema.parse(await appiumRuntimeService.start());
    } catch (error) {
      return appiumErrorReply(reply, error);
    }
  });

  app.post("/api/v1/appium/runtime/stop", async (_request, reply) => {
    try {
      return appiumRuntimeSchema.parse(await appiumRuntimeService.stop());
    } catch (error) {
      return appiumErrorReply(reply, error);
    }
  });

  app.get("/api/v1/devices/:serial/screenshot", async (request, reply) => {
    try {
      const screenshot = await deviceControlService.captureScreenshot(parseSerial(request.params));
      return reply.header("Cache-Control", "no-store").type("image/png").send(screenshot);
    } catch (error) {
      return controlErrorReply(reply, error);
    }
  });

  app.get("/api/v1/devices/:serial/ui-tree", async (request, reply) => {
    try {
      const response = await deviceControlService.readUiTree(parseSerial(request.params));
      return deviceUiTreeResponseSchema.parse(response);
    } catch (error) {
      return controlErrorReply(reply, error);
    }
  });

  app.get("/api/v1/devices/:serial/actions", async (request, reply) => {
    try {
      const serial = parseSerial(request.params);
      return deviceActionHistoryResponseSchema.parse({
        serial,
        actions: deviceActionAuditStore.list(serial),
      });
    } catch (error) {
      return controlErrorReply(reply, error);
    }
  });

  app.post("/api/v1/devices/:serial/actions", async (request, reply) => {
    let serial: string;
    let action: ReturnType<typeof deviceControlActionSchema.parse>;

    try {
      serial = parseSerial(request.params);
      action = deviceControlActionSchema.parse(request.body);
    } catch (error) {
      return controlErrorReply(
        reply,
        error instanceof DeviceControlError
          ? error
          : new DeviceControlError("The device action payload is invalid", 400),
      );
    }

    const requestedAt = new Date().toISOString();
    try {
      const execution = await deviceControlService.execute(serial, action);
      const audit = deviceActionAuditStore.record({
        serial,
        action,
        success: true,
        ...execution,
      });
      return deviceActionResultSchema.parse(audit);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Device action failed";
      deviceActionAuditStore.record(createFailedActionAudit(serial, action, requestedAt, message));
      return controlErrorReply(reply, error);
    }
  });

  app.get("/api/v1/devices/:serial/scrcpy/stream", { websocket: true }, (socket, request) => {
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    const pointerStarts = new Map<number, { x: number; y: number; startedAt: string }>();
    let serial: string;
    try {
      serial = parseSerial(request.params);
    } catch (error) {
      socket.close(
        1008,
        error instanceof Error ? error.message : "A valid device serial is required",
      );
      return;
    }

    const sendControlError = (): void => {
      if (socket.readyState === WEBSOCKET_OPEN) {
        socket.send(
          JSON.stringify({ type: "control-error", message: "Unable to control the device" }),
        );
      }
    };

    const recordControlAudit = (command: ReturnType<typeof parseScrcpyControlCommand>): void => {
      if (command === undefined) {
        return;
      }

      if (command.type === "back") {
        const finishedAt = new Date().toISOString();
        deviceActionAuditStore.record({
          serial,
          action: { action: "ui.back" },
          success: true,
          startedAt: finishedAt,
          finishedAt,
        });
        return;
      }

      if (command.type === "key") {
        return;
      }

      if (command.action === "down") {
        pointerStarts.set(command.pointerId, {
          x: command.x,
          y: command.y,
          startedAt: new Date().toISOString(),
        });
        return;
      }

      if (command.action === "cancel") {
        pointerStarts.delete(command.pointerId);
        return;
      }

      if (command.action !== "up") {
        return;
      }

      const start = pointerStarts.get(command.pointerId);
      pointerStarts.delete(command.pointerId);
      if (start === undefined) {
        return;
      }

      const distance = Math.hypot(command.x - start.x, command.y - start.y);
      deviceActionAuditStore.record({
        serial,
        action:
          distance < 24
            ? { action: "ui.tap", x: command.x, y: command.y }
            : {
                action: "ui.swipe",
                startX: start.x,
                startY: start.y,
                endX: command.x,
                endY: command.y,
              },
        success: true,
        startedAt: start.startedAt,
        finishedAt: new Date().toISOString(),
      });
    };

    socket.on("message", (data: { toString(): string }, isBinary: boolean) => {
      if (isBinary) {
        sendControlError();
        return;
      }

      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        sendControlError();
        return;
      }

      const command = parseScrcpyControlCommand(message);
      if (command === undefined) {
        sendControlError();
        return;
      }

      void scrcpyStreamService
        .control(serial, command)
        .then(() => recordControlAudit(command))
        .catch(sendControlError);
    });

    const dispose = (): void => {
      closed = true;
      unsubscribe?.();
      unsubscribe = undefined;
    };

    socket.on("close", dispose);
    socket.on("error", dispose);

    void (async () => {
      try {
        const release = await scrcpyStreamService.subscribe(serial, {
          send: (data, binary) => {
            if (socket.readyState === WEBSOCKET_OPEN) {
              socket.send(data, { binary });
            }
          },
        });

        if (closed) {
          release();
        } else {
          unsubscribe = release;
        }
      } catch (error) {
        if (socket.readyState === WEBSOCKET_OPEN) {
          socket.send(
            JSON.stringify({
              type: "error",
              message: error instanceof Error ? error.message : "Unable to start scrcpy streaming",
            }),
          );
          socket.close(1011);
        }
      }
    })();
  });

  if (webAvailable) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
    });

    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }

      return reply.sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => {
    await scrcpyStreamService.dispose();
    await appiumRuntimeService.dispose();
    await projectBuildService.dispose();
    database.close();
  });

  return {
    app,
    database,
    paths,
    deviceService,
    deviceControlService,
    deviceManagementService,
    deviceFileTransferService,
    projectService,
    projectBuildService,
    aiPlanService,
    apkArtifactService,
    deviceActionAuditStore,
    appiumRuntimeService,
    scrcpyStreamService,
  };
}
