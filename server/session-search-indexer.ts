import type { AgentRegistry } from "./agents/registry.js";
import type { ThreadSummary } from "./types.js";
import { SessionSearchStore } from "./session-search.js";

const INDEX_INTERVAL_MS = 750;

function key(thread: ThreadSummary) {
  return `${thread.agentId || "codex"}:${thread.id}`;
}

export class SessionSearchIndexer {
  private queue: ThreadSummary[] = [];
  private timer?: NodeJS.Timeout;
  private auxiliaryTimers = new Set<NodeJS.Timeout>();
  private activeKey?: string;
  private reconciling = false;
  private closed = false;

  constructor(
    readonly store: SessionSearchStore,
    private agents: AgentRegistry,
  ) {}

  reconcileSoon() {
    if (this.closed || this.reconciling) return;
    this.reconciling = true;
    const timer = setTimeout(() => {
      this.auxiliaryTimers.delete(timer);
      if (this.closed) return;
      this.reconciling = false;
      this.reconcile();
    }, 250);
    this.auxiliaryTimers.add(timer);
    timer.unref();
  }

  reconcile() {
    if (this.closed) return;
    const snapshot = this.agents.snapshot();
    const threads = [...snapshot.threads, ...(snapshot.archivedThreads || [])];
    this.store.removeAbsent(threads);
    this.queue = threads
      .filter((thread) => this.store.needsIndex(thread))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    this.schedule(0);
  }

  capture(thread: ThreadSummary, full: unknown) {
    if (this.closed || this.agents.busyThreads().length > 0) return;
    const timer = setTimeout(() => {
      this.auxiliaryTimers.delete(timer);
      if (this.closed) return;
      try {
        this.store.upsert(thread, full);
        this.queue = this.queue.filter((item) => key(item) !== key(thread));
      } catch (error) {
        this.store.markFailure(thread, error);
      }
    }, 0);
    this.auxiliaryTimers.add(timer);
    timer.unref();
  }

  progress(threads: ThreadSummary[]) {
    const allowed = new Set(threads.map(key));
    const indexed = this.store.indexedCount(allowed);
    return {
      indexed,
      total: threads.length,
      building:
        Boolean(this.activeKey && allowed.has(this.activeKey)) ||
        this.queue.some((thread) => allowed.has(key(thread))),
    };
  }

  private schedule(delay: number) {
    if (this.closed || this.timer || this.queue.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.processOne();
    }, delay);
    this.timer.unref();
  }

  private async processOne() {
    if (this.agents.busyThreads().length > 0) {
      this.schedule(2_000);
      return;
    }
    const thread = this.queue.shift();
    if (!thread) return;
    this.activeKey = key(thread);
    try {
      const full = await this.agents.readThread(
        thread.agentId || "codex",
        thread.id,
      );
      if (this.closed) return;
      this.store.upsert(thread, full);
    } catch (error) {
      if (this.closed) return;
      this.store.markFailure(thread, error);
    } finally {
      this.activeKey = undefined;
    }
    this.schedule(INDEX_INTERVAL_MS);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const timer of this.auxiliaryTimers) clearTimeout(timer);
    this.auxiliaryTimers.clear();
    this.store.close();
  }
}
