import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import { ensureAgentDirectories, resolveAgentPaths, type AgentPaths } from "@device-robot/config";
import { healthResponseSchema } from "@device-robot/contracts";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { openDatabase, type DatabaseHandle } from "./db/database.js";
import { isAllowedOrigin, isLoopbackHost } from "./security/loopback.js";

export const AGENT_VERSION = "0.1.0";

export type CreateAgentAppOptions = {
  paths?: AgentPaths;
  localAppData?: string;
  logger?: FastifyServerOptions["logger"];
  serveWeb?: boolean;
  webRoot?: string;
};

export type AgentApp = {
  app: FastifyInstance;
  database: DatabaseHandle;
  paths: AgentPaths;
};

function defaultWebRoot(): string {
  return resolve(import.meta.dirname, "../../web/dist");
}

export async function createAgentApp(options: CreateAgentAppOptions = {}): Promise<AgentApp> {
  const paths = options.paths ?? resolveAgentPaths(options.localAppData);
  ensureAgentDirectories(paths);
  const database = openDatabase(paths.database);
  const startedAt = new Date().toISOString();
  const webRoot = options.webRoot ?? defaultWebRoot();
  const shouldServeWeb = options.serveWeb ?? false;
  const webAvailable = shouldServeWeb && existsSync(webRoot);

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
    database.close();
  });

  return { app, database, paths };
}
