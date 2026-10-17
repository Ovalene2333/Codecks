import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRegistry } from "./agents/registry.js";
import type { AgentCreateThreadInput } from "./agents/types.js";
import type { AgentId, AskSession, ThreadSummary } from "./types.js";
import type { MessageDeliveryQueue } from "./message-delivery.js";
import type { WakeOutbox } from "./wake-outbox.js";

export interface AskRecord extends AskSession {
  targetAgentId: AgentId;
  targetThreadId?: string;
  targetProviderId?: string;
  question: string;
  wakeCode: string;
  createdAt: number;
  updatedAt: number;
  deliveryId?: string;
  turnId?: string;
  response?: string;
  wakeDeliveryId?: string;
  suppressFailureReply?: boolean;
  sentMessages?: { id: string; text: string; mode: "queue" | "interrupt"; deliveryId?: string }[];
  turnSentOffset?: number;
  executionCompletion?: { turnId: string; status: string };
  executionFailure?: { turnId: string; message: string };
}

interface Options {
  file: string;
  agents: AgentRegistry;
  messages: MessageDeliveryQueue;
  wake: WakeOutbox;
  onChanged?: () => void;
  timer?: boolean;
}

/** Conversation text stays in the native agent history; this is only its routing ledger. */
export class AskService {
  private items: AskRecord[] = [];
  private writes = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private closed = false;
  private loadError?: string;

  private readonly onEvent = (event: any) => {
    if (!["agent.event", "codex.event"].includes(event?.type) || !["turn/started", "turn/completed"].includes(event.data?.method)) return;
    const data = event.data;
    const turn = data.params?.turn;
    if (!turn?.id) return;
    if (data.method === "turn/started") {
      const item = this.items.find((entry) => entry.targetAgentId === (data.agentId || "codex") && entry.targetThreadId === data.params?.threadId);
      if (!item || item.turnId === turn.id) return;
      item.turnId = turn.id;
      item.status = "running";
      item.turnSentOffset = item.sentMessages?.length || 0;
      delete item.executionCompletion;
      delete item.executionFailure;
      delete item.response;
      delete item.wakeDeliveryId;
      delete item.error;
      void this.save().catch((error) => console.error("会话回合状态保存失败:", error.message));
      return;
    }
    if (!["completed", "failed", "error", "interrupted", "cancelled"].includes(turn.status)) return;
    const item = this.items.find((item) =>
      ["queued", "running"].includes(item.status) && item.targetAgentId === (data.agentId || "codex") &&
      item.targetThreadId === data.params?.threadId && (!item.turnId || item.turnId === turn.id),
    );
    if (!item) return;
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
      this.items = data.items.filter((item: any) =>
        typeof item?.id === "string" && typeof item.sourceAgentId === "string" &&
        typeof item.sourceThreadId === "string" && typeof item.targetAgentId === "string" &&
        typeof item.question === "string" && typeof item.wakeCode === "string" &&
        ["queue", "interrupt"].includes(item.returnMode) &&
        ["creating", "queued", "running", "answered", "completed", "failed"].includes(item.status),
      );
      for (const item of this.items) {
        if (item.sentMessages !== undefined && (!Array.isArray(item.sentMessages) || item.sentMessages.some((message) =>
          !message || typeof message.id !== "string" || typeof message.text !== "string" ||
          !["queue", "interrupt"].includes(message.mode) ||
          (message.deliveryId !== undefined && typeof message.deliveryId !== "string"))))
          throw new Error("主动消息台账格式无效");
        if (item.status === "creating") {
          item.status = "failed";
          item.error = "创建期间服务重启，请检查目标会话后重新发起询问";
        }
      }
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

  list() {
    return this.items.map(({ response: _response, sentMessages, ...item }) => ({ ...item, sentCount: sentMessages?.length || 0 }));
  }

  decorate(thread: ThreadSummary): ThreadSummary {
    const item = this.items.find((item) => item.targetAgentId === (thread.agentId || "codex") && item.targetThreadId === thread.id);
    if (!item) return thread;
    return { ...thread, ask: {
      id: item.id, sourceAgentId: item.sourceAgentId, sourceThreadId: item.sourceThreadId, sourceProviderId: item.sourceProviderId,
      returnMode: item.returnMode, status: item.status, error: item.error, sentCount: item.sentMessages?.length || 0,
    } };
  }

  async create(input: {
    sourceAgentId: AgentId; sourceThreadId: string; targetAgentId: AgentId;
    question: string; wakeCode: string; returnMode: "queue" | "interrupt";
    settings: AgentCreateThreadInput;
  }) {
    if (this.loadError) throw new Error(this.loadError);
    const item: AskRecord = {
      id: randomUUID(), sourceAgentId: input.sourceAgentId, sourceThreadId: input.sourceThreadId,
      sourceProviderId: this.options.agents.messageState(input.sourceAgentId, input.sourceThreadId).thread.providerId,
      targetAgentId: input.targetAgentId, question: input.question, wakeCode: input.wakeCode,
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
      item.status = "queued";
      await this.save();
      await this.start(item);
      return { item: this.list().find((entry) => entry.id === item.id)!, thread: this.decorate(thread) };
    } catch (error: any) {
      await this.fail(item, String(error.message || error), false);
      throw new Error(`询问 ${item.id} 创建或发送失败：${item.error}`);
    }
  }

  private async start(item: AskRecord) {
    const delivery = await this.options.messages.enqueue(item.targetAgentId, item.targetThreadId!, "queue", {
      text: [
        `[deck-api:create:${item.id}] 来自 ${item.sourceAgentId}:${item.sourceThreadId} 的询问。`,
        "由你决定何时以及回传什么：使用 deck-api send -- '需要告知发起方的内容' 主动发送（可多次发送进度、澄清问题或结果）。默认目标已绑定为发起会话，无需查询代号。",
        "结束前请主动 send 有用的结论、关键依据和必要文件位置；完整过程留在本会话。最终回复不会自动转发，正常结束也不会有任何自动通知——来源只会看到你 send 的内容。不要为总结再调用其他模型。",
        "执行入口优先使用 ${CODEX_DECK_HOME:-$HOME/.codex-deck}/bin/deck-api；项目内也可读取 deck-api skill。没有该入口时说明失败，不要猜测来源或借用其他会话。",
        `本会话身份为 ${item.targetAgentId}:${item.targetThreadId}；自动识别有歧义时，将这个已知值作为 send 的 --session 参数（发送方身份），不要查询或猜测其他会话。`,
        "这是独立询问会话；只使用本问题提供的上下文，不假设能看到发起会话的历史。",
        "", item.question,
      ].join("\n"),
    }, { id: `ask:${item.id}` });
    item.deliveryId = delivery.id;
    await this.save();
  }

  async tick() {
    if (this.ticking || this.closed || this.loadError) return;
    this.ticking = true;
    try {
      for (const item of this.items) {
        try {
          for (const message of item.sentMessages || []) {
            if (!message.deliveryId) await this.deliverMessage(item, message);
          }
          if (item.status === "failed" && !item.suppressFailureReply && !item.response && item.error) await this.fail(item, item.error);
          if (item.response && !item.wakeDeliveryId) await this.reply(item);
          if (!["queued", "running"].includes(item.status)) continue;
          if (item.executionFailure) { await this.fail(item, item.executionFailure.message); continue; }
          if (item.executionCompletion?.status === "completed") { await this.complete(item); continue; }
          const descriptor = this.options.agents.list().find((agent) => agent.id === item.targetAgentId);
          if (descriptor?.enabled === false) { await this.fail(item, "目标 Agent 已停用，询问无法继续", false); continue; }
          if (!descriptor?.online && descriptor?.error) { await this.fail(item, descriptor.error); continue; }
          if (!item.deliveryId) await this.start(item);
          const delivery = this.options.messages.list().find((entry) => entry.id === item.deliveryId);
          if (!delivery) {
            await this.fail(item, "询问消息已被取消或投递记录不存在");
            continue;
          }
          if (delivery.status === "failed") {
            item.status = "failed";
            item.error = delivery.error || "询问消息投递失败";
            item.response = `询问失败：${item.error}`;
            await this.save();
            await this.reply(item);
            continue;
          }
          if (delivery.status !== "delivered") continue;
          if (item.status === "queued") {
            item.status = "running";
            item.turnId = delivery.turnId;
            await this.save();
          }
          const state = this.options.agents.messageState(item.targetAgentId, item.targetThreadId!);
          if (state.thread.status === "error") { await this.fail(item, state.thread.lastError || "目标 Agent 执行失败，未生成回答"); continue; }
          if (!this.options.agents.messageBackendOnline(item.targetAgentId)) continue;
          if (state.thread.archived) { await this.fail(item, "询问会话已归档"); continue; }
          if (!state.ready) continue;
          const full: any = await this.options.agents.readThread(item.targetAgentId, item.targetThreadId!, { background: true });
          const turns: any[] = full?.turns || full?.thread?.turns || [];
          const turn = item.turnId ? turns.find((turn) => turn.id === item.turnId) : turns[0];
          if (!turn || ["inProgress", "running", "pending"].includes(turn.status)) continue;
          const failed = ["failed", "error", "interrupted", "cancelled"].includes(turn.status);
          if (failed) { await this.fail(item, state.thread.lastError || `询问未正常完成（${turn.status}）`); continue; }
          await this.complete(item);
        } catch (error: any) {
          // Offline adapters/history refreshes are retried; never repeat an accepted question.
          if (/会话不存在|已归档/.test(String(error.message))) await this.fail(item, error.message);
          else console.error(`询问 ${item.id} 等待恢复:`, error.message);
        }
      }
    } finally { this.ticking = false; }
  }

  /** Bound source is resolved on the server, never from an agent-supplied wake code. */
  async sendFrom(agentId: AgentId, threadId: string, text: string, mode?: "queue" | "interrupt", requestId?: string) {
    if (this.loadError) throw new Error(this.loadError);
    const item = this.items.find((entry) => entry.targetAgentId === agentId && entry.targetThreadId === threadId);
    if (!item) throw new Error("当前会话没有绑定来源，请使用 --to <agentId:threadId> 或 --code <代号> 指定目标");
    text = text.trim();
    if (!text || text.length > 80_000) throw new Error("消息须为 1 至 80000 字符；请精简消息并将完整内容留在会话中");
    const messages = item.sentMessages ||= [];
    let message = requestId ? messages.find((entry) => entry.id === requestId) : undefined;
    if (message && (message.text !== text || message.mode !== (mode || item.returnMode)))
      throw new Error("requestId 已用于不同内容或投递方式");
    if (!message) {
      message = { id: requestId || randomUUID(), text, mode: mode || item.returnMode };
      messages.push(message);
      if (item.status === "completed") item.status = "answered";
      await this.save();
    }
    if (!message.deliveryId) await this.deliverMessage(item, message);
    return { askId: item.id, target: { agentId: item.sourceAgentId, threadId: item.sourceThreadId },
      messageId: message.id, deliveryId: message.deliveryId, mode: message.mode };
  }

  private reference(item: AskRecord) {
    const key = `${item.targetAgentId}:${item.targetProviderId || ""}:${item.targetThreadId}`;
    return `[查看完整会话](/session/${encodeURIComponent(key)})`;
  }

  private async deliverMessage(item: AskRecord, message: NonNullable<AskRecord["sentMessages"]>[number]) {
    const delivery = await this.options.wake.enqueue({
      code: item.wakeCode, agentId: item.sourceAgentId, threadId: item.sourceThreadId, mode: message.mode,
      // 以消息 id 幂等：同一条消息的重复投递（重启恢复、重试）只入队一次。
      dedupeKey: message.id,
      prompt: `[wake:${item.wakeCode}] [ask:${item.id}] [message:${message.id}] ${item.targetAgentId}:${item.targetThreadId}\n${this.reference(item)}\n\n${message.text}`,
    });
    message.deliveryId = delivery.id;
    await this.save();
  }

  private async complete(item: AskRecord) {
    // 纯双向通信：正常结束不产生任何自动通知，来源只会看到目标主动 send
    // 的内容；status 仍记录 answered/completed 供 UI 与后续 send 路由使用。
    const sentThisTurn = (item.sentMessages?.length || 0) > (item.turnSentOffset || 0);
    item.status = sentThisTurn ? "answered" : "completed";
    await this.save();
  }

  private async fail(item: AskRecord, message: string, notify = true) {
    item.status = "failed";
    item.error = message.slice(0, 500);
    item.suppressFailureReply = !notify;
    item.response = notify ? `询问失败：${item.error}` : undefined;
    await this.save();
    if (notify) await this.reply(item);
  }

  private async reply(item: AskRecord) {
    const prefix = `[wake:${item.wakeCode}] [ask:${item.id}] [turn:${item.turnId || "creating"}] ${item.targetAgentId}:${item.targetThreadId || "unknown"}\n`;
    const body = `${this.reference(item)}\n\n${item.response}`;
    const prompt = prefix + (body.length > 99_000 ? body.slice(0, 98_800) + "\n\n[内容已截断，完整回答请查看询问会话]" : body);
    const delivery = await this.options.wake.enqueue({
      code: item.wakeCode, agentId: item.sourceAgentId, threadId: item.sourceThreadId,
      mode: item.returnMode, prompt,
    });
    item.wakeDeliveryId = delivery.id;
    await this.save();
  }

  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.options.agents.off("event", this.onEvent);
  }

  private async save() {
    const snapshot = JSON.stringify({ version: 1, items: this.items });
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
