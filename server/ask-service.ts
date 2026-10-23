import type { DeckNotices } from "./deck-notices.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRegistry } from "./agents/registry.js";
import type { AgentCreateThreadInput } from "./agents/types.js";
import type { AgentId, AskSession, DeckDeliveryMode, ThreadSummary } from "./types.js";
import type { MessageDeliveryQueue } from "./message-delivery.js";
import { ASK_OUTPUT_LIMIT, finalAnswer, inspectOutput, type AskResult } from "./ask-output.js";
import { DeckRecipientError } from "./deck-recipients.js";

export type AskCancelMode = "after-turn" | "now" | "force";

/** 谁发起了停止/删除：Agent 来源或 Deck 用户；只用于审计与 UI 展示。 */
export interface AskActor {
  kind: "agent" | "user";
  agentId?: AgentId;
  threadId?: string;
}

export interface AskRecord extends AskSession {
  targetAgentId: AgentId;
  targetThreadId?: string;
  targetProviderId?: string;
  /** 目标会话本身的稳定短别名，与询问关系别名不同。 */
  targetAlias?: string;
  question: string;
  result?: AskResult;
  /** 完整回合已读取，但没有非空最终文本；不能冒充可领取结果。 */
  emptyResultTurnId?: string;
  /** 新完成回合后台同步；旧普通记录仅在 result 查询时补读，避免启动扫描全部历史。 */
  capturePending?: boolean;
  createdAt: number;
  updatedAt: number;
  deliveryId?: string;
  turnId?: string;
  response?: string;
  /** 旧版回传投递 ID；只作为“已回传”标记，新流程使用 replyDeliveryId。 */
  wakeDeliveryId?: string;
  replyDeliveryId?: string;
  suppressFailureReply?: boolean;
  suppressFailureNotice?: boolean;
  sentMessages?: { id: string; text: string; mode: DeckDeliveryMode; deliveryId?: string; turnId?: string }[];
  turnSentOffset?: number;
  executionCompletion?: { turnId: string; status: string };
  executionFailure?: { turnId: string; message: string };
  /** detached 交付同步失败的最近一次原因；成功捕获后清除，供 UI 与排查使用。 */
  lastCaptureError?: string;
  captureAttempts?: number;
  /** 显式 collect 推进的已读回合；result 查询不消耗。 */
  lastReadTurnId?: string;
  lastReadWaitingKey?: string;
  /**
   * 本轮在 Deck 侧开始的时刻。部分 Agent（如 OpenCode）结束后会把回合 id
   * 从 Deck 生成的 UUID 换回原生 user message id，单靠 turnId 会永远匹配
   * 不到结果；captureResult 用这个时间做兜底关联。
   */
  turnStartedAt?: number;
  /** 本轮在 Deck 侧结束（完成/失败事件）的时刻；关联重试产生的多个原生回合。 */
  turnEndedAt?: number;
  /** 停止请求先落盘，再打断后端；重启后据此继续收口，不把中断误报成失败。 */
  cancelMode?: AskCancelMode;
  /** 谁发起了停止/删除，仅用于审计。 */
  cancelledBy?: AskActor;
  deletedBy?: AskActor;
  /** 删除失败原因；保留台账，修正后可以重试。 */
  deleteError?: string;
}

interface SessionAliasProvision {
  ensure(targets: { agentId: AgentId; threadId: string }[]): Promise<Map<string, string>>;
  /** 只读查已有别名；加载台账时用于回填，不触发分配。 */
  peek(agentId: AgentId, threadId: string): string | undefined;
}

interface Options {
  file: string;
  agents: AgentRegistry;
  messages: MessageDeliveryQueue;
  /** 跨命名空间保留标识，避免与会话别名、唤醒代号逐字冲突。 */
  reservedAliases?: () => Iterable<string>;
  sessionAliases?: SessionAliasProvision;
  onChanged?: () => void;
  timer?: boolean;
  notices?: DeckNotices;
}

/**
 * 中止类结束不应触发「询问失败」自动回传。不同后端会把它报成
 * interrupted / cancelled / aborted，甚至 failed + aborted 错误文案。
 */
export function isAbortLike(status: string | undefined, message?: string) {
  if (status && ["interrupted", "cancelled", "canceled"].includes(status)) return true;
  return Boolean(message && /(^|[^a-z])(abort(ed)?|interrupt(ed|ion)?|cancel(led|ed)?)([^a-z]|$)|中断|取消|已停止/i.test(message));
}

/**
 * 把错误压成单行并脱敏（key/token/bearer/URL 查询串），供非主节点的 [done]
 * 通知使用；主节点不发通知。通知可能被转发，不能携带凭据或完整 baseURL。
 */
export function sanitizeInline(text: string | undefined, limit = 160) {
  const single = String(text || "").replace(/\s+/g, " ").trim()
    // 先处理 URL 查询串（精确到参数边界），再处理裸 key=value（贪婪到空白）。
    .replace(/([?&])(key|token|api[_-]?key|access[_-]?token|sig|signature)=([^&\s]*)/gi, "$1$2=[已脱敏]")
    .replace(/\b(?:Bearer|bearer)\s+\S+/g, "Bearer [已脱敏]")
    .replace(/\b(sk|rk)-[A-Za-z0-9_-]{8,}/g, "[已脱敏]")
    .replace(/\b(api[_-]?key|token|secret|password|passwd)\s*[=:]\s*\S+/gi, "$1=[已脱敏]");
  return single.slice(0, limit);
}

/** 完整对话留在原生历史；台账仅保存路由、状态与本回合最终交付快照。 */
export class AskService {  private items: AskRecord[] = [];
  private writes = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private closed = false;
  private progressSavedAt = new Map<string, number>();
  private loadError?: string;

  private readonly onEvent = (event: any) => {
    if (["agent.event", "codex.event"].includes(event?.type)) {
      const data = event.data;
      const item = this.items.find((entry) => !entry.deletedAt && ["queued", "running"].includes(entry.status) && entry.targetAgentId === (data?.agentId || "codex") && entry.targetThreadId === data?.params?.threadId);
      if (item) {
        item.lastProgressAt = Date.now();
        if (Date.now() - (this.progressSavedAt.get(item.id) || 0) > 30_000) {
          this.progressSavedAt.set(item.id, Date.now());
          void this.save().catch((error) => console.error("进展状态保存失败:", error.message));
        }
      }
    }
    if (!["agent.event", "codex.event"].includes(event?.type) || !["turn/started", "turn/completed"].includes(event.data?.method)) return;
    const data = event.data;
    const turn = data.params?.turn;
    if (!turn?.id) return;
    if (data.method === "turn/started") {
      const item = this.items.find((entry) => !entry.deletedAt &&
        entry.targetAgentId === (data.agentId || "codex") && entry.targetThreadId === data.params?.threadId);
      if (!item || item.turnId === turn.id) return;
      delete item.waitingReason;
      delete item.waitingDetail;
      delete item.waitingSince;
      item.turnId = turn.id;
      item.status = "running";
      // 显式重新发送会开启新回合；上一轮的停止意图不能继续套在新回合上。
      delete item.cancelRequestedAt;
      delete item.cancelMode;
      delete item.cancelledAt;
      delete item.cancelledBy;
      item.updatedAt = Date.now();
      item.turnSentOffset = item.sentMessages?.length || 0;
      item.turnStartedAt = Date.now();
      delete item.turnEndedAt;
      delete item.executionCompletion;
      delete item.executionFailure;
      delete item.response;
      delete item.replyDeliveryId;
      delete item.wakeDeliveryId;
      delete item.error;
      delete item.suppressFailureNotice;
      delete item.result;
      delete item.emptyResultTurnId;
      delete item.capturePending;
      delete item.lastCaptureError;
      item.captureAttempts = 0;
      void this.save().catch((error) => console.error("会话回合状态保存失败:", error.message));
      return;
    }
    if (!["completed", "failed", "error", "interrupted", "cancelled"].includes(turn.status)) return;
    const item = this.items.find((item) => !item.deletedAt &&
      ["queued", "running"].includes(item.status) && item.targetAgentId === (data.agentId || "codex") &&
      item.targetThreadId === data.params?.threadId && (!item.turnId || item.turnId === turn.id),
    );
    if (!item) return;
    item.turnId ||= turn.id;
    item.updatedAt = Date.now();
    item.turnEndedAt = Date.now();
    item.executionCompletion = { turnId: turn.id, status: turn.status };
    if (turn.status !== "completed") {
      item.executionFailure = { turnId: turn.id,
        message: String(turn.error?.message || (typeof turn.error === "string" ? turn.error : "") || `目标回合${turn.status === "interrupted" || turn.status === "cancelled" ? "已中断" : "执行失败"}`).slice(0, 500) };
    }
    // Persist before relying on history: launch errors may never create a native transcript.
    void this.save().then(() => this.tick()).catch((error) => console.error("询问失败事件保存失败:", error.message));
  };

  constructor(private readonly options: Options) {}

  async load() {
    try {
      const data = JSON.parse(await readFile(this.options.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.items)) throw new Error("询问台账格式无效");
      let changed = data.readTrackingVersion !== 1;
      this.items = data.items.filter((item: any) =>
        typeof item?.id === "string" && typeof item.sourceAgentId === "string" &&
        typeof item.sourceThreadId === "string" && typeof item.targetAgentId === "string" &&
        typeof item.question === "string" &&
        ["queue", "steer", "interrupt"].includes(item.returnMode) &&
        ["creating", "queued", "running", "answered", "completed", "failed", "cancelled"].includes(item.status),
      );
      for (const item of this.items) {
        const legacy = item as unknown as Record<string, unknown>;
        delete legacy.wakeCode;
        delete legacy.doneDeliveryId;
        delete legacy.doneTurnId;
      }
      // 先收下记录自带的别名，再为缺别名的旧记录补齐：入参里的保留集合
      // 可能包含本台账自己刚写入的别名，先补会把已落盘别名误判成撞车。
      const used = new Set<string>();
      for (const item of this.items) {
        if (typeof item.alias === "string" && /^[a-z0-9]{8,32}$/.test(item.alias)) used.add(item.alias);
      }
      for (const item of this.items) {
        if (data.readTrackingVersion !== 1 && ["answered", "completed", "failed", "cancelled"].includes(item.status))
          item.lastReadTurnId = item.turnId || "creating";
        if (item.detached !== undefined && typeof item.detached !== "boolean") throw new Error("detached 模式无效");
        if (item.turnStartedAt !== undefined && !Number.isFinite(item.turnStartedAt)) throw new Error("回合开始时间无效");
        if (item.turnEndedAt !== undefined && !Number.isFinite(item.turnEndedAt)) throw new Error("回合结束时间无效");
        if (item.result !== undefined && (typeof item.result?.turnId !== "string" ||
          typeof item.result.text !== "string" || item.result.text.length > ASK_OUTPUT_LIMIT ||
          !Number.isFinite(item.result.completedAt) || typeof item.result.truncated !== "boolean"))
          throw new Error("询问交付结果格式无效");
        if (item.sentMessages !== undefined && (!Array.isArray(item.sentMessages) || item.sentMessages.some((message) =>
          !message || typeof message.id !== "string" || typeof message.text !== "string" ||
          !["queue", "steer", "interrupt"].includes(message.mode) ||
          (message.deliveryId !== undefined && typeof message.deliveryId !== "string") ||
          (message.turnId !== undefined && typeof message.turnId !== "string"))))
          throw new Error("主动消息台账格式无效");
        for (const [field, valid] of [
          ["lastCaptureError", (value: any) => typeof value === "string"],
          ["emptyResultTurnId", (value: any) => typeof value === "string"],
          ["capturePending", (value: any) => typeof value === "boolean"],
          ["lastReadWaitingKey", (value: any) => typeof value === "string"],
          ["waitingReason", (value: any) => ["waiting-approval", "backend-offline", "unresolved", "stalled"].includes(value)],
          ["waitingSince", (value: any) => Number.isFinite(value)],
          ["waitingDetail", (value: any) => typeof value === "string"],
          ["lastProgressAt", (value: any) => Number.isFinite(value)],
          ["suppressFailureNotice", (value: any) => typeof value === "boolean"],
          ["lastReadTurnId", (value: any) => typeof value === "string"],
          ["captureAttempts", (value: any) => Number.isInteger(value) && value >= 0],
          ["cancelRequestedAt", (value: any) => Number.isFinite(value)],
          ["cancelledAt", (value: any) => Number.isFinite(value)],
          ["archivedAt", (value: any) => Number.isFinite(value)],
          ["deletedAt", (value: any) => Number.isFinite(value)],
          ["deleteError", (value: any) => typeof value === "string"],
          ["cancelMode", (value: any) => ["after-turn", "now", "force"].includes(value)],
        ] as const) {
          if (item[field] !== undefined && !valid(item[field])) throw new Error(`询问台账 ${field} 字段无效`);
        }
        if (item.result && !item.result.text.trim()) {
          item.emptyResultTurnId = item.result.turnId;
          delete item.result;
          changed = true;
        }
        if (item.status === "creating") {
          item.status = item.cancelRequestedAt ? "cancelled" : "failed";
          item.updatedAt = Date.now();
          item.error = item.status === "failed"
            ? "创建期间服务重启，请检查目标会话后重新发起询问"
            : undefined;
          if (item.status === "cancelled") item.cancelledAt ??= item.updatedAt;
          changed = true;
        }
        // 旧记录的 wakeDeliveryId 仅视为“已回传”标记，避免升级后重复回复。
        if (item.wakeDeliveryId && !item.replyDeliveryId) {
          item.replyDeliveryId = item.wakeDeliveryId;
          changed = true;
        }
        // 别名落盘后永不重算；旧记录缺别名时按 id 补一次并保存。
        const stored = typeof item.alias === "string" && /^[a-z0-9]{8,32}$/.test(item.alias)
          ? item.alias : undefined;
        const alias = stored ?? this.uniqueAlias(item.id, used);
        if (alias !== item.alias) {
          item.alias = alias;
          changed = true;
        }
        used.add(alias);
        // 旧记录在会话别名功能上线前创建，没有 targetAlias。会话别名的权威
        // 来源是 ThreadSettingsStore 台账，这里补一次并落盘，避免询问卡片
        // 退回读取会随事件变化的 thread.alias 而显示成别的值。
        if (!item.targetAlias && item.targetThreadId) {
          const targetAlias = this.options.sessionAliases
            ?.peek(item.targetAgentId, item.targetThreadId);
          if (targetAlias) {
            item.targetAlias = targetAlias;
            changed = true;
          }
        }
      }
      if (changed) await this.save();
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        this.loadError = `询问台账不可用：${error.message || error}，请修复后重启 Deck`;
        console.error(this.loadError);
      }
    }
    this.options.agents.on("event", this.onEvent);
    if (this.options.timer !== false) {
      this.timer = setInterval(() => void this.tick().catch((error) =>
        console.error("询问调度失败:", error.message)), 2000);
      this.timer.unref();
    }
  }

  private usedAliases() {
    const used = new Set<string>();
    for (const item of this.items) {
      if (typeof item.alias === "string" && item.alias) used.add(item.alias);
    }
    for (const reserved of this.options.reservedAliases?.() ?? []) {
      if (typeof reserved === "string" && reserved) used.add(reserved);
    }
    return used;
  }

  /** 由 ask id 派生、在现有别名集合里唯一的短标识；长度不足时逐步加长。 */
  private uniqueAlias(id: string, used: Set<string>) {
    const base = id.replace(/[^a-z0-9]/gi, "").toLowerCase();
    for (let length = 8; length <= base.length; length += 2) {
      const candidate = base.slice(0, length);
      if (!used.has(candidate)) return candidate;
    }
    for (let i = 0; i < 1000; i += 1) {
      const candidate = `${base.slice(0, 8)}${i.toString(36).padStart(2, "0")}`;
      if (!used.has(candidate)) return candidate;
    }
    return randomUUID().replace(/[^a-z0-9]/gi, "").slice(0, 12);
  }

  /** `send --to @alias` 的目标解析；别名只在询问台账内生效。 */
  findByAlias(alias: string) {
    const item = this.items.find((entry) => entry.alias === alias);
    if (!item?.targetThreadId) return undefined;
    return {
      alias,
      item,
      target: { agentId: item.targetAgentId, threadId: item.targetThreadId },
    };
  }

  private summary(record: AskRecord) {
    const { response: _response, result, sentMessages, question: _question, lastCaptureError, ...item } = record;
    const offset = item.turnSentOffset ?? 0;
    const outgoingMessages: NonNullable<AskSession["outgoingMessages"]> = (sentMessages || []).map((message, index) => {
      const delivery = message.deliveryId ? this.options.messages.receipt(message.deliveryId) : undefined;
      return {
        id: message.id, turnId: message.turnId ?? (index >= offset ? item.turnId : undefined),
        deliveryId: message.deliveryId, mode: message.mode,
        status: delivery?.status ?? (message.deliveryId ? "unknown" : "pending"),
        error: delivery?.error,
      };
    });
    const current = outgoingMessages.filter((message) => item.turnId && message.turnId === item.turnId);
    const delivered = current.filter((message) => message.status === "delivered").length;
    const finished = ["completed", "answered"].includes(item.status);
    const resultAvailable = !!result?.text.trim() && result.turnId === item.turnId;
    const resultState: AskSession["resultState"] = !finished ? undefined : resultAvailable ? "ready"
      : item.emptyResultTurnId === item.turnId && item.turnId ? "empty" : "pending";
    return {
      ...item, status: finished ? (delivered ? "answered" as const : "completed" as const) : item.status,
      detached: item.detached === true, resultAvailable, resultState,
      unread: !item.deletedAt && !item.archivedAt && ((item.lastReadTurnId !== (item.turnId || "creating") && (resultAvailable || item.status === "failed")) ||
        (!!item.waitingReason && item.lastReadWaitingKey !== `${item.waitingReason}:${item.waitingSince}`)),
      currentTurnSentCount: current.length, currentTurnDeliveredCount: delivered, outgoingMessages,
      sentCount: sentMessages?.length || 0, captureError: lastCaptureError,
    };
  }

  list(filter: { source?: string; unread?: boolean } = {}) {
    return this.items.filter((item) => !filter.source || `${item.sourceAgentId}:${item.sourceThreadId}` === filter.source)
      .map((item) => this.summary(item)).filter((item) => !filter.unread || item.unread);
  }

  /**
   * 完整台账只读副本，供协作泳道解析。list() 面向 UI 会裁掉问题与逐条
   * 回传正文；这里需要原样保留，才能从真实消息还原时间线。
   */
  records(): AskRecord[] {
    return this.items.map((item) => ({
      ...item,
      sentMessages: item.sentMessages?.map((message) => ({ ...message })),
    }));
  }

  /** 管理操作需要读取墓碑；普通查询用 lookup 拒绝已删除记录。 */
  findRecord(reference: string): AskRecord | undefined {
    if (this.loadError) throw new Error(this.loadError);
    const key = reference.replace(/^@/, "");
    return this.items.find((entry) => entry.alias === key || entry.id === key);
  }

  /** 供收件人解析：目标会话对应的询问若已删除（事务只完成一半）也不能再投递。 */
  isTargetDeleted(agentId: AgentId, threadId: string): boolean {
    return this.items.some((entry) =>
      entry.deletedAt !== undefined &&
      entry.targetAgentId === agentId && entry.targetThreadId === threadId);
  }

  private lookup(reference: string) {
    const item = this.findRecord(reference);
    if (!item) throw new Error(`询问 ${reference} 不存在`);
    if (item.deletedAt)
      throw new DeckRecipientError("DELETED", 410, `询问 ${reference} 已删除`);
    return item;
  }

  /** 查询不投递、不标为已读，可重复读取。 */
  async readResult(reference: string) {
    const item = this.lookup(reference);
    if (["completed", "answered"].includes(item.status) && !item.result) {
      try { await this.captureResult(item); } catch { /* captureResult 已落态，保留待同步。 */ }
    }
    const result = item.result?.turnId === item.turnId ? item.result : undefined;
    return { item: this.list().find((entry) => entry.id === item.id)!, result: result || null,
      pending: ["completed", "answered"].includes(item.status) && !result && (!item.turnId || item.emptyResultTurnId !== item.turnId) };
  }

  async waitResult(reference: string, seconds: number, signal?: AbortSignal) {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 60) throw new Error("wait 应为 0 至 60 秒的整数");
    const deadline = Date.now() + seconds * 1000;
    while (true) {
      if (signal?.aborted || this.closed) throw new Error("等待已取消或服务已关闭");
      const response = await this.readResult(reference);
      if (signal?.aborted || this.closed) throw new Error("等待已取消或服务已关闭");
      if (response.result || ["failed", "cancelled"].includes(response.item.status) || response.item.resultState === "empty") return { ...response, timedOut: false };
      if (Date.now() >= deadline) return { ...response, timedOut: true };
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, Math.min(1000, deadline - Date.now()));
        signal?.addEventListener("abort", finish, { once: true });
        if (signal?.aborted) finish();
      });
    }
  }

  /** Explicit collection is the only action that acknowledges a result. */
  async collect(references: string[]) {
    const records = references.map((reference) => this.lookup(reference));
    const results = await Promise.all(records.map((item) => this.readResult(item.id)));
    for (let index = 0; index < records.length; index++) {
      const item = records[index];
      const snapshot = results[index];
      if ((snapshot.result && snapshot.result.turnId === item.turnId) || (snapshot.item.status === "failed" && item.status === "failed" && snapshot.item.turnId === item.turnId))
        item.lastReadTurnId = snapshot.result?.turnId || item.turnId || "creating";
      if (snapshot.item.waitingReason === item.waitingReason && snapshot.item.waitingSince === item.waitingSince && item.waitingReason)
        item.lastReadWaitingKey = `${item.waitingReason}:${item.waitingSince}`;
    }
    await this.save();
    return { items: results.map((entry) => ({ ...entry, item: this.summary(this.lookup(entry.item.id)) })) };
  }

  private async waiting(item: AskRecord, reason?: AskSession["waitingReason"], detail?: string) {
    if (item.waitingReason === reason && item.waitingDetail === detail) return;
    item.waitingDetail = detail;
    item.waitingReason = reason;
    item.waitingSince = reason ? Date.now() : undefined;
    await this.save();
  }

  async inspect(reference: string, tail = 40) {
    if (!Number.isInteger(tail) || tail < 1 || tail > 200) throw new Error("tail 应为 1 至 200 的整数");
    const item = this.lookup(reference);
    if (!item.targetThreadId) throw new Error("目标会话尚未创建");
    const full: any = await this.options.agents.readThread(item.targetAgentId, item.targetThreadId, { background: true });
    const turns = full?.turns || full?.thread?.turns || [];
    return { item: this.list().find((entry) => entry.id === item.id)!, ...inspectOutput(turns, tail) };
  }

  decorate(thread: ThreadSummary): ThreadSummary {
    const base = thread;
    const item = this.items.find((item) => item.targetAgentId === (thread.agentId || "codex") && item.targetThreadId === thread.id);
    if (!item) return base;
    const view = this.summary(item);
    return { ...base, ask: {
      id: view.id, alias: view.alias, targetAlias: view.targetAlias,
      sourceAgentId: view.sourceAgentId, sourceThreadId: view.sourceThreadId, sourceProviderId: view.sourceProviderId,
      returnMode: view.returnMode, status: view.status, error: view.error, sentCount: view.sentCount,
      detached: view.detached, resultAvailable: view.resultAvailable, resultState: view.resultState,
      unread: view.unread, waitingReason: view.waitingReason, waitingSince: view.waitingSince, waitingDetail: view.waitingDetail,
      lastProgressAt: view.lastProgressAt,
      captureError: view.captureError, currentTurnSentCount: view.currentTurnSentCount,
      currentTurnDeliveredCount: view.currentTurnDeliveredCount,
    } };
  }

  /**
   * 主节点判定：人创建的会话（不是任何询问的目标）即主节点，主节点永不
   * 接受 agent 消息注入。fork/retry 产生的新 id 没有询问标记，自然视为主节点。
   */
  isMaster(agentId: AgentId, threadId: string): boolean {
    return !this.items.some((entry) =>
      entry.targetAgentId === agentId && entry.targetThreadId === threadId);
  }

  async create(input: {
    sourceAgentId: AgentId; sourceThreadId: string; targetAgentId: AgentId;
    question: string; returnMode: DeckDeliveryMode;
    detached?: boolean;
    settings: AgentCreateThreadInput;
  }) {
    if (this.loadError) throw new Error(this.loadError);
    const id = randomUUID();
    const item: AskRecord = {
      id, alias: this.uniqueAlias(id, this.usedAliases()),
      sourceAgentId: input.sourceAgentId, sourceThreadId: input.sourceThreadId,
      sourceProviderId: this.options.agents.messageState(input.sourceAgentId, input.sourceThreadId).thread.providerId,
      targetAgentId: input.targetAgentId, question: input.question,
      detached: input.detached === true,
      returnMode: input.returnMode, status: "creating", createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.items.push(item);
    await this.save();
    try {
      const thread = await this.options.agents.createThread(input.targetAgentId, {
        ...input.settings, name: input.settings.name || `询问 · ${input.question.slice(0, 60)}`,
      }) as ThreadSummary;
      item.targetThreadId = thread.id;
      item.targetProviderId = thread.providerId;
      const sessionAliases = this.options.sessionAliases
        ? await this.options.sessionAliases.ensure([{ agentId: input.targetAgentId, threadId: thread.id }])
        : new Map<string, string>();
      item.targetAlias = sessionAliases.get(JSON.stringify([input.targetAgentId, thread.id]));
      // createThread 返回前可能已经被 stop/delete：不能再把问题投递出去，
      // 并把刚创建的原生会话尽力回收，避免留下无人管理的空会话。
      if (item.deletedAt || item.cancelRequestedAt) {
        try {
          await this.options.agents.deleteThread?.(input.targetAgentId, thread.id);
        } catch { /* 原生删除失败时保留会话，台账状态仍然一致。 */ }
        if (!item.deletedAt) await this.cancelItem(item);
        else await this.save();
        const decorated = this.decorate(thread);
        return { item: this.list().find((entry) => entry.id === item.id)!, thread: { ...decorated, alias: item.targetAlias ?? decorated.alias } };
      }
      item.status = "queued";
      item.updatedAt = Date.now();
      await this.save();
      await this.start(item);
      const decorated = this.decorate(thread);
      return { item: this.list().find((entry) => entry.id === item.id)!, thread: { ...decorated, alias: item.targetAlias ?? decorated.alias } };
    } catch (error: any) {
      await this.fail(item, String(error.message || error), false);
      throw new Error(`询问 ${item.id} 创建或发送失败：${item.error}`);
    }
  }

  private async start(item: AskRecord) {
    const delivery = await this.options.messages.enqueue(item.targetAgentId, item.targetThreadId!, "queue", {
      text: [
        `[deck-api:create:${item.alias}] 来自发起会话的询问。`,
        "这是独立会话：你看不到发起会话的历史，需要的背景都在下面的问题里。",
        item.detached
          ? "这是 detached 任务：来源会自行领取结果，不要主动 send 常规进度或完成通知。需要来源决定的阻塞问题、或用户明确要求时，仍可显式 send；默认收件人已绑定。"
          : "用 deck-api send 主动回传；可以多次发送进度、澄清问题或结果。默认收件人已绑定为发起会话，不需要查询代号。",
        item.targetAlias
          ? `本会话询问别名是 ${item.alias}，会话短别名是 ${item.targetAlias}，身份是 ${item.targetAgentId}:${item.targetThreadId}。需要主动联系来源时使用 send；自动识别失败时把该身份传给 --session，不要查询或猜测其他会话。`
          : `本会话询问别名是 ${item.alias}，身份是 ${item.targetAgentId}:${item.targetThreadId}。需要主动联系来源时使用 send；自动识别失败时把该身份传给 --session，不要查询或猜测其他会话。`,
        "执行入口优先使用 ${CODEX_DECK_HOME:-$HOME/.codex-deck}/bin/deck-api；项目内也可读取 deck-api skill。没有该入口时说明失败，不要借用其他会话身份。",
        ...(item.detached ? [
          "结束时直接在本会话最终答复中交付：结论、关键依据、文件或产物位置、验证结果与未决问题。Deck 会保存最终答复供来源用 deck-api result @别名 领取；不需要另行 send。",
          "正常结束、失败或中断都不会自动向来源发消息；完整执行过程留在原生历史，来源可用 deck-api inspect 查看。",
        ] : [
          "结束前必须 send 一条最终结论（关键依据、文件或产物位置）。即使没有新结论、或不需要来源采取行动，也请 send 一条简短状态（如“已完成，无新增结论”）；不要静默结束。",
          "正常结束不会自动转发或通知；Deck 会保存最终答复供来源用 result 查询，即使 send 失败也可领取。启动或执行失败沿用自动通知。",
        ]),
        "回传是异步的：send 返回成功后不要等待、轮询或反复追问来源；继续本会话工作或结束。来源的回复不会自动回到本会话，需要时由来源另行 send 到本会话。",
        "一条消息只放对来源下一步有帮助的内容；完整分析、工具日志和讨论留在本会话，不要为总结再调用其他模型。单条消息上限 80000 字符。",
        "", item.question,
      ].join("\n"),
    }, { id: `ask:${item.id}` });
    item.deliveryId = delivery.id;
    item.updatedAt = Date.now();
    await this.save();
  }

  async tick() {
    if (this.ticking || this.closed || this.loadError) return;
    this.ticking = true;
    try {
      for (const item of this.items) {
        try {
          if (item.deletedAt) continue;
          if ((item.capturePending || item.detached) && ["completed", "answered"].includes(item.status) && !item.result && item.emptyResultTurnId !== item.turnId) {
            try { await this.captureResult(item); } catch { /* 结果同步不阻塞显式 send 的恢复。 */ }
          }
          for (const message of item.sentMessages || []) {
            if (!message.deliveryId) await this.deliverMessage(item, message);
          }
          if (item.status === "failed" && !item.suppressFailureReply && !item.response && item.error) await this.fail(item, item.error);
          if (item.response && !item.replyDeliveryId) await this.reply(item);
          if (!["queued", "running"].includes(item.status)) continue;
          if (item.executionFailure) {
            // 中止/取消是用户或 stop 的主动行为：标记 cancelled，不再向来源
            // 自动回一条「询问失败」，避免每次停会话都往主进程灌垃圾消息。
            if (isAbortLike(item.executionCompletion?.status, item.executionFailure.message))
              await this.cancelItem(item);
            else await this.fail(item, item.executionFailure.message);
            continue;
          }
          if (item.executionCompletion?.status === "completed") {
            if (item.cancelRequestedAt) await this.cancelItem(item);
            else await this.complete(item);
            continue;
          }
          const descriptor = this.options.agents.list().find((agent) => agent.id === item.targetAgentId);
          if (descriptor?.enabled === false) {
            if (item.cancelRequestedAt) await this.cancelItem(item);
            else await this.fail(item, "目标 Agent 已停用，询问无法继续", false);
            continue;
          }
          if (!this.options.agents.messageBackendOnline(item.targetAgentId)) {
            await this.waiting(item, "backend-offline", sanitizeInline(descriptor?.error) || undefined);
            continue;
          }
          if (!item.deliveryId) await this.start(item);
          const delivery = this.options.messages.receipt(item.deliveryId!);
          if (!delivery) {
            // 初始投递被取消（stop、用户在待发送列表取消）不是执行失败，
            // 统一收口为 cancelled，避免给来源回一条失败消息。
            await this.cancelItem(item);
            continue;
          }
          if (delivery.status === "failed") {
            if (item.cancelRequestedAt) await this.cancelItem(item);
            else await this.fail(item, delivery.error || "询问消息投递失败");
            continue;
          }
          if (delivery.status !== "delivered") continue;
          if (item.status === "queued") {
            item.status = "running";
            item.updatedAt = Date.now();
            item.turnId = delivery.turnId;
            item.turnStartedAt ??= Date.now();
            await this.save();
          }
          const state = this.options.agents.messageState(item.targetAgentId, item.targetThreadId!);
          if (state.thread.status === "error") {
            if (item.cancelRequestedAt) await this.cancelItem(item);
            else await this.fail(item, state.thread.lastError || "目标 Agent 执行失败，未生成回答");
            continue;
          }
          if (!this.options.agents.messageBackendOnline(item.targetAgentId)) continue;
          if (state.thread.archived) {
            if (item.cancelRequestedAt) await this.cancelItem(item);
            else await this.fail(item, "询问会话已归档");
            continue;
          }
          const approvals = this.options.agents.snapshot?.().approvals || [];
          const approval = approvals.some((entry) => entry.agentId === item.targetAgentId &&
            (entry.request?.params?.threadId === item.targetThreadId || entry.threadId === item.targetThreadId));
          if (approval) { await this.waiting(item, "waiting-approval"); continue; }
          if (!state.ready) {
            await this.waiting(item, Date.now() - (item.lastProgressAt || item.turnStartedAt || item.updatedAt) >= 300_000 ? "stalled" : undefined);
            continue;
          }
          const full: any = await this.options.agents.readThread(item.targetAgentId, item.targetThreadId!, { background: true });
          const turns: any[] = full?.turns || full?.thread?.turns || [];
          const turn = this.findTurn(item, turns);
          if (!turn) { await this.waiting(item, "unresolved"); continue; }
          await this.waiting(item);
          if (["inProgress", "running", "pending"].includes(turn.status)) continue;
          const failed = ["failed", "error", "interrupted", "cancelled"].includes(turn.status);
          if (failed) {
            const message = state.thread.lastError || `询问未正常完成（${turn.status}）`;
            if (isAbortLike(turn.status, message)) await this.cancelItem(item);
            else await this.fail(item, message);
            continue;
          }
          if (item.cancelRequestedAt) await this.cancelItem(item);
          else await this.complete(item, turn);
        } catch (error: any) {
          // Offline adapters/history refreshes are retried; never repeat an accepted question.
          if (/会话不存在|已归档/.test(String(error.message))) {
            if (item.cancelRequestedAt) await this.cancelItem(item);
            else await this.fail(item, error.message);
          }
          else console.error(`询问 ${item.id} 等待恢复:`, error.message);
        }
      }
      await this.options.notices?.tick(this.list());
    } finally { this.ticking = false; }
  }

  /**
   * 主动停止：先落停止意图并取消自动投递，再按模式打断后端。
   * after-turn 让当前回合自然收尾；now 立即打断；force 再补一次紧急归位。
   * 停止是静默的，不会向来源自动回一条失败消息。
   */
  async stop(reference: string, options: { mode?: AskCancelMode; actor?: AskActor } = {}) {
    const item = this.lookup(reference);
    if (item.status === "cancelled") return { item: this.itemView(item), alreadyStopped: true };
    if (["completed", "answered", "failed"].includes(item.status))
      throw new DeckRecipientError("NOT_CANCELLABLE", 409, `询问 ${reference} 已结束（${item.status}），不能停止`);
    const mode = options.mode || "now";
    item.cancelRequestedAt ??= Date.now();
    item.cancelMode = mode;
    if (options.actor) item.cancelledBy = options.actor;
    item.updatedAt = Date.now();
    delete item.deleteError;
    await this.save();
    await this.cancelPendingDeliveries(item);
    // creating 阶段还没有原生会话；create() 返回后会看到停止意图并回收刚建的会话。
    if (item.status === "creating" || !item.targetThreadId) {
      await this.cancelItem(item);
      return { item: this.itemView(item), alreadyStopped: false, pendingAfterTurn: false };
    }
    const state = this.safeMessageState(item);
    const running = state ? ["running", "waiting"].includes(state.thread.status) : false;
    const activeTurn = state?.thread.activeTurnId || item.turnId;
    if (mode === "after-turn" && running)
      return { item: this.itemView(item), alreadyStopped: false, pendingAfterTurn: true };
    let warning: string | undefined;
    if (running && activeTurn) {
      try {
        await this.options.agents.interrupt(item.targetAgentId, item.targetThreadId, activeTurn);
      } catch (error: any) {
        warning = `打断请求失败：${error?.message || error}`;
      }
    }
    if (mode === "force") {
      try { await this.options.agents.forceStop(item.targetAgentId, item.targetThreadId); }
      catch (error: any) { warning = warning || `紧急停止失败：${error?.message || error}`; }
    }
    await this.cancelItem(item);
    return { item: this.itemView(item), alreadyStopped: false, pendingAfterTurn: false, warning };
  }

  /** 归档只改 Deck 侧生命周期，不清原生历史；运行中的会话必须先停止。 */
  async setArchived(reference: string, archived: boolean) {
    const item = this.lookup(reference);
    if (archived) item.archivedAt = Date.now();
    else delete item.archivedAt;
    item.updatedAt = Date.now();
    await this.save();
    return this.itemView(item);
  }

  /** 删除台账转墓碑：路由负责删原生会话；这里清掉正文，别名继续保留。 */
  async markDeleted(reference: string, actor?: AskActor) {
    const item = this.findRecord(reference);
    if (!item) throw new Error(`询问 ${reference} 不存在`);
    if (item.deletedAt) return { item: this.itemView(item), alreadyDeleted: true };
    if (["creating", "queued", "running"].includes(item.status)) await this.cancelItem(item);
    item.deletedAt = Date.now();
    item.deletedBy = actor;
    item.updatedAt = item.deletedAt;
    item.question = "";
    item.sentMessages = [];
    delete item.result;
    delete item.response;
    delete item.error;
    delete item.deleteError;
    delete item.lastCaptureError;
    await this.save();
    return { item: this.itemView(item), alreadyDeleted: false };
  }

  async markDeleteFailed(reference: string, message: string) {
    const item = this.findRecord(reference);
    if (!item || item.deletedAt) return;
    item.deleteError = message.slice(0, 500);
    item.updatedAt = Date.now();
    await this.save();
  }

  private itemView(item: AskRecord) {
    return this.list().find((entry) => entry.id === item.id)!;
  }

  private safeMessageState(item: AskRecord) {
    if (!item.targetThreadId) return undefined;
    try { return this.options.agents.messageState(item.targetAgentId, item.targetThreadId); }
    catch { return undefined; }
  }

  /** 取消自动投递（初始询问、遗留失败回传）；显式 send 不在此列。 */
  private async cancelPendingDeliveries(item: AskRecord) {
    const cancel = async (id: string | undefined, agentId: AgentId, threadId: string) => {
      if (!id) return;
      try { await this.options.messages.cancel(id, agentId, threadId); }
      catch { /* 已送达/发送中的消息不能取消，交给后端打断收口。 */ }
    };
    if (item.targetThreadId)
      await cancel(item.deliveryId, item.targetAgentId, item.targetThreadId);
    await cancel(item.replyDeliveryId, item.sourceAgentId, item.sourceThreadId);
  }

  private async cancelItem(item: AskRecord) {
    delete item.waitingReason;
    delete item.waitingDetail;
    delete item.waitingSince;
    item.status = "cancelled";
    item.cancelledAt ??= Date.now();
    item.turnEndedAt ??= Date.now();
    item.updatedAt = Date.now();
    item.suppressFailureReply = true;
    delete item.response;
    delete item.executionCompletion;
    delete item.executionFailure;
    delete item.error;
    await this.save();
  }

  /** Bound source is resolved on the server, never from an agent-supplied wake code. */
  async sendFrom(agentId: AgentId, threadId: string, text: string, mode?: DeckDeliveryMode, requestId?: string) {
    if (this.loadError) throw new Error(this.loadError);
    const bound = this.items.filter((entry) => !entry.deletedAt &&
      entry.targetAgentId === agentId && entry.targetThreadId === threadId && entry.sourceThreadId);
    if (!bound.length) {
      if (this.items.some((entry) => entry.deletedAt &&
        entry.targetAgentId === agentId && entry.targetThreadId === threadId))
        throw new DeckRecipientError("DELETED", 410, "当前询问已删除，不能再回传");
      throw new Error("当前会话没有绑定来源，请使用 --to <agentId:threadId> 或 --to @s-… 指定目标");
    }
    // fork/重试会让同一目标挂多条询问；来源一致时投递无歧义，否则明确报错
    // 带候选，不再静默取第一条把结论投给错误的来源。
    const distinctSources = new Map<string, AskRecord>();
    for (const entry of bound) {
      const key = `${entry.sourceAgentId}:${entry.sourceThreadId}`;
      if (!distinctSources.has(key)) distinctSources.set(key, entry);
    }
    if (distinctSources.size > 1)
      throw new DeckRecipientError("AMBIGUOUS", 409,
        "当前会话绑定了多个不同来源的询问，无法确定回传目标；请用 --to <agentId:threadId> 显式指定来源",
        [...distinctSources.values()].map((entry) => ({
          agentId: entry.sourceAgentId, threadId: entry.sourceThreadId,
          alias: entry.alias, status: entry.status,
        })));
    const item = bound[0];
    const effectiveMode = mode || item.returnMode;
    if (effectiveMode === "steer") this.assertSteerSupported(item.sourceAgentId, item.sourceThreadId);
    if (effectiveMode === "interrupt") this.assertInterruptSupported(item.sourceAgentId, item.sourceThreadId);
    text = text.trim();
    if (!text || text.length > 80_000) throw new Error("消息须为 1 至 80000 字符；请精简消息并将完整内容留在会话中");
    const messages = item.sentMessages ||= [];
    let message = requestId ? messages.find((entry) => entry.id === requestId) : undefined;
    if (message && (message.text !== text || message.mode !== (mode || item.returnMode)))
      throw new Error("requestId 已用于不同内容或投递方式");
    if (!message) {
      message = { id: requestId || randomUUID(), text, mode: mode || item.returnMode, turnId: item.turnId };
      messages.push(message);
      if (item.status === "cancelled") item.status = "completed";
      // 新的显式回传意味着会话重新工作；上一轮停止意图随之失效。
      delete item.cancelRequestedAt;
      delete item.cancelMode;
      delete item.cancelledAt;
      delete item.cancelledBy;
      item.updatedAt = Date.now();
      await this.save();
    }
    if (!message.deliveryId) await this.deliverMessage(item, message);
    return { askId: item.id, alias: item.alias, target: { agentId: item.sourceAgentId, threadId: item.sourceThreadId },
      messageId: message.id, deliveryId: message.deliveryId, mode: message.mode };
  }

  /** steer 要求收件会话能把消息转向进当前回合（codex turn/steer）；不支持就明确拒绝，不静默降级。 */
  private assertSteerSupported(agentId: AgentId, threadId: string) {
    let capabilities;
    try {
      capabilities = this.options.agents.messageState(agentId, threadId).capabilities;
    } catch {
      return;
    }
    if (capabilities.messages?.busyBehavior !== "steer" ||
      !capabilities.messages?.deliveryModes?.includes("feedback"))
      throw new Error("对方会话不支持即时追加（需要 Codex 这类支持转向当前回合的会话）；空闲时用 queue 会立即发送，运行时想打断请用 interrupt");
  }

  /** interrupt 需要收件会话支持打断；不支持就拒绝，避免消息队列反复失败。 */
  private assertInterruptSupported(agentId: AgentId, threadId: string) {
    let capabilities;
    try {
      capabilities = this.options.agents.messageState(agentId, threadId).capabilities;
    } catch {
      return;
    }
    if (!capabilities.interrupt)
      throw new Error("对方会话不支持打断当前回合；请改用 queue（空闲时立即发送）或 steer（对方支持时）");
  }

  /**
   * 找到询问对应的回合。优先精确 id；OpenCode 等适配器在回合结束后会把 id
   * 换回原生 user message id，而且一次询问可能因重试产生多个原生回合。
   * 兜底按 Deck 看到的回合起止时间关联，取该区间内最后一个回合（重试后的
   * 最终答复所在回合），区间外的旧/新回合都不领取。
   */
  private findTurn(item: AskRecord, turns: any[]) {
    if (item.turnId) {
      const exact = turns.find((turn) => String(turn?.id) === item.turnId);
      if (exact) return exact;
    }
    // 旧台账没有 turnStartedAt：初始询问可用创建时间兜底；追问不猜，避免领错回合。
    const startedAt = item.turnStartedAt ??
      (!item.sentMessages?.length ? item.createdAt : undefined);
    if (!Number.isFinite(startedAt)) return undefined;
    const endedAt = item.turnEndedAt ??
      (item.executionCompletion || ["completed", "answered", "failed", "cancelled"].includes(item.status)
        ? item.updatedAt
        : undefined);
    let best: any;
    let bestAt = -Infinity;
    for (const turn of turns) {
      const at = Number(turn?.startedAt);
      if (!Number.isFinite(at)) continue;
      // 原生历史可能比 Deck 的发送回执稍晚；早于该时刻太多的回合不是本轮。
      if (at < startedAt! - 2_000) continue;
      // 已知结束时刻时，只收本轮窗口内的回合（含重试）；否则给 5 分钟上限。
      if (Number.isFinite(endedAt) ? at > endedAt! + 2_000 : at > startedAt! + 5 * 60_000) continue;
      if (at > bestAt) {
        best = turn;
        bestAt = at;
      }
    }
    return best;
  }

  private reference(item: AskRecord) {
    return item.alias ? `[查看完整会话](/s/${item.alias})` : "";
  }

  private async deliverMessage(item: AskRecord, message: NonNullable<AskRecord["sentMessages"]>[number]) {
    // 发往主会话不留注入后门：steer/interrupt 降级为 queue；但不再无限期缓冲，
    // 空闲时正常送达，运行中排队等空闲。
    const master = this.isMaster(item.sourceAgentId, item.sourceThreadId);
    const mode = master ? "queue" : message.mode;
    const delivery = await this.options.messages.enqueue(
      item.sourceAgentId, item.sourceThreadId,
      mode === "queue" ? "queue" : "feedback",
      { text: `[ask:${item.alias}] ${this.reference(item)}\n\n${message.text}` },
      // 以消息 id 幂等：同一条消息的重复投递（重启恢复、重试）只入队一次。
      { id: `ask:${item.id}:${message.id}`, forceInterrupt: mode === "interrupt" },
    );
    message.deliveryId = delivery.id;
    item.updatedAt = Date.now();
    await this.save();
  }

  private async captureResult(item: AskRecord, turn?: any) {
    if (!item.targetThreadId || !item.turnId || item.result ||
      !["completed", "answered"].includes(item.status)) return;
    const turnId = item.turnId;
    if (!turn) {
      try {
        const full: any = await this.options.agents.readThread(item.targetAgentId, item.targetThreadId, { background: true });
        turn = this.findTurn(item, full?.turns || full?.thread?.turns || []);
      } catch (error: any) {
        // 落态不吞错：来源查询能看到明确的同步失败原因，而不是把 pending 误判成任务失败。
        item.captureAttempts = (item.captureAttempts || 0) + 1;
        item.lastCaptureError = `交付同步失败（第 ${item.captureAttempts} 次）：${error?.message || error}`.slice(0, 300);
        await this.save();
        return;
      }
    }
    // 完成事件可能早于原生历史落盘；后续调度/查询继续同步，不把旧回合当成新结果。
    if (!turn || turn.status !== "completed" || !Array.isArray(turn.items) ||
      item.turnId !== turnId || !["completed", "answered"].includes(item.status)) return;
    const text = finalAnswer(turn);
    if (!text) {
      item.emptyResultTurnId = turnId;
      delete item.capturePending;
      delete item.lastCaptureError;
      try { await this.save(); }
      catch (error) {
        if (item.emptyResultTurnId === turnId) {
          delete item.emptyResultTurnId;
          item.capturePending = true;
        }
        throw error;
      }
      return;
    }
    // 结果始终记 Deck 侧的 turnId：readResult 用它判断“本回合已交付”。
    const result = { turnId, text: text.slice(0, ASK_OUTPUT_LIMIT), completedAt: Date.now(), truncated: text.length > ASK_OUTPUT_LIMIT };
    item.result = result;
    delete item.emptyResultTurnId;
    delete item.capturePending;
    delete item.lastCaptureError;
    item.captureAttempts = 0;
    try { await this.save(); }
    catch (error) {
      if (item.result === result) {
        delete item.result;
        item.captureAttempts = undefined;
        item.capturePending = true;
      }
      throw error;
    }
  }

  private async complete(item: AskRecord, turn?: any) {
    // 停止/删除意图优先：即使完成事件晚到，也不能把已取消的任务改回完成。
    if (item.cancelRequestedAt || item.deletedAt) {
      if (!item.deletedAt) await this.cancelItem(item);
      return;
    }
    // 保存结果与通知分离：正常结束仍然静默，主动消息的投递状态单独查询。
    delete item.waitingReason;
    delete item.waitingDetail;
    delete item.waitingSince;
    item.status = "completed";
    item.capturePending = true;
    item.turnEndedAt ??= Date.now();
    item.updatedAt = Date.now();
    await this.save();
    try { await this.captureResult(item, turn); } catch { /* 状态已保存；历史恢复后再同步结果。 */ }

  }

  private async fail(item: AskRecord, message: string, notify = true) {
    if (item.cancelRequestedAt || item.deletedAt) {
      if (!item.deletedAt) await this.cancelItem(item);
      return;
    }
    item.suppressFailureNotice = !notify;
    notify = notify && !item.detached && !this.options.notices;
    delete item.waitingReason;
    delete item.waitingDetail;
    delete item.waitingSince;
    item.status = "failed";
    item.turnEndedAt ??= Date.now();
    item.updatedAt = Date.now();
    item.error = message.slice(0, 500);
    item.suppressFailureReply = !notify;
    item.response = notify ? `询问失败：${item.error}` : undefined;
    await this.save();
    if (notify) await this.reply(item);

  }

  private async reply(item: AskRecord) {
    if (item.detached || item.replyDeliveryId || item.deletedAt || item.status === "cancelled") return;
    const body = `${this.reference(item)}\n\n${item.response || ""}`;
    const prompt = `[deck:notice:${item.alias}] ` + (body.length > 99_000 ? body.slice(0, 98_800) + "\n\n[内容已截断，完整回答请查看询问会话]" : body);
    const master = this.isMaster(item.sourceAgentId, item.sourceThreadId);
    const mode = master ? "queue" : item.returnMode;
    const delivery = await this.options.messages.enqueue(
      item.sourceAgentId, item.sourceThreadId,
      mode === "queue" ? "queue" : "feedback",
      { text: prompt },
      { id: `ask:${item.id}:reply:${item.turnId || "creating"}`, forceInterrupt: mode === "interrupt" },
    );
    item.replyDeliveryId = delivery.id;
    item.updatedAt = Date.now();
    await this.save();
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.options.agents.off("event", this.onEvent);
  }

  private async save() {
    const snapshot = JSON.stringify({ version: 1, readTrackingVersion: 1, items: this.items });
    const write = this.writes.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.options.file), { recursive: true });
      const temp = `${this.options.file}.${process.pid}.tmp`;
      await writeFile(temp, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.options.file);
    });
    this.writes = write;
    await write;
    this.options.onChanged?.();
  }
}
