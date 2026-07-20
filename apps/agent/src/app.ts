import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { ensureAgentDirectories, resolveAgentPaths, type AgentPaths } from "@device-robot/config";
import {
  deviceActionHistoryResponseSchema,
  deviceActionResultSchema,
  deviceControlActionSchema,
  deviceListResponseSchema,
  deviceUiTreeResponseSchema,
  healthResponseSchema,
  appiumRuntimeSchema,
} from "@device-robot/contracts";
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyServerOptions,
} from "fastify";

import { openDatabase, type DatabaseHandle } from "./db/database.js";
import {
  AdbDeviceControlService,
  DeviceControlError,
  type DeviceControlService,
} from "./devices/adb-device-control-service.js";
import { AdbDeviceService, type DeviceDiscoveryService } from "./devices/adb-device-service.js";
import {
  createFailedActionAudit,
  SqliteDeviceActionAuditStore,
  type DeviceActionAuditStore,
} from "./devices/device-action-audit-store.js";
import { isAllowedOrigin, isLoopbackHost } from "./security/loopback.js";
import { AppiumRuntimeError, AppiumRuntimeService } from "./appium/appium-runtime-service.js";

export const AGENT_VERSION = "0.1.0";

export type CreateAgentAppOptions = {
  paths?: AgentPaths;
  localAppData?: string;
  logger?: FastifyServerOptions["logger"];
  serveWeb?: boolean;
  webRoot?: string;
  deviceService?: DeviceDiscoveryService;
  deviceControlService?: DeviceControlService;
  deviceActionAuditStore?: DeviceActionAuditStore;
  appiumRuntimeService?: AppiumRuntimeService;
};

export type AgentApp = {
  app: FastifyInstance;
  database: DatabaseHandle;
  paths: AgentPaths;
  deviceService: DeviceDiscoveryService;
  deviceControlService: DeviceControlService;
  deviceActionAuditStore: DeviceActionAuditStore;
  appiumRuntimeService: AppiumRuntimeService;
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

function controlErrorReply(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof DeviceControlError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "Device control request failed";
  return reply.code(500).send({ error: message });
}

function appiumErrorReply(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof AppiumRuntimeError) {
    return reply.code(error.statusCode).send({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "Appium runtime request failed";
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
  const deviceActionAuditStore =
    options.deviceActionAuditStore ?? new SqliteDeviceActionAuditStore(database.sqlite);
  const appiumRuntimeService = options.appiumRuntimeService ?? new AppiumRuntimeService({ paths });

  const app = Fastify({
    logger: options.logger ?? false,
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
    await appiumRuntimeService.dispose();
    database.close();
  });

  return {
    app,
    database,
    paths,
    deviceService,
    deviceControlService,
    deviceActionAuditStore,
    appiumRuntimeService,
  };
}
