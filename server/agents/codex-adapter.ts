import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import type { ProviderStore } from "../store.js";
import type { ProjectStore } from "../projects.js";
import type { ThreadSettingsStore } from "../thread-settings.js";
import { CodexClient } from "../codex-client.js";
import { CodexUsageStore, loadCodexRolloutUsages } from "../codex-usage.js";
import {
  compileRuntimeProvider,
  isOfficialProvider,
} from "../provider-config.js";
import { configuredRuntimePort, findFreeListenPort } from "../runtime-port.js";
import {
  isPidAlive,
  readRuntimeLock,
} from "../runtime-lock.js";
import {
  probeCodexVersion,
  resolveEffectiveCodexBin,
} from "../codex-bins.js";
import {
  windowsPathToWsl,
  WSL_CODEX_SHELL_COMMAND,
} from "../runtime-platform.js";
import {
  classifyApprovalMethod,
  formatCommand,
  isChatgptAccount,
  parseAccount,
  parseFileChanges,
  parseRateLimits,
  parseSandboxMode,
  parseTimestamp,
  parseTokenUsage,
  pickString,
  sandboxPolicyFromMode,
  timestampFromId,
} from "../protocol.js";
import {
  buildTurnInput,
  DIFF_SHELL_COMMAND,
  INIT_PROMPT,
  PLAN_PROMPT,
  reviewParams,
} from "../turn-input.js";
import { visibleUserText } from "./injected-context.js";
import { AgentMessageError, assertMessageInput, type AgentMessageInput, type AgentMessageAcceptance } from "./messages.js";
import {
  classifyThreadStoreError,
  explainThreadStoreError,
  isMissingRolloutError,
} from "../thread-store-error.js";
import type {
  AccountInfo,
  ApprovalKind,
  ApprovalPolicy,
  ApprovalsReviewer,
  FileChange,
  ModelInfo,
  Personality,
  Provider,
  RateLimits,
  ReviewTarget,
  RpcMessage,
  RuntimeModelConfig,
  SandboxMode,
  ThreadSummary,
  TokenUsage,
  TurnImage,
} from "../types.js";
import type {
  AgentCapabilities,
  AgentDescriptor,
  AgentHistoryStatus,
  AgentId,
} from "./types.js";

const CODEX_CAPABILITIES: AgentCapabilities = {
  messages: { busyBehavior: "steer", interruptScope: "turn" },
  approvals: true,
  archive: true,
  delete: true,
  fork: true,
  images: true,
  interrupt: true,
  mcp: true,
  models: true,
  review: true,
  sessionSettings: true,
  shell: true,
  skills: true,
};

const COMPACTION_TIMEOUT_MS = 10 * 60_000;
const MODEL_CATALOG_TTL_MS = 10 * 60_000;

/** Codex 没有字面量 "default" 模型：空串与占位都视同未指定，走供应商默认。 */
function normalizeCodexModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "default") return undefined;
  return trimmed;
}

function sameModelConfig(a: RuntimeModelConfig, b: RuntimeModelConfig) {
  return (
    (a.modelContextWindow || undefined) ===
      (b.modelContextWindow || undefined) &&
    (a.modelAutoCompactTokenLimit || undefined) ===
      (b.modelAutoCompactTokenLimit || undefined)
  );
}

function stateDbOnlyUnsupported(error: unknown) {
  const message = String((error as any)?.message || error);
  return (
    /useStateDbOnly/i.test(message) &&
    /invalid|unknown|unexpected|unsupported|deserialize/i.test(message)
  );
}

export class CodexAdapter extends EventEmitter {
  readonly id: AgentId = "codex";
  private client?: CodexClient;
  private startingClient?: Promise<CodexClient>;
  private stoppingClient?: Promise<void>;
  private threads = new Map<string, ThreadSummary>();
  private loadedThreads = new Set<string>();
  // thread/start is in-memory only. Codex writes a rollout on the first turn,
  // when the thread is listed, or when it is forked/resumed from disk.
  private knownRollouts = new Set<string>();
  // 本 adapter 经 thread/start 创建、尚未落 rollout 的纯内存会话。
  // 不能拿 loadedThreads 充当这个角色：其它客户端 resume 历史会话也会让
  // runtime 广播 thread/started，把 id 塞进 loadedThreads，readThread 的快
  // 路径就会把那类有历史的会话直接读成空。
  private inMemoryThreads = new Set<string>();
  private approvals = new Map<
    string,
    { providerId: string; request: RpcMessage }
  >();
  private loadedProviderRevision = -1;
  private loadedConnectionRevision = -1;
  private loadedProviderIds = new Set<string>();
  private runtimePort?: number;
  private account?: AccountInfo;
  private rateLimits: RateLimits | null = null;
  private rateLimitsError?: string;
  private usageFetchedAt = 0;
  private usageLoading?: Promise<ReturnType<CodexAdapter["runtimeStatus"]>>;
  private archiveError?: string;
  private pendingFileChanges = new Map<string, FileChange[]>();
  private compactionTimers = new Map<string, NodeJS.Timeout>();
  private usageStore: CodexUsageStore;
  private rolloutUsageLoaded = false;
  /**
   * 进行中回合的产出基线（turn/progress 与 turn.stats 用）：turn/started
   * 记录开始时间 + 当时累计 output/reasoning，turn/completed 按结束时累计
   * 做差得到本轮产出。key 为 threadId，同时只跟踪一个活跃回合。
   */
  private runningTurns = new Map<
    string,
    {
      turnId: string;
      startedAt: number;
      /** turn/started 时累计生成 token（output+reasoning），缺失则本轮不算 TPS。 */
      generatedBefore?: number;
      lastEmitAt: number;
    }
  >();
  /**
   * per-item 生成统计（思考/回复行行尾 TPS）：reasoning/agentMessage 的
   * item/started 记录开始时间与当时累计 output/reasoning，item/completed
   * 窗口内累计做差即为该 item 的产出。key 为 itemId，量有界。
   */
  private itemUsageWindows = new Map<
    string,
    { type: string; startedAt: number; output: number; reasoning: number }
  >();
  private historyStatus: AgentHistoryStatus;
  private historyError?: string;
  private backgroundTerminalApi?: boolean;
  private modelCatalog = new Map<string, { at: number; models: ModelInfo[] }>();
  private modelCatalogLoading = new Map<string, Promise<ModelInfo[]>>();
  private ownerProviderIds?: Set<string>;
  /** 本次实际启动后端用的二进制（空字符串表示 PATH 默认 `codex`）。 */
  private runningCodexBin = "";
  /** 本次实际启动后端时用的上下文配置快照：启动参数的真实值。 */
  private runningModelConfig: RuntimeModelConfig = {};
  private runningCodexVersion?: string;
  /** 设置页选中的后端版本（后台探测，非阻塞）。 */
  private selectedCodexVersion?: string;

  constructor(
    private store: ProviderStore,
    private dataDir: string,
    private codexBin?: string,
    runtimePort?: number,
    private useWsl = false,
    private projects?: ProjectStore,
    initialThreads: ThreadSummary[] = [],
    private repairEmptyStateDb = false,
    private threadSettings?: ThreadSettingsStore,
  ) {
    super();
    this.usageStore = new CodexUsageStore(dataDir);
    for (const thread of initialThreads) {
      if ((thread.agentId || "codex") !== "codex") continue;
      this.threads.set(thread.id, {
        ...thread,
        ...this.threadSettings?.get(this.id, thread.id),
        agentId: "codex",
        compacting: false,
      });
      this.knownRollouts.add(thread.id);
    }
    this.historyStatus = this.threads.size ? "cached" : "loading";
    this.runtimePort =
      runtimePort && runtimePort > 0 ? runtimePort : configuredRuntimePort();
  }

  async startAll() {
    await this.usageStore.load();
    // 后台探测选中后端的版本：只用于设置页展示与 mismatch 提示。
    void this.refreshSelectedCodexVersion();
    try {
      await this.ensure();
      await this.refreshAll();
      // 后台预热模型目录：新建会话的模型选择卡不该在服务冷启动后
      // 第一次打开时才等 runtime 拉目录。
      for (const provider of this.store.runtimeProviders()) {
        void this.refreshModelCatalog(provider.id).catch(() => {});
      }
    } catch (error: any) {
      this.historyStatus = "error";
      this.historyError = String(error?.message || "Codex 服务启动失败");
      this.broadcast("snapshot", this.snapshot());
      throw error;
    }
  }

  descriptor(): AgentDescriptor {
    const runtime = this.runtimeStatus();
    return {
      id: this.id,
      name: "Codex",
      protocol: "native",
      available: true,
      online: runtime.online,
      starting: runtime.starting,
      error: runtime.error,
      historyStatus: this.historyStatus,
      historyError: this.historyError,
      capabilities: CODEX_CAPABILITIES,
    };
  }

  async ensure(providerId?: string) {
    if (providerId && !this.store.get(providerId))
      throw new Error("供应商不存在");
    if (this.client?.online) return this.client;
    if (this.startingClient) return this.startingClient;
    const starting = this.startClient(this.client);
    this.startingClient = starting;
    try {
      return await starting;
    } finally {
      if (this.startingClient === starting) this.startingClient = undefined;
    }
  }

  private async resolveRuntimePort() {
    if (this.runtimePort) return this.runtimePort;
    this.runtimePort = await findFreeListenPort();
    return this.runtimePort;
  }

  private runtimeUrl() {
    return this.runtimePort ? `ws://127.0.0.1:${this.runtimePort}` : "";
  }

  private async startClient(previous?: CodexClient) {
    const pendingStop = this.stoppingClient;
    if (pendingStop) await pendingStop;
    if (previous) await previous.stop();
    this.loadedThreads.clear();
    this.knownRollouts.clear();
    const profile = this.store.runtimeProfile();
    // 生效后端：环境变量 > 设置页选择 > PATH 默认。每次启动都重新解析，
    // Deck 重启后 PATH 变化也能体现（只提示、不自动杀旧进程）。
    const effectiveBin = resolveEffectiveCodexBin(
      process.env,
      this.useWsl,
      this.store.runtimeCodexBin?.() || "",
    );
    const modelConfig = this.store.runtimeModelConfig?.() || {};
    const client = new CodexClient(
      profile,
      this.dataDir,
      effectiveBin || "codex",
      this.store.runtimeProviders(),
      `ws://127.0.0.1:${await this.resolveRuntimePort()}`,
      this.useWsl,
      (providerId) => this.projects?.overlayForProvider(providerId),
      modelConfig,
    );
    this.client = client;
    client.on("notification", (msg) => this.onNotification(msg));
    client.on("request", (msg) => this.onRequest(msg));
    client.on("online", () => {
      this.broadcast("runtime.status", { online: true });
      void this.loadOfficialUsage();
    });
    client.on("offline", (error) => {
      this.clearCompactions();
      this.markOffline();
      this.broadcast("runtime.status", { online: false, error });
    });
    await client.start();
    if (this.client !== client) {
      client.stop();
      throw new Error("运行时配置在启动期间已更新，请重试");
    }
    this.runningCodexBin = effectiveBin;
    this.runningModelConfig = { ...modelConfig };
    this.runningCodexVersion = undefined;
    // 版本探测是 best-effort：成了就补进快照提示，不阻塞启动。
    void probeCodexVersion(effectiveBin || "codex").then((version) => {
      if (this.client !== client) return;
      this.runningCodexVersion = version;
      this.broadcast("runtime.status", this.runtimeStatus());
    });
    this.broadcast("runtime.process", {
      pid: client.pid,
      remoteUrl: this.runtimeUrl(),
      codexBin: effectiveBin || "codex",
    });
    const providerIds = new Set(
      this.store.runtimeProviders().map((provider) => provider.id),
    );
    // 供应商集合变了，目录可能随鉴权变化；重启本身不清缓存，避免
    // 重启后第一次打开模型选择卡又退化成阻塞等待。
    if (
      this.ownerProviderIds &&
      [...providerIds].some((id) => !this.ownerProviderIds?.has(id))
    )
      this.modelCatalog.clear();
    this.ownerProviderIds = providerIds;
    this.loadedProviderRevision = this.store.revision;
    this.loadedConnectionRevision = this.projects?.connectionRevision ?? 0;
    this.loadedProviderIds = new Set(
      this.store.runtimeProviders().map((provider) => provider.id),
    );
    return client;
  }

  restart(_providerId?: string) {
    this.clearCompactions();
    // 先按 offline 语义解除进行中回合的占用：client 被 stop 后不会再触发
    // offline 事件，若不在此处 markOffline，被杀的 turn 会从 state DB 的
    // inProgress 记录复活为 running，永久挡住后续供应商配置变更。
    // 无运行中会话时 markOffline 是空操作，只清理审批与文件变更缓存。
    this.markOffline();
    this.broadcast("runtime.status", this.runtimeStatus());
    const previous = this.client;
    this.client = undefined;
    const stopping = previous?.stop() || Promise.resolve();
    this.stoppingClient = stopping;
    void stopping.finally(() => {
      if (this.stoppingClient === stopping) this.stoppingClient = undefined;
    });
    this.startingClient = undefined;
    this.loadedThreads.clear();
    this.knownRollouts.clear();
    this.runningTurns.clear();
    this.runningModelConfig = {};
  }

  providerStatuses() {
    return this.store.listPublic().map((p) => ({
      ...p,
      online: this.client?.online ?? false,
      starting: Boolean(this.startingClient),
      error: this.client?.lastError,
    }));
  }

  publicProfiles() {
    return this.providerStatuses().map((provider) => ({
      ...provider,
      agentId: this.id,
    }));
  }

  listThreads() {
    return [...this.threads.values()]
      .filter((thread) => !thread.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  listArchivedThreads() {
    return [...this.threads.values()]
      .filter((thread) => thread.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async refreshAll() {
    await this.refreshHistory(true);
  }

  async repairHistory() {
    await this.refreshHistory(false);
    if (this.historyStatus === "error")
      throw new Error(this.historyError || "Codex 历史索引修复失败");
  }

  private async refreshHistory(useStateDbOnly: boolean) {
    const cachedCount = this.threads.size;
    const seen = new Set<string>();
    let activeListed = false;
    let archivedListed = false;
    this.historyStatus = "loading";
    this.historyError = undefined;
    this.broadcast("snapshot", this.snapshot());
    try {
      const client = await this.ensure();
      await this.pullThreadPages(client, false, seen, useStateDbOnly);
      activeListed = true;
      try {
        await this.pullThreadPages(client, true, seen, useStateDbOnly);
        archivedListed = true;
        this.archiveError = undefined;
      } catch (error: any) {
        this.archiveError = String(error?.message || "归档会话列表加载失败");
        this.historyStatus = "error";
        this.historyError = this.archiveError;
      }
    } catch (error: any) {
      if (useStateDbOnly && stateDbOnlyUnsupported(error)) {
        await this.refreshHistory(false);
        return;
      }
      this.historyStatus = "error";
      this.historyError = String(error?.message || "会话索引加载失败");
    }
    if (
      useStateDbOnly &&
      activeListed &&
      archivedListed &&
      (cachedCount > 0 || this.repairEmptyStateDb) &&
      seen.size === 0
    ) {
      this.repairEmptyStateDb = false;
      await this.refreshHistory(false);
      return;
    }
    // Only drop stale rows after a successful unarchived listing. A failed
    // thread/list (timeout, current-provider filter error) must not wipe
    // history that is already on screen.
    if (activeListed || archivedListed) {
      for (const [key, thread] of this.threads) {
        const bucketListed = thread.archived ? archivedListed : activeListed;
        if (
          bucketListed &&
          !seen.has(thread.id) &&
          !this.loadedThreads.has(key)
        ) {
          this.threads.delete(key);
          this.inMemoryThreads.delete(key);
        }
      }
      await this.projects?.rememberSeenMany(
        [...this.threads.values()].map((thread) => ({
          cwd: thread.cwd,
          updatedAt: thread.updatedAt,
        })),
      );
      if (!useStateDbOnly) await this.restoreHistoricalUsage();
      if (activeListed && archivedListed) {
        this.historyStatus = "ready";
        this.historyError = undefined;
      }
    }
    this.broadcast("snapshot", this.snapshot());
  }

  private async pullThreadPages(
    client: CodexClient,
    archived: boolean,
    seen: Set<string>,
    useStateDbOnly: boolean,
  ) {
    let cursor: string | undefined;
    let loaded = 0;
    do {
      const result = await client.request(
        "thread/list",
        this.threadListParams(cursor, archived, useStateDbOnly),
        120_000,
      );
      for (const thread of result.data || result.threads || []) {
        this.upsertThread(this.providerForThread(thread), {
          ...thread,
          archived: archived || thread.archived,
        });
        this.rememberRollout(thread.id);
        seen.add(thread.id);
      }
      loaded += result.data?.length || result.threads?.length || 0;
      cursor = result.nextCursor || result.next_cursor || undefined;
    } while (cursor && loaded < 2_000);
  }

  private async restoreHistoricalUsage() {
    const wanted = new Set(
      [...this.threads.values()]
        .filter((thread) => !this.rolloutUsageLoaded || !thread.tokenUsage)
        .map((thread) => thread.id),
    );
    if (!wanted.size) return;
    const codexHome = this.store.runtimeProfile().codexHome;
    if (!codexHome) return;
    try {
      const restored = await loadCodexRolloutUsages({
        codexHome,
        useWsl: this.useWsl,
        wanted,
      });
      for (const [threadId, restoredUsage] of restored) {
        const thread = this.threads.get(threadId);
        if (thread) thread.tokenUsage = restoredUsage.usage;
      }
      // setMany/set 返回的 promise 挂在 unref 的 300ms 落盘定时器上，await 它
      // 会饿死事件循环；flush() 立即落盘且语义等价（已提交的写全部持久化）。
      void this.usageStore.setMany(
        [...restored].map(([threadId, entry]) => [
          threadId,
          entry.usage,
          {
            providerId:
              this.threads.get(threadId)?.providerId ||
              this.officialProviderId(),
            at: entry.at,
          },
        ]),
      );
      await this.usageStore.flush();
      this.rolloutUsageLoaded = true;
    } catch {
      // History remains usable when a rollout is unreadable or WSL is offline.
    }
  }

  private rememberUsage(
    threadId: string,
    usage: TokenUsage,
    meta?: { providerId?: string; at?: number },
  ) {
    void this.usageStore.set(threadId, usage, meta).catch(() => undefined);
  }

  /**
   * 累计用量里的生成 token（output + reasoning）：total 存在时是累计值，
   * 只有 last 时是单次调用值；起止口径一致时做差即本轮产出。
   */
  private generatedOf(usage?: TokenUsage | null) {
    if (!usage) return undefined;
    const output = Number(usage.output);
    const reasoning = Number(usage.reasoningOutput);
    if (!Number.isFinite(output) && !Number.isFinite(reasoning))
      return undefined;
    return (Number.isFinite(output) ? output : 0) +
      (Number.isFinite(reasoning) ? reasoning : 0);
  }

  /** per-item 窗口差值按字段认领：reasoning 吃 reasoningOutput，回复吃 output。 */
  private usageFields(usage?: TokenUsage | null) {
    return {
      output: Number(usage?.output) || 0,
      reasoning: Number(usage?.reasoningOutput) || 0,
    };
  }

  /**
   * 思考/回复 item 的 per-item 产出：started 记基线，completed 用窗口内的
   * 累计做差盖章 item.stats（delta<=0 或用时缺失就不编造）。tokenUsage
   * 事件若晚于 item/completed 才到达，本 item 不计、下一个 item 的基线
   * 已含该批 token，不会重复累计。
   */
  private noteItemUsage(
    item: any,
    method: string,
    itemId: string,
    existing: ThreadSummary,
    now: number,
  ) {
    if (method === "item/started") {
      if (this.itemUsageWindows.size > 400) this.itemUsageWindows.clear();
      const baseline = this.usageFields(existing.tokenUsage);
      this.itemUsageWindows.set(itemId, {
        type: String(item.type),
        startedAt: Number(item.startedAt) || now,
        ...baseline,
      });
      return;
    }
    const entry = this.itemUsageWindows.get(itemId);
    this.itemUsageWindows.delete(itemId);
    if (!entry || entry.type !== item.type) return;
    const startedAt = Number(entry.startedAt);
    const endedAt = Number(item.endedAt) || now;
    if (!(startedAt > 0 && endedAt > startedAt)) return;
    const fields = this.usageFields(existing.tokenUsage);
    const isReasoning = item.type === "reasoning";
    const outputTokens = Math.max(
      0,
      (isReasoning ? fields.reasoning : fields.output) -
        (isReasoning ? entry.reasoning : entry.output),
    );
    if (outputTokens <= 0) return;
    item.stats = {
      durationMs: endedAt - startedAt,
      outputTokens,
      tps: Math.round((outputTokens / ((endedAt - startedAt) / 1000)) * 10) / 10,
    };
  }

  /**
   * 把持久化的回合统计回填到 readThread 返回的 turn.stats（无则不碰，
   * 由前端回落隐藏）。与 stampTurnModels 同一位置调用。
   */
  private stampTurnStats(thread: any) {
    const turns = thread?.turns;
    const store = this.threadSettings;
    if (!Array.isArray(turns) || !store || typeof store.turnStats !== "function")
      return;
    for (const turn of turns) {
      if (!turn || turn.stats) continue;
      const stamp = store.turnStats(
        this.id,
        String(thread.id),
        String(turn.id || ""),
      );
      if (stamp && (stamp.durationMs != null || stamp.outputTokens != null || stamp.startedAt != null))
        turn.stats = { ...stamp };
    }
  }

  /**
   * turn/completed 结算：用时恒有（Deck 见证的起止），产出取起止累计
   * 生成 token 差值（基线缺失则只留用时，不编造 TPS），持久化供历史回填。
   */
  private finishRunningTurn(existing: ThreadSummary, turnId?: unknown) {
    const running = this.runningTurns.get(existing.id);
    this.runningTurns.delete(existing.id);
    if (!running) return;
    const id = String(turnId || running.turnId || "");
    if (!id) return;
    const endedAt = Date.now();
    const stamp: {
      startedAt: number;
      endedAt: number;
      durationMs: number;
      outputTokens?: number;
      tps?: number;
    } = {
      startedAt: running.startedAt,
      endedAt,
      durationMs: Math.max(0, endedAt - running.startedAt),
    };
    if (running.generatedBefore != null) {
      const generatedAfter = this.generatedOf(existing.tokenUsage);
      if (generatedAfter != null) {
        const outputTokens = Math.max(0, generatedAfter - running.generatedBefore);
        stamp.outputTokens = outputTokens;
        if (stamp.durationMs > 0 && outputTokens > 0)
          stamp.tps =
            Math.round((outputTokens / (stamp.durationMs / 1000)) * 10) / 10;
      }
    }
    void this.threadSettings
      ?.recordTurnStats(this.id, existing.id, id, stamp)
      ?.catch(() => undefined);
  }

  /**
   * tokenUsage/updated 自带累计用量：活跃回合内按 1Hz 推 turn/progress
   * 供底部状态块显示实时 TPS。非活跃/无基线/节流窗内直接跳过。
   */
  private noteTurnProgress(existing: ThreadSummary, usage: TokenUsage) {
    const turnId = String(existing.activeTurnId || "");
    const running = this.runningTurns.get(existing.id);
    if (!turnId || !running || running.turnId !== turnId) return;
    if (running.generatedBefore == null) return;
    const generated = this.generatedOf(usage);
    if (generated == null) return;
    const now = Date.now();
    if (now - running.lastEmitAt < 1_000) return;
    running.lastEmitAt = now;
    this.broadcast("codex.event", {
      agentId: this.id,
      providerId: existing.providerId,
      method: "turn/progress",
      params: {
        threadId: existing.id,
        turnId: running.turnId,
        outputTokens: Math.max(0, generated - running.generatedBefore),
        elapsedMs: Math.max(0, now - running.startedAt),
      },
    });
  }

  private officialProviders() {
    const providers =
      typeof this.store.runtimeProviders === "function"
        ? this.store.runtimeProviders()
        : [];
    const official = providers.filter((provider) => isOfficialProvider(provider));
    const profile = this.store.runtimeProfile?.();
    return official.length ? official : profile ? [profile] : [];
  }

  /** 官方帐号对应的 provider id 集合：rateLimits 窗口描述的就是这个帐号。 */
  private officialProviderIds() {
    return new Set(this.officialProviders().map((provider) => provider.id));
  }

  private officialProviderId() {
    return this.officialProviders()[0]?.id;
  }

  private threadListParams(
    cursor: string | undefined,
    archived: boolean,
    useStateDbOnly = true,
  ) {
    return {
      cursor,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived,
      useStateDbOnly,
      // Omitted/null is an implicit filter for the runtime's current
      // model_provider. Deck bootstraps a CCS relay as that default, which
      // hides ~/.codex history recorded as "custom" / "openai" / other ids.
      // An empty array means every provider.
      modelProviders: [] as string[],
    };
  }

  snapshot() {
    return {
      providers: this.providerStatuses(),
      threads: this.listThreads(),
      archivedThreads: this.listArchivedThreads(),
      approvals: [...this.approvals.entries()].map(([id, value]) =>
        this.approvalView(id, value),
      ),
      runtime: this.runtimeStatus(),
    };
  }

  runtimeStatus() {
    const modelConfig = this.store.runtimeModelConfig?.() || {};
    const selectedBin = resolveEffectiveCodexBin(
      process.env,
      this.useWsl,
      this.store.runtimeCodexBin?.() || "",
    );
    const envPinned = Boolean(
      (this.useWsl ? process.env.CODEX_WSL_BIN : process.env.CODEX_BIN)?.trim(),
    );
    return {
      online: this.client?.online ?? false,
      starting: Boolean(this.startingClient),
      remoteUrl: this.runtimeUrl(),
      error: this.client?.lastError,
      configPending:
        Boolean(this.client?.online) &&
        (this.loadedProviderRevision !== this.store.revision ||
          (this.projects != null &&
            this.loadedConnectionRevision !==
              this.projects.connectionRevision)),
      account: this.account,
      rateLimits: this.rateLimits,
      rateLimitsError: this.rateLimitsError,
      accountUsageDaily: this.usageStore.dailyUsage(this.officialProviderIds()),
      archiveError: this.archiveError,
      runtimeWsl: this.useWsl,
      ...(modelConfig.modelContextWindow ||
      modelConfig.modelAutoCompactTokenLimit
        ? { modelConfig }
        : {}),
      // 正在运行的进程实际用的值（仅在线时有）：与已保存的不一致
      // 说明新值还没重启生效，设置页据此打标而不是让用户靠猜。
      ...(this.client?.online
        ? { modelConfigRunning: { ...this.runningModelConfig } }
        : {}),
      modelConfigPending:
        Boolean(this.client?.online) &&
        !sameModelConfig(modelConfig, this.runningModelConfig),
      // 后端版本状态：只提示、不自动杀旧进程。env pin 最高优时 selected 即 env。
      codexBin: selectedBin || "codex",
      codexBinPinned: envPinned,
      codexBinRunning: this.client?.online
        ? this.runningCodexBin || "codex"
        : undefined,
      codexVersionRunning: this.runningCodexVersion,
      codexVersionSelected: this.selectedCodexVersion,
      codexVersionMismatch:
        this.client?.online &&
        Boolean(this.runningCodexVersion) &&
        Boolean(this.selectedCodexVersion) &&
        this.runningCodexVersion !== this.selectedCodexVersion
          ? {
              running: this.runningCodexVersion as string,
              selected: this.selectedCodexVersion as string,
            }
          : undefined,
      staleBackend: this.staleBackendInfo(),
    };
  }

  /** 探测选中后端的版本并缓存，失败时保持旧值（best-effort，不抛错）。 */
  async refreshSelectedCodexVersion() {
    try {
      const selected = resolveEffectiveCodexBin(
        process.env,
        this.useWsl,
        this.store.runtimeCodexBin?.() || "",
      );
      const version = await probeCodexVersion(selected || "codex");
      if (version) {
        this.selectedCodexVersion = version;
        this.broadcast("runtime.status", this.runtimeStatus());
      }
      return version;
    } catch {
      return undefined;
    }
  }

  /**
   * 上个 Deck 进程留下的后端（只提示、不杀）：
   * 锁里的 Deck pid 已死，但记录的 app-server 子进程还活着，说明现在看到的
   * 端口/会话可能属于那个旧后端。发现后由设置页提示用户手动处理。
   */
  private staleBackendInfo():
    | { pid: number; codexBin?: string; codexVersion?: string }
    | undefined {
    try {
      const lock = readRuntimeLock(this.dataDir);
      if (!lock || lock.pid === process.pid) return undefined;
      if (isPidAlive(lock.pid)) return undefined;
      if (lock.childPid && isPidAlive(lock.childPid))
        return {
          pid: lock.childPid,
          codexBin: lock.codexBin,
          codexVersion: lock.codexVersion,
        };
    } catch {}
    return undefined;
  }

  terminalCommand(providerId?: string, cwd?: string) {
    const provider = providerId ? this.store.get(providerId) : undefined;
    const quote = (value: string) =>
      process.platform === "win32"
        ? `"${value.replace(/"/g, '""')}"`
        : `'${value.replace(/'/g, `'"'"'`)}'`;
    const parts = this.useWsl
      ? [
          "wsl.exe",
          "--exec",
          process.env.CODEX_WSL_SHELL || "bash",
          "-lc",
          `'${WSL_CODEX_SHELL_COMMAND.replace(/'/g, `'"'"'`)}'`,
          "codex-deck",
          process.env.CODEX_WSL_BIN || "codex",
          "--remote",
          this.runtimeStatus().remoteUrl,
        ]
      : ["codex", "--remote", this.runtimeStatus().remoteUrl];
    if (cwd) parts.push("-C", quote(this.useWsl ? windowsPathToWsl(cwd) : cwd));
    if (provider) {
      const compiled = compileRuntimeProvider(provider);
      if (compiled.model) parts.push("-m", quote(compiled.model));
      parts.push(
        "-c",
        quote(`model_provider=${JSON.stringify(compiled.modelProvider)}`),
      );
    }
    return parts.join(" ");
  }

  busyThreads() {
    return this.listThreads().filter(
      (thread) => thread.status === "running" || thread.status === "waiting",
    );
  }

  runtimePids() {
    const pid = this.client?.pid;
    return typeof pid === "number" ? [pid] : [];
  }

  async applyProviderConfig() {
    const busy = this.busyThreads();
    if (busy.length)
      throw new Error(
        `仍有 ${busy.length} 个会话正在运行或等待审批，请处理后再应用供应商配置`,
      );
    this.restart();
    await this.ensure();
    await this.refreshAll();
    return this.runtimeStatus();
  }

  async updateRuntimeModelConfig(config: RuntimeModelConfig) {
    const busy = this.busyThreads();
    if (busy.length)
      throw new Error(
        `仍有 ${busy.length} 个 Codex 会话正在运行或等待审批，请处理后再保存上下文设置`,
      );
    const previous = this.store.runtimeModelConfig();
    await this.store.updateRuntimeModelConfig(config);
    this.restart();
    try {
      await this.ensure();
      await this.refreshAll();
      return this.runtimeStatus();
    } catch (error: any) {
      await this.store.updateRuntimeModelConfig(previous);
      this.restart();
      try {
        await this.ensure();
        await this.refreshAll();
      } catch (rollbackError: any) {
        throw new Error(
          `上下文设置启动失败，恢复旧配置后 Runtime 仍无法启动：${rollbackError?.message || rollbackError}`,
        );
      }
      throw new Error(
        `上下文设置未生效，已恢复旧配置并重启 Runtime：${error?.message || error}`,
      );
    }
  }

  /**
   * 切换本机后端：空字符串表示跟随 PATH/CODEX_BIN。
   * 有会话运行时拒绝切换（与上下文设置同规则），由调用方提示用户。
   */
  async updateRuntimeCodexBin(bin: string) {
    const busy = this.busyThreads();
    if (busy.length)
      throw new Error(
        `仍有 ${busy.length} 个 Codex 会话正在运行或等待审批，请处理后再切换后端`,
      );
    const previous = this.store.runtimeCodexBin?.() || "";
    await this.store.updateRuntimeCodexBin(bin);
    this.selectedCodexVersion = undefined;
    this.restart();
    try {
      await this.ensure();
      await this.refreshAll();
      await this.refreshSelectedCodexVersion();
      return this.runtimeStatus();
    } catch (error: any) {
      await this.store.updateRuntimeCodexBin(previous);
      this.restart();
      try {
        await this.ensure();
        await this.refreshAll();
      } catch (rollbackError: any) {
        throw new Error(
          `后端切换失败，恢复旧后端后 Runtime 仍无法启动：${rollbackError?.message || rollbackError}`,
        );
      }
      throw new Error(
        `后端切换未生效，已恢复旧后端并重启 Runtime：${error?.message || error}`,
      );
    }
  }

  async createThread(
    providerId: string,
    input: {
      cwd: string;
      model?: string;
      reasoningEffort?: string;
      personality?: Personality;
      approvalPolicy?: string;
      approvalsReviewer?: string;
      sandbox?: string;
      name?: string;
    },
  ) {
    if (
      this.client?.online &&
      !this.loadedProviderIds.has(providerId) &&
      this.store.get(providerId)?.kind !== "local-profile"
    )
      throw new Error("该供应商尚未装入服务，请先在供应商设置中应用配置");
    const client = await this.ensure(providerId);
    const provider = this.store.get(providerId)!;
    const runtimeProvider = compileRuntimeProvider(provider);
    const requestedModel = normalizeCodexModel(input.model);
    const providerModel = normalizeCodexModel(runtimeProvider.model);
    const sandbox = (input.sandbox || "workspace-write") as SandboxMode;
    const approvalPolicy = (input.approvalPolicy ||
      "on-request") as ApprovalPolicy;
    const approvalsReviewer = (input.approvalsReviewer ||
      "auto_review") as ApprovalsReviewer;
    const start: Record<string, unknown> = {
      cwd: this.useWsl ? windowsPathToWsl(input.cwd) : input.cwd,
      model: requestedModel || providerModel || undefined,
      modelProvider: runtimeProvider.modelProvider,
      approvalPolicy,
      approvalsReviewer,
      sandbox,
    };
    if (input.reasoningEffort) start.reasoningEffort = input.reasoningEffort;
    if (input.personality) start.personality = input.personality;
    const result = await client.request("thread/start", start);
    if (input.name)
      await client.request("thread/name/set", {
        threadId: result.thread.id,
        name: input.name,
      });
    // The runtime history can report its provider default after creation.
    // Preserve Deck's explicit thread choices before the next list refresh.
    await this.threadSettings?.update(this.id, result.thread.id, {
      model: requestedModel,
      reasoningEffort: input.reasoningEffort,
      personality: input.personality,
      sandbox,
      approvalPolicy,
      approvalsReviewer,
    });
    this.loadedThreads.add(result.thread.id);
    this.inMemoryThreads.add(result.thread.id);
    this.upsertThread(
      provider,
      {
        ...result.thread,
        name: input.name || result.thread.name,
        model: requestedModel || result.thread.model,
        reasoningEffort: input.reasoningEffort || result.reasoningEffort,
        personality: input.personality,
        sandbox:
          parseSandboxMode(
            result.sandbox,
            result.activePermissionProfile,
            sandbox,
          ) || sandbox,
        approvalPolicy:
          pickString(result.approvalPolicy, approvalPolicy) || approvalPolicy,
        approvalsReviewer:
          pickString(result.approvalsReviewer, approvalsReviewer) ||
          approvalsReviewer,
      },
      "idle",
    );
    return this.threads.get(result.thread.id) || result.thread;
  }

  async listModels(providerId: string): Promise<ModelInfo[]> {
    const cached = this.modelCatalog.get(providerId);
    if (cached && Date.now() - cached.at < MODEL_CATALOG_TTL_MS)
      return cached.models.map((model) => ({ ...model }));
    // 过期缓存立即返回、后台刷新：目录拉取可能赶上 runtime 冷启动，
    // 阻塞等待会让新建会话的模型卡长时间空白（前端 8s 即超时）。
    if (cached?.models.length) {
      void this.refreshModelCatalog(providerId).catch(() => {});
      return cached.models.map((model) => ({ ...model }));
    }
    const pending = this.modelCatalogLoading.get(providerId);
    if (pending) return pending;
    const loading = this.refreshModelCatalog(providerId).finally(() => {
      if (this.modelCatalogLoading.get(providerId) === loading)
        this.modelCatalogLoading.delete(providerId);
    });
    this.modelCatalogLoading.set(providerId, loading);
    return loading;
  }

  private async refreshModelCatalog(providerId: string): Promise<ModelInfo[]> {
    const cached = this.modelCatalog.get(providerId);
    const client = await this.ensure(providerId);
    const models: ModelInfo[] = [];
    try {
      let cursor: string | undefined;
      do {
        const result = await client.request("model/list", {
          cursor,
          limit: 50,
          includeHidden: false,
        });
        for (const item of result.data || []) {
          models.push({
            id: item.id || item.model,
            model: item.model || item.id,
            displayName: item.displayName || item.model || item.id,
            hidden: item.hidden,
            isDefault: item.isDefault,
            defaultReasoningEffort: item.defaultReasoningEffort,
            supportedReasoningEfforts: item.supportedReasoningEfforts,
            supportsPersonality: item.supportsPersonality,
            serviceTiers: item.serviceTiers,
            defaultServiceTier: item.defaultServiceTier,
          });
        }
        cursor = result.nextCursor || undefined;
      } while (cursor && models.length < 200);
    } catch (error) {
      // 目录偶发卡住时，用未过期的上次结果顶上，避免前端被迫手输/误提交脏值。
      if (cached?.models.length) return cached.models.map((model) => ({ ...model }));
      throw error;
    }
    if (!models.length && cached?.models.length)
      return cached.models.map((model) => ({ ...model }));
    this.modelCatalog.set(providerId, {
      at: Date.now(),
      models: models.map((model) => ({ ...model })),
    });
    return models;
  }

  async listSkills(providerId: string, threadId: string, forceReload = false) {
    await this.ensureLoaded(providerId, threadId);
    const client = await this.ensure(providerId);
    const thread = this.threads.get(threadId);
    if (!thread?.cwd) throw new Error("当前会话没有可用的工作目录");
    const cwd = this.useWsl ? windowsPathToWsl(thread.cwd) : thread.cwd;
    try {
      const result = await client.request("skills/list", {
        cwds: [cwd],
        forceReload,
      });
      const entries = Array.isArray(result?.data) ? result.data : [];
      return {
        skills: entries.flatMap((entry: any) =>
          (Array.isArray(entry?.skills) ? entry.skills : []).map(
            (skill: any) => ({
              name: String(skill.name || ""),
              description: String(
                skill.description || skill.shortDescription || "",
              ),
              path: String(skill.path || ""),
              scope: String(skill.scope || ""),
              enabled: skill.enabled !== false,
            }),
          ),
        ),
        errors: entries.flatMap((entry: any) =>
          Array.isArray(entry?.errors) ? entry.errors : [],
        ),
      };
    } catch (error: any) {
      throw new Error(
        `当前 Codex 不支持 Skill 列表：${error.message || error}`,
      );
    }
  }

  async listMcpServers(providerId: string, threadId: string, verbose = false) {
    await this.ensureLoaded(providerId, threadId);
    const client = await this.ensure(providerId);
    const servers: any[] = [];
    let cursor: string | undefined;
    try {
      do {
        const result = await client.request("mcpServerStatus/list", {
          threadId,
          cursor,
          limit: 50,
          detail: verbose ? "full" : "toolsAndAuthOnly",
        });
        servers.push(...(Array.isArray(result?.data) ? result.data : []));
        cursor = result?.nextCursor || undefined;
      } while (cursor && servers.length < 200);
      return servers;
    } catch (error: any) {
      throw new Error(
        `当前 Codex 不支持 MCP 状态列表：${error.message || error}`,
      );
    }
  }

  async searchWorkspaceFiles(
    providerId: string,
    threadId: string,
    query: string,
  ) {
    const thread = this.threads.get(threadId);
    if (!thread?.cwd) throw new Error("当前会话没有可用的工作目录");
    const client = await this.ensure(providerId);
    const root = this.useWsl ? windowsPathToWsl(thread.cwd) : thread.cwd;
    try {
      const result = await client.request("fuzzyFileSearch", {
        query: query.slice(0, 500),
        roots: [root],
        cancellationToken: null,
      });
      return (Array.isArray(result?.files) ? result.files : [])
        .slice(0, 100)
        .map((file: any) => ({
          root: String(file.root || root),
          path: String(file.path || ""),
          fileName: String(file.file_name || file.fileName || ""),
          score: Number(file.score || 0),
        }))
        .filter((file: any) => file.path);
    } catch (error: any) {
      throw new Error(
        `当前 Codex 不支持工作区文件搜索：${error.message || error}`,
      );
    }
  }

  async renameThread(providerId: string, threadId: string, name: string) {
    const client = await this.ensure(providerId);
    await client.request("thread/name/set", { threadId, name });
    const existing = this.threads.get(threadId);
    if (existing) {
      existing.name = name;
      existing.updatedAt = Date.now();
      this.broadcast("thread.updated", existing);
    }
    return existing;
  }

  async updateThreadSettings(
    providerId: string,
    threadId: string,
    settings: {
      model?: string;
      reasoningEffort?: string;
      personality?: Personality;
      approvalPolicy?: string;
      approvalsReviewer?: string;
      sandbox?: string;
      serviceTier?: string | null;
    },
  ) {
    await this.ensureLoaded(providerId, threadId);
    const client = await this.ensure(providerId);
    const params: Record<string, unknown> = { threadId };
    const nextModel = normalizeCodexModel(settings.model);
    if (nextModel) params.model = nextModel;
    if (settings.reasoningEffort) params.effort = settings.reasoningEffort;
    if (settings.personality) params.personality = settings.personality;
    if (settings.approvalPolicy)
      params.approvalPolicy = settings.approvalPolicy;
    if (settings.approvalsReviewer)
      params.approvalsReviewer = settings.approvalsReviewer;
    if (settings.sandbox)
      params.sandboxPolicy = sandboxPolicyFromMode(settings.sandbox);
    if (Object.prototype.hasOwnProperty.call(settings, "serviceTier"))
      params.serviceTier = settings.serviceTier || null;
    // 手填模型清空时表示「用供应商默认」，normalize 后没有可下发字段；
    // 只剩 threadId 的空更新对 runtime 没有意义，直接跳过。
    if (Object.keys(params).length === 1) return this.threads.get(threadId);
    try {
      await client.request("thread/settings/update", params);
    } catch (error: any) {
      throw new Error(
        `当前 Codex 不支持中途修改会话设置：${error.message || error}`,
      );
    }
    const existing = this.threads.get(threadId);
    if (existing) {
      if (nextModel) existing.model = nextModel;
      if (nextModel) {
        const labelHit = this.modelCatalog
          .get(providerId)
          ?.models.find(
            (item) => item.model === nextModel || item.id === nextModel,
          );
        if (labelHit?.displayName) existing.modelLabel = labelHit.displayName;
      }
      if (settings.reasoningEffort)
        existing.reasoningEffort = settings.reasoningEffort;
      if (settings.personality) existing.personality = settings.personality;
      if (settings.approvalPolicy)
        existing.approvalPolicy =
          settings.approvalPolicy as ThreadSummary["approvalPolicy"];
      if (settings.approvalsReviewer)
        existing.approvalsReviewer =
          settings.approvalsReviewer as ThreadSummary["approvalsReviewer"];
      if (settings.sandbox)
        existing.sandbox = settings.sandbox as ThreadSummary["sandbox"];
      if (Object.prototype.hasOwnProperty.call(settings, "serviceTier"))
        existing.serviceTier = settings.serviceTier || undefined;
      existing.updatedAt = Date.now();
      this.broadcast("thread.updated", existing);
    }
    return existing;
  }

  async forkThread(
    providerId: string,
    threadId: string,
    options: { lastTurnId?: string } = {},
  ) {
    const source = this.threads.get(threadId);
    if (
      options.lastTurnId &&
      source &&
      (source.status === "running" || source.status === "waiting")
    )
      throw new Error("会话正在运行，无法从中间回合分支");
    await this.ensureLoaded(providerId, threadId);
    const client = await this.ensure(providerId);
    const provider = this.store.get(providerId)!;
    const runtimeProvider = compileRuntimeProvider(provider);
    const params: Record<string, unknown> = {
      threadId,
      model:
        normalizeCodexModel(source?.model) ||
        normalizeCodexModel(runtimeProvider.model) ||
        undefined,
      modelProvider: runtimeProvider.modelProvider,
    };
    if (source?.sandbox) params.sandbox = source.sandbox;
    if (source?.approvalPolicy) params.approvalPolicy = source.approvalPolicy;
    if (source?.approvalsReviewer)
      params.approvalsReviewer = source.approvalsReviewer;
    if (options.lastTurnId) params.lastTurnId = options.lastTurnId;
    const result = await client.request("thread/fork", params);
    this.loadedThreads.add(result.thread.id);
    this.rememberRollout(result.thread.id);
    const branchName = `${source?.name || result.thread.name || "会话"} · 分支`;
    try {
      await client.request("thread/name/set", {
        threadId: result.thread.id,
        name: branchName,
      });
    } catch {}
    this.upsertThread(
      provider,
      {
        ...result.thread,
        name: branchName,
        forkedFromId: threadId,
        sessionId:
          result.thread.sessionId ||
          result.thread.session_id ||
          result.thread.id,
        sandbox:
          parseSandboxMode(
            result.sandbox,
            result.activePermissionProfile,
            source?.sandbox,
            result.thread.sandbox,
          ) || source?.sandbox,
        approvalPolicy:
          pickString(
            result.approvalPolicy,
            source?.approvalPolicy,
            result.thread.approvalPolicy,
          ) || source?.approvalPolicy,
        approvalsReviewer:
          pickString(
            result.approvalsReviewer,
            source?.approvalsReviewer,
            result.thread.approvalsReviewer,
          ) || source?.approvalsReviewer,
        reasoningEffort: source?.reasoningEffort,
        model: normalizeCodexModel(source?.model) || result.thread.model,
      },
      "idle",
    );
    this.persistForkedSettings(result.thread.id);
    return this.threads.get(result.thread.id) || result.thread;
  }

  /**
   * fork/迁移产生的新会话：把实际生效的设置记进 thread-settings。
   * 不记的话下一次列表刷新后显示回落成服务端默认值（“fork 后重置”）。
   */
  private persistForkedSettings(newThreadId: string) {
    const branch = this.threads.get(newThreadId);
    if (!branch) return;
    void this.threadSettings
      ?.update(this.id, branch.id, {
        model: normalizeCodexModel(branch.model),
        reasoningEffort: branch.reasoningEffort,
        personality: branch.personality,
        sandbox: branch.sandbox,
        approvalPolicy: branch.approvalPolicy,
        approvalsReviewer: branch.approvalsReviewer,
        serviceTier: branch.serviceTier,
      })
      .catch(() => undefined);
  }

  /** In-place conversation rewind. Codex does not revert workspace files. */
  async revertSession(providerId: string, threadId: string, beforeTurnId?: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Codex 会话不存在");
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("任务运行中不能编辑历史消息，请先停止任务");
    const target = String(beforeTurnId || "").trim();
    if (!target) throw new Error("请选择要编辑的消息");
    await this.ensureLoaded(providerId, threadId);
    const client = await this.ensure(providerId);
    await client.request("thread/revert", { threadId, beforeTurnId: target });
    thread.status = "idle";
    thread.activeTurnId = undefined;
    thread.lastError = undefined;
    thread.updatedAt = Date.now();
    delete thread.tokenUsage;
    void this.usageStore.remove(threadId).catch(() => undefined);
    this.broadcast("thread.updated", thread);
    return { messageID: target, files: 0, additions: 0, deletions: 0 };
  }

  private async createEmptyFork(providerId: string, source: ThreadSummary) {
    const branchName = `${source.name || "会话"} · 分支`;
    const created = await this.createThread(providerId, {
      cwd: source.cwd,
      model: source.model,
      reasoningEffort: source.reasoningEffort,
      personality: source.personality,
      approvalPolicy: source.approvalPolicy,
      approvalsReviewer: source.approvalsReviewer,
      sandbox: source.sandbox,
      name: branchName,
    });
    const branch = this.threads.get(created.id);
    if (!branch) throw new Error("重试分支创建失败");
    branch.forkedFromId = source.id;
    branch.updatedAt = Date.now();
    this.broadcast("thread.updated", branch);
    return branch;
  }

  async retryFromTurn(
    providerId: string,
    threadId: string,
    turnId: string,
    text: string,
    images?: TurnImage[],
  ) {
    const source = this.threads.get(threadId);
    if (!source) throw new Error("源会话不存在，请刷新后重试");
    if (source.status === "running" || source.status === "waiting")
      throw new Error("会话正在运行或等待确认，无法从历史消息重试");

    const full = await this.readThread(providerId, threadId);
    const turns = Array.isArray(full?.turns) ? full.turns : [];
    const targetIndex = turns.findIndex((turn: any) => turn?.id === turnId);
    if (targetIndex < 0) throw new Error("找不到这条消息所属的回合");

    const previousTurnId =
      targetIndex > 0 ? String(turns[targetIndex - 1]?.id || "") : "";
    const branch = previousTurnId
      ? await this.forkThread(providerId, threadId, {
          lastTurnId: previousTurnId,
        })
      : await this.createEmptyFork(providerId, source);
    await this.sendTurn(providerId, branch.id, text, images);
    return this.threads.get(branch.id) || branch;
  }

  async migrateThread(
    sourceProviderId: string,
    sourceThreadId: string,
    targetProviderId: string,
    options: { model?: string; reasoningEffort?: string } = {},
  ) {
    if (sourceProviderId === targetProviderId)
      throw new Error("目标供应商与当前供应商相同");
    const source = this.threads.get(sourceThreadId);
    if (!source) throw new Error("源会话不存在，请先刷新会话列表");
    if (source.status === "running" || source.status === "waiting")
      throw new Error("会话正在运行或等待确认，请完成当前任务后再切换供应商");
    const target = this.store.get(targetProviderId);
    if (!target || !target.enabled) throw new Error("目标供应商不可用");

    if (this.canSwitchWithoutFork(source))
      return this.migrateUnsentThread(source, target, options);

    const client = await this.ensure(targetProviderId);
    const runtimeProvider = compileRuntimeProvider(target);
    const requestedModel =
      normalizeCodexModel(options.model) ||
      normalizeCodexModel(runtimeProvider.model) ||
      undefined;
    let result: any;
    try {
      result = await client.request("thread/fork", {
        threadId: sourceThreadId,
        model: requestedModel,
        modelProvider: runtimeProvider.modelProvider,
        approvalPolicy: source.approvalPolicy || "on-request",
        approvalsReviewer: source.approvalsReviewer || "auto_review",
        sandbox: source.sandbox || "workspace-write",
      });
    } catch (error: unknown) {
      if (!isMissingRolloutError(error)) throw error;
      return this.migrateUnsentThread(source, target, options);
    }
    this.loadedThreads.add(result.thread.id);
    this.rememberRollout(result.thread.id);
    if (
      result.thread?.modelProvider &&
      result.thread.modelProvider !== runtimeProvider.modelProvider
    )
      throw new Error(
        `供应商切换分支未生效（仍为 ${result.thread.modelProvider}）`,
      );
    this.upsertThread(target, {
      ...result.thread,
      model: requestedModel || result.thread.model,
      reasoningEffort: options.reasoningEffort || source.reasoningEffort,
      sandbox:
        parseSandboxMode(
          result.sandbox,
          result.activePermissionProfile,
          source.sandbox,
        ) || source.sandbox,
      approvalPolicy:
        pickString(result.approvalPolicy, source.approvalPolicy) ||
        source.approvalPolicy,
      approvalsReviewer:
        pickString(result.approvalsReviewer, source.approvalsReviewer) ||
        source.approvalsReviewer,
      forkedFromId: sourceThreadId,
      migratedFrom: { providerId: sourceProviderId, threadId: sourceThreadId },
    });
    this.persistForkedSettings(result.thread.id);
    return result.thread;
  }

  private canSwitchWithoutFork(thread: ThreadSummary) {
    return this.inMemoryThreads.has(thread.id);
  }

  private rememberRollout(threadId?: string) {
    if (!threadId) return;
    this.knownRollouts.add(threadId);
    this.inMemoryThreads.delete(threadId);
  }

  private async migrateUnsentThread(
    source: ThreadSummary,
    target: Provider,
    options: { model?: string; reasoningEffort?: string },
  ) {
    const created = await this.createThread(target.id, {
      cwd: source.cwd,
      model: options.model,
      reasoningEffort: options.reasoningEffort || source.reasoningEffort,
      personality: source.personality,
      approvalPolicy: source.approvalPolicy,
      approvalsReviewer: source.approvalsReviewer,
      sandbox: source.sandbox,
      name: source.name && source.name !== "新会话" ? source.name : undefined,
    });
    const next = this.threads.get(created.id);
    if (next) {
      next.migratedFrom = {
        providerId: source.providerId,
        threadId: source.id,
      };
      this.broadcast("thread.updated", next);
    }
    this.removeThread(source.id);
    return this.threads.get(created.id) || created;
  }

  async archiveThread(providerId: string, threadId: string) {
    const client = await this.ensure(providerId);
    await client.request("thread/archive", { threadId });
    this.markArchived(threadId, true);
    return { ok: true };
  }

  async unarchiveThread(providerId: string, threadId: string) {
    const client = await this.ensure(providerId);
    const result = await client.request("thread/unarchive", { threadId });
    this.markArchived(threadId, false);
    if (result?.thread)
      this.upsertThread(this.providerForThread(result.thread), {
        ...result.thread,
        archived: false,
      });
    return result?.thread || this.threads.get(threadId);
  }

  async deleteThread(providerId: string, threadId: string) {
    const client = await this.ensure(providerId);
    await client.request("thread/delete", { threadId });
    this.removeThread(threadId);
    return { ok: true };
  }

  async readThread(providerId: string, threadId: string) {
    // thread/start creates an in-memory, empty session. Some runtimes answer
    // includeTurns with "list_turns is not supported yet" until the first
    // turn is persisted. We already have all metadata needed to show it.
    // loadedThreads 不能用来判断：外部客户端 resume 历史会话同样会触发
    // thread/started 把它装进来，混用会把有历史的会话直接读成空。
    if (this.inMemoryThreads.has(threadId)) {
      const fresh = this.threads.get(threadId);
      if (fresh) return { ...fresh, turns: [] };
    }
    const client = await this.ensure(providerId);
    const read = (includeTurns: boolean) =>
      client
        .request("thread/read", { threadId, includeTurns })
        .then((result) => {
          const thread = result.thread;
          if (!thread) return thread;
          const tokenUsage = parseTokenUsage(thread);
          const existing = this.threads.get(threadId);
          const restored =
            tokenUsage || existing?.tokenUsage || this.usageStore.get(threadId);
          const normalized = restored
            ? { ...thread, tokenUsage: restored }
            : thread;
          this.stampTurnModels(normalized);
          this.stampTurnStats(normalized);
          this.flagMissingHistory(normalized, includeTurns, restored);
          if (existing && restored) {
            existing.tokenUsage = restored;
            this.broadcast("thread.updated", existing);
          }
          if (tokenUsage)
            this.rememberUsage(threadId, tokenUsage, {
              providerId:
                this.threads.get(threadId)?.providerId ||
                this.providerForThread(thread).id,
              at: parseTimestamp(
                thread.updatedAt,
                thread.updated_at,
                thread.lastUpdatedAt,
                thread.last_updated_at,
              ),
            });
          return normalized;
        });
    try {
      return await read(true);
    } catch (error: unknown) {
      const kind = classifyThreadStoreError(error);
      if (kind !== "unmaterialized") throw explainThreadStoreError(error, kind);
      // thread/start is usable in memory before Codex flushes the rollout.
      // 0.147 may also create an empty jsonl and reject includeTurns until
      // the first bytes land. Retry briefly, then fall back to metadata.
      if (this.loadedThreads.has(threadId)) {
        for (let attempt = 0; attempt < 2; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 80));
          try {
            return await read(true);
          } catch (retryError: unknown) {
            if (classifyThreadStoreError(retryError) !== "unmaterialized")
              throw explainThreadStoreError(retryError);
          }
        }
      }
      try {
        return await read(false);
      } catch (metadataError: unknown) {
        if (classifyThreadStoreError(metadataError) !== "unmaterialized")
          throw explainThreadStoreError(metadataError);
        // Some app-server versions route even includeTurns=false through
        // list_turns for an empty rollout. The list/start summary is enough
        // to render that session until its first turn is written.
        const cached = this.threads.get(threadId);
        if (cached) return { ...cached, turns: [] };
        throw explainThreadStoreError(metadataError);
      }
    }
  }

  /**
   * includeTurns 正常返回但 turns 为空、而会话明明跑过（有用量/预览）：
   * 多半是 rollout 文件缺失（CODEX_HOME 被替换、文件被移走）。本地运行时
   * 可以直接 stat；WSL 下 thread.path 是 WSL 内部路径，跳过检查以免误报。
   * 命中的结果带 historyMissing，前端据此提示而不是渲染成全新空会话。
   */
  private flagMissingHistory(
    thread: any,
    includeTurns: boolean,
    usage?: TokenUsage | null,
  ) {
    if (!includeTurns || !Array.isArray(thread?.turns) || thread.turns.length)
      return;
    if (!thread.preview && Number(usage?.used || 0) <= 0) return;
    const rolloutPath = pickString(
      thread.path,
      thread.rolloutPath,
      thread.rollout_path,
    );
    if (!rolloutPath || this.useWsl) return;
    try {
      if (!existsSync(rolloutPath)) thread.historyMissing = rolloutPath;
    } catch {
      // stat 失败按正常空会话处理
    }
  }

  /**
   * Codex 的 turn 记录不含模型；把 turn/started 时记入的快照回填到
   * turn.model / turn.reasoningEffort。agent 自带字段（或老数据没有快照）
   * 时保持原值，由前端回落到会话当前模型。
   */
  private stampTurnModels(thread: any) {
    const turns = thread?.turns;
    if (!Array.isArray(turns) || !this.threadSettings) return;
    for (const turn of turns) {
      if (!turn || turn.model) continue;
      const stamp = this.threadSettings.turnModel(
        this.id,
        String(thread.id),
        String(turn.id || ""),
      );
      if (stamp?.model) turn.model = stamp.model;
      if (stamp?.reasoningEffort && !turn.reasoningEffort)
        turn.reasoningEffort = stamp.reasoningEffort;
    }
  }

  private async prepareThread(providerId: string, threadId: string) {
    const client = await this.ensure(providerId);
    // A thread returned by thread/start is already loaded, but has no rollout
    // until its first turn. Resuming it here fails with "no rollout found".
    // Threads discovered by thread/list, on the other hand, must be resumed.
    if (!this.loadedThreads.has(threadId)) {
      await this.resumeThread(client, providerId, threadId);
      this.loadedThreads.add(threadId);
    }
    this.rememberRollout(threadId);
    return client;
  }

  async sendTurn(
    providerId: string,
    threadId: string,
    text: string,
    images?: TurnImage[],
  ) {
    return (await this.deliverTurn(providerId, threadId, text, images)).response;
  }

  async sendMessage(providerId: string, threadId: string, input: AgentMessageInput): Promise<AgentMessageAcceptance> {
    const { response: _response, ...acceptance } = await this.deliverTurn(
      providerId, threadId, input.text, input.images, input,
    );
    return acceptance;
  }

  private async deliverTurn(
    providerId: string,
    threadId: string,
    text: string,
    images?: TurnImage[],
    message?: AgentMessageInput,
  ): Promise<AgentMessageAcceptance & { response: any }> {
    let client;
    try {
      client = await this.prepareThread(providerId, threadId);
    } catch (error: unknown) {
      throw explainThreadStoreError(error);
    }
    const existing = this.threads.get(threadId);
    if (message) {
      if (!existing) throw new Error("会话不存在");
      assertMessageInput(existing, message, CODEX_CAPABILITIES.messages!);
    }
    const input = buildTurnInput(text, images);
    const startTurn = async () => {
      if (this.threadSettings?.deferred?.(this.id, threadId))
        await this.threadSettings.applyDeferred(this.id, threadId, (settings) =>
          this.updateThreadSettings(providerId, threadId, settings),
        );
      // Do not re-send sandbox/approval here. thread/start, resume, and
      // thread/settings/update already applied them. Repeating the policy on
      // every turn/start makes Codex rebuild the instruction prefix and
      // drops prompt cache to the static ~3.5k header.
      return client.request("turn/start", { threadId, input });
    };
    const start = async () => {
      let response;
      try {
        response = await startTurn();
      } catch (error: unknown) {
        response = await this.retryTurnAfterMissing(client, providerId, threadId, error, startTurn);
      }
      return { response, disposition: "started" as const, turnId: response?.turn?.id };
    };
    if (
      existing &&
      (existing?.status === "running" || existing?.status === "waiting" || message?.mode === "append") &&
      existing.activeTurnId &&
      !existing.compacting
    ) {
      const expectedTurnId = existing.activeTurnId;
      try {
        const response = await client.request("turn/steer", {
          threadId,
          expectedTurnId,
          input,
        });
        return { response, disposition: "appended", turnId: response?.turnId || expectedTurnId };
      } catch (error: any) {
        // 严格追加不能悄悄创建新回合，expectedTurnId 也不能被恢复逻辑绕过。
        if (message?.mode === "append" || message?.expectedTurnId) {
          if (/no active turn/i.test(String(error?.message || error)))
            throw new AgentMessageError("no_active_turn", "目标回合已结束，消息未追加");
          throw error;
        }
        if (
          !String(error?.message || "")
            .toLowerCase()
            .includes("no active turn")
        ) {
          const response = await this.retryTurnAfterMissing(client, providerId, threadId, error, startTurn);
          return { response, disposition: "started", turnId: response?.turn?.id };
        }
      }
    }
    return start();
  }

  private async retryTurnAfterMissing(
    client: { request: (method: string, params?: unknown) => Promise<any> },
    providerId: string,
    threadId: string,
    error: unknown,
    startTurn: () => Promise<any>,
  ) {
    if (classifyThreadStoreError(error) !== "notInRuntime")
      throw explainThreadStoreError(error);
    this.loadedThreads.delete(threadId);
    try {
      await this.resumeThread(client, providerId, threadId);
      this.loadedThreads.add(threadId);
    } catch (resumeError: unknown) {
      throw explainThreadStoreError(resumeError);
    }
    try {
      return await startTurn();
    } catch (retryError: unknown) {
      throw explainThreadStoreError(retryError);
    }
  }

  async reviewThread(
    providerId: string,
    threadId: string,
    target?: ReviewTarget,
    delivery: "inline" | "detached" = "inline",
  ) {
    const client = await this.prepareThread(providerId, threadId);
    return client.request(
      "review/start",
      reviewParams(threadId, target, delivery),
    );
  }

  async runShellCommand(providerId: string, threadId: string, command: string) {
    const trimmed = command.trim();
    if (!trimmed) throw new Error("请输入要执行的命令");
    const client = await this.prepareThread(providerId, threadId);
    return client.request("thread/shellCommand", {
      threadId,
      command: trimmed,
    });
  }

  async setThreadGoal(
    providerId: string,
    threadId: string,
    objective?: string | null,
  ) {
    const client = await this.prepareThread(providerId, threadId);
    const text = objective?.trim();
    if (!text) return client.request("thread/goal/clear", { threadId });
    return client.request("thread/goal/set", {
      threadId,
      objective: text,
    });
  }

  sendInitTurn(providerId: string, threadId: string) {
    return this.sendTurn(providerId, threadId, INIT_PROMPT);
  }

  sendPlanTurn(providerId: string, threadId: string) {
    return this.sendTurn(providerId, threadId, PLAN_PROMPT);
  }

  showDiff(providerId: string, threadId: string) {
    return this.runShellCommand(providerId, threadId, DIFF_SHELL_COMMAND);
  }

  async compactThread(providerId: string, threadId: string) {
    const existing = this.threads.get(threadId);
    if (existing) this.setCompacting(existing, true, true);
    try {
      const client = await this.prepareThread(providerId, threadId);
      return await client.request("thread/compact/start", { threadId });
    } catch (error) {
      if (existing) this.setCompacting(existing, false, true);
      throw error;
    }
  }

  private setCompacting(
    thread: ThreadSummary,
    compacting: boolean,
    notify = false,
  ) {
    const timer = this.compactionTimers.get(thread.id);
    if (timer) clearTimeout(timer);
    this.compactionTimers.delete(thread.id);
    thread.compacting = compacting;
    if (compacting) {
      const next = setTimeout(() => {
        this.compactionTimers.delete(thread.id);
        const current = this.threads.get(thread.id);
        if (!current?.compacting) return;
        current.compacting = false;
        current.updatedAt = Date.now();
        this.broadcast("thread.updated", current);
      }, COMPACTION_TIMEOUT_MS);
      next.unref();
      this.compactionTimers.set(thread.id, next);
    }
    if (notify) {
      thread.updatedAt = Date.now();
      this.broadcast("thread.updated", thread);
    }
  }

  private clearCompactions() {
    for (const timer of this.compactionTimers.values()) clearTimeout(timer);
    this.compactionTimers.clear();
    for (const thread of this.threads.values()) {
      if (!thread.compacting) continue;
      thread.compacting = false;
      thread.updatedAt = Date.now();
      this.broadcast("thread.updated", thread);
    }
  }

  /**
   * app-server 被外部结束（如后台 ctrl+C）后不会再有 turn/completed 通知，
   * running/waiting 的会话必须在此处解除占用，否则分支、重试、供应商配置
   * 变更都会被“会话正在运行”永久挡住，中断按钮也指向一个不存在的 turn。
   * 被中断的 turn id 记进摘要（随 thread-summaries.json 持久化），刷新时
   * 不会把它从 Codex state DB 的 inProgress 记录恢复成 running。
   */
  private markOffline() {
    for (const [approvalId] of this.approvals)
      this.broadcast("approval.resolved", { approvalId });
    this.approvals.clear();
    this.pendingFileChanges.clear();
    for (const thread of this.threads.values()) {
      if (thread.status !== "running" && thread.status !== "waiting") continue;
      thread.status = "offline";
      thread.interruptedTurnId = thread.activeTurnId;
      thread.activeTurnId = undefined;
      thread.lastError = "Codex 运行时已退出，该任务被中断";
      thread.errorCode = undefined;
      thread.updatedAt = Date.now();
      this.broadcast("thread.updated", thread);
    }
  }

  async interrupt(providerId: string, threadId: string, turnId: string) {
    return (await this.ensure(providerId)).request("turn/interrupt", {
      threadId,
      turnId,
    });
  }

  /**
   * 紧急停止：完成事件在断流/后端异常中丢失时，会话可能永久卡在
   * running/waiting。先尽力打断在途回合（后端已正常收尾的回合会按
   * turn/completed 自愈），随后把该会话的挂起审批撤掉、本地状态强制
   * 归位 idle。interruptedTurnId 记下回合 id，刷新不会把它恢复成 running。
   */
  async forceStop(providerId: string, threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Codex 会话不存在");
    const turnId = thread.activeTurnId;
    if (turnId)
      void this.interrupt(providerId, threadId, turnId).catch(() => undefined);
    for (const [approvalId, approval] of this.approvals)
      if (String(approval.request?.params?.threadId || "") === threadId) {
        const params = approval.request.params || {};
        const itemId = params.itemId || params.item?.id;
        // fileChange 明细只为挂起的审批服务，撤掉审批时一并回收。
        if (itemId) this.pendingFileChanges.delete(itemId);
        this.approvals.delete(approvalId);
        this.broadcast("approval.resolved", { approvalId });
      }
    const compactionTimer = this.compactionTimers.get(threadId);
    if (compactionTimer) {
      clearTimeout(compactionTimer);
      this.compactionTimers.delete(threadId);
    }
    this.runningTurns.delete(threadId);
    if (thread.status !== "running" && thread.status !== "waiting") return { ok: true as const };
    thread.status = "idle";
    thread.interruptedTurnId = turnId;
    thread.activeTurnId = undefined;
    thread.lastError = undefined;
    thread.errorCode = undefined;
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    return { ok: true as const };
  }

  async backgroundTerminals(providerId: string, threadId: string) {
    if (this.backgroundTerminalApi === false)
      return { data: [], supported: false };
    try {
      const result = await (
        await this.ensure(providerId)
      ).request(
        "thread/backgroundTerminals/list",
        { threadId, limit: 100 },
        10_000,
      );
      this.backgroundTerminalApi = true;
      const data = (result.data || []).map((item: any) => ({
        itemId: item.itemId ? String(item.itemId) : undefined,
        processId: item.processId ? String(item.processId) : undefined,
        command: String(item.command || "后台终端"),
        cwd: item.cwd ? String(item.cwd) : undefined,
        osPid: typeof item.osPid === "number" ? item.osPid : null,
        cpuPercent:
          typeof item.cpuPercent === "number" ? item.cpuPercent : null,
        rssKb: typeof item.rssKb === "number" ? item.rssKb : null,
      }));
      return { data, supported: true };
    } catch (error: any) {
      const message = String(error?.message || error);
      if (
        /unknown method|method not found|unsupported|invalid request/i.test(
          message,
        )
      ) {
        this.backgroundTerminalApi = false;
        return { data: [], supported: false };
      }
      return { data: [], supported: true, error: message };
    }
  }

  async terminateBackgroundTerminal(
    providerId: string,
    threadId: string,
    processId: string,
  ) {
    if (this.backgroundTerminalApi === false)
      throw new Error("当前 Codex 服务不支持单独停止后台终端");
    const result = await (
      await this.ensure(providerId)
    ).request("thread/backgroundTerminals/terminate", { threadId, processId });
    this.backgroundTerminalApi = true;
    return result;
  }

  async resolveApproval(
    approvalId: string,
    body:
      | string
      | {
          decision?: string;
          permissions?: unknown;
          scope?: "session" | "turn";
          answers?: unknown;
        },
  ) {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error("审批已处理或不存在");
    const payload = typeof body === "string" ? { decision: body } : body;
    const method = approval.request.method || "";
    const kind = classifyApprovalMethod(method);
    let result: Record<string, unknown>;
    if (kind === "command" || kind === "file") {
      if (!payload.decision) throw new Error("缺少审批决定");
      result = { decision: payload.decision };
    } else if (kind === "permission") {
      result = { permissions: payload.permissions, scope: payload.scope };
    } else if (kind === "question") {
      result = { answers: payload.answers };
    } else {
      throw new Error("未知审批类型，未向 Codex 发送响应");
    }
    const client = await this.ensure(approval.providerId);
    client.respond(approval.request.id!, result);
    const params = approval.request.params || {};
    const itemId = params.itemId || params.item?.id;
    // fileChange 明细只为本次审批服务，决议后即删，否则 key 永不回收。
    if (itemId) this.pendingFileChanges.delete(itemId);
    this.approvals.delete(approvalId);
    this.broadcast("approval.resolved", { approvalId });
  }

  // account/updated、turn 失败、前端手动刷新都会走到这里；rateLimits/read
  // 上游会请求 wham/usage，不能裸奔。被动触发走 60s 冷却 + 在途去重，
  // 只有用户点“重新读取”（force）才绕过冷却。
  private static USAGE_REFRESH_COOLDOWN_MS = 60_000;

  loadOfficialUsage(force = false) {
    const client = this.client;
    if (!client?.online) return Promise.resolve(this.runtimeStatus());
    if (
      !force &&
      this.usageFetchedAt &&
      Date.now() - this.usageFetchedAt < CodexAdapter.USAGE_REFRESH_COOLDOWN_MS
    )
      return Promise.resolve(this.runtimeStatus());
    if (this.usageLoading) return this.usageLoading;
    this.usageFetchedAt = Date.now();
    const loading = this.fetchOfficialUsage(client);
    this.usageLoading = loading;
    return loading.finally(() => {
      if (this.usageLoading === loading) this.usageLoading = undefined;
    });
  }

  private async fetchOfficialUsage(client: CodexClient) {
    try {
      const accountRaw = await client.request("account/read", {});
      this.account = parseAccount(accountRaw);
      if (!isChatgptAccount(this.account)) {
        this.rateLimits = null;
        this.rateLimitsError =
          "当前服务未使用官方 ChatGPT 登录，额度不可用";
        this.broadcast("runtime.status", this.runtimeStatus());
        return this.runtimeStatus();
      }
      try {
        const limitsRaw = await client.request("account/rateLimits/read", {});
        this.rateLimits = parseRateLimits(limitsRaw);
        this.rateLimitsError = this.rateLimits
          ? undefined
          : "官方账号额度暂不可用";
      } catch (error: any) {
        this.rateLimits = null;
        this.rateLimitsError = String(error?.message || "额度读取失败");
      }
    } catch (error: any) {
      this.rateLimits = null;
      this.rateLimitsError = String(error?.message || "账号信息读取失败");
    }
    this.broadcast("runtime.status", this.runtimeStatus());
    return this.runtimeStatus();
  }

  private upsertThread(
    provider: Provider,
    thread: any,
    status?: ThreadSummary["status"],
  ) {
    const key = thread.id;
    const old = this.threads.get(key);
    const latestTurn = thread.turns?.at?.(-1);
    const latestError = this.turnError(latestTurn?.error);
    // 该 turn 在 runtime 崩溃时仍在进行，Codex state DB 不会再有它的完成
    // 记录；不能让刷新把它恢复成 running，否则会话再次被“正在运行”挡住。
    const staleRunning =
      latestTurn?.status === "inProgress" &&
      Boolean(old?.interruptedTurnId) &&
      latestTurn.id === old?.interruptedTurnId;
    const latestStatus: ThreadSummary["status"] | undefined = latestTurn
      ? latestTurn.status === "inProgress"
        ? "running"
        : latestTurn.status === "failed"
          ? "error"
          : "idle"
      : undefined;
    const preview =
      thread.preview || this.extractPreview(thread) || old?.preview || "新会话";
    const parsedUsage = parseTokenUsage(
      thread.tokenUsage || thread.token_usage,
    );
    const item: ThreadSummary = {
      agentId: this.id,
      id: thread.id,
      providerId: provider.id,
      name: thread.name || preview.slice(0, 42),
      preview,
      cwd: thread.cwd || old?.cwd || "",
      model:
        normalizeCodexModel(thread.model) ||
        normalizeCodexModel(provider.model) ||
        normalizeCodexModel(old?.model) ||
        "default",
      status: status
        ? status
        : staleRunning
          ? "error"
          : latestStatus || old?.status || "idle",
      updatedAt:
        parseTimestamp(
          thread.updatedAt,
          thread.updated_at,
          thread.lastUpdatedAt,
          thread.last_updated_at,
          thread.createdAt,
          thread.created_at,
        ) ||
        old?.updatedAt ||
        timestampFromId(thread.id) ||
        Date.now(),
      activeTurnId: latestTurn
        ? latestTurn.status === "inProgress" && !staleRunning
          ? latestTurn.id
          : undefined
        : old?.activeTurnId,
      lastError: staleRunning
        ? "Codex 运行时已退出，该任务被中断"
        : latestTurn
          ? latestTurn.status === "failed"
            ? latestError?.message
            : undefined
          : old?.lastError,
      errorCode: staleRunning
        ? undefined
        : latestTurn
          ? latestTurn.status === "failed"
            ? latestError?.code
            : undefined
          : old?.errorCode,
      interruptedTurnId: staleRunning ? old?.interruptedTurnId : undefined,
      archived: thread.archived ?? old?.archived,
      reasoningEffort: thread.reasoningEffort || old?.reasoningEffort,
      personality: thread.personality || old?.personality,
      sandbox:
        parseSandboxMode(
          thread.sandbox,
          thread.sandboxMode,
          thread.sandbox_mode,
          thread.sandboxPolicy,
          thread.sandbox_policy,
          thread.activePermissionProfile,
        ) || old?.sandbox,
      approvalPolicy:
        (pickString(thread.approvalPolicy, thread.approval_policy) as
          ThreadSummary["approvalPolicy"] | undefined) || old?.approvalPolicy,
      approvalsReviewer:
        (pickString(thread.approvalsReviewer, thread.approvals_reviewer) as
          ThreadSummary["approvalsReviewer"] | undefined) ||
        old?.approvalsReviewer,
      serviceTier:
        pickString(thread.serviceTier, thread.service_tier) || old?.serviceTier,
      forkedFromId:
        pickString(
          thread.forkedFromId,
          thread.forked_from_id,
          thread.parentThreadId,
        ) || old?.forkedFromId,
      sessionId:
        pickString(thread.sessionId, thread.session_id) || old?.sessionId,
      tokenUsage:
        parsedUsage || old?.tokenUsage || this.usageStore.get(thread.id),
      compacting:
        typeof thread.compacting === "boolean"
          ? thread.compacting
          : old?.compacting,
      migratedFrom: thread.migratedFrom || old?.migratedFrom,
      controlMode:
        status || this.loadedThreads.has(thread.id)
          ? "managed"
          : old?.controlMode || "history",
      ...this.threadSettings?.get(this.id, key),
    };
    this.threads.set(key, item);
    if (parsedUsage)
      this.rememberUsage(item.id, parsedUsage, {
        providerId: item.providerId,
        at: item.updatedAt,
      });
    if (thread.turns?.length || thread.preview) this.rememberRollout(thread.id);
    if (item.cwd) void this.projects?.rememberSeen(item.cwd, item.updatedAt);
    this.broadcast("thread.updated", item);
  }

  private extractPreview(thread: any) {
    for (const turn of thread.turns || [])
      for (const item of turn.items || []) {
        if (item.type !== "userMessage") continue;
        // Codex 会把 environment_context / AGENTS.md 等注入内容写进
        // userMessage——预览只取剥离后的可见文本，纯注入的消息跳过。
        const raw = item.content?.find((x: any) => x.type === "text")?.text;
        const text = visibleUserText(String(raw ?? ""));
        if (text) return text;
      }
    return "";
  }

  private onNotification(
    messageOrProviderId: RpcMessage | string,
    legacyMessage?: RpcMessage,
  ) {
    const message = legacyMessage || (messageOrProviderId as RpcMessage);
    const params = message.params || {};
    if (message.method === "account/updated") {
      const parsed = parseAccount(params.account || params);
      if (parsed) this.account = parsed;
      void this.loadOfficialUsage();
    }
    if (message.method === "account/rateLimits/updated") {
      const parsed = parseRateLimits(params.rateLimits || params);
      this.rateLimits = parsed;
      this.rateLimitsError = parsed ? undefined : this.rateLimitsError;
      this.broadcast("runtime.status", this.runtimeStatus());
    }
    const item = params.item;
    if (item && typeof item === "object") {
      // Deck 侧工具计时：item/started 落开始，item/completed 落结束；
      // 原生 item 本无时间字段，历史重拉无计时则前端不展示。
      const now = Date.now();
      if (message.method === "item/started" && item.startedAt == null)
        item.startedAt = now;
      else if (message.method === "item/completed" && item.endedAt == null)
        item.endedAt = now;
    }
    if (item?.id && (item.type === "fileChange" || item.changes)) {
      const changes = parseFileChanges(item.changes);
      if (changes) {
        // 有界：approval 决议后会删除对应条目，这里再兜一层上限，
        // 防止异常路径（如 runtime 掉线）下无限累积。
        if (this.pendingFileChanges.size >= 1000) {
          const overflow = this.pendingFileChanges.size - 800;
          let removed = 0;
          for (const key of this.pendingFileChanges.keys()) {
            if (removed++ >= overflow) break;
            this.pendingFileChanges.delete(key);
          }
        }
        this.pendingFileChanges.set(item.id, changes);
        this.attachFileChanges(item.id);
      }
    }
    const thread = params.thread;
    const threadId = params.threadId || thread?.id;
    if (threadId && message.method === "thread/started")
      this.loadedThreads.add(threadId);
    if (threadId && message.method === "thread/closed")
      this.loadedThreads.delete(threadId);
    if (threadId && message.method === "thread/archived")
      this.markArchived(threadId, true);
    if (threadId && message.method === "thread/unarchived")
      this.markArchived(threadId, false);
    if (threadId && message.method === "thread/deleted") {
      this.removeThread(threadId);
      return this.broadcast("codex.event", { agentId: this.id, ...message });
    }
    if (thread) this.upsertThread(this.providerForThread(thread), thread);
    const existing = threadId ? this.threads.get(threadId) : undefined;
    if (existing) {
      existing.controlMode = "managed";
      // per-item 生成统计：reasoning/agentMessage 走窗口差值。
      if (
        (item?.type === "reasoning" || item?.type === "agentMessage") &&
        (message.method === "item/started" || message.method === "item/completed")
      ) {
        const itemId = String(item.id || "");
        if (itemId) this.noteItemUsage(item, message.method, itemId, existing, Date.now());
      }
      if (message.method === "thread/status/changed") {
        const type = params.status?.type;
        existing.status =
          type === "active"
            ? params.status.activeFlags?.length
              ? "waiting"
              : "running"
            : type === "systemError" || existing.lastError
              ? "error"
              : "idle";
      }
      if (message.method === "turn/started") {
        this.rememberRollout(existing.id);
        existing.status = "running";
        existing.activeTurnId = params.turn?.id;
        if (params.turn?.id)
          void this.threadSettings
            ?.recordTurnModel(this.id, existing.id, String(params.turn.id), {
              model: existing.resolvedModel || existing.model,
              reasoningEffort: existing.reasoningEffort,
            })
            ?.catch(() => undefined);
        // 本轮产出基线：累计生成 token + 开始时间，供 turn/progress
        // 直播与 turn/completed 结算 turn.stats。全新线程还没有任何
        // tokenUsage 且 usageStore 也无记录（连续回退等场景都不会留
        // 记录），基线按 0 起算——首回合的累计生成就是本轮产出；
        // usageStore 有记录但内存没生效时保持未知，宁可不算不多算。
        if (params.turn?.id)
          this.runningTurns.set(existing.id, {
            turnId: String(params.turn.id),
            startedAt: Date.now(),
            generatedBefore:
              this.generatedOf(existing.tokenUsage) ??
              (this.usageStore.get(existing.id) ? undefined : 0),
            lastEmitAt: 0,
          });
        existing.interruptedTurnId = undefined;
        existing.updatedAt = Date.now();
        existing.lastError = undefined;
        existing.errorCode = undefined;
      }
      if (message.method === "turn/completed") {
        const failed = params.turn?.status === "failed";
        existing.status = failed ? "error" : "idle";
        existing.activeTurnId = undefined;
        this.setCompacting(existing, false);
        this.finishRunningTurn(existing, params.turn?.id);
        // interrupted 等非失败收尾也可能带 error 字段，只有 failed 才上横幅。
        const error = this.turnError(params.turn?.error);
        existing.lastError = failed ? error?.message : undefined;
        existing.errorCode = failed ? error?.code : undefined;
        if (failed && this.isUsageLimitError(error?.code))
          void this.loadOfficialUsage();
      }
      if (message.method === "error" && !params.willRetry) {
        const error = this.turnError(params.error);
        existing.status = "error";
        existing.activeTurnId = undefined;
        this.setCompacting(existing, false);
        this.runningTurns.delete(existing.id);
        existing.lastError = error?.message || "Codex 任务失败";
        existing.errorCode = error?.code;
        if (this.isUsageLimitError(error?.code)) void this.loadOfficialUsage();
      }
      if (message.method === "thread/name/updated" && params.name)
        existing.name = params.name;
      if (
        message.method === "thread/tokenUsage/updated" ||
        message.method === "thread/token_usage/updated"
      ) {
        const usage =
          parseTokenUsage(params.tokenUsage || params.usage || params) ||
          existing.tokenUsage;
        existing.tokenUsage = usage;
        if (usage) {
          this.rememberUsage(existing.id, usage, {
            providerId: existing.providerId,
          });
          this.noteTurnProgress(existing, usage);
        }
      }
      if (
        message.method === "thread/compact/started" ||
        message.method === "thread/compact/start"
      )
        this.setCompacting(existing, true);
      if (
        message.method === "thread/compact/completed" ||
        message.method === "thread/compacted"
      )
        this.setCompacting(existing, false);
      if (
        item?.type === "contextCompaction" ||
        item?.type === "context_compaction"
      ) {
        if (message.method === "item/started")
          this.setCompacting(existing, true);
        if (message.method === "item/completed")
          this.setCompacting(existing, false);
      }
      if (message.method === "thread/settings/updated") {
        const settings = params.threadSettings || params.settings || {};
        if (settings.model) existing.model = settings.model;
        if (settings.effort || settings.reasoningEffort)
          existing.reasoningEffort =
            settings.effort || settings.reasoningEffort;
        if (settings.personality) existing.personality = settings.personality;
        const sandbox = parseSandboxMode(
          settings.sandboxPolicy,
          settings.sandbox_policy,
          settings.sandbox,
          settings.activePermissionProfile,
        );
        if (sandbox) existing.sandbox = sandbox;
        if (settings.approvalPolicy)
          existing.approvalPolicy = settings.approvalPolicy;
        if (settings.approvalsReviewer)
          existing.approvalsReviewer = settings.approvalsReviewer;
        if (Object.prototype.hasOwnProperty.call(settings, "serviceTier"))
          existing.serviceTier = settings.serviceTier || undefined;
      }
      if (
        message.method === "turn/started" ||
        message.method === "turn/completed" ||
        (message.method === "error" && !params.willRetry) ||
        message.method === "thread/name/updated"
      )
        existing.updatedAt = Date.now();
      this.broadcast("thread.updated", existing);
    }
    this.broadcast("codex.event", {
      agentId: this.id,
      providerId: existing?.providerId,
      ...message,
    });
  }

  private onRequest(request: RpcMessage) {
    const thread = this.threads.get(request.params?.threadId);
    const providerId = thread?.providerId || this.store.runtimeProfile().id;
    const id = `${request.params?.threadId || "runtime"}:${request.id}`;
    this.approvals.set(id, { providerId, request });
    if (thread) {
      thread.status = "waiting";
      this.broadcast("thread.updated", thread);
    }
    this.broadcast(
      "approval.requested",
      this.approvalView(id, { providerId, request }),
    );
  }

  private async ensureLoaded(providerId: string, threadId: string) {
    const key = threadId;
    if (this.loadedThreads.has(key)) return;
    const client = await this.ensure(providerId);
    await this.resumeThread(client, providerId, threadId);
    this.loadedThreads.add(key);
  }

  private async resumeThread(
    client: { request: (method: string, params?: unknown) => Promise<any> },
    _providerId: string,
    threadId: string,
  ) {
    const existing = this.threads.get(threadId);
    const params: Record<string, unknown> = {
      threadId,
      excludeTurns: true,
    };
    // Keep the rollout's model/provider/sandbox. Overriding them on resume
    // rebinds the thread (often to a new deck_* provider id) and invalidates
    // previous_response_id, so the next turn only caches the static prefix.
    const result = await client
      .request("thread/resume", params)
      .catch((error) => {
        if (!String(error.message).includes("already")) throw error;
      });
    this.rememberRollout(threadId);
    if (existing && result) {
      const applied = parseSandboxMode(
        result.sandbox,
        result.activePermissionProfile,
      );
      if (applied) existing.sandbox = applied;
      const approval = pickString(result.approvalPolicy);
      if (approval)
        existing.approvalPolicy = approval as ThreadSummary["approvalPolicy"];
      const reviewer = pickString(result.approvalsReviewer);
      if (reviewer)
        existing.approvalsReviewer =
          reviewer as ThreadSummary["approvalsReviewer"];
    }
    await this.restoreSavedThreadSettings(client, threadId);
  }

  /**
   * thread/resume 只带 threadId：runtime 从 rollout 恢复的是落盘时的旧设置。
   * Deck 侧若有更新的显式选择（之前 settings/update 已存进 thread-settings），
   * 在这里补推一次，否则下一 turn 就按旧权限执行，而界面显示的还是新值。
   * 只补与当前真相不一致的字段；model/modelProvider 不动，不触发 rebind。
   */
  private async restoreSavedThreadSettings(
    client: { request: (method: string, params?: unknown) => Promise<any> },
    threadId: string,
  ) {
    const saved = this.threadSettings?.get(this.id, threadId);
    const existing = this.threads.get(threadId);
    if (!saved || !existing) return;
    const params: Record<string, unknown> = { threadId };
    const nextModel = normalizeCodexModel(saved.model);
    if (nextModel && nextModel !== normalizeCodexModel(existing.model))
      params.model = nextModel;
    if (
      saved.reasoningEffort &&
      saved.reasoningEffort !== existing.reasoningEffort
    )
      params.effort = saved.reasoningEffort;
    if (saved.personality && saved.personality !== existing.personality)
      params.personality = saved.personality;
    if (
      saved.approvalPolicy &&
      saved.approvalPolicy !== existing.approvalPolicy
    )
      params.approvalPolicy = saved.approvalPolicy;
    if (
      saved.approvalsReviewer &&
      saved.approvalsReviewer !== existing.approvalsReviewer
    )
      params.approvalsReviewer = saved.approvalsReviewer;
    if (saved.sandbox && saved.sandbox !== existing.sandbox) {
      const policy = sandboxPolicyFromMode(saved.sandbox);
      if (policy) params.sandboxPolicy = policy;
    }
    if (saved.serviceTier && saved.serviceTier !== existing.serviceTier)
      params.serviceTier = saved.serviceTier;
    if (Object.keys(params).length === 1) return;
    try {
      await client.request("thread/settings/update", params);
    } catch {
      // best-effort：推不进去就保持 rollout 真相，下一次 turn 前的
      // deferred 机制会再推一次；绝不能因为这个打断 resume/发消息。
      return;
    }
    if (typeof params.model === "string") existing.model = params.model;
    if (typeof params.effort === "string")
      existing.reasoningEffort = params.effort;
    if (typeof params.personality === "string")
      existing.personality = params.personality as ThreadSummary["personality"];
    if (typeof params.approvalPolicy === "string")
      existing.approvalPolicy =
        params.approvalPolicy as ThreadSummary["approvalPolicy"];
    if (typeof params.approvalsReviewer === "string")
      existing.approvalsReviewer =
        params.approvalsReviewer as ThreadSummary["approvalsReviewer"];
    if (saved.sandbox && params.sandboxPolicy) existing.sandbox = saved.sandbox;
    if (typeof params.serviceTier === "string")
      existing.serviceTier = params.serviceTier;
    existing.updatedAt = Date.now();
    this.broadcast("thread.updated", existing);
  }

  private markArchived(threadId: string, archived: boolean) {
    const existing = this.threads.get(threadId);
    if (!existing) return;
    existing.archived = archived;
    existing.updatedAt = Date.now();
    this.broadcast("thread.updated", existing);
  }

  private removeThread(threadId: string) {
    const key = threadId;
    this.threads.delete(key);
    this.loadedThreads.delete(key);
    this.knownRollouts.delete(key);
    this.inMemoryThreads.delete(key);
    void this.usageStore.remove(key).catch(() => undefined);
    this.broadcast("thread.deleted", { threadId });
  }

  private providerForThread(thread: any): Provider {
    const modelProvider = String(thread.modelProvider || "");
    const matched = this.store
      .runtimeProviders()
      .find(
        (provider) =>
          compileRuntimeProvider(provider).modelProvider === modelProvider,
      );
    const publicProviders = this.store.runtimeProviders();
    const official = publicProviders.find((provider) =>
      isOfficialProvider(provider),
    );
    return matched || official || this.store.runtimeProfile();
  }

  private approvalView(
    id: string,
    approval: { providerId: string; request: RpcMessage },
  ) {
    const params = approval.request.params || {};
    const itemId = params.itemId || params.item?.id;
    const kind: ApprovalKind = classifyApprovalMethod(
      approval.request.method || "",
    );
    const changes =
      parseFileChanges(
        params.fileChange?.changes ||
          params.changes ||
          params.file_change?.changes,
      ) || (itemId ? this.pendingFileChanges.get(itemId) : undefined);
    return {
      id,
      agentId: this.id,
      providerId: approval.providerId,
      request: approval.request,
      kind,
      cwd: params.cwd,
      command: formatCommand(params.command),
      reason: params.reason,
      changes,
      questions: params.questions || params.items,
      availableDecisions:
        params.availableDecisions || params.available_decisions,
      permissions: params.permissions,
      itemId,
      networkApproval: Boolean(
        params.networkApprovalContext || params.network_approval_context,
      ),
    };
  }

  private attachFileChanges(itemId: string) {
    for (const [id, approval] of this.approvals) {
      const params = approval.request.params || {};
      if (params.itemId === itemId || params.item?.id === itemId)
        this.broadcast("approval.updated", this.approvalView(id, approval));
    }
  }

  private isUsageLimitError(code?: string) {
    const value = String(code || "").toLowerCase();
    return value === "usagelimitexceeded" || value === "usage_limit_exceeded";
  }

  private turnError(error: any) {
    if (!error) return undefined;
    const message = String(
      error.message || error.additionalDetails || "Codex 任务失败",
    ).slice(0, 2_000);
    const info = error.codexErrorInfo ?? error.codex_error_info;
    const code =
      typeof info === "string"
        ? info
        : info && typeof info === "object"
          ? Object.keys(info)[0]
          : undefined;
    return { message, code };
  }

  private broadcast(type: string, data: any) {
    this.emit("event", { type, data });
  }
}
