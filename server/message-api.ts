import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { AgentRegistry } from "./agents/registry.js";
import { AgentMessageError } from "./agents/messages.js";
import type { MessageDeliveryQueue } from "./message-delivery.js";

const messageSchema = z.object({
  text: z.string().max(100_000).default(""),
  images: z.array(z.object({
    url: z.string().min(1).max(20_000_000),
    name: z.string().max(200).optional(),
  })).max(8).optional(),
  mode: z.enum(["auto", "start", "append", "queue", "feedback"]).default("auto"),
  expectedTurnId: z.string().min(1).max(300).optional(),
}).strict();

const interruptSchema = z.object({
  expectedTurnId: z.string().min(1).max(300),
}).strict();

const paramsSchema = z.object({
  agentId: z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9_-]*$/),
  threadId: z.string().min(1),
});

/** 独立注册便于用假的 registry 验证 HTTP 契约，不启动真实 Agent。 */
export function registerMessageRoutes(app: Express, agents: AgentRegistry, deliveries?: MessageDeliveryQueue) {
  const route = (handler: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        res.json(await handler(req, res));
      } catch (error: unknown) {
        if (error instanceof AgentMessageError) {
          res.status(error.statusCode).json({ code: error.code, error: error.message });
        } else if (error instanceof z.ZodError) {
          res.status(400).json({ code: "invalid_request", error: error.message });
        } else {
          res.status(400).json({ code: "delivery_failed", error: error instanceof Error ? error.message : "请求失败" });
        }
      }
    };

  app.post("/api/agents/:agentId/threads/:threadId/messages", route(async (req, res) => {
    const { agentId, threadId } = paramsSchema.parse(req.params);
    const { mode, ...input } = messageSchema.parse(req.body ?? {});
    if (mode === "queue" || mode === "feedback") {
      if (!deliveries) throw new AgentMessageError("unsupported", "当前服务端未启用发送模式", 422);
      const item = await deliveries.enqueue(agentId, threadId, mode, input);
      res.status(202);
      return { ...item, disposition: "queued", queueDurability: "disk" };
    }
    return agents.sendMessage(agentId, threadId, { ...input, mode });
  }));
  app.post("/api/agents/:agentId/threads/:threadId/messages/interrupt", route(async (req) => {
    const { agentId, threadId } = paramsSchema.parse(req.params);
    const { expectedTurnId } = interruptSchema.parse(req.body ?? {});
    return agents.interruptMessage(agentId, threadId, expectedTurnId);
  }));
  app.delete("/api/agents/:agentId/threads/:threadId/messages/:messageId", route(async (req) => {
    const { agentId, threadId } = paramsSchema.parse(req.params);
    if (!deliveries) throw new AgentMessageError("unsupported", "当前服务端未启用发送模式", 422);
    await deliveries.cancel(String(req.params.messageId), agentId, threadId);
    return { ok: true };
  }));
  app.post("/api/agents/:agentId/threads/:threadId/messages/:messageId/retry", route(async (req) => {
    const { agentId, threadId } = paramsSchema.parse(req.params);
    if (!deliveries) throw new AgentMessageError("unsupported", "当前服务端未启用发送模式", 422);
    await deliveries.retry(String(req.params.messageId), agentId, threadId);
    return { ok: true };
  }));
  app.post("/api/agents/:agentId/threads/:threadId/messages/:messageId/feedback", route(async (req, res) => {
    const { agentId, threadId } = paramsSchema.parse(req.params);
    if (!deliveries) throw new AgentMessageError("unsupported", "当前服务端未启用发送模式", 422);
    const item = await deliveries.feedback(String(req.params.messageId), agentId, threadId);
    res.status(202);
    return item;
  }));
}
