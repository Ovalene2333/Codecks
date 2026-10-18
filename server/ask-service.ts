import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentRegistry } from "./agents/registry.js";
import type { AgentCreateThreadInput } from "./agents/types.js";
import type { AgentId, AskSession, DeckDeliveryMode, ThreadSummary } from "./types.js";
import type { MessageDeliveryQueue } from "./message-delivery.js";
import { ASK_OUTPUT_LIMIT, finalAnswer, inspectOutput, type AskResult } from "./ask-output.js";

export interface AskRecord extends AskSession {
  targetAgentId: AgentId;
  targetThreadId?: string;
  targetProviderId?: string;
  question: string;
  result?: AskResult;
  /** 旧版询问回传使用的唤醒代号；仅用于兼容旧记录，新流程不再使用。 */
  wakeCode?: string;
  createdAt: number;
  updatedAt: number;
  deliveryId?: string;
  turnId?: string;
  response?: string;
  /** 旧版回传投递 ID；只作为“已回传”标记，新流程使用 replyDeliveryId。 */
  wakeDeliveryId?: string;
  replyDeliveryId?: string;
  suppressFailureReply?: boolean;
  sentMessages?: { id: string; text: string; mode: DeckDeliveryMode; deliveryId?: string }[];
  turnSentOffset?: number;
  executionCompletion?: { turnId: string; status: string };
  executionFailure?: { turnId: string; message: string };
}

interface Options {
  file: string;
  agents: AgentRegistry;
  messages: MessageDeliveryQueue;
  onChanged?: () => void;
  timer?: boolean;
}

/** 完整对话留在原生历史；台账仅保存路由、状态与 detached 最新交付快照。 */
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
      item.updatedAt = Date.now();
      item.turnSentOffset = item.sentMessages?.length || 0;
      delete item.executionCompletion;
      delete item.executionFailure;
      delete item.response;
      delete item.replyDeliveryId;
      delete item.wakeDeliveryId;
      delete item.error;
      delete item.result;
      void this.save().catch((error) => console.error("会话回合状态保存失败:", error.message));
      return;
    }
    if (!["completed", "failed", "error", "interrupted", "cancelled"].includes(turn.status)) return;
    const item = this.items.find((item) =>
      ["queued", "running"].includes(item.status) && item.targetAgentId === (data.agentId || "codex") &&
      item.targetThreadId === data.params?.threadId && (!item.turnId || item.turnId === turn.id),
    );
    if (!item) return;
    item.turnId ||= turn.id;
    item.updatedAt = Date.now();
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
      let changed = false;
      this.items = data.items.filter((item: any) =>
        typeof item?.id === "string" && typeof item.sourceAgentId === "string" &&
        typeof item.sourceThreadId === "string" && typeof item.targetAgentId === "string" &&
        typeof item.question === "string" &&
        (item.wakeCode === undefined || typeof item.wakeCode === "string") &&
        ["queue", "steer", "interrupt"].includes(item.returnMode) &&
        ["creating", "queued", "running", "answered", "completed", "failed"].includes(item.status),
      );
      const used = new Set<string>();
      for (const item of this.items) {
        if (item.detached !== undefined && typeof item.detached !== "boolean") throw new Error("detached 模式无效");
        if (item.result !== undefined && (typeof item.result?.turnId !== "string" ||
          typeof item.result.text !== "string" || item.result.text.length > ASK_OUTPUT_LIMIT ||
          !Number.isFinite(item.result.completedAt) || typeof item.result.truncated !== "boolean"))
          throw new Error("询问交付结果格式无效");
        if (item.sentMessages !== undefined && (!Array.isArray(item.sentMessages) || item.sentMessages.some((message) =>
          !message || typeof message.id !== "string" || typeof message.text !== "string" ||
          !["queue", "steer", "interrupt"].includes(message.mode) ||
          (message.deliveryId !== undefined && typeof message.deliveryId !== "string"))))
          throw new Error("主动消息台账格式无效");
        if (item.status === "creating") {
          item.status = "failed";
          item.updatedAt = Date.now();
          item.error = "创建期间服务重启，请检查目标会话后重新发起询问";
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
        const alias = stored && !used.has(stored) ? stored : this.uniqueAlias(item.id, used);
        if (alias !== item.alias) {
          item.alias = alias;
          changed = true;
        }
        used.add(alias);
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

  list() {
    return this.items.map(({ response: _response, result, sentMessages, question: _question, ...item }) => ({
      ...item, detached: item.detached === true, resultAvailable: !!result && result.turnId === item.turnId,
      sentCount: sentMessages?.length || 0,
    }));
  }

  private lookup(reference: string) {
    if (this.loadError) throw new Error(this.loadError);
    const key = reference.replace(/^@/, "");
    const item = this.items.find((entry) => entry.alias === key || entry.id === key);
    if (!item) throw new Error(`询问 ${reference} 不存在`);
    return item;
  }

  /** 查询不投递消息、不标记已读，可重复领取；离线时也能返回已保存的交付。 */
  async readResult(reference: string) {
    const item = this.lookup(reference);
    if (item.detached && ["completed", "answered"].includes(item.status) && !item.result) {
      try { await this.captureResult(item); } catch { /* 原生历史暂不可用，保留待同步状态。 */ }
    }
    const result = item.result?.turnId === item.turnId ? item.result : undefined;
    return { item: this.list().find((entry) => entry.id === item.id)!, result: result || null,
      pending: item.detached === true && ["completed", "answered"].includes(item.status) && !result };
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
    const item = this.items.find((item) => item.targetAgentId === (thread.agentId || "codex") && item.targetThreadId === thread.id);
    if (!item) return thread;
    return { ...thread, ask: {
      id: item.id, alias: item.alias, sourceAgentId: item.sourceAgentId, sourceThreadId: item.sourceThreadId, sourceProviderId: item.sourceProviderId,
      returnMode: item.returnMode, status: item.status, error: item.error, sentCount: item.sentMessages?.length || 0,
      detached: item.detached === true, resultAvailable: !!item.result && item.result.turnId === item.turnId,
    } };
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
      id, alias: this.uniqueAlias(id, new Set(this.items.map((entry) => entry.alias).filter(Boolean) as string[])),
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
      item.status = "queued";
      item.updatedAt = Date.now();
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
        `[deck-api:create:${item.alias}] 来自发起会话的询问。`,
        "这是独立会话：你看不到发起会话的历史，需要的背景都在下面的问题里。",
        item.detached
          ? "这是 detached 任务：来源会自行领取结果，不要主动 send 常规进度或完成通知。需要来源决定的阻塞问题、或用户明确要求时，仍可显式 send；默认收件人已绑定。"
          : "用 deck-api send 主动回传；可以多次发送进度、澄清问题或结果。默认收件人已绑定为发起会话，不需要查询代号。",
        `本会话询问别名是 ${item.alias}，身份是 ${item.targetAgentId}:${item.targetThreadId}。需要主动联系来源时使用 send；自动识别失败时把该身份传给 --session，不要查询或猜测其他会话。`,
        "执行入口优先使用 ${CODEX_DECK_HOME:-$HOME/.codex-deck}/bin/deck-api；项目内也可读取 deck-api skill。没有该入口时说明失败，不要借用其他会话身份。",
        ...(item.detached ? [
          "结束时直接在本会话最终答复中交付：结论、关键依据、文件或产物位置、验证结果与未决问题。Deck 会保存最终答复供来源用 deck-api result @别名 领取；不需要另行 send。",
          "正常结束、失败或中断都不会自动向来源发消息；完整执行过程留在原生历史，来源可用 deck-api inspect 查看。",
        ] : [
          "结束前必须 send 一条最终结论（关键依据、文件或产物位置）。即使没有新结论、或不需要来源采取行动，也请 send 一条简短状态（如“已完成，无新增结论”）；不要静默结束。",
          "正常结束不会自动转发最终回复，也不会自动通知来源；来源只会看到你 send 的内容。启动或执行失败会由 Deck 自动通知。",
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
          if (item.detached && ["completed", "answered"].includes(item.status) && !item.result) {
            try { await this.captureResult(item); } catch { /* 结果同步不阻塞显式 send 的恢复。 */ }
          }
          for (const message of item.sentMessages || []) {
            if (!message.deliveryId) await this.deliverMessage(item, message);
          }
          if (item.status === "failed" && !item.suppressFailureReply && !item.response && item.error) await this.fail(item, item.error);
          if (item.response && !item.replyDeliveryId) await this.reply(item);
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
            await this.fail(item, delivery.error || "询问消息投递失败");
            continue;
          }
          if (delivery.status !== "delivered") continue;
          if (item.status === "queued") {
            item.status = "running";
            item.updatedAt = Date.now();
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
          await this.complete(item, turn);
        } catch (error: any) {
          // Offline adapters/history refreshes are retried; never repeat an accepted question.
          if (/会话不存在|已归档/.test(String(error.message))) await this.fail(item, error.message);
          else console.error(`询问 ${item.id} 等待恢复:`, error.message);
        }
      }
    } finally { this.ticking = false; }
  }

  /** Bound source is resolved on the server, never from an agent-supplied wake code. */
  async sendFrom(agentId: AgentId, threadId: string, text: string, mode?: DeckDeliveryMode, requestId?: string) {
    if (this.loadError) throw new Error(this.loadError);
    const item = this.items.find((entry) => entry.targetAgentId === agentId && entry.targetThreadId === threadId);
    if (!item) throw new Error("当前会话没有绑定来源，请使用 --to <agentId:threadId> 或 --code <代号> 指定目标");
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
      message = { id: requestId || randomUUID(), text, mode: mode || item.returnMode };
      messages.push(message);
      if (item.status === "completed") item.status = "answered";
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

  private reference(item: AskRecord) {
    return item.alias ? `[查看完整会话](/s/${item.alias})` : "";
  }

  private async deliverMessage(item: AskRecord, message: NonNullable<AskRecord["sentMessages"]>[number]) {
    const delivery = await this.options.messages.enqueue(
      item.sourceAgentId, item.sourceThreadId,
      message.mode === "queue" ? "queue" : "feedback",
      { text: `[ask:${item.alias}] ${this.reference(item)}\n\n${message.text}` },
      // 以消息 id 幂等：同一条消息的重复投递（重启恢复、重试）只入队一次。
      { id: `ask:${item.id}:${message.id}`, forceInterrupt: message.mode === "interrupt" },
    );
    message.deliveryId = delivery.id;
    item.updatedAt = Date.now();
    await this.save();
  }

  private async captureResult(item: AskRecord, turn?: any) {
    if (!item.detached || !item.targetThreadId || !item.turnId || item.result ||
      !["completed", "answered"].includes(item.status)) return;
    const turnId = item.turnId;
    if (!turn) {
      const full: any = await this.options.agents.readThread(item.targetAgentId, item.targetThreadId, { background: true });
      turn = (full?.turns || full?.thread?.turns || []).find((entry: any) => entry.id === turnId);
    }
    // 完成事件可能早于原生历史落盘；后续调度/查询继续同步，不把旧回合当成新结果。
    if (!turn || turn.id !== turnId || turn.status !== "completed" || !Array.isArray(turn.items) ||
      item.turnId !== turnId || !["completed", "answered"].includes(item.status)) return;
    const text = finalAnswer(turn);
    const result = { turnId, text: text.slice(0, ASK_OUTPUT_LIMIT), completedAt: Date.now(), truncated: text.length > ASK_OUTPUT_LIMIT };
    item.result = result;
    try { await this.save(); }
    catch (error) {
      if (item.result === result) delete item.result;
      throw error;
    }
  }

  private async complete(item: AskRecord, turn?: any) {
    // 纯双向通信：正常结束不产生任何自动通知，来源只会看到目标主动 send
    // 的内容；status 仍记录 answered/completed 供 UI 与后续 send 路由使用。
    item.status = item.sentMessages?.length ? "answered" : "completed";
    item.updatedAt = Date.now();
    await this.save();
    try { await this.captureResult(item, turn); } catch { /* 状态已保存；历史恢复后再同步结果。 */ }
  }

  private async fail(item: AskRecord, message: string, notify = true) {
    notify = notify && !item.detached;
    item.status = "failed";
    item.updatedAt = Date.now();
    item.error = message.slice(0, 500);
    item.suppressFailureReply = !notify;
    item.response = notify ? `询问失败：${item.error}` : undefined;
    await this.save();
    if (notify) await this.reply(item);
  }

  private async reply(item: AskRecord) {
    if (item.detached || item.replyDeliveryId) return;
    const body = `${this.reference(item)}\n\n${item.response || ""}`;
    const prompt = `[ask:${item.alias}] ` + (body.length > 99_000 ? body.slice(0, 98_800) + "\n\n[内容已截断，完整回答请查看询问会话]" : body);
    const delivery = await this.options.messages.enqueue(
      item.sourceAgentId, item.sourceThreadId,
      item.returnMode === "queue" ? "queue" : "feedback",
      { text: prompt },
      { id: `ask:${item.id}:reply:${item.turnId || "creating"}`, forceInterrupt: item.returnMode === "interrupt" },
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
