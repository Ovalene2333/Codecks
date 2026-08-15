import { sessionKey } from "../format";
import type { ThreadSummary } from "../types";

const STORAGE_KEY = "codex-deck:unseen-sessions:v1";
const ACTIVE_STATUSES = new Set<ThreadSummary["status"]>([
  "starting",
  "running",
  "waiting",
]);

export function threadStatusMap(threads: ThreadSummary[]) {
  return new Map(threads.map((thread) => [sessionKey(thread), thread.status]));
}

export function completedThreads(
  previous: Map<string, ThreadSummary["status"]>,
  threads: ThreadSummary[],
) {
  return threads.filter((thread) => {
    const before = previous.get(sessionKey(thread));
    return Boolean(
      before && ACTIVE_STATUSES.has(before) && thread.status === "idle",
    );
  });
}

export function reconcileUnseenSessions({
  current,
  previous,
  threads,
  selected,
  visible,
}: {
  current: ReadonlySet<string>;
  previous: Map<string, ThreadSummary["status"]>;
  threads: ThreadSummary[];
  selected?: string;
  visible: boolean;
}) {
  const available = new Set(threads.map(sessionKey));
  const next = new Set([...current].filter((key) => available.has(key)));

  for (const thread of completedThreads(previous, threads)) {
    const key = sessionKey(thread);
    if (!visible || selected !== key) next.add(key);
  }
  if (visible && selected) next.delete(selected);
  return next;
}

export function sameSessionSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
) {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

export function readUnseenSessions() {
  try {
    if (typeof localStorage === "undefined") return new Set<string>();
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return new Set(
      Array.isArray(raw) ? raw.filter((item) => typeof item === "string") : [],
    );
  } catch {
    return new Set<string>();
  }
}

export function writeUnseenSessions(value: ReadonlySet<string>) {
  try {
    if (typeof localStorage !== "undefined")
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...value]));
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}
