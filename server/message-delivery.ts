import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRegistry } from "./agents/registry.js";
import { AgentMessageError, messageBusy, type AgentMessageInput, type MessageDelivery, type MessageDeliveryMode } from "./agents/messages.js";

interface StoredMessage extends MessageDelivery {
  input: AgentMessageInput;
  originTurnId?: string;
}

interface Options {
  file: string;
  agents: AgentRegistry;
  onChanged?: () => void;
  interruptTimeoutMs?: number;
  timer?: boolean;
}

/** 用户语义：queue 等空闲再 start；feedback 原生 steer 或打断后 start。 */
export class MessageDeliveryQueue {
  private items: StoredMessage[] = [];
  private persisted = new Set<string>();
  private inflight = new Map<string, AbortController>();
  private activeTargets = new Set<string>();
  private writes = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private scheduled?: NodeJS.Timeout;
  private closed = false;
  private readonly onEvent = (event: any) => {
    if (["thread.updated", "snapshot", "agent.status"].includes(event?.type) ||
      (event?.type === "agent.event" && ["turn/completed", "turn/started"].includes(event.data?.method)))
      this.schedule();
  };

  constructor(private readonly options: Options) {}

  async load() {
    let recovered = false;
    try {
      const stored = JSON.parse(await readFile(this.options.file, "utf8"));
      if (stored.version === 1 && Array.isArray(stored.items)) {
        this.items = stored.items.filter((item: any) =>
          typeof item?.id === "string" && typeof item.agentId === "string" &&
          typeof item.threadId === "string" && ["queue", "feedback"].includes(item.mode) &&
          ["queued", "interrupting", "sending", "delivered", "failed"].includes(item.status) &&
          typeof item.input?.text === "string" && typeof item.createdAt === "number",
        );
        for (const item of this.items) {
          this.persisted.add(item.id);
          if (item.status === "sending" || item.status === "interrupting") {
            recovered = true;
            item.canRetry = item.status === "interrupting";
            item.error = item.canRetry
              ? "服务端在等待打断期间重启，消息尚未发送，可重试"
              : "服务端在发送期间重启，无法确认是否已受理，请先检查会话";
            item.status = "failed";
            item.updatedAt = Date.now();
          }
        }
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") console.error("消息队列读取失败，原文件保留:", error?.message);
    }
    if (recovered) await this.save();
    this.options.agents.on("event", this.onEvent);
    if (this.options.timer !== false) {
      this.timer = setInterval(() => void this.tick().catch((error) => console.error("消息队列调度失败:", error?.message)), 1000);
      this.timer.unref();
      this.schedule();
    }
  }

  list(): MessageDelivery[] {
    return this.items.map(({ input, originTurnId: _origin, ...item }) => ({
      ...item,
      // 受理回执可能先于 transcript 到达；最近 50 条完成记录也保留全文，
      // 前端确认聊天记录出现对应消息后才移除气泡。图片本体不进快照。
      text: input.text,
      imageCount: input.images?.length ?? 0,
    }));
  }

  async enqueue(agentId: string, threadId: string, mode: MessageDeliveryMode, input: AgentMessageInput) {
    const state = this.options.agents.messageState(agentId, threadId);
    if (!state.capabilities.messages?.deliveryModes?.includes(mode))
      throw new AgentMessageError("unsupported", "该 Agent 不支持此发送模式", 422);
    if (state.thread.archived) throw new AgentMessageError("archived", "会话已归档，请先恢复再发送");
    if (!input.text.trim() && !input.images?.length)
      throw new AgentMessageError("invalid_request", "请输入指令或图片", 400);
    if (input.expectedTurnId && state.thread.activeTurnId !== input.expectedTurnId)
      throw new AgentMessageError("turn_mismatch", "当前回合已变化，请刷新会话状态");
    const now = Date.now();
    const item: StoredMessage = {
      id: randomUUID(), agentId, threadId, mode, status: "queued",
      preview: input.text.trim().slice(0, 300) || `[${input.images?.length ?? 0} 张图片]`,
      input: { text: input.text, images: input.images },
      originTurnId: mode === "feedback" ? state.thread.activeTurnId : undefined,
      createdAt: now, updatedAt: now,
    };
    this.items.push(item);
    try { await this.save(); }
    catch (error) { this.items.splice(this.items.indexOf(item), 1); throw error; }
    this.persisted.add(item.id);
    this.options.onChanged?.();
    this.schedule();
    return this.list().find((entry) => entry.id === item.id)!;
  }

  async cancel(id: string, agentId: string, threadId: string) {
    const item = this.find(id, agentId, threadId);
    if (item.status === "sending" || item.status === "delivered")
      throw new AgentMessageError("busy", "消息已在发送或已受理，无法取消");
    this.items.splice(this.items.indexOf(item), 1);
    this.persisted.delete(id);
    this.inflight.get(id)?.abort();
    await this.changed();
  }

  async retry(id: string, agentId: string, threadId: string) {
    const item = this.find(id, agentId, threadId);
    if (item.status !== "failed" || !item.canRetry)
      throw new AgentMessageError("invalid_request", "无法确认未发送，不能自动重试，请先检查会话", 400);
    item.status = "queued";
    item.originTurnId = this.options.agents.messageState(agentId, threadId).thread.activeTurnId;
    delete item.error;
    delete item.canRetry;
    await this.changed(item);
    this.schedule();
  }

  /** 提升原消息而非重新入队；落盘前暂停调度，发送中的消息不可改模式。 */
  async feedback(id: string, agentId: string, threadId: string) {
    const item = this.find(id, agentId, threadId);
    if (item.mode === "feedback" && item.status !== "failed") {
      // 并发的重复点击也必须等首次提升落盘，不能提前回执。
      await this.writes;
      this.find(id, agentId, threadId);
      return this.list().find((entry) => entry.id === id)!;
    }
    if (item.status !== "queued")
      throw new AgentMessageError("busy", "消息已开始发送或发送失败，无法改为即时反馈");
    const state = this.options.agents.messageState(agentId, threadId);
    if (!state.capabilities.messages?.deliveryModes?.includes("feedback"))
      throw new AgentMessageError("unsupported", "该 Agent 不支持即时反馈", 422);
    if (state.thread.archived)
      throw new AgentMessageError("archived", "会话已归档，请先恢复再操作");
    const previousUpdatedAt = item.updatedAt;
    this.persisted.delete(id);
    item.mode = "feedback";
    item.originTurnId = state.thread.activeTurnId;
    try { await this.changed(item); }
    catch (error) {
      item.mode = "queue";
      item.updatedAt = previousUpdatedAt;
      delete item.originTurnId;
      if (this.items.includes(item)) this.persisted.add(id);
      throw error;
    }
    if (!this.items.includes(item))
      throw new AgentMessageError("invalid_request", "消息已取消", 404);
    this.persisted.add(id);
    this.schedule();
    return this.list().find((entry) => entry.id === id)!;
  }

  /** 每个会话一次只处理一条；即时反馈优先，普通追加保持 FIFO。 */
  async tick() {
    if (this.closed) return;
    const targets = new Map<string, StoredMessage>();
    for (const item of this.items) {
      if (item.status !== "queued" || !this.persisted.has(item.id)) continue;
      const key = JSON.stringify([item.agentId, item.threadId]);
      if (this.activeTargets.has(key)) continue;
      const previous = targets.get(key);
      if (!previous || (item.mode === "feedback" && previous.mode === "queue")) targets.set(key, item);
    }
    await Promise.all([...targets.values()].map((item) => this.deliver(item)));
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    clearTimeout(this.scheduled);
    this.options.agents.off("event", this.onEvent);
    for (const controller of this.inflight.values()) controller.abort();
  }

  private async deliver(item: StoredMessage) {
    const key = JSON.stringify([item.agentId, item.threadId]);
    this.activeTargets.add(key);
    const controller = new AbortController();
    this.inflight.set(item.id, controller);
    let release = () => {};
    let attemptedSend = false;
    try {
      // 历史还没载入的启动窗口不能把持久队列误判成「会话不存在」。
      if (!this.options.agents.messageBackendOnline(item.agentId)) return;
      const state = this.options.agents.messageState(item.agentId, item.threadId);
      if (!state.online) return;
      if (state.thread.archived) throw new AgentMessageError("archived", "会话已归档，消息未发送");
      let input: AgentMessageInput = { ...item.input, mode: "start" };
      if (!state.ready) {
        if (item.mode === "queue" || !messageBusy(state.thread) || state.thread.compacting) return;
        const target = state.thread.activeTurnId;
        if (!target) throw new AgentMessageError("no_active_turn", "无法确定当前回合，消息未发送");
        if (item.originTurnId && target !== item.originTurnId)
          throw new AgentMessageError("turn_mismatch", "当前回合已变化，未打断新的任务");
        if (state.capabilities.messages?.busyBehavior === "steer") {
          input = { ...item.input, mode: "append", expectedTurnId: target };
        } else {
          release = this.options.agents.holdMessageQueue(item.agentId, item.threadId);
          item.status = "interrupting";
          await this.changed(item);
          if (!this.items.includes(item) || controller.signal.aborted) return;
          await this.options.agents.interruptMessage(item.agentId, item.threadId, target);
          await this.waitForReady(item, target, controller.signal);
        }
      }
      if (!this.items.includes(item) || controller.signal.aborted) return;
      item.status = "sending";
      item.sentAt = Date.now();
      await this.changed(item);
      if (!this.items.includes(item) || controller.signal.aborted) return;
      attemptedSend = true;
      const receipt = await this.options.agents.sendMessage(item.agentId, item.threadId, input);
      item.status = "delivered";
      item.disposition = receipt.disposition;
      item.turnId = receipt.turnId;
      delete item.error;
      delete item.canRetry;
      await this.changed(item);
    } catch (error: any) {
      if (!this.items.includes(item) || this.closed) return;
      const knownRejection = error instanceof AgentMessageError;
      if (knownRejection && ["busy", "no_active_turn", "turn_mismatch"].includes(error.code) &&
          (item.mode === "queue" || (attemptedSend && item.mode === "feedback" && error.code === "no_active_turn"))) {
        item.status = "queued";
        await this.changed(item);
      } else {
        item.status = "failed";
        item.error = String(error?.message || error).slice(0, 500);
        item.canRetry = !attemptedSend || knownRejection;
        await this.changed(item);
      }
    } finally {
      release();
      this.inflight.delete(item.id);
      this.activeTargets.delete(key);
    }
  }

  private waitForReady(item: StoredMessage, target: string, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      const started = Date.now();
      let timer: NodeJS.Timeout;
      const finish = (error?: Error) => {
        clearInterval(timer);
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      };
      const abort = () => finish(new Error("消息发送已取消"));
      const check = () => {
        try {
          const state = this.options.agents.messageState(item.agentId, item.threadId);
          if (state.thread.activeTurnId && state.thread.activeTurnId !== target)
            return finish(new AgentMessageError("turn_mismatch", "其他任务已开始，消息尚未发送"));
          if (state.online && state.ready) return finish();
          if (Date.now() - started >= (this.options.interruptTimeoutMs ?? 30_000))
            finish(new Error("未能确认当前回合结束，消息尚未发送，可重试"));
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      };
      timer = setInterval(check, 100);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort(); else check();
    });
  }

  private find(id: string, agentId: string, threadId: string) {
    const item = this.items.find((entry) => entry.id === id && entry.agentId === agentId && entry.threadId === threadId);
    if (!item) throw new AgentMessageError("invalid_request", "消息记录不存在", 404);
    return item;
  }

  private schedule() {
    if (this.closed || this.options.timer === false || this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = undefined;
      void this.tick().catch((error) => console.error("消息队列调度失败:", error?.message));
    }, 0);
    this.scheduled.unref();
  }

  private async changed(changedItem?: StoredMessage) {
    if (changedItem) changedItem.updatedAt = Date.now();
    const completed = this.items.filter((item) => item.status === "delivered");
    for (const item of completed.slice(0, Math.max(0, completed.length - 50))) {
      this.items.splice(this.items.indexOf(item), 1);
      this.persisted.delete(item.id);
    }
    await this.save();
    this.options.onChanged?.();
  }

  private save() {
    const snapshot = JSON.stringify({ version: 1, items: this.items });
    const pending = this.writes.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.options.file), { recursive: true });
      const temporary = `${this.options.file}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.options.file);
    });
    this.writes = pending;
    return pending;
  }
}
