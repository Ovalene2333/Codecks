import { EventEmitter } from "node:events";
import type { ProviderStore } from "./store.js";
import { CodexClient } from "./codex-client.js";
import {
  compileRuntimeProvider,
  isOfficialProvider,
} from "./provider-config.js";
import { configuredRuntimePort, findFreeListenPort } from "./runtime-port.js";
import type {
  ModelInfo,
  Personality,
  Provider,
  RpcMessage,
  ThreadSummary,
} from "./types.js";

export class CodexManager extends EventEmitter {
  private client?: CodexClient;
  private startingClient?: Promise<CodexClient>;
  private threads = new Map<string, ThreadSummary>();
  private loadedThreads = new Set<string>();
  private approvals = new Map<
    string,
    { providerId: string; request: RpcMessage }
  >();
  private loadedProviderRevision = -1;
  private loadedProviderIds = new Set<string>();
  private runtimePort?: number;

  constructor(
    private store: ProviderStore,
    private dataDir: string,
    private codexBin?: string,
    runtimePort?: number,
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
    const profile = this.store.runtimeProfile();
    const client = new CodexClient(
      profile,
      this.dataDir,
      this.codexBin,
      this.store.runtimeProviders(),
      `ws://127.0.0.1:${await this.resolveRuntimePort()}`,
    );
    this.client = client;
    client.on("notification", (msg) => this.onNotification(msg));
    client.on("request", (msg) => this.onRequest(msg));
    client.on("online", () =>
      this.broadcast("runtime.status", { online: true }),
    );
    client.on("offline", (error) =>
      this.broadcast("runtime.status", { online: false, error }),
    );
    await client.start();
    if (this.client !== client) {
      client.stop();
      throw new Error("运行时配置在启动期间已更新，请重试");
    }
    this.loadedProviderRevision = this.store.revision;
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
      } catch {}
    } catch {}
    // Only drop stale rows after a successful unarchived listing. A failed
    // thread/list (timeout, current-provider filter error) must not wipe
    // history that is already on screen.
    if (listed) {
      for (const [key, thread] of this.threads) {
        if (!seen.has(thread.id) && !this.loadedThreads.has(key))
          this.threads.delete(key);
      }
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
      approvals: [...this.approvals.entries()].map(([id, value]) => ({
        id,
        ...value,
      })),
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
        this.loadedProviderRevision !== this.store.revision,
    };
  }

  terminalCommand(providerId?: string, cwd?: string) {
    const provider = providerId ? this.store.get(providerId) : undefined;
    const quote = (value: string) =>
      process.platform === "win32"
        ? `"${value.replace(/"/g, '""')}"`
        : `'${value.replace(/'/g, `'"'"'`)}'`;
    const parts = ["codex", "--remote", this.runtimeStatus().remoteUrl];
    if (cwd) parts.push("-C", quote(cwd));
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

  async applyProviderConfig() {
    const busy = this.listThreads().filter(
      (thread) => thread.status === "running" || thread.status === "waiting",
    );
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
    const start: Record<string, unknown> = {
      cwd: input.cwd,
      model: input.model || runtimeProvider.model || undefined,
      modelProvider: runtimeProvider.modelProvider,
      approvalPolicy: input.approvalPolicy || "on-request",
      sandbox: input.sandbox || "workspace-write",
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
        reasoningEffort: input.reasoningEffort,
        personality: input.personality,
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
    try {
      await client.request("thread/settings/update", {
        threadId,
        ...settings,
      });
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
      existing.updatedAt = Date.now();
      this.broadcast("thread.updated", existing);
    }
    return existing;
  }

  async forkThread(providerId: string, threadId: string) {
    await this.ensureLoaded(providerId, threadId);
    const client = await this.ensure(providerId);
    const provider = this.store.get(providerId)!;
    const runtimeProvider = compileRuntimeProvider(provider);
    const result = await client.request("thread/fork", {
      threadId,
      model: runtimeProvider.model,
      modelProvider: runtimeProvider.modelProvider,
    });
    this.loadedThreads.add(result.thread.id);
    this.upsertThread(provider, result.thread, "idle");
    return result.thread;
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

    const client = await this.ensure(targetProviderId);
    const runtimeProvider = compileRuntimeProvider(target);
    const result = await client.request("thread/fork", {
      threadId: sourceThreadId,
      model: options.model || runtimeProvider.model,
      modelProvider: runtimeProvider.modelProvider,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    this.loadedThreads.add(result.thread.id);
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
    });
    return result.thread;
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
    try {
      return (
        await client.request("thread/read", { threadId, includeTurns: true })
      ).thread;
    } catch (error: any) {
      // thread/start creates a usable in-memory thread, but Codex does not persist
      // ("materialize") it until the first user turn. Asking for turns before that
      // point is rejected, so return its metadata-only representation instead.
      if (!String(error?.message).includes("is not materialized yet"))
        throw error;
      return (
        await client.request("thread/read", { threadId, includeTurns: false })
      ).thread;
    }
  }

  async sendTurn(providerId: string, threadId: string, text: string) {
    const client = await this.ensure(providerId);
    const key = threadId;
    // A thread returned by thread/start is already loaded, but has no rollout
    // until its first turn. Resuming it here fails with "no rollout found".
    // Threads discovered by thread/list, on the other hand, must be resumed.
    if (!this.loadedThreads.has(key)) {
      const provider = this.store.get(providerId)!;
      const runtimeProvider = compileRuntimeProvider(provider);
      await client
        .request("thread/resume", {
          threadId,
          model: runtimeProvider.model,
          modelProvider: runtimeProvider.modelProvider,
          excludeTurns: true,
        })
        .catch((error) => {
          if (!String(error.message).includes("already")) throw error;
        });
      this.loadedThreads.add(key);
    }
    return client.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
    });
  }

  async interrupt(providerId: string, threadId: string, turnId: string) {
    return (await this.ensure(providerId)).request("turn/interrupt", {
      threadId,
      turnId,
    });
  }

  async resolveApproval(approvalId: string, decision: string) {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error("审批已处理或不存在");
    const client = await this.ensure(approval.providerId);
    const method = approval.request.method || "";
    let result: any = { decision };
    if (method === "item/permissions/requestApproval")
      throw new Error("权限配置审批暂不支持，请在桌面端处理");
    if (method.includes("requestUserInput"))
      throw new Error("交互式问答暂不支持");
    client.respond(approval.request.id!, result);
    this.approvals.delete(approvalId);
    this.broadcast("approval.resolved", { approvalId });
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
        Date.parse(thread.updatedAt || thread.createdAt || "") || Date.now(),
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
      controlMode:
        status || this.loadedThreads.has(thread.id)
          ? "managed"
          : old?.controlMode || "history",
    };
    this.threads.set(key, item);
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
        existing.status = "running";
        existing.activeTurnId = params.turn?.id;
        existing.lastError = undefined;
        existing.errorCode = undefined;
      }
      if (message.method === "turn/completed") {
        existing.status = params.turn?.status === "failed" ? "error" : "idle";
        existing.activeTurnId = undefined;
        const error = this.turnError(params.turn?.error);
        existing.lastError = error?.message;
        existing.errorCode = error?.code;
      }
      if (message.method === "error" && !params.willRetry) {
        const error = this.turnError(params.error);
        existing.status = "error";
        existing.activeTurnId = undefined;
        existing.lastError = error?.message || "Codex 任务失败";
        existing.errorCode = error?.code;
      }
      if (message.method === "thread/name/updated" && params.name)
        existing.name = params.name;
      if (message.method === "thread/settings/updated") {
        const settings = params.threadSettings || params.settings || {};
        if (settings.model) existing.model = settings.model;
        if (settings.reasoningEffort)
          existing.reasoningEffort = settings.reasoningEffort;
        if (settings.personality) existing.personality = settings.personality;
      }
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
    this.broadcast("approval.requested", { id, providerId, request });
  }

  private async ensureLoaded(providerId: string, threadId: string) {
    const key = threadId;
    if (this.loadedThreads.has(key)) return;
    const client = await this.ensure(providerId);
    const provider = this.store.get(providerId)!;
    const runtimeProvider = compileRuntimeProvider(provider);
    await client
      .request("thread/resume", {
        threadId,
        model: runtimeProvider.model,
        modelProvider: runtimeProvider.modelProvider,
        excludeTurns: true,
      })
      .catch((error) => {
        if (!String(error.message).includes("already")) throw error;
      });
    this.loadedThreads.add(key);
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
