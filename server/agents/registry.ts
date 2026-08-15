import { EventEmitter } from "node:events";
import type {
  AgentAdapter,
  AgentCreateThreadInput,
  AgentDescriptor,
  AgentId,
  AgentSnapshot,
} from "./types.js";
import type { TurnImage } from "../types.js";

export class AgentRegistry extends EventEmitter {
  private adapters = new Map<AgentId, AgentAdapter>();

  constructor(adapters: AgentAdapter[] = []) {
    super();
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: AgentAdapter) {
    if (this.adapters.has(adapter.id))
      throw new Error(`Agent ${adapter.id} 已注册`);
    this.adapters.set(adapter.id, adapter);
    adapter.on("event", (event) => this.emit("event", event));
  }

  get(id: AgentId) {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Agent ${id} 不存在`);
    return adapter;
  }

  list(): AgentDescriptor[] {
    return [...this.adapters.values()].map((adapter) => adapter.descriptor());
  }

  snapshot(primaryId: AgentId = "codex") {
    const snapshots = [...this.adapters.values()].map((adapter) =>
      adapter.snapshot(),
    );
    const primary = this.adapters.has(primaryId)
      ? this.get(primaryId).snapshot()
      : ({} as AgentSnapshot);
    return {
      ...primary,
      agents: this.list(),
      threads: snapshots.flatMap((snapshot) => snapshot.threads || []),
      archivedThreads: snapshots.flatMap(
        (snapshot) => snapshot.archivedThreads || [],
      ),
      approvals: snapshots.flatMap((snapshot) => snapshot.approvals || []),
    };
  }

  async startAll() {
    const results = await Promise.allSettled(
      [...this.adapters.values()].map((adapter) => adapter.startAll()),
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
      [...this.adapters.values()].map((adapter) => adapter.refreshAll()),
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

  profiles(id: AgentId) {
    const adapter = this.get(id);
    return adapter.publicProfiles?.() || [];
  }

  async createThread(id: AgentId, input: AgentCreateThreadInput) {
    const adapter = this.operation(id, "createThread");
    return adapter.createThread!(input.providerId || "", input);
  }

  async readThread(id: AgentId, threadId: string) {
    const adapter = this.operation(id, "readThread");
    const thread = this.thread(id, threadId);
    return adapter.readThread!(thread.providerId, threadId);
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

  async resolveApproval(
    id: AgentId,
    approvalId: string,
    body: {
      decision?: string;
      permissions?: unknown;
      scope?: "session" | "turn";
      answers?: unknown;
    },
  ) {
    const adapter = this.operation(id, "resolveApproval");
    return adapter.resolveApproval!(approvalId, body);
  }

  busyThreads() {
    return [...this.adapters.values()].flatMap((adapter) =>
      adapter.busyThreads(),
    );
  }

  stopAll() {
    for (const adapter of this.adapters.values()) adapter.restart();
  }

  private operation<K extends keyof AgentAdapter>(id: AgentId, key: K) {
    const adapter = this.get(id);
    if (typeof adapter[key] !== "function")
      throw new Error(`Agent ${id} 不支持此操作`);
    return adapter;
  }

  private thread(id: AgentId, threadId: string) {
    const thread = this.get(id)
      .snapshot()
      .threads.find((item) => item.id === threadId);
    if (!thread) throw new Error(`Agent ${id} 的会话不存在`);
    return thread;
  }
}
