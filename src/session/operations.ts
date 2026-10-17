import { useSyncExternalStore } from "react";
import { post, remove } from "../api";
import { threadPath } from "../agents";
import { sessionKey } from "../format";
import type { ThreadSummary } from "../types";

type Operation = "fork" | "delete";
export type PendingSessionOperation = { key: string; kind: Operation; name: string; startedAt: number };
const pending = new Map<string, { kind: Operation; identity: string; promise: Promise<any>; status: PendingSessionOperation }>();
const emptySnapshot: readonly PendingSessionOperation[] = [];
let snapshot = emptySnapshot;
const listeners = new Set<() => void>();
function notify() {
  snapshot = [...pending.values()].map((operation) => operation.status);
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getPendingSessionOperations() { return snapshot; }
export function usePendingSessionOperations() {
  return useSyncExternalStore(subscribe, getPendingSessionOperations, () => emptySnapshot);
}

export function hasPendingSessionOperations() { return pending.size > 0; }

export function useSessionOperation(thread?: ThreadSummary | null) {
  const key = thread ? sessionKey(thread) : "";
  return useSyncExternalStore(subscribe, () => pending.get(key)?.kind);
}

function run<T>(thread: ThreadSummary, kind: Operation, action: () => Promise<T>, identity = ""): Promise<T> {
  const key = sessionKey(thread);
  const current = pending.get(key);
  if (current) return current.kind === kind && current.identity === identity
    ? current.promise
    : Promise.reject(new Error("此会话还有操作正在进行，请稍候"));
  // Install the guard before starting fetch, including same-tick double clicks.
  const promise = Promise.resolve().then(action).finally(() => {
    if (pending.get(key)?.promise === promise) pending.delete(key);
    notify();
  });
  pending.set(key, { kind, identity, promise,
    status: { key, kind, name: thread.name || "未命名会话", startedAt: Date.now() },
  });
  notify();
  return promise;
}

export function forkSession(thread: ThreadSummary, lastTurnId?: string) {
  return run<ThreadSummary>(thread, "fork", () => post(
    (thread.agentId || "codex") === "codex"
      ? `/threads/${encodeURIComponent(thread.providerId)}/${encodeURIComponent(thread.id)}/fork`
      : `${threadPath(thread)}/fork`,
    lastTurnId ? { lastTurnId } : {},
  ), lastTurnId || "");
}

export function deleteSession(thread: ThreadSummary) {
  return run(thread, "delete", () => remove(
    threadPath(thread) + (thread.agentId === "opencode" ? "?ack=1" : ""),
    thread.agentId === "claude" && thread.claudeConnected ? { closeConnection: true } : undefined,
  ));
}
