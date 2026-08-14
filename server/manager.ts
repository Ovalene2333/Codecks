import { EventEmitter } from "node:events";
import type { ProviderStore } from "./store.js";
import type { ProjectStore } from "./projects.js";
import { CodexClient } from "./codex-client.js";
import {
  compileRuntimeProvider,
  isOfficialProvider,
} from "./provider-config.js";
import { configuredRuntimePort, findFreeListenPort } from "./runtime-port.js";
import {
  windowsPathToWsl,
  WSL_CODEX_SHELL_COMMAND,
} from "./runtime-platform.js";
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
} from "./protocol.js";
import {
  buildTurnInput,
  DIFF_SHELL_COMMAND,
  INIT_PROMPT,
  PLAN_PROMPT,
  reviewParams,
} from "./turn-input.js";
import {
  classifyThreadStoreError,
  explainThreadStoreError,
  isMissingRolloutError,
} from "./thread-store-error.js";
import type {
  AccountInfo,
  ApprovalKind,
  FileChange,
  ModelInfo,
  Personality,
  Provider,
  RateLimits,
  ReviewTarget,
  RpcMessage,
  ThreadSummary,
  TurnImage,
} from "./types.js";

export class CodexManager extends EventEmitter {
  private client?: CodexClient;
  private startingClient?: Promise<CodexClient>;
  private threads = new Map<string, ThreadSummary>();
  private loadedThreads = new Set<string>();
  // thread/start is in-memory only. Codex writes a rollout on the first turn,
  // when the thread is listed, or when it is forked/resumed from disk.
  private knownRollouts = new Set<string>();
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
  private archiveError?: string;
  private pendingFileChanges = new Map<string, FileChange[]>();

  constructor(
    private store: ProviderStore,
    private dataDir: string,
    private codexBin?: string,
    runtimePort?: number,
    private useWsl = false,
    private projects?: ProjectStore,
  ) {
    super();
    this.runtimePort =
      runtimePort && runtimePort > 0 ? runtimePort : configuredRuntimePort();
  }

  async startAll() {
    await this.ensure();
    await this.refreshAll();
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
    previous?.stop();
    this.loadedThreads.clear();
    this.knownRollouts.clear();
    const profile = this.store.runtimeProfile();
    const client = new CodexClient(
      profile,
      this.dataDir,
      this.codexBin,
      this.store.runtimeProviders(),
      `ws://127.0.0.1:${await this.resolveRuntimePort()}`,
      this.useWsl,
      (providerId) => this.projects?.overlayForProvider(providerId),
    );
    this.client = client;
    client.on("notification", (msg) => this.onNotification(msg));
    client.on("request", (msg) => this.onRequest(msg));
    client.on("online", () => {
      this.broadcast("runtime.status", { online: true });
      void this.loadOfficialUsage();
    });
    client.on("offline", (error) =>
      this.broadcast("runtime.status", { online: false, error }),
    );
    await client.start();
    if (this.client !== client) {
      client.stop();
      throw new Error("运行时配置在启动期间已更新，请重试");
    }
    this.broadcast("runtime.process", {
      pid: client.pid,
      remoteUrl: this.runtimeUrl(),
    });
    this.loadedProviderRevision = this.store.revision;
    this.loadedConnectionRevision = this.projects?.connectionRevision ?? 0;
    this.loadedProviderIds = new Set(
      this.store.runtimeProviders().map((provider) => provider.id),
    );
    return client;
  }

  restart(_providerId?: string) {
    this.client?.stop();
    this.client = undefined;
    this.startingClient = undefined;
    this.loadedThreads.clear();
    this.knownRollouts.clear();
  }

  providerStatuses() {
    return this.store.listPublic().map((p) => ({
      ...p,
      online: this.client?.online ?? false,
      starting: Boolean(this.startingClient),
      error: this.client?.lastError,
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
    const seen = new Set<string>();
    let listed = false;
    try {
      const client = await this.ensure();
      await this.pullThreadPages(client, false, seen);
      listed = true;
      try {
        await this.pullThreadPages(client, true, seen);
        this.archiveError = undefined;
      } catch (error: any) {
        this.archiveError = String(error?.message || "归档会话列表加载失败");
      }
    } catch {}
    // Only drop stale rows after a successful unarchived listing. A failed
    // thread/list (timeout, current-provider filter error) must not wipe
    // history that is already on screen.
    if (listed) {
      for (const [key, thread] of this.threads) {
        if (!seen.has(thread.id) && !this.loadedThreads.has(key))
          this.threads.delete(key);
      }
      await this.projects?.rememberSeenMany(
        [...this.threads.values()].map((thread) => ({
          cwd: thread.cwd,
          updatedAt: thread.updatedAt,
        })),
      );
    }
    this.broadcast("snapshot", this.snapshot());
  }

  private async pullThreadPages(
    client: CodexClient,
    archived: boolean,
    seen: Set<string>,
  ) {
    let cursor: string | undefined;
    let loaded = 0;
    do {
      const result = await client.request(
        "thread/list",
        this.threadListParams(cursor, archived),
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

  private threadListParams(cursor: string | undefined, archived: boolean) {
    return {
      cursor,
      limit: 100,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived,
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
      archiveError: this.archiveError,
      runtimeWsl: this.useWsl,
    };
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

  async createThread(
    providerId: string,
    input: {
      cwd: string;
      model?: string;
      reasoningEffort?: string;
      personality?: Personality;
      approvalPolicy?: string;
      sandbox?: string;
      name?: string;
    },
  ) {
    if (
      this.client?.online &&
      !this.loadedProviderIds.has(providerId) &&
      this.store.get(providerId)?.kind !== "local-profile"
    )
      throw new Error("该供应商尚未装入 Runtime，请先在供应商设置中应用配置");
    const client = await this.ensure(providerId);
    const provider = this.store.get(providerId)!;
    const runtimeProvider = compileRuntimeProvider(provider);
    const sandbox = input.sandbox || "workspace-write";
    const approvalPolicy = input.approvalPolicy || "on-request";
    const start: Record<string, unknown> = {
      cwd: this.useWsl ? windowsPathToWsl(input.cwd) : input.cwd,
      model: input.model || runtimeProvider.model || undefined,
      modelProvider: runtimeProvider.modelProvider,
      approvalPolicy,
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
    this.loadedThreads.add(result.thread.id);
    this.upsertThread(
      provider,
      {
        ...result.thread,
        name: input.name || result.thread.name,
        model: input.model || result.thread.model,
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
      },
      "idle",
    );
    return result.thread;
  }

  async listModels(providerId: string): Promise<ModelInfo[]> {
    const client = await this.ensure(providerId);
    const models: ModelInfo[] = [];
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
        });
      }
      cursor = result.nextCursor || undefined;
    } while (cursor && models.length < 200);
    return models;
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
      sandbox?: string;
    },
  ) {
    await this.ensureLoaded(providerId, threadId);
    const client = await this.ensure(providerId);
    const params: Record<string, unknown> = { threadId };
    if (settings.model) params.model = settings.model;
    if (settings.reasoningEffort) params.effort = settings.reasoningEffort;
    if (settings.personality) params.personality = settings.personality;
    if (settings.approvalPolicy)
      params.approvalPolicy = settings.approvalPolicy;
    if (settings.sandbox)
      params.sandboxPolicy = sandboxPolicyFromMode(settings.sandbox);
    try {
      await client.request("thread/settings/update", params);
    } catch (error: any) {
      throw new Error(
        `当前 Codex 不支持中途修改会话设置：${error.message || error}`,
      );
    }
    const existing = this.threads.get(threadId);
    if (existing) {
      if (settings.model) existing.model = settings.model;
      if (settings.reasoningEffort)
        existing.reasoningEffort = settings.reasoningEffort;
      if (settings.personality) existing.personality = settings.personality;
      if (settings.approvalPolicy)
        existing.approvalPolicy =
          settings.approvalPolicy as ThreadSummary["approvalPolicy"];
      if (settings.sandbox)
        existing.sandbox = settings.sandbox as ThreadSummary["sandbox"];
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
      model: source?.model || runtimeProvider.model,
      modelProvider: runtimeProvider.modelProvider,
    };
    if (source?.sandbox) params.sandbox = source.sandbox;
    if (source?.approvalPolicy) params.approvalPolicy = source.approvalPolicy;
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
        reasoningEffort: source?.reasoningEffort,
        model: source?.model || result.thread.model,
      },
      "idle",
    );
    return this.threads.get(result.thread.id) || result.thread;
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
    let result: any;
    try {
      result = await client.request("thread/fork", {
        threadId: sourceThreadId,
        model: options.model || runtimeProvider.model,
        modelProvider: runtimeProvider.modelProvider,
        approvalPolicy: source.approvalPolicy || "on-request",
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
      model: options.model || runtimeProvider.model,
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
      forkedFromId: sourceThreadId,
      migratedFrom: { providerId: sourceProviderId, threadId: sourceThreadId },
    });
    return result.thread;
  }

  private canSwitchWithoutFork(thread: ThreadSummary) {
    return (
      this.loadedThreads.has(thread.id) && !this.knownRollouts.has(thread.id)
    );
  }

  private rememberRollout(threadId?: string) {
    if (threadId) this.knownRollouts.add(threadId);
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
    const client = await this.ensure(providerId);
    const read = (includeTurns: boolean) =>
      client
        .request("thread/read", { threadId, includeTurns })
        .then((result) => result.thread);
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
      return await read(false);
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
    let client;
    try {
      client = await this.prepareThread(providerId, threadId);
    } catch (error: unknown) {
      throw explainThreadStoreError(error);
    }
    const existing = this.threads.get(threadId);
    const input = buildTurnInput(text, images);
    const startTurn = () => {
      const start: Record<string, unknown> = { threadId, input };
      if (existing?.sandbox)
        start.sandboxPolicy = sandboxPolicyFromMode(existing.sandbox);
      if (existing?.approvalPolicy)
        start.approvalPolicy = existing.approvalPolicy;
      return client.request("turn/start", start);
    };
    if (
      (existing?.status === "running" || existing?.status === "waiting") &&
      existing.activeTurnId &&
      !existing.compacting
    ) {
      try {
        return await client.request("turn/steer", {
          threadId,
          expectedTurnId: existing.activeTurnId,
          input,
        });
      } catch (error: any) {
        if (
          !String(error?.message || "")
            .toLowerCase()
            .includes("no active turn")
        )
          return this.retryTurnAfterMissing(
            client,
            providerId,
            threadId,
            error,
            startTurn,
          );
      }
    }
    try {
      return await startTurn();
    } catch (error: unknown) {
      return this.retryTurnAfterMissing(
        client,
        providerId,
        threadId,
        error,
        startTurn,
      );
    }
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
    const client = await this.ensure(providerId);
    const existing = this.threads.get(threadId);
    if (existing) {
      existing.compacting = true;
      existing.updatedAt = Date.now();
      this.broadcast("thread.updated", existing);
    }
    return client.request("thread/compact/start", { threadId });
  }

  async interrupt(providerId: string, threadId: string, turnId: string) {
    return (await this.ensure(providerId)).request("turn/interrupt", {
      threadId,
      turnId,
    });
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
    this.approvals.delete(approvalId);
    this.broadcast("approval.resolved", { approvalId });
  }

  async loadOfficialUsage() {
    const client = this.client;
    if (!client?.online) return this.runtimeStatus();
    try {
      const accountRaw = await client.request("account/read", {});
      this.account = parseAccount(accountRaw);
      if (!isChatgptAccount(this.account)) {
        this.rateLimits = null;
        this.rateLimitsError =
          "当前 Runtime 未使用 Official ChatGPT 登录，额度不可用";
        this.broadcast("runtime.status", this.runtimeStatus());
        return this.runtimeStatus();
      }
      try {
        const limitsRaw = await client.request("account/rateLimits/read", {});
        this.rateLimits = parseRateLimits(limitsRaw);
        this.rateLimitsError = this.rateLimits
          ? undefined
          : "Official 账号额度暂不可用";
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
    const latestStatus: ThreadSummary["status"] | undefined = latestTurn
      ? latestTurn.status === "inProgress"
        ? "running"
        : latestTurn.status === "failed"
          ? "error"
          : "idle"
      : undefined;
    const preview =
      thread.preview || this.extractPreview(thread) || old?.preview || "新会话";
    const item: ThreadSummary = {
      id: thread.id,
      providerId: provider.id,
      name: thread.name || preview.slice(0, 42),
      preview,
      cwd: thread.cwd || old?.cwd || "",
      model: thread.model || provider.model || old?.model || "default",
      status: status || latestStatus || old?.status || "idle",
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
        ? latestTurn.status === "inProgress"
          ? latestTurn.id
          : undefined
        : old?.activeTurnId,
      lastError: latestTurn ? latestError?.message : old?.lastError,
      errorCode: latestTurn ? latestError?.code : old?.errorCode,
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
      forkedFromId:
        pickString(
          thread.forkedFromId,
          thread.forked_from_id,
          thread.parentThreadId,
        ) || old?.forkedFromId,
      sessionId:
        pickString(thread.sessionId, thread.session_id) || old?.sessionId,
      tokenUsage:
        parseTokenUsage(thread.tokenUsage || thread.token_usage) ||
        old?.tokenUsage,
      compacting:
        typeof thread.compacting === "boolean"
          ? thread.compacting
          : old?.compacting,
      migratedFrom: thread.migratedFrom || old?.migratedFrom,
      controlMode:
        status || this.loadedThreads.has(thread.id)
          ? "managed"
          : old?.controlMode || "history",
    };
    this.threads.set(key, item);
    if (thread.turns?.length || thread.preview) this.rememberRollout(thread.id);
    if (item.cwd) void this.projects?.rememberSeen(item.cwd, item.updatedAt);
    this.broadcast("thread.updated", item);
  }

  private extractPreview(thread: any) {
    for (const turn of thread.turns || [])
      for (const item of turn.items || []) {
        if (item.type === "userMessage")
          return item.content?.find((x: any) => x.type === "text")?.text;
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
    if (item?.id && (item.type === "fileChange" || item.changes)) {
      const changes = parseFileChanges(item.changes);
      if (changes) {
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
      return this.broadcast("codex.event", { ...message });
    }
    if (thread) this.upsertThread(this.providerForThread(thread), thread);
    const existing = params.threadId
      ? this.threads.get(params.threadId)
      : undefined;
    if (existing) {
      existing.controlMode = "managed";
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
        existing.lastError = undefined;
        existing.errorCode = undefined;
      }
      if (message.method === "turn/completed") {
        existing.status = params.turn?.status === "failed" ? "error" : "idle";
        existing.activeTurnId = undefined;
        existing.compacting = false;
        const error = this.turnError(params.turn?.error);
        existing.lastError = error?.message;
        existing.errorCode = error?.code;
        if (this.isUsageLimitError(error?.code)) void this.loadOfficialUsage();
      }
      if (message.method === "error" && !params.willRetry) {
        const error = this.turnError(params.error);
        existing.status = "error";
        existing.activeTurnId = undefined;
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
        existing.tokenUsage =
          parseTokenUsage(params.tokenUsage || params.usage || params) ||
          existing.tokenUsage;
      }
      if (
        message.method === "thread/compact/started" ||
        message.method === "thread/compact/start"
      )
        existing.compacting = true;
      if (
        message.method === "thread/compact/completed" ||
        message.method === "thread/compacted"
      )
        existing.compacting = false;
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
    providerId: string,
    threadId: string,
  ) {
    const provider = this.store.get(providerId)!;
    const runtimeProvider = compileRuntimeProvider(provider);
    const existing = this.threads.get(threadId);
    const params: Record<string, unknown> = {
      threadId,
      model: runtimeProvider.model,
      modelProvider: runtimeProvider.modelProvider,
      excludeTurns: true,
    };
    if (existing?.sandbox) params.sandbox = existing.sandbox;
    if (existing?.approvalPolicy)
      params.approvalPolicy = existing.approvalPolicy;
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
    }
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
