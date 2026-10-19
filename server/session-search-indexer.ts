import type { AgentRegistry } from "./agents/registry.js";
import type { ThreadSummary } from "./types.js";
import type { BackgroundSearchStore } from "./session-search-background.js";

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
  private reconcilePending = false;
  private reconcileRetry?: NodeJS.Timeout;
  private captures = new Set<string>();

  constructor(
    readonly store: BackgroundSearchStore,
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
    void this.reconcileAsync().catch(() => {
      if (this.closed || this.reconcileRetry) return;
      console.error("会话搜索索引暂时不可用，5 秒后重试");
      this.reconcileRetry = setTimeout(() => {
        this.reconcileRetry = undefined;
        this.reconcile();
      }, 5_000);
      this.reconcileRetry.unref();
    });
  }

  private async reconcileAsync() {
    if (this.closed || this.reconcilePending) return;
    this.reconcilePending = true;
    try {
      const snapshot = this.agents.snapshot();
      const threads = [...snapshot.threads, ...(snapshot.archivedThreads || [])];
      const pending = await this.store.reconcile(threads);
      if (this.closed) return;
      this.queue = pending.filter((thread) => key(thread) !== this.activeKey)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      if (this.reconcileRetry) clearTimeout(this.reconcileRetry);
      this.reconcileRetry = undefined;
      this.schedule(0);
    } finally { this.reconcilePending = false; }
  }

  capture(thread: ThreadSummary, full: unknown) {
    if (this.closed || this.captures.size >= 8 || this.captures.has(key(thread)) || this.agents.busyThreads().length > 0 ||
        (full as any)?.__cachedTailOmitted) return;
    // HTTP folding/paging replaces the outer turns reference after capture.
    // Keep the full reference without copying large tool outputs.
    const transcript = full && typeof full === "object" ? { ...full } : full;
    this.captures.add(key(thread));
    const timer = setTimeout(async () => {
      this.auxiliaryTimers.delete(timer);
      if (this.closed) { this.captures.delete(key(thread)); return; }
      try {
        await this.store.upsert(thread, transcript);
        this.queue = this.queue.filter((item) => key(item) !== key(thread));
      } catch (error) {
        await this.store.markFailure(thread, error).catch(() => {});
      } finally { this.captures.delete(key(thread)); }
    }, 0);
    this.auxiliaryTimers.add(timer);
    timer.unref();
  }

  async progress(threads: ThreadSummary[]) {
    const allowed = new Set(threads.map(key));
    const indexed = await this.store.indexedCount(allowed);
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
    if (this.closed || this.activeKey) return;
    if (this.agents.busyThreads().length > 0 || this.agents.historyInteractionActive?.()) {
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
        { background: true },
      );
      if (this.closed) return;
      await this.store.upsert(thread, full);
    } catch (error) {
      if (this.closed) return;
      await this.store.markFailure(thread, error).catch(() => {});
    } finally {
      this.activeKey = undefined;
    }
    this.schedule(INDEX_INTERVAL_MS);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.reconcileRetry) clearTimeout(this.reconcileRetry);
    for (const timer of this.auxiliaryTimers) clearTimeout(timer);
    this.auxiliaryTimers.clear();
    this.captures.clear();
    this.store.close();
  }
}
