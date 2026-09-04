import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ThreadSummary } from "./types.js";

interface CachedThreadSummaries {
  version: 1;
  savedAt: number;
  threads: ThreadSummary[];
  archivedThreads: ThreadSummary[];
}

function validThread(value: unknown): value is ThreadSummary {
  if (!value || typeof value !== "object") return false;
  const thread = value as Partial<ThreadSummary>;
  return Boolean(
    thread.id &&
    thread.providerId &&
    (thread.agentId === "codex" ||
      thread.agentId === "claude" ||
      thread.agentId === "opencode"),
  );
}

function restoredThread(thread: ThreadSummary): ThreadSummary {
  return { ...thread, compacting: false };
}

function cachedThread(thread: ThreadSummary): ThreadSummary {
  const { compacting: _compacting, ...cached } = thread;
  return cached as ThreadSummary;
}

export class ThreadSummaryCache {
  private file: string;
  private pending?: CachedThreadSummaries;
  private timer?: NodeJS.Timeout;
  private writes = Promise.resolve();

  constructor(private dataDir: string) {
    this.file = path.join(dataDir, "thread-summaries.json");
  }

  async load(): Promise<CachedThreadSummaries> {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (parsed?.version !== 1) throw new Error("unsupported cache version");
      return {
        version: 1,
        savedAt: Number(parsed.savedAt) || 0,
        threads: Array.isArray(parsed.threads)
          ? parsed.threads.filter(validThread).map(restoredThread)
          : [],
        archivedThreads: Array.isArray(parsed.archivedThreads)
          ? parsed.archivedThreads.filter(validThread).map(restoredThread)
          : [],
      };
    } catch {
      return { version: 1, savedAt: 0, threads: [], archivedThreads: [] };
    }
  }

  schedule(threads: ThreadSummary[], archivedThreads: ThreadSummary[] = []) {
    this.pending = {
      version: 1,
      savedAt: Date.now(),
      threads: threads.map(cachedThread),
      archivedThreads: archivedThreads.map(cachedThread),
    };
    if (this.timer) return;
    // flush 自带 catch：timer 路径丢弃 promise，一次写失败即 unhandled rejection 崩进程。
    this.timer = setTimeout(() => {
      this.flush().catch((error) => {
        console.error("线程摘要缓存写入失败:", error?.message || error);
      });
    }, 150);
    this.timer.unref();
  }

  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const snapshot = this.pending;
    this.pending = undefined;
    if (!snapshot) return this.writes;
    // 写链自愈：一次失败后重置链，避免后续所有 flush 带着旧错误永久跳过。
    // 失败的 snapshot 已无意义（更新的 schedule 会覆盖），直接丢弃并记录。
    const attempt = this.writes.catch(() => undefined).then(async () => {
      await mkdir(this.dataDir, { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.file);
    });
    this.writes = attempt.catch(() => undefined);
    return attempt;
  }
}
