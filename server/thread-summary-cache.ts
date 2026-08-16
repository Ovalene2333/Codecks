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
    (thread.agentId === "codex" || thread.agentId === "claude"),
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
    this.timer = setTimeout(() => void this.flush(), 150);
    this.timer.unref();
  }

  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const snapshot = this.pending;
    this.pending = undefined;
    if (!snapshot) return this.writes;
    this.writes = this.writes.then(async () => {
      await mkdir(this.dataDir, { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporary, this.file);
    });
    return this.writes;
  }
}
