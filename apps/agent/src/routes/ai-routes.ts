import {
  aiModelConnectionTestRequestSchema,
  aiModelConnectionTestResponseSchema,
  aiModelListRequestSchema,
  aiModelListResponseSchema,
  aiModelStatusSchema,
  aiPlanListResponseSchema,
  aiPlanResponseSchema,
  generateAiPlanRequestSchema,
} from "@device-robot/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";

import { AiPlanError, type AiPlanService } from "../ai/ai-plan-service.js";

type ReplyError = (reply: FastifyReply, error: unknown) => FastifyReply;

function parseModelListRequest(body: unknown): ReturnType<typeof aiModelListRequestSchema.parse> {
  try {
    return aiModelListRequestSchema.parse(body);
  } catch {
    throw new AiPlanError("请填写有效的 Base URL 和 API Key。", 400);
  }
}

function parseModelConnectionTestRequest(
  body: unknown,
): ReturnType<typeof aiModelConnectionTestRequestSchema.parse> {
  try {
    return aiModelConnectionTestRequestSchema.parse(body);
  } catch {
    throw new AiPlanError("请填写有效的 Base URL、API Key 并选择模型。", 400);
  }
}

export function registerAiRoutes(
  app: FastifyInstance,
  aiPlanService: AiPlanService,
  replyError: ReplyError,
): void {
  app.get("/api/v1/ai/status", async () => {
    return aiModelStatusSchema.parse(await aiPlanService.status());
  });

  app.get("/api/v1/ai/plans", async (_request, reply) => {
    try {
      return aiPlanListResponseSchema.parse(await aiPlanService.list());
    } catch (error) {
      return replyError(reply, error);
    }
  });

  app.post("/api/v1/ai/models", async (request, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      return aiModelListResponseSchema.parse(
        await aiPlanService.listModels(parseModelListRequest(request.body)),
      );
    } catch (error) {
      return replyError(reply, error);
    }
  });

  app.post("/api/v1/ai/config/test", async (request, reply) => {
    try {
      reply.header("Cache-Control", "no-store");
      return aiModelConnectionTestResponseSchema.parse(
        await aiPlanService.testConfiguration(parseModelConnectionTestRequest(request.body)),
      );
    } catch (error) {
      return replyError(reply, error);
    }
  });

  app.post("/api/v1/ai/plans", async (request, reply) => {
    try {
      return aiPlanResponseSchema.parse(
        await aiPlanService.generate(generateAiPlanRequestSchema.parse(request.body)),
      );
    } catch (error) {
      return replyError(reply, error);
    }
  });
}
