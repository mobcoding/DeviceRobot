import {
  aiModelConnectionTestRequestSchema,
  aiModelConnectionTestResponseSchema,
  aiModelListRequestSchema,
  aiModelListResponseSchema,
  aiModelStatusSchema,
  aiConversationDetailResponseSchema,
  aiConversationListResponseSchema,
  aiConversationSchema,
  aiPlanListResponseSchema,
  aiPlanResponseSchema,
  createAiConversationRequestSchema,
  generateAiPlanRequestSchema,
} from "@device-robot/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { AiPlanError, type AiPlanService } from "../ai/ai-plan-service.js";

type ReplyError = (reply: FastifyReply, error: unknown) => FastifyReply;

const projectParamsSchema = z.object({ projectId: z.uuid() });
const conversationParamsSchema = z.object({ conversationId: z.uuid() });

function parseProjectId(params: unknown): string {
  try {
    return projectParamsSchema.parse(params).projectId;
  } catch {
    throw new AiPlanError("项目标识无效。", 400);
  }
}

function parseConversationId(params: unknown): string {
  try {
    return conversationParamsSchema.parse(params).conversationId;
  } catch {
    throw new AiPlanError("AI 会话标识无效。", 400);
  }
}

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

  app.get("/api/v1/projects/:projectId/ai-conversations", async (request, reply) => {
    try {
      if (aiPlanService.listConversations === undefined) {
        throw new AiPlanError("当前 Agent 未启用 AI 会话存储。", 503);
      }
      return aiConversationListResponseSchema.parse(
        await aiPlanService.listConversations(parseProjectId(request.params)),
      );
    } catch (error) {
      return replyError(reply, error);
    }
  });

  app.post("/api/v1/projects/:projectId/ai-conversations", async (request, reply) => {
    try {
      if (aiPlanService.createConversation === undefined) {
        throw new AiPlanError("当前 Agent 未启用 AI 会话存储。", 503);
      }
      return aiConversationSchema.parse(
        await aiPlanService.createConversation(
          parseProjectId(request.params),
          createAiConversationRequestSchema.parse(request.body),
        ),
      );
    } catch (error) {
      return replyError(reply, error);
    }
  });

  app.delete("/api/v1/projects/:projectId/ai-conversations", async (request, reply) => {
    try {
      if (aiPlanService.removeConversation === undefined) {
        throw new AiPlanError("当前 Agent 未启用 AI 会话存储。", 503);
      }
      await aiPlanService.removeConversation(parseProjectId(request.params));
      return reply.code(204).send();
    } catch (error) {
      return replyError(reply, error);
    }
  });

  app.get("/api/v1/ai-conversations/:conversationId", async (request, reply) => {
    try {
      if (aiPlanService.getConversation === undefined) {
        throw new AiPlanError("当前 Agent 未启用 AI 会话存储。", 503);
      }
      return aiConversationDetailResponseSchema.parse(
        await aiPlanService.getConversation(parseConversationId(request.params)),
      );
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
