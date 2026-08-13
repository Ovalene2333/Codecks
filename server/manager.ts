import { EventEmitter } from "node:events";
import type { ProviderStore } from "./store.js";
import { CodexClient } from "./codex-client.js";
import type { Provider, RpcMessage, ThreadSummary } from "./types.js";

export class CodexManager extends EventEmitter {
  private clients = new Map<string, CodexClient>();
  private threads = new Map<string, ThreadSummary>();
  private loadedThreads = new Set<string>();
  private approvals = new Map<
    string,
    { providerId: string; request: RpcMessage }
  >();

  constructor(
    private store: ProviderStore,
    private dataDir: string,
    private codexBin?: string,
  ) {
    super();
  }

  async startAll() {
    await Promise.allSettled(
      this.store
        .listPublic()
        .filter((p) => p.enabled)
        .map((p) => this.ensure(p.id)),
    );
    await this.refreshAll();
  }

  async ensure(providerId: string) {
    let client = this.clients.get(providerId);
    if (client?.online) return client;
    const provider = this.store.get(providerId);
    if (!provider) throw new Error("供应商不存在");
    client?.stop();
    this.forgetLoadedThreads(providerId);
    client = new CodexClient(provider, this.dataDir, this.codexBin);
    this.clients.set(providerId, client);
    client.on("notification", (msg) => this.onNotification(providerId, msg));
    client.on("request", (msg) => this.onRequest(providerId, msg));
    client.on("online", () =>
      this.broadcast("provider.status", { providerId, online: true }),
    );
    client.on("offline", (error) =>
      this.broadcast("provider.status", { providerId, online: false, error }),
    );
    await client.start();
    return client;
  }

  restart(providerId: string) {
    this.clients.get(providerId)?.stop();
    this.clients.delete(providerId);
    this.forgetLoadedThreads(providerId);
  }

  providerStatuses() {
    return this.store.listPublic().map((p) => ({
      ...p,
      online: this.clients.get(p.id)?.online ?? false,
      error: this.clients.get(p.id)?.lastError,
    }));
  }

  listThreads() {
    return [...this.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async refreshAll() {
    await Promise.allSettled(
      this.store
        .listPublic()
        .filter((p) => p.enabled)
        .map(async (provider) => {
          const client = await this.ensure(provider.id);
          let cursor: string | undefined;
          let loaded = 0;
          do {
            const result = await client.request("thread/list", {
              cursor,
              limit: 100,
              sortKey: "updated_at",
              sortDirection: "desc",
            });
            for (const thread of result.data || [])
              this.upsertThread(provider as Provider, thread);
            loaded += result.data?.length || 0;
            cursor = result.nextCursor || undefined;
          } while (cursor && loaded < 2_000);
        }),
    );
    this.broadcast("snapshot", this.snapshot());
  }

  snapshot() {
    return {
      providers: this.providerStatuses(),
      threads: this.listThreads(),
      approvals: [...this.approvals.entries()].map(([id, value]) => ({
        id,
        ...value,
      })),
    };
  }

  async createThread(
    providerId: string,
    input: {
      cwd: string;
      model?: string;
      approvalPolicy?: string;
      sandbox?: string;
      name?: string;
    },
  ) {
    const client = await this.ensure(providerId);
    const provider = this.store.get(providerId)!;
    const result = await client.request("thread/start", {
      cwd: input.cwd,
      model: input.model || provider.model || undefined,
      approvalPolicy: input.approvalPolicy || "on-request",
      sandbox: input.sandbox || "workspace-write",
    });
    if (input.name)
      await client.request("thread/name/set", {
        threadId: result.thread.id,
        name: input.name,
      });
    this.loadedThreads.add(`${providerId}:${result.thread.id}`);
    this.upsertThread(provider, result.thread, "idle");
    return result.thread;
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
    const key = `${providerId}:${threadId}`;
    // A thread returned by thread/start is already loaded, but has no rollout
    // until its first turn. Resuming it here fails with "no rollout found".
    // Threads discovered by thread/list, on the other hand, must be resumed.
    if (!this.loadedThreads.has(key)) {
      await client
        .request("thread/resume", { threadId, excludeTurns: true })
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
    const key = `${provider.id}:${thread.id}`;
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

  private onNotification(providerId: string, message: RpcMessage) {
    const params = message.params || {};
    const thread = params.thread;
    const threadId = params.threadId || thread?.id;
    if (threadId && message.method === "thread/started")
      this.loadedThreads.add(`${providerId}:${threadId}`);
    if (threadId && message.method === "thread/closed")
      this.loadedThreads.delete(`${providerId}:${threadId}`);
    if (thread) this.upsertThread(this.store.get(providerId)!, thread);
    const existing = params.threadId
      ? this.threads.get(`${providerId}:${params.threadId}`)
      : undefined;
    if (existing) {
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
      existing.updatedAt = Date.now();
      this.broadcast("thread.updated", existing);
    }
    this.broadcast("codex.event", { providerId, ...message });
  }

  private onRequest(providerId: string, request: RpcMessage) {
    const id = `${providerId}:${request.id}`;
    this.approvals.set(id, { providerId, request });
    const thread = this.threads.get(
      `${providerId}:${request.params?.threadId}`,
    );
    if (thread) {
      thread.status = "waiting";
      this.broadcast("thread.updated", thread);
    }
    this.broadcast("approval.requested", { id, providerId, request });
  }

  private forgetLoadedThreads(providerId: string) {
    const prefix = `${providerId}:`;
    for (const key of this.loadedThreads)
      if (key.startsWith(prefix)) this.loadedThreads.delete(key);
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
