import type { Snapshot } from "./types";

const SNAPSHOT_KEY = "codex-deck:snapshot:v1";
const THREAD_PREFIX = "codex-deck:thread:v1:";
const THREAD_INDEX_KEY = "codex-deck:thread-index:v1";
const UI_KEY = "codex-deck:ui:v2";
const MAX_CACHED_THREADS = 24;

export interface DeckUiCache {
  expandedProjects: string[];
  query: string;
}

const memorySnapshot: { current: Snapshot | null } = { current: null };
const memoryThreads = new Map<string, unknown>();
const memoryUi: { current: DeckUiCache | null } = { current: null };
const inflightThreads = new Map<string, Promise<unknown>>();

let injectedStore: Storage | null | undefined;

export function configureCacheStorage(store: Storage | null | undefined) {
  injectedStore = store;
}

function getStore(): Storage | null {
  if (injectedStore !== undefined) return injectedStore;
  try {
    if (typeof sessionStorage === "undefined") return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

function readJson<T>(key: string): T | null {
  const store = getStore();
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  const store = getStore();
  if (!store) return;
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    evictOldestThread();
    try {
      store.setItem(key, JSON.stringify(value));
    } catch {
      // quota / private mode
    }
  }
}

function evictOldestThread() {
  const store = getStore();
  const index = readJson<string[]>(THREAD_INDEX_KEY) || [];
  const dropped = index.pop();
  if (dropped) {
    memoryThreads.delete(dropped);
    try {
      store?.removeItem(THREAD_PREFIX + dropped);
    } catch {
      // ignore
    }
    writeJson(THREAD_INDEX_KEY, index);
  }
}

export function sanitizeSnapshot(snapshot: Snapshot): Snapshot {
  return {
    providers: snapshot.providers,
    threads: snapshot.threads,
    archivedThreads: snapshot.archivedThreads,
    projects: snapshot.projects,
    preferences: snapshot.preferences,
    runtime: snapshot.runtime,
    approvals: [],
  };
}

export function readSnapshotCache(): Snapshot | null {
  if (memorySnapshot.current) return memorySnapshot.current;
  const cached = readJson<Snapshot>(SNAPSHOT_KEY);
  if (cached) memorySnapshot.current = cached;
  return cached;
}

export function writeSnapshotCache(snapshot: Snapshot) {
  const next = sanitizeSnapshot(snapshot);
  memorySnapshot.current = next;
  writeJson(SNAPSHOT_KEY, next);
}

export function readThreadCache<T = unknown>(key: string): T | null {
  if (memoryThreads.has(key)) return memoryThreads.get(key) as T;
  const cached = readJson<T>(THREAD_PREFIX + key);
  if (cached) memoryThreads.set(key, cached);
  return cached;
}

export function writeThreadCache(key: string, data: unknown) {
  memoryThreads.set(key, data);
  const index = [
    key,
    ...(readJson<string[]>(THREAD_INDEX_KEY) || []).filter((item) => item !== key),
  ];
  const dropped = index.slice(MAX_CACHED_THREADS);
  const kept = index.slice(0, MAX_CACHED_THREADS);
  const store = getStore();
  for (const item of dropped) {
    memoryThreads.delete(item);
    try {
      store?.removeItem(THREAD_PREFIX + item);
    } catch {
      // ignore
    }
  }
  writeJson(THREAD_INDEX_KEY, kept);
  writeJson(THREAD_PREFIX + key, data);
}

export function dedupeThreadLoad<T>(
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const existing = inflightThreads.get(key);
  if (existing) return existing as Promise<T>;
  const request = load()
    .then((data) => {
      writeThreadCache(key, data);
      return data;
    })
    .finally(() => {
      inflightThreads.delete(key);
    });
  inflightThreads.set(key, request);
  return request;
}

export function readUiCache(): DeckUiCache {
  if (memoryUi.current) return memoryUi.current;
  const cached = readJson<DeckUiCache>(UI_KEY);
  const next: DeckUiCache = {
    expandedProjects: Array.isArray(cached?.expandedProjects)
      ? cached.expandedProjects.filter((item) => typeof item === "string")
      : [],
    query: typeof cached?.query === "string" ? cached.query : "",
  };
  memoryUi.current = next;
  return next;
}

export function writeUiCache(state: DeckUiCache) {
  memoryUi.current = {
    expandedProjects: [...state.expandedProjects],
    query: state.query,
  };
  writeJson(UI_KEY, memoryUi.current);
}

export function resetCacheForTests() {
  memorySnapshot.current = null;
  memoryThreads.clear();
  memoryUi.current = null;
  inflightThreads.clear();
}
