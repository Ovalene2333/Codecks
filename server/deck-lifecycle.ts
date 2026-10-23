import { DeckRecipientError } from "./deck-recipients.js";
import type { AskActor, AskRecord } from "./ask-service.js";
import type { AgentRegistry } from "./agents/registry.js";

export function isMissingDeckThread(error: unknown) {
  return /会话不存在|(?:thread|session).*(?:not found|does not exist)|unknown (?:thread|session)/i.test(String((error as Error)?.message || error));
}

export async function waitForDeckStop(agents: AgentRegistry, agentId: string, threadId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    let state;
    try { state = agents.messageState(agentId, threadId); }
    catch (error) { if (isMissingDeckThread(error)) return false; throw error; }
    if (state.online && state.ready && !state.thread.activeTurnId) return true;
    if (Date.now() >= deadline) throw new DeckRecipientError("BUSY", 409, "尚未确认原生会话停止，保留删除意图与工作区，请稍后重试");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function assertDeckLifecycleOwner(item: AskRecord | undefined, actor?: AskActor, allowTarget = true) {
  if (!item || !actor || actor.kind === "user") return;
  const source = actor.agentId === item.sourceAgentId && actor.threadId === item.sourceThreadId;
  const target = allowTarget && actor.agentId === item.targetAgentId && actor.threadId === item.targetThreadId;
  if (!source && !target)
    throw new DeckRecipientError("FORBIDDEN", 403, "只能管理自己创建的目标会话；force 不能绕过所有权检查");
}
