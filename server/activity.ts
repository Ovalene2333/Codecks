import { openCodePartToItem } from "./agents/opencode-adapter.js";
import type {
  ActivityItem,
  ActivityUpdate,
  AgentId,
  ThreadActivity,
} from "./types.js";

/**
 * 监控台的实时活动：从各 adapter 已归一化成 Codex 形状的流式事件里，
 * 推出每个会话“本轮何时开始 / 当前在做哪一步 / 最后一次有动静是何时”。
 * 放在 registry 事件汇合处统一计算，四类 agent 不必各写一遍。
 */

/** 只有 lastEventAt 前进时，同一会话最多每 10 秒广播一次。 */
export const ACTIVITY_HEARTBEAT_MS = 10_000;
const MAX_OPEN_ITEMS = 16;
const MAX_ENTRIES = 500;
const TEXT_LIMIT = 300;
/** thread.updated 可能先于 turn/completed 到达，这个窗口内允许补写结果。 */
const LATE_RESULT_MS = 5_000;

const TOOL_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "webSearch",
  "subagent",
  "collabAgentToolCall",
  "imageView",
  "imageGeneration",
  "contextCompaction",
]);
/** 文本/思考没有可靠的结束事件（OpenCode 只发快照），新工具开始即视为结束。 */
const SOFT_TYPES = new Set(["agentMessage", "reasoning"]);
const INPUT_KEYS = [
  "command",
  "cmd",
  "script",
  "commands",
  "filePath",
  "file_path",
  "file",
  "filename",
  "relativePath",
  "path",
  "notebook_path",
  "pattern",
  "query",
  "q",
  "url",
  "description",
];
const ACTIVE_STATUSES = new Set(["starting", "running", "waiting"]);

interface Entry extends ThreadActivity {
  open: Map<string, { item: ActivityItem; startedAt: number }>;
  broadcastAt: number;
}

function clip(value: unknown, limit = TEXT_LIMIT) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function compactInput(input: unknown) {
  if (typeof input === "string") {
    const command = clip(input);
    return command ? { command } : undefined;
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const row = input as Record<string, unknown>;
  const picked: Record<string, string> = {};
  for (const key of INPUT_KEYS) {
    const value = row[key];
    const text = Array.isArray(value)
      ? clip(value.map((entry) => String(entry ?? "")).join("\n"))
      : clip(value);
    if (text) picked[key] = text;
  }
  return Object.keys(picked).length ? picked : undefined;
}

export function compactActivityItem(item: any): ActivityItem | undefined {
  const type = String(item?.type || "");
  const id = String(item?.id || "");
  if (!id || (!TOOL_TYPES.has(type) && !SOFT_TYPES.has(type)))
    return undefined;
  const compact: ActivityItem = { id, type };
  const text = (key: keyof ActivityItem, value: unknown) => {
    const clipped = clip(value);
    if (clipped) (compact as any)[key] = clipped;
  };
  text("status", item.status);
  text("command", item.command);
  text("tool", item.tool || item.name);
  text("server", item.server || item.namespace);
  text("title", item.title);
  text("agent", item.agent);
  text("activity", item.activity);
  text("query", item.query || item.action?.query);
  text("path", item.path);
  const input = compactInput(item.arguments ?? item.input);
  if (input) compact.input = input;
  if (Array.isArray(item.commandActions) && item.commandActions.length)
    compact.commandActions = item.commandActions
      .filter(Boolean)
      .slice(0, 5)
      .map((action: any) => {
        const row: NonNullable<ActivityItem["commandActions"]>[number] = {
          type: String(action.type || ""),
        };
        for (const key of ["path", "query", "name", "command"] as const) {
          const value = clip(action[key]);
          if (value) row[key] = value;
        }
        return row;
      });
  if (Array.isArray(item.changes) && item.changes.length) {
    compact.changes = item.changes
      .filter((change: any) => change?.path)
      .slice(0, 3)
      .map((change: any) => ({
        path: clip(String(change.path)) || "",
        ...(change.kind ? { kind: String(change.kind) } : {}),
      }));
    compact.changeCount = item.changes.length;
  }
  return compact;
}

function publicView(entry: Entry): ThreadActivity {
  const view: ThreadActivity = {
    agentId: entry.agentId,
    threadId: entry.threadId,
    lastEventAt: entry.lastEventAt,
  };
  if (entry.turnId) view.turnId = entry.turnId;
  if (entry.turnStartedAt != null) view.turnStartedAt = entry.turnStartedAt;
  if (entry.step) view.step = entry.step;
  if (entry.lastTurn) view.lastTurn = entry.lastTurn;
  return view;
}

function latestOpen(entry: Entry) {
  let latest: { item: ActivityItem; startedAt: number } | undefined;
  for (const value of entry.open.values())
    if (!latest || value.startedAt >= latest.startedAt) latest = value;
  return latest;
}

function isDone(method: string, status: unknown) {
  if (method === "item/completed") return true;
  const value = String(status || "");
  return ["completed", "failed", "declined", "cancelled", "error"].includes(
    value,
  );
}

export class ActivityTracker {
  private entries = new Map<string, Entry>();

  list(): ThreadActivity[] {
    return [...this.entries.values()].map(publicView);
  }

  get(agentId: AgentId, threadId: string) {
    const entry = this.entries.get(`${agentId}:${threadId}`);
    return entry ? publicView(entry) : undefined;
  }

  /** 吃一条 registry 事件；返回值非空时需要广播给前端。 */
  ingest(
    event: { type: string; data?: any },
    now = Date.now(),
  ): ActivityUpdate | undefined {
    const data = event.data || {};
    if (event.type === "thread.deleted") {
      const agentId = String(data.agentId || "codex");
      const threadId = String(data.threadId || "");
      if (!threadId || !this.entries.delete(`${agentId}:${threadId}`))
        return undefined;
      return { agentId, threadId, activity: null };
    }
    if (event.type === "thread.updated") return this.onThread(data, now);
    if (event.type !== "codex.event" && event.type !== "agent.event")
      return undefined;
    const method = String(data.method || "");
    const params = data.params || {};
    const threadId = String(params.threadId || params.thread?.id || "");
    if (!method || !threadId) return undefined;
    const agentId = String(data.agentId || "codex");
    const entry = this.entry(agentId, threadId, now);
    const before = this.signature(entry);
    entry.lastEventAt = now;

    if (method === "turn/started") {
      entry.turnId = params.turn?.id ? String(params.turn.id) : undefined;
      entry.turnStartedAt = now;
      entry.open.clear();
    } else if (method === "turn/completed") {
      const status = String(params.turn?.status || "completed");
      if (entry.turnStartedAt != null)
        entry.lastTurn = { startedAt: entry.turnStartedAt, endedAt: now, status };
      else if (entry.lastTurn && now - entry.lastTurn.endedAt <= LATE_RESULT_MS)
        entry.lastTurn = { ...entry.lastTurn, status };
      entry.turnId = undefined;
      entry.turnStartedAt = undefined;
      entry.open.clear();
    } else if (
      method === "item/started" ||
      method === "item/updated" ||
      method === "item/completed"
    ) {
      // item/updated 只有 OpenCode 在发，载荷是原生 part，与前端流式层同样先归一化。
      const raw =
        method === "item/updated"
          ? openCodePartToItem(params.item)
          : params.item;
      const item = compactActivityItem(raw);
      if (item) {
        if (isDone(method, raw?.status)) entry.open.delete(item.id);
        else this.open(entry, item, now);
      }
    } else if (method === "item/agentMessage/delta" && params.itemId) {
      const id = String(params.itemId);
      if (!entry.open.has(id)) this.open(entry, { id, type: "agentMessage" }, now);
    } else if (method.startsWith("item/reasoning/") && params.itemId) {
      const id = String(params.itemId);
      if (!entry.open.has(id)) this.open(entry, { id, type: "reasoning" }, now);
    }

    entry.step = latestOpen(entry);
    const changed = this.signature(entry) !== before;
    if (!changed && now - entry.broadcastAt < ACTIVITY_HEARTBEAT_MS)
      return undefined;
    entry.broadcastAt = now;
    return { agentId, threadId, activity: publicView(entry) };
  }

  /**
   * 兜底：Deck 启动前就在跑的回合收不到 turn/started；进程崩溃等路径也可能
   * 只有状态变化没有 turn/completed。以会话状态为准补齐起止。
   */
  private onThread(thread: any, now: number): ActivityUpdate | undefined {
    const threadId = String(thread?.id || "");
    if (!threadId) return undefined;
    const agentId = String(thread.agentId || "codex");
    const key = `${agentId}:${threadId}`;
    const active = ACTIVE_STATUSES.has(String(thread.status)) || thread.compacting;
    let entry = this.entries.get(key);
    if (active && entry?.turnStartedAt == null) {
      entry ??= this.entry(agentId, threadId, now);
      entry.turnStartedAt = Math.min(now, Number(thread.updatedAt) || now);
      entry.turnId = thread.activeTurnId ? String(thread.activeTurnId) : undefined;
    } else if (!active && entry?.turnStartedAt != null) {
      entry.lastTurn = {
        startedAt: entry.turnStartedAt,
        endedAt: now,
        status: thread.status === "error" ? "failed" : "completed",
      };
      entry.turnId = undefined;
      entry.turnStartedAt = undefined;
      entry.open.clear();
      entry.step = undefined;
    } else return undefined;
    entry.broadcastAt = now;
    return { agentId, threadId, activity: publicView(entry) };
  }

  private entry(agentId: AgentId, threadId: string, now: number) {
    const key = `${agentId}:${threadId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        agentId,
        threadId,
        lastEventAt: now,
        open: new Map(),
        broadcastAt: 0,
      };
      this.entries.set(key, entry);
      this.prune();
    }
    return entry;
  }

  private open(entry: Entry, item: ActivityItem, now: number) {
    const previous = entry.open.get(item.id);
    if (!SOFT_TYPES.has(item.type))
      for (const [id, value] of entry.open)
        if (id !== item.id && SOFT_TYPES.has(value.item.type))
          entry.open.delete(id);
    entry.open.set(item.id, { item, startedAt: previous?.startedAt ?? now });
    if (entry.open.size > MAX_OPEN_ITEMS) {
      const oldest = entry.open.keys().next().value;
      if (oldest !== undefined) entry.open.delete(oldest);
    }
  }

  /** 只看前端可见的字段：步骤内容、步骤开始时间、回合起止。 */
  private signature(entry: Entry) {
    return JSON.stringify([
      entry.turnId,
      entry.turnStartedAt,
      entry.lastTurn,
      entry.step?.startedAt,
      entry.step?.item,
    ]);
  }

  /** 空闲会话的条目只为显示上次耗时，超量时先丢最久没动静的。 */
  private prune() {
    if (this.entries.size <= MAX_ENTRIES) return;
    const idle = [...this.entries]
      .filter(([, entry]) => entry.turnStartedAt == null)
      .sort((left, right) => left[1].lastEventAt - right[1].lastEventAt);
    for (const [key] of idle.slice(0, this.entries.size - MAX_ENTRIES))
      this.entries.delete(key);
  }
}
