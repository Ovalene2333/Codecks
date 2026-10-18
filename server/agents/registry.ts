import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { AgentMessageError, assertMessageInput, messageBusy, type AgentMessageInput, type AgentMessageReceipt } from "./messages.js";
import type {
  AgentAdapter,
  AgentApproval,
  AgentCommand,
  AgentCreateThreadInput,
  AgentDescriptor,
  AgentId,
  AgentSnapshot,
} from "./types.js";
import type {
  ActiveTask,
  ApprovalKind,
  ThreadSummary,
  TurnImage,
} from "../types.js";
import type { AgentSkill } from "./types.js";
import { activeTask } from "../tasks.js";

/** 会话已被本进程接管或正有活动；只有未接管的空闲历史才可能被当作重复项隐藏。 */
function engaged(thread: ThreadSummary) {
  return thread.controlMode === "managed" || thread.status !== "idle";
}

const TASK_SNAPSHOT_TTL_MS = 1_500;
const SKILL_CACHE_TTL_MS = 30_000;

/** 主 agent 能正常提供会话：已启用，已上线或正在启动，且历史读取没有失败。 */
function usable(agent?: AgentDescriptor) {
  return Boolean(
    agent?.available &&
    agent.enabled !== false &&
    (agent.starting || (agent.online && agent.historyStatus !== "error")),
  );
}

/** 一个 agent 的加载策略，由组装层（index.ts）在注册时给出。 */
export interface AgentPolicy {
  /** 能否在设置里停用；缺省 true（Codex 是核心，不可停用）。 */
  toggleable?: boolean;
  /** 用户没有显式选择时是否加载；缺省 true。 */
  defaultEnabled?: boolean;
  /** defaultEnabled 为 false 时的原因，如「未检测到 kimi 命令」。 */
  defaultNote?: string;
}

export interface AgentRegistration extends AgentPolicy {
  /** 当前是否加载；缺省取 defaultEnabled。 */
  enabled?: boolean;
}

interface AgentState {
  enabled: boolean;
  toggleable: boolean;
  defaultEnabled: boolean;
  defaultNote?: string;
}

export interface AgentReloadResult {
  id: AgentId;
  /** 是否真的执行了重载：有会话在运行且没有 force 时为 false。 */
  reloaded: boolean;
  /** 发现的运行中/待审批会话数（force 时即被中断的数量）。 */
  busyCount: number;
  /** 实际落地方式：OpenCode 的重载可能升级成进程重启。 */
  mode?: "instances" | "process";
  error?: string;
}

export interface AgentToggleResult {
  /** false 表示因为有会话在运行而没有执行（需要 force）。 */
  applied: boolean;
  changed: boolean;
  busyCount: number;
}

/**
 * 待命的备选 agent。备选 agent（`AgentDescriptor.fallbackFor`）与主 agent 共用
 * 同一份会话存储，同一批会话会在两边各出现一次；主 agent 可用时它待命，
 * 不再展示自己的历史会话，主 agent 不可用时才完整顶上。
 */
function standbyIds(descriptors: AgentDescriptor[]) {
  const byId = new Map(descriptors.map((agent) => [agent.id, agent]));
  return new Set(
    descriptors
      .filter(
        (agent) =>
          agent.fallbackFor &&
          agent.fallbackFor !== agent.id &&
          usable(byId.get(agent.fallbackFor)),
      )
      .map((agent) => agent.id),
  );
}

/**
 * 待命备选 agent 要隐藏的会话：
 * - 自己未接管的会话不展示：不是主 agent 会话的重复，就是没有内容的空壳；
 * - 自己已接管（managed 或有活动）的会话保留，主 agent 里同 id 且未接管的副本让位。
 */
function hiddenFallbackThreads(
  entries: { descriptor: AgentDescriptor; snapshot: AgentSnapshot }[],
) {
  const hidden = new Set<ThreadSummary>();
  const byId = new Map(entries.map((entry) => [entry.descriptor.id, entry]));
  const all = (entry: (typeof entries)[number]) => [
    ...(entry.snapshot.threads || []),
    ...(entry.snapshot.archivedThreads || []),
  ];
  for (const entry of entries) {
    const primary = entry.descriptor.standby
      ? byId.get(entry.descriptor.fallbackFor ?? "")
      : undefined;
    if (!primary) continue;
    const claimed = new Set<string>();
    for (const thread of all(entry)) {
      if (engaged(thread)) claimed.add(thread.id);
      else hidden.add(thread);
    }
    for (const thread of all(primary))
      if (claimed.has(thread.id) && !engaged(thread)) hidden.add(thread);
  }
  return hidden;
}

export class AgentRegistry extends EventEmitter {
  private foregroundHistory = 0;
  private historyQuietUntil = 0;

  historyInteractionActive() {
    return this.foregroundHistory > 0 || Date.now() < this.historyQuietUntil;
  }

  private async interact<T>(action: () => Promise<T>) {
    this.foregroundHistory++;
    try { return await action(); }
    finally {
      this.foregroundHistory--;
      this.historyQuietUntil = Date.now() + 1_500;
    }
  }

  private adapters = new Map<AgentId, AgentAdapter>();
  private states = new Map<AgentId, AgentState>();
  private forwarders = new Map<AgentId, (event: any) => void>();
  private locks = new Map<AgentId, Promise<unknown>>();
  private messageLocks = new Map<string, Promise<unknown>>();
  /** 开发测试 API 注入的假审批：只在内存里，绝不进入任何 adapter。 */
  private devApprovals = new Map<string, AgentApproval>();
  private taskSnapshot?: { at: number; tasks: ActiveTask[] };
  private taskRefresh?: Promise<ActiveTask[]>;
  private skillCache = new Map<
    string,
    { at: number; value: { skills: AgentSkill[]; errors?: unknown[] } }
  >();
  private skillLoading = new Map<
    string,
    Promise<{ skills: AgentSkill[]; errors?: unknown[] }>
  >();

  constructor(adapters: AgentAdapter[] = []) {
    super();
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: AgentAdapter, options: AgentRegistration = {}) {
    if (this.adapters.has(adapter.id))
      throw new Error(`Agent ${adapter.id} 已注册`);
    this.adapters.set(adapter.id, adapter);
    this.configure(adapter.id, options);
    const listener = (event: any) => {
      if (!this.suppressed(adapter, event)) this.emit("event", event);
    };
    this.forwarders.set(adapter.id, listener);
    adapter.on("event", listener);
  }

  /** 更新加载策略/当前启用状态，只改状态，不启停后端进程。 */
  configure(id: AgentId, options: AgentRegistration) {
    this.get(id);
    const state = this.states.get(id);
    const defaultEnabled =
      options.defaultEnabled ?? state?.defaultEnabled ?? true;
    this.states.set(id, {
      toggleable: options.toggleable ?? state?.toggleable ?? true,
      defaultEnabled,
      defaultNote:
        "defaultNote" in options ? options.defaultNote : state?.defaultNote,
      enabled: options.enabled ?? state?.enabled ?? defaultEnabled,
    });
  }

  /** 摘掉一个 agent：先停后端，再解除事件转发。 */
  async unregister(id: AgentId) {
    const adapter = this.get(id);
    await this.serialized(id, async () => {
      adapter.restart();
      const listener = this.forwarders.get(id);
      if (listener) adapter.off("event", listener);
      this.forwarders.delete(id);
      this.adapters.delete(id);
      this.states.delete(id);
    });
    this.announce();
  }

  isEnabled(id: AgentId) {
    return this.states.get(id)?.enabled !== false;
  }

  /** 无显式选择时该 agent 是否加载（设置页据此判断要不要清除显式选择）。 */
  defaultEnabled(id: AgentId) {
    return this.states.get(id)?.defaultEnabled !== false;
  }

  /**
   * 不该到达客户端的事件：
   * - 已停用 agent 停机过程中的残余事件；
   * - 已被快照过滤掉的备选会话，不能靠 thread.updated 增量重新冒出来。
   */
  private suppressed(adapter: AgentAdapter, event: any) {
    if (!this.isEnabled(adapter.id)) return true;
    if (event?.type !== "thread.updated") return false;
    const thread = event.data as ThreadSummary | undefined;
    // 有活动的会话（流式事件的绝大多数）先在 engaged 处短路，不必算描述符。
    return Boolean(
      thread && !engaged(thread) && standbyIds(this.list()).has(adapter.id),
    );
  }

  get(id: AgentId) {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Agent ${id} 不存在`);
    return adapter;
  }

  private descriptors(): AgentDescriptor[] {
    return [...this.adapters.values()].map((adapter) => {
      const raw = adapter.descriptor();
      if (raw.capabilities.messages && adapter.sendMessage) {
        const deliveryModes: ("queue" | "feedback")[] = ["queue"];
        if (raw.capabilities.messages.busyBehavior === "steer" ||
          (raw.capabilities.interrupt && adapter.interrupt)) deliveryModes.push("feedback");
        raw.capabilities = {
          ...raw.capabilities,
          messages: { ...raw.capabilities.messages, deliveryModes },
        };
      }
      const state = this.states.get(adapter.id);
      if (!state) return raw;
      if (state.enabled)
        return { ...raw, enabled: true, toggleable: state.toggleable };
      return {
        ...raw,
        enabled: false,
        toggleable: state.toggleable,
        disabledReason: state.defaultEnabled ? "user" : "default",
        defaultNote: state.defaultEnabled ? undefined : state.defaultNote,
        // 停用的 agent 不再报告运行状态，监控台不能把它当成故障。
        online: false,
        starting: false,
        error: undefined,
        historyStatus: undefined,
        historyError: undefined,
      };
    });
  }

  /**
   * 描述符列表。registry 在这里补上加载状态（`enabled`/`toggleable`），
   * 待命的备选 agent 带 `standby: true`（服务端已隐藏其历史会话）。
   */
  list(): AgentDescriptor[] {
    const descriptors = this.descriptors();
    const standby = standbyIds(descriptors);
    return descriptors.map((agent) =>
      standby.has(agent.id) ? { ...agent, standby: true } : agent,
    );
  }

  private entries() {
    const agents = this.list();
    return [...this.adapters.values()].map((adapter, index) => ({
      adapter,
      descriptor: agents[index],
      snapshot: adapter.snapshot(),
    }));
  }

  snapshot(primaryId: AgentId = "codex") {
    const entries = this.entries();
    const hidden = hiddenFallbackThreads(entries);
    const live = entries.filter((entry) => entry.descriptor.enabled !== false);
    const shown = (threads: ThreadSummary[] = []) =>
      threads.filter((thread) => !hidden.has(thread));
    const primary = this.adapters.has(primaryId)
      ? this.get(primaryId).snapshot()
      : ({} as AgentSnapshot);
    return {
      ...primary,
      agents: entries.map((entry) => entry.descriptor),
      agentProfiles: live.flatMap(
        (entry) => entry.adapter.publicProfiles?.() || [],
      ),
      threads: live.flatMap((entry) => shown(entry.snapshot.threads)),
      archivedThreads: live.flatMap((entry) =>
        shown(entry.snapshot.archivedThreads),
      ),
      approvals: [
        ...live.flatMap((entry) => entry.snapshot.approvals || []),
        ...this.devApprovals.values(),
      ],
    };
  }

  /**
   * 落盘缓存用的会话摘要：与 snapshot 一样不含被备选让位的重复项，但保留
   * 已停用 agent 的会话——没有历史列举能力的 agent 只能靠这份缓存找回
   * 会话，停用期间不能把它清掉。
   */
  cacheSnapshot() {
    const entries = this.entries();
    const hidden = hiddenFallbackThreads(entries);
    const shown = (threads: ThreadSummary[] = []) =>
      threads.filter((thread) => !hidden.has(thread));
    return {
      threads: entries.flatMap((entry) => shown(entry.snapshot.threads)),
      archivedThreads: entries.flatMap((entry) =>
        shown(entry.snapshot.archivedThreads),
      ),
    };
  }

  private enabledAdapters() {
    return [...this.adapters.values()].filter((adapter) =>
      this.isEnabled(adapter.id),
    );
  }

  /** 让所有客户端立刻看到 registry 自己造成的状态变化（启停/重载）。 */
  private announce() {
    this.emit("event", { type: "snapshot", data: this.snapshot() });
  }

  /** 同一个 agent 的启停/重载串行执行，避免连点造成 stop/start 交叠。 */
  private serialized<T>(id: AgentId, task: () => Promise<T>): Promise<T> {
    const run = (this.locks.get(id) ?? Promise.resolve())
      .catch(() => undefined)
      .then(task);
    const tail = run.catch(() => undefined);
    this.locks.set(id, tail);
    void tail.then(() => {
      if (this.locks.get(id) === tail) this.locks.delete(id);
    });
    return run;
  }

  private nameOf(id: AgentId) {
    return this.get(id).descriptor().name || id;
  }

  /**
   * 启用/停用一个 agent。停用要停掉后端进程，若它有会话在运行或等待审批，
   * 没有 force 时不执行、返回 `applied: false` 让调用方确认。
   */
  async setEnabled(
    id: AgentId,
    enabled: boolean,
    options: { force?: boolean } = {},
  ): Promise<AgentToggleResult> {
    const adapter = this.get(id);
    if (this.states.get(id)?.toggleable === false)
      throw new Error(`${this.nameOf(id)} 是核心 Agent，不能停用`);
    return this.serialized(id, async () => {
      const state = this.states.get(id);
      if (!state) throw new Error(`Agent ${id} 不存在`);
      if (state.enabled === enabled)
        return { applied: true, changed: false, busyCount: 0 };
      if (!enabled) {
        const busy = adapter.busyThreads();
        if (busy.length && !options.force)
          return { applied: false, changed: false, busyCount: busy.length };
        // 先标记停用再停机：停机过程中的残余事件会被 suppressed 丢掉。
        state.enabled = false;
        adapter.restart();
        this.announce();
        return { applied: true, changed: true, busyCount: busy.length };
      }
      state.enabled = true;
      this.announce();
      try {
        await adapter.startAll();
      } catch {
        // 启动失败是 agent 自己的状态：原因体现在描述符的 error 上，
        // 不能让「启用」这个操作本身失败。
      }
      this.announce();
      return { applied: true, changed: true, busyCount: 0 };
    });
  }

  /**
   * 重载一个 agent：重新读取它的配置与会话，不重启 Deck。有会话在运行
   * 或等待审批时不执行（除非 force），避免打断正在进行的任务。
   */
  async reload(
    id: AgentId,
    options: { force?: boolean; restart?: boolean } = {},
  ): Promise<AgentReloadResult> {
    const adapter = this.get(id);
    return this.serialized(id, async () => {
      if (!this.isEnabled(id))
        throw new Error(`${this.nameOf(id)} 未启用，请先在设置中启用`);
      const busy = adapter.busyThreads();
      if (busy.length && !options.force)
        return { id, reloaded: false, busyCount: busy.length };
      try {
        let mode: AgentReloadResult["mode"];
        if (!options.restart && adapter.reload) {
          const light = await adapter.reload();
          mode = light === "instances" || light === "process" ? light : undefined;
        } else {
          adapter.restart();
          await adapter.startAll();
          mode = "process";
        }
        return { id, reloaded: true, mode, busyCount: busy.length };
      } catch (error: any) {
        return {
          id,
          reloaded: false,
          busyCount: busy.length,
          error: String(error?.message || error),
        };
      } finally {
        this.announce();
      }
    });
  }

  /** 原子切换某个 Agent 的可执行文件；失败时恢复原选择和原后端。 */
  async switchExecutable(
    id: AgentId,
    apply: () => Promise<void>,
    rollback: () => Promise<void>,
  ): Promise<AgentReloadResult> {
    const adapter = this.get(id);
    return this.serialized(id, async () => {
      if (!this.isEnabled(id))
        throw new Error(`${this.nameOf(id)} 未启用，请先在设置中启用`);
      const busy = adapter.busyThreads();
      if (busy.length) return { id, reloaded: false, busyCount: busy.length };
      let changed = false;
      try {
        await apply();
        changed = true;
        adapter.restart();
        await adapter.startAll();
        return { id, reloaded: true, busyCount: 0 };
      } catch (error: any) {
        if (changed) {
          try {
            await rollback();
            adapter.restart();
            await adapter.startAll();
          } catch (rollbackError: any) {
            return {
              id, reloaded: false, busyCount: 0,
              error: `切换失败：${error?.message || error}；恢复旧后端失败：${rollbackError?.message || rollbackError}`,
            };
          }
        }
        return { id, reloaded: false, busyCount: 0, error: error?.message || String(error) };
      }
    });
  }

  /**
   * 重载全部：已启用的逐个重载；已停用的确保是停着的（默认策略变化后可能
   * 刚被关掉）。有会话在运行的 agent 会被跳过，结果里带 busyCount。
   */
  async reloadAll(
    options: { force?: boolean } = {},
  ): Promise<AgentReloadResult[]> {
    const results = await Promise.all(
      [...this.adapters.keys()].map(async (id) => {
        if (this.isEnabled(id)) return this.reload(id, options);
        await this.serialized(id, async () => this.adapters.get(id)?.restart());
        return undefined;
      }),
    );
    return results.filter((item): item is AgentReloadResult => Boolean(item));
  }

  async startAll() {
    const results = await Promise.allSettled(
      this.enabledAdapters().map((adapter) => adapter.startAll()),
    );
    if (
      results.length &&
      results.every((result) => result.status === "rejected")
    )
      throw new AggregateError(
        results.map((result) =>
          result.status === "rejected" ? result.reason : undefined,
        ),
        "所有 Agent 均启动失败",
      );
  }

  async refreshAll() {
    const results = await Promise.allSettled(
      this.enabledAdapters().map((adapter) => adapter.refreshAll()),
    );
    if (
      results.length &&
      results.every((result) => result.status === "rejected")
    )
      throw new AggregateError(
        results.map((result) =>
          result.status === "rejected" ? result.reason : undefined,
        ),
        "所有 Agent 均刷新失败",
      );
  }

  async repairHistory(id: AgentId) {
    const adapter = this.operation(id, "repairHistory");
    await adapter.repairHistory!();
  }

  profiles(id: AgentId) {
    const adapter = this.get(id);
    if (!this.isEnabled(id)) return [];
    return adapter.publicProfiles?.() || [];
  }

  async models(id: AgentId, providerId?: string, directory?: string) {
    const adapter = this.operation(id, "listModels");
    return adapter.listModels!(providerId, directory);
  }

  async createThread(id: AgentId, input: AgentCreateThreadInput) {
    const adapter = this.operation(id, "createThread");
    return adapter.createThread!(input.providerId || "", input);
  }

  async readThread(id: AgentId, threadId: string, options?: {
    turnLimit?: number;
    beforeTurn?: string;
    background?: boolean;
  }) {
    const adapter = this.operation(id, "readThread");
    const thread = this.thread(id, threadId);
    const read = () => adapter.readThread!(thread.providerId, threadId, options);
    return options?.background ? read() : this.interact(read);
  }

  /**
   * 读单个回合全文（折叠展开用）：各 adapter 都能 readThread 全文，
   * 这里按 turnId 切片返回，不新增 adapter 接口。折叠只发生在 HTTP
   * 传输层，本接口恒返回未折叠原文。
   */
  async readTurn(id: AgentId, threadId: string, turnId: string) {
    const adapter = this.operation(id, "readThread");
    const thread = this.thread(id, threadId);
    if (adapter.readTurn) {
      const turn: any = await this.interact(() => adapter.readTurn!(thread.providerId, threadId, turnId));
      return { ...turn, agentId: id, threadId };
    }
    const full: any = await this.readThread(id, threadId);
    const turn = Array.isArray(full?.turns)
      ? full.turns.find((item: any) => String(item?.id || "") === String(turnId))
      : undefined;
    if (!turn) throw new Error("找不到该回合，可能已被撤回或压缩");
    return { ...turn, agentId: id, threadId };
  }

  async renameThread(id: AgentId, threadId: string, name: string) {
    const adapter = this.operation(id, "renameThread");
    const thread = this.thread(id, threadId);
    return adapter.renameThread!(thread.providerId, threadId, name);
  }

  async archiveThread(id: AgentId, threadId: string) {
    const adapter = this.operation(id, "archiveThread");
    const thread = this.thread(id, threadId);
    return adapter.archiveThread!(thread.providerId, threadId);
  }

  async unarchiveThread(id: AgentId, threadId: string) {
    const adapter = this.operation(id, "unarchiveThread");
    const thread = this.thread(id, threadId);
    return adapter.unarchiveThread!(thread.providerId, threadId);
  }

  async updateThreadSettings(
    id: AgentId,
    threadId: string,
    settings: Partial<AgentCreateThreadInput>,
  ) {
    const adapter = this.operation(id, "updateThreadSettings");
    const thread = this.thread(id, threadId);
    return adapter.updateThreadSettings!(thread.providerId, threadId, settings);
  }

  async deleteThread(
    id: AgentId,
    threadId: string,
    options?: { closeConnection?: boolean },
  ) {
    const adapter = this.operation(id, "deleteThread");
    const thread = this.thread(id, threadId);
    return this.interact(() => adapter.deleteThread!(thread.providerId, threadId, options));
  }

  async sendTurn(
    id: AgentId,
    threadId: string,
    text: string,
    images?: TurnImage[],
  ) {
    const adapter = this.operation(id, "sendTurn");
    const thread = this.thread(id, threadId);
    return adapter.sendTurn!(thread.providerId, threadId, text, images);
  }

  async interrupt(id: AgentId, threadId: string, turnId: string) {
    const adapter = this.operation(id, "interrupt");
    const thread = this.thread(id, threadId);
    return adapter.interrupt!(thread.providerId, threadId, turnId);
  }

  /** 紧急停止：不经运行状态校验，把卡住的会话强制归位 idle。 */
  async forceStop(id: AgentId, threadId: string) {
    const adapter = this.operation(id, "forceStop");
    const thread = this.thread(id, threadId);
    return adapter.forceStop!(thread.providerId, threadId);
  }

  async sendMessage(id: AgentId, threadId: string, input: AgentMessageInput): Promise<AgentMessageReceipt> {
    // 只串行化受理，不等待模型回合结束；防止两个 start 同时通过空闲检查。
    const key = JSON.stringify([id, threadId]);
    const previous = this.messageLocks.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      const adapter = this.get(id);
      const capabilities = adapter.descriptor().capabilities.messages;
      if (!capabilities || !adapter.sendMessage)
        throw new AgentMessageError("unsupported", "该 Agent 未声明通用消息能力", 422);
      this.operation(id, "sendMessage");
      const thread = this.thread(id, threadId);
      assertMessageInput(thread, input, capabilities);
      const acceptance = await adapter.sendMessage(thread.providerId, threadId, input);
      return { ...acceptance, id: randomUUID(), agentId: id, threadId, status: "accepted" as const };
    });
    this.messageLocks.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.messageLocks.get(key) === pending) this.messageLocks.delete(key);
    }
  }

  messageState(id: AgentId, threadId: string) {
    const adapter = this.get(id);
    const descriptor = this.list().find((item) => item.id === id)!;
    const thread = this.thread(id, threadId);
    return {
      thread,
      capabilities: descriptor.capabilities,
      online: descriptor.online && this.isEnabled(id),
      ready: !messageBusy(thread) && !thread.compacting &&
        thread.status !== "starting" && thread.status !== "offline" && !thread.locked &&
        (adapter.messageReady?.(threadId) ?? true),
    };
  }

  messageBackendOnline(id: AgentId) {
    return this.isEnabled(id) && this.get(id).descriptor().online;
  }

  holdMessageQueue(id: AgentId, threadId: string) {
    return this.get(id).holdMessageQueue?.(threadId) ?? (() => {});
  }

  /** 回执只确认打断请求成功发出，最终状态由 turn/completed 等事件确认。 */
  async interruptMessage(id: AgentId, threadId: string, expectedTurnId: string) {
    const adapter = this.get(id);
    const capabilities = adapter.descriptor().capabilities;
    if (!capabilities.interrupt || !capabilities.messages || !adapter.interrupt)
      throw new AgentMessageError("unsupported", "该 Agent 未声明通用打断能力", 422);
    this.operation(id, "interrupt");
    const thread = this.thread(id, threadId);
    if (thread.archived)
      throw new AgentMessageError("archived", "会话已归档，请先恢复再操作");
    if (!messageBusy(thread) || !thread.activeTurnId)
      throw new AgentMessageError("no_active_turn", "会话没有正在运行的回合");
    if (thread.activeTurnId !== expectedTurnId)
      throw new AgentMessageError("turn_mismatch", "当前回合已变化，未发送打断请求");
    await adapter.interrupt!(thread.providerId, threadId, expectedTurnId);
    return { status: "interrupt_requested" as const, agentId: id, threadId, turnId: expectedTurnId, scope: capabilities.messages.interruptScope };
  }

  async resolveApproval(
    id: AgentId,
    approvalId: string,
    body: {
      decision?: string;
      /** ACP：直接选中 agent 给出的 optionId。 */
      optionId?: string;
      permissions?: unknown;
      scope?: "session" | "turn";
      answers?: unknown;
    },
  ) {
    // 注入的假审批不经过 adapter，直接回执即可；否则测试卡会永远挂着。
    if (this.devApprovals.delete(approvalId)) {
      this.emit("event", {
        type: "approval.resolved",
        data: { agentId: id, approvalId },
      });
      return { ok: true as const, source: "dev" as const };
    }
    const adapter = this.operation(id, "resolveApproval");
    return adapter.resolveApproval!(approvalId, body);
  }

  /**
   * 开发测试 API：注入一条看起来和真实审批一样的假请求。
   * 只存活在进程内存里，`resolveApproval` 时直接回执，不接触任何 agent 进程。
   */
  injectDevApproval(
    input: {
      agentId?: AgentId;
      threadId?: string;
      providerId?: string;
      kind?: ApprovalKind;
      method?: string;
      params?: Record<string, unknown>;
    } = {},
  ) {
    const id = input.agentId || ("codex" as AgentId);
    const adapter = this.get(id);
    if (!this.isEnabled(id)) throw new Error(`Agent ${id} 已停用`);
    const threadId = input.threadId;
    let providerId = input.providerId;
    if (!providerId && threadId) {
      const snapshot = adapter.snapshot();
      providerId = [
        ...snapshot.threads,
        ...(snapshot.archivedThreads || []),
      ].find((thread) => thread.id === threadId)?.providerId;
    }
    const approval: AgentApproval = {
      id: `${threadId || "dev"}:dev-${randomUUID()}`,
      agentId: id,
      providerId: providerId || "dev",
      kind: input.kind || "command",
      request: {
        method: input.method || "item/commandExecution/requestApproval",
        params: {
          ...(threadId ? { threadId } : {}),
          ...input.params,
        },
      },
    };
    this.devApprovals.set(approval.id, approval);
    this.emit("event", { type: "approval.requested", data: approval });
    return approval;
  }

  listDevApprovals() {
    return [...this.devApprovals.values()];
  }

  /** 清空所有注入审批，并逐个广播 resolved，避免客户端卡片残留。 */
  clearDevApprovals() {
    const approvals = [...this.devApprovals.values()];
    this.devApprovals.clear();
    for (const approval of approvals)
      this.emit("event", {
        type: "approval.resolved",
        data: { agentId: approval.agentId, approvalId: approval.id },
      });
    return approvals.length;
  }

  async listSessionCommands(
    id: AgentId,
    threadId: string,
  ): Promise<AgentCommand[]> {
    const adapter = this.operation(id, "listSessionCommands");
    const thread = this.thread(id, threadId);
    return adapter.listSessionCommands!(thread.providerId, threadId);
  }

  async listSkills(id: AgentId, threadId: string, forceReload = false) {
    const adapter = this.operation(id, "listSkills");
    const thread = this.thread(id, threadId);
    const key = `${id}:${threadId}`;
    const cached = this.skillCache.get(key);
    if (!forceReload) {
      if (cached && Date.now() - cached.at < SKILL_CACHE_TTL_MS) return cached.value;
      const pending = this.skillLoading.get(key);
      if (pending) return pending;
    }
    const loading = adapter
      .listSkills!(thread.providerId, threadId, forceReload)
      .then((value) => {
        // 简单上限防长期运行时无界增长；列表重建很便宜。
        if (this.skillCache.size > 128) {
          for (const [k, entry] of this.skillCache)
            if (Date.now() - entry.at >= SKILL_CACHE_TTL_MS)
              this.skillCache.delete(k);
          if (this.skillCache.size > 128) this.skillCache.clear();
        }
        this.skillCache.set(key, { at: Date.now(), value });
        if (this.skillLoading.get(key) === loading)
          this.skillLoading.delete(key);
        return value;
      })
      .catch((error: unknown) => {
        if (this.skillLoading.get(key) === loading)
          this.skillLoading.delete(key);
        throw error;
      });
    this.skillLoading.set(key, loading);
    return loading;
  }

  async runSessionCommand(
    id: AgentId,
    threadId: string,
    command: string,
    args?: string,
  ) {
    const adapter = this.operation(id, "runSessionCommand");
    const thread = this.thread(id, threadId);
    return adapter.runSessionCommand!(
      thread.providerId,
      threadId,
      command,
      args,
    );
  }

  async compactSession(id: AgentId, threadId: string) {
    const adapter = this.operation(id, "compactSession");
    const thread = this.thread(id, threadId);
    return adapter.compactSession!(thread.providerId, threadId);
  }

  async forkThread(
    id: AgentId,
    threadId: string,
    options: { messageID?: string; lastTurnId?: string } = {},
  ) {
    const adapter = this.operation(id, "forkThread");
    const thread = this.thread(id, threadId);
    return this.interact(() => adapter.forkThread!(thread.providerId, threadId, options));
  }

  async retryFromTurn(
    id: AgentId,
    threadId: string,
    turnId: string,
    text: string,
    images?: TurnImage[],
  ) {
    const adapter = this.operation(id, "retryFromTurn");
    const thread = this.thread(id, threadId);
    return adapter.retryFromTurn!(
      thread.providerId,
      threadId,
      turnId,
      text,
      images,
    );
  }

  async revertSession(id: AgentId, threadId: string, messageID?: string) {
    const adapter = this.operation(id, "revertSession");
    const thread = this.thread(id, threadId);
    return adapter.revertSession!(thread.providerId, threadId, messageID);
  }

  async unrevertSession(id: AgentId, threadId: string) {
    const adapter = this.operation(id, "unrevertSession");
    const thread = this.thread(id, threadId);
    return adapter.unrevertSession!(thread.providerId, threadId);
  }

  async listTasks() {
    // 任务明细要对每个忙碌会话各发一次 thread/read，轮询频繁时代价高。
    // 有缓存就先返回、后台再刷新，保证响应即时。
    if (!this.taskSnapshot) return this.refreshTasks();
    if (Date.now() - this.taskSnapshot.at > TASK_SNAPSHOT_TTL_MS)
      void this.refreshTasks().catch(() => {});
    return this.taskSnapshot.tasks;
  }

  /** 刷新任务快照；有并发刷新时跟随既有结果，避免重复 thread/read。 */
  private refreshTasks(): Promise<ActiveTask[]> {
    const pending = this.taskRefresh;
    if (pending) return pending;
    const refresh = this.buildTasks().finally(() => {
      if (this.taskRefresh === refresh) this.taskRefresh = undefined;
    });
    this.taskRefresh = refresh;
    return refresh;
  }

  private async buildTasks() {
    const tasks = await Promise.all(
      this.enabledAdapters().flatMap((adapter) =>
        adapter.busyThreads().map(async (thread) => {
          const [detail, terminals] = await Promise.all([
            adapter.readThread
              ? adapter
                  .readThread(thread.providerId, thread.id)
                  .catch(() => undefined)
              : undefined,
            adapter.backgroundTerminals
              ? adapter
                  .backgroundTerminals(thread.providerId, thread.id)
                  .catch((error: any) => ({
                    data: [],
                    supported: false,
                    error: String(error?.message || "任务明细读取失败"),
                  }))
              : { data: [], supported: false },
          ]);
          return activeTask(
            thread,
            detail,
            terminals.data,
            terminals.supported,
            "error" in terminals ? terminals.error : undefined,
          );
        }),
      ),
    );
    this.taskSnapshot = {
      at: Date.now(),
      tasks: tasks.sort((left, right) => right.startedAt - left.startedAt),
    };
    return this.taskSnapshot.tasks;
  }

  async terminateBackgroundTerminal(
    id: AgentId,
    threadId: string,
    processId: string,
  ) {
    const adapter = this.operation(id, "terminateBackgroundTerminal");
    const thread = this.thread(id, threadId);
    return adapter.terminateBackgroundTerminal!(
      thread.providerId,
      threadId,
      processId,
    );
  }

  busyThreads() {
    return this.enabledAdapters().flatMap((adapter) => adapter.busyThreads());
  }

  /** 各已启用 agent 的后端进程 pid（deck-wake 判定会话来源用）。 */
  runtimePids(): { agentId: AgentId; pid: number }[] {
    return this.enabledAdapters().flatMap((adapter) =>
      (adapter.runtimePids?.() || []).map((pid) => ({
        agentId: adapter.id,
        pid,
      })),
    );
  }

  stopAll() {
    for (const adapter of this.adapters.values()) adapter.restart();
  }

  private operation<K extends keyof AgentAdapter>(id: AgentId, key: K) {
    const adapter = this.get(id);
    if (!this.isEnabled(id))
      throw new Error(`${this.nameOf(id)} 未启用，请先在设置中启用`);
    if (typeof adapter[key] !== "function")
      throw new Error(`Agent ${id} 不支持此操作`);
    return adapter;
  }

  private thread(id: AgentId, threadId: string) {
    const snapshot = this.get(id).snapshot();
    const thread = [
      ...snapshot.threads,
      ...(snapshot.archivedThreads || []),
    ].find((item) => item.id === threadId);
    if (!thread) throw new Error(`Agent ${id} 的会话不存在`);
    return thread;
  }
}
