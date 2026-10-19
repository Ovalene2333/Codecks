import { setImmediate as yieldToLoop } from "node:timers/promises";
import { backgroundWork } from "./background-work.js";
import type { ThreadSummary } from "./types.js";
import type { SessionSearchMatch } from "./session-search.js";

/** Send bounded message text, never megabytes of tool output, through structured clone. */
async function searchTranscript(full: any) {
  const turns: any[] = [];
  let remaining = 2_000_000;
  let visited = 0;
  for (const turn of full?.turns || []) {
    const items: any[] = [];
    for (const item of turn?.items || []) {
      if (++visited % 128 === 0) await yieldToLoop();
      if (item?.type !== "userMessage" && item?.type !== "agentMessage")
        continue;
      const limit = Math.min(100_000, remaining);
      let text = "";
      if (item.type === "agentMessage" && typeof item.text === "string")
        text = item.text.slice(0, limit);
      if (!text && typeof item.content === "string")
        text = item.content.slice(0, limit);
      if (!text && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (++visited % 128 === 0) await yieldToLoop();
          if (part?.type !== "text" || typeof part.text !== "string") continue;
          text +=
            (text ? "\n" : "") +
            part.text.slice(
              0,
              Math.max(0, limit - text.length - (text ? 1 : 0)),
            );
          if (text.length >= limit) break;
        }
      }
      if (!text && typeof item.text === "string")
        text = item.text.slice(0, limit);
      remaining -= text.length;
      items.push({ id: item.id, type: item.type, text });
      if (!remaining) break;
    }
    turns.push({ id: turn?.id, items });
    if (!remaining) break;
    if (++visited % 128 === 0) await yieldToLoop();
  }
  return { turns, __searchTruncated: remaining === 0 };
}

export class BackgroundSearchStore {
  constructor(private dir: string) {}
  private call<T>(operation: string, params: unknown[]) {
    return backgroundWork<T>("search", [this.dir, operation, params]);
  }
  reconcile(threads: ThreadSummary[]) {
    return this.call<ThreadSummary[]>("reconcile", [threads]);
  }
  async upsert(thread: ThreadSummary, full: unknown) {
    const transcript = await searchTranscript(full);
    await this.call("upsert", [thread, transcript]);
  }
  markFailure(thread: ThreadSummary, error: unknown) {
    // Errors are diagnostics only; never serialize an arbitrary exception object.
    return this.call("failure", [
      thread,
      String((error as Error)?.message || "Indexing failed").slice(0, 500),
    ]);
  }
  search(query: string, allowed: Set<string>, limit?: number) {
    return this.call<SessionSearchMatch[]>("search", [
      query,
      [...allowed],
      limit,
    ]);
  }
  indexedCount(allowed: Set<string>) {
    return this.call<number>("count", [[...allowed]]);
  }
  close() {
    /* The shared worker pool is closed by the server lifecycle. */
  }
}
