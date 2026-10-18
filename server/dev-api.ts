import type { Express, Request, Response } from "express";
import { z } from "zod";
import type { AgentRegistry } from "./agents/registry.js";
import type { AgentId } from "./agents/types.js";
import type { ApprovalKind } from "./types.js";

const approvalInput = z
  .object({
    agentId: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9_-]*$/)
      .default("codex"),
    threadId: z.string().min(1).max(300).optional(),
    providerId: z.string().min(1).max(200).optional(),
    kind: z
      .enum(["command", "file", "permission", "question", "unknown"])
      .default("command"),
    method: z.string().min(1).max(200).optional(),
    /** 原样合并进 request.params，贴近真实 adapter 的审批载荷。 */
    params: z.record(z.string(), z.unknown()).optional(),
    command: z.union([z.string().max(20_000), z.array(z.string().max(2_000)).max(200)]).optional(),
    cwd: z.string().max(4_096).optional(),
    reason: z.string().max(4_000).optional(),
    changes: z.array(z.unknown()).optional(),
    questions: z.array(z.unknown()).optional(),
    availableDecisions: z.array(z.string()).optional(),
    permissions: z.unknown().optional(),
    networkApproval: z.boolean().optional(),
  })
  .strict();

/**
 * 仅开发调试使用：`DECK_DEV_API=1` 时挂上 /api/dev/*。
 * 注入的审批只存在内存中，走现有的快照/WS/解析链路，方便手动验证审批 UI。
 */
export function installDevApi(
  app: Express,
  agents: AgentRegistry,
  enabled = process.env.DECK_DEV_API === "1",
) {
  if (!enabled) return false;

  const route =
    (handler: (req: Request, res: Response) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        const result = await handler(req, res);
        if (!res.headersSent) res.json(result ?? { ok: true });
      } catch (error: any) {
        res.status(400).json({ error: error?.message || "请求失败" });
      }
    };

  app.get(
    "/api/dev/approvals",
    route(async () => ({ items: agents.listDevApprovals() })),
  );

  app.post(
    "/api/dev/approvals",
    route(async (req) => {
      const input = approvalInput.parse(req.body ?? {});
      const params: Record<string, unknown> = { ...input.params };
      if (input.command !== undefined) params.command = input.command;
      if (input.cwd !== undefined) params.cwd = input.cwd;
      if (input.reason !== undefined) params.reason = input.reason;
      if (input.changes !== undefined) params.changes = input.changes;
      if (input.questions !== undefined) params.questions = input.questions;
      if (input.availableDecisions !== undefined)
        params.availableDecisions = input.availableDecisions;
      if (input.permissions !== undefined) params.permissions = input.permissions;
      if (input.networkApproval) params.networkApprovalContext = {};
      const approval = agents.injectDevApproval({
        agentId: input.agentId as AgentId,
        threadId: input.threadId,
        providerId: input.providerId,
        kind: input.kind as ApprovalKind,
        method: input.method,
        params,
      });
      return { approval };
    }),
  );

  app.delete(
    "/api/dev/approvals",
    route(async () => ({ cleared: agents.clearDevApprovals() })),
  );

  return true;
}
