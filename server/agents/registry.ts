import { EventEmitter } from "node:events";
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentId,
  AgentSnapshot,
} from "./types.js";

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
    await Promise.all(
      [...this.adapters.values()].map((adapter) => adapter.startAll()),
    );
  }

  async refreshAll() {
    await Promise.all(
      [...this.adapters.values()].map((adapter) => adapter.refreshAll()),
    );
  }

  busyThreads() {
    return [...this.adapters.values()].flatMap((adapter) =>
      adapter.busyThreads(),
    );
  }

  stopAll() {
    for (const adapter of this.adapters.values()) adapter.restart();
  }
}
