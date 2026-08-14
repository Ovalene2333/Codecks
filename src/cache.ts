import type {
  ProjectRecord,
  Provider,
  Snapshot,
  ThreadSummary,
} from "./types";

export const SNAPSHOT_KEY = "codex-deck:snapshot:v2";
const SNAPSHOT_LEGACY_KEYS = ["codex-deck:snapshot:v1"];
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
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

function readRaw(store: Storage, key: string) {
  try {
    return store.getItem(key);
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

function compactThread(thread: ThreadSummary): ThreadSummary {
  return {
    id: thread.id,
    providerId: thread.providerId,
    name: thread.name,
    preview: thread.preview,
    cwd: thread.cwd,
    model: thread.model,
    status: thread.status,
    updatedAt: thread.updatedAt,
    archived: thread.archived,
    controlMode: thread.controlMode,
    forkedFromId: thread.forkedFromId,
  };
}

function compactProvider(provider: Provider): Provider {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    color: provider.color,
    model: provider.model,
    hasApiKey: provider.hasApiKey,
    enabled: provider.enabled,
    online: provider.online,
    current: provider.current,
  };
}

export function compactSnapshot(snapshot: Snapshot): Snapshot {
  return {
    providers: (snapshot.providers || []).map(compactProvider),
    threads: (snapshot.threads || []).map(compactThread),
    archivedThreads: (snapshot.archivedThreads || []).map(compactThread),
    projects: snapshot.projects,
    preferences: snapshot.preferences,
    runtime: snapshot.runtime
      ? {
          online: snapshot.runtime.online,
          starting: snapshot.runtime.starting,
          remoteUrl: snapshot.runtime.remoteUrl,
          error: snapshot.runtime.error,
        }
      : undefined,
    approvals: [],
  };
}

export function hasSidebarData(snapshot: Snapshot | null | undefined) {
  return Boolean(
    snapshot &&
      ((snapshot.threads && snapshot.threads.length) ||
        (snapshot.archivedThreads && snapshot.archivedThreads.length) ||
        (snapshot.projects && snapshot.projects.length)),
  );
}

export function sanitizeSnapshot(snapshot: Snapshot): Snapshot {
  return compactSnapshot(snapshot);
}

function migrateLegacySnapshot(store: Storage): Snapshot | null {
  for (const key of SNAPSHOT_LEGACY_KEYS) {
    const raw = readRaw(store, key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Snapshot;
      if (hasSidebarData(parsed)) {
        const next = compactSnapshot(parsed);
        store.setItem(SNAPSHOT_KEY, JSON.stringify(next));
        store.removeItem(key);
        return next;
      }
    } catch {
      // ignore broken legacy rows
    }
    try {
      store.removeItem(key);
    } catch {
      // ignore
    }
  }
  if (typeof sessionStorage === "undefined" || store === sessionStorage)
    return null;
  try {
    for (const key of [SNAPSHOT_KEY, ...SNAPSHOT_LEGACY_KEYS]) {
      const raw = sessionStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as Snapshot;
      if (hasSidebarData(parsed)) {
        const next = compactSnapshot(parsed);
        store.setItem(SNAPSHOT_KEY, JSON.stringify(next));
        sessionStorage.removeItem(key);
        return next;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export function readSnapshotCache(): Snapshot | null {
  if (memorySnapshot.current) return memorySnapshot.current;
  const store = getStore();
  const cached = readJson<Snapshot>(SNAPSHOT_KEY);
  if (hasSidebarData(cached)) {
    memorySnapshot.current = cached;
    return cached;
  }
  if (store) {
    const migrated = migrateLegacySnapshot(store);
    if (migrated) {
      memorySnapshot.current = migrated;
      return migrated;
    }
  }
  return null;
}

export function writeSnapshotCache(snapshot: Snapshot) {
  if (!hasSidebarData(snapshot)) return;
  const next = compactSnapshot(snapshot);
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
    query: "",
  };
  memoryUi.current = next;
  return next;
}

export function writeUiCache(state: DeckUiCache) {
  memoryUi.current = {
    expandedProjects: [...state.expandedProjects],
    query: "",
  };
  writeJson(UI_KEY, memoryUi.current);
}

export function resetCacheForTests() {
  memorySnapshot.current = null;
  memoryThreads.clear();
  memoryUi.current = null;
  inflightThreads.clear();
}

export function projectNamesFromSnapshot(snapshot: Snapshot) {
  const names = new Map<string, string>();
  for (const project of snapshot.projects || []) {
    const key = project.key || project.cwd;
    if (key) names.set(key, project.name || basename(project.cwd));
  }
  for (const thread of snapshot.threads || []) {
    const key = thread.cwd || "未指定路径";
    if (!names.has(key)) names.set(key, basename(key));
  }
  return [...names.values()];
}

function basename(path: string) {
  return path.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || path;
}

export type { ProjectRecord };
