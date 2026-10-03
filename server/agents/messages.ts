import type { ThreadSummary, TurnImage } from "../types.js";

export interface AgentMessageCapabilities {
  /** auto 在会话忙时的行为；unknown 表示交给后端，尚未保证其语义。 */
  busyBehavior: "steer" | "queue" | "reject" | "unknown";
  interruptScope: "turn" | "session";
  queueDurability?: "memory";
  /** Deck 输送层提供的用户发送模式，由 registry 按 adapter 能力补充。 */
  deliveryModes?: ("queue" | "feedback")[];
}

export type MessageDeliveryMode = "queue" | "feedback";

export interface MessageDelivery {
  id: string;
  agentId: string;
  threadId: string;
  mode: MessageDeliveryMode;
  status: "queued" | "interrupting" | "sending" | "delivered" | "failed";
  preview: string;
  /** 气泡的全文；最近完成记录也保留，图片本体不进快照。 */
  text?: string;
  imageCount?: number;
  createdAt: number;
  updatedAt: number;
  turnId?: string;
  /** 用于关联采用原生消息 ID 的历史记录（如 OpenCode）。 */
  sentAt?: number;
  disposition?: AgentMessageAcceptance["disposition"];
  error?: string;
  canRetry?: boolean;
}

export interface AgentMessageInput {
  text: string;
  images?: TurnImage[];
  mode?: "auto" | "start" | "append";
  /** append 必填；auto/start 可用于避免对过期的回合状态操作。 */
  expectedTurnId?: string;
}

export interface AgentMessageAcceptance {
  disposition: "started" | "appended" | "queued" | "backend-managed";
  turnId?: string;
  queueDurability?: "memory";
}

export interface AgentMessageReceipt extends AgentMessageAcceptance {
  /** 本次调用的回执 ID，不是跨请求去重键。 */
  id: string;
  agentId: string;
  threadId: string;
  status: "accepted";
}

export class AgentMessageError extends Error {
  constructor(
    readonly code: "unsupported" | "busy" | "turn_mismatch" | "no_active_turn" | "archived" | "compacting" | "invalid_request",
    message: string,
    readonly statusCode = 409,
  ) {
    super(message);
  }
}

export const messageBusy = (thread: ThreadSummary) =>
  thread.status === "running" || thread.status === "waiting" || Boolean(thread.activeTurnId);

/** 在调用后端前检查策略；adapter 在其异步准备之后仍需检查一次。 */
export function assertMessageInput(
  thread: ThreadSummary,
  input: AgentMessageInput,
  capabilities: AgentMessageCapabilities,
) {
  if (thread.archived)
    throw new AgentMessageError("archived", "会话已归档，请先恢复再发送");
  if (thread.compacting)
    throw new AgentMessageError("compacting", "会话正在压缩上下文，请稍后发送");
  if (!input.text.trim() && !input.images?.length)
    throw new AgentMessageError("invalid_request", "请输入指令或图片", 400);
  if (input.expectedTurnId && thread.activeTurnId !== input.expectedTurnId)
    throw new AgentMessageError("turn_mismatch", "当前回合已变化，请刷新会话状态");
  if (input.mode === "append") {
    if (!input.expectedTurnId)
      throw new AgentMessageError("invalid_request", "append 必须提供 expectedTurnId", 400);
    if (capabilities.busyBehavior !== "steer")
      throw new AgentMessageError("unsupported", "该 Agent 不支持追加到当前回合", 422);
    if (!messageBusy(thread) || !thread.activeTurnId)
      throw new AgentMessageError("no_active_turn", "会话没有正在运行的回合");
  } else if (
    messageBusy(thread) &&
    (input.mode === "start" || capabilities.busyBehavior === "reject")
  ) {
    throw new AgentMessageError("busy", "会话正在运行，请等待结束或先请求打断");
  }
}
