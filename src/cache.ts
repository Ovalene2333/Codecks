import type {
  Approval,
  ProjectRecord,
  Provider,
  Snapshot,
  ThreadActivity,
  ThreadSummary,
} from "./types";

export const SNAPSHOT_KEY = "codex-deck:snapshot:v2";
const SNAPSHOT_LEGACY_KEYS = ["codex-deck:snapshot:v1"];
const THREAD_PREFIX = "codex-deck:thread:v1:";
const THREAD_INDEX_KEY = "codex-deck:thread-index:v1";
const THREAD_ETAG_KEY = "codex-deck:thread-etag:v1";
const UI_KEY = "codex-deck:ui:v2";
/** 落盘（localStorage）最多留几个会话。 */
const MAX_CACHED_THREADS = 24;
/**
 * 内存里的会话全文按“最近用过”留，条数和总量（JSON 字符数）双上限：
 * 手机浏览器内存吃紧会直接杀页面，比慢一点更糟。
 */
const MEMORY_THREAD_LIMIT = 8;
const MEMORY_THREAD_BUDGET = 8_000_000;
/**
 * 落盘只存尾部：打开会话第一屏只看得到最后几轮，往上翻之前全文早已拉回。
 * 被截掉的条数记在 PARTIAL_KEY 上；带这个标记的副本不能当 304 的复用体。
 */
const PERSIST_TURNS = 40;
const PERSIST_MAX_CHARS = 400_000;
export const PARTIAL_KEY = "__cachedTailOmitted";

export interface DeckUiCache {
  expandedProjects: string[];
  query: string;
}

const memorySnapshot: { current: Snapshot | null } = { current: null };
/** Map 的插入顺序即 LRU 顺序：读写时挪到末尾，淘汰从头部开始。 */
const memoryThreads = new Map<string, { data: unknown; size: number }>();
let memoryThreadChars = 0;
const memoryEtags = new Map<string, string>();
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
  let raw: string;
  try {
    raw = JSON.stringify(value);
  } catch {
    return;
  }
  writeString(key, raw);
}

function writeString(key: string, raw: string) {
  const store = getStore();
  if (!store) return;
  try {
    store.setItem(key, raw);
  } catch {
    evictOldestThread();
    try {
      store.setItem(key, raw);
    } catch {
      // quota / private mode
    }
  }
}

/** 给其它缓存模块（swr-cache）共用同一份可注入的存储。 */
export function getCacheStore() {
  return getStore();
}

function evictOldestThread() {
  const store = getStore();
  const index = readJson<string[]>(THREAD_INDEX_KEY) || [];
  const dropped = index.pop();
  if (dropped) {
    forgetMemoryThread(dropped);
    dropThreadEtag(dropped);
    try {
      store?.removeItem(THREAD_PREFIX + dropped);
    } catch {
      // ignore
    }
    writeJson(THREAD_INDEX_KEY, index);
  }
}

function forgetMemoryThread(key: string) {
  const entry = memoryThreads.get(key);
  if (!entry) return;
  memoryThreads.delete(key);
  memoryThreadChars -= entry.size;
}

function rememberThread(key: string, data: unknown, size: number) {
  forgetMemoryThread(key);
  // 单个就超预算的超长会话不进内存缓存：组件 state 里本来就有一份。
  if (size > MEMORY_THREAD_BUDGET) return;
  memoryThreads.set(key, { data, size });
  memoryThreadChars += size;
  for (const [oldest, entry] of memoryThreads) {
    if (
      memoryThreads.size <= MEMORY_THREAD_LIMIT &&
      memoryThreadChars <= MEMORY_THREAD_BUDGET
    )
      break;
    if (oldest === key) break;
    memoryThreads.delete(oldest);
    memoryThreadChars -= entry.size;
  }
}

/** 会话全文的落盘版本：超过轮数/体积就只留尾部并打上 PARTIAL_KEY；单轮都放不下时返回 null。 */
function persistedThread(data: unknown, raw: string): string | null {
  const thread = data as { turns?: unknown[]; [PARTIAL_KEY]?: number } | null;
  const turns = thread && Array.isArray(thread.turns) ? thread.turns : null;
  if (!turns) return raw.length <= PERSIST_MAX_CHARS ? raw : null;
  if (raw.length <= PERSIST_MAX_CHARS && turns.length <= PERSIST_TURNS)
    return raw;
  const omittedBefore = Number(thread?.[PARTIAL_KEY]) || 0;
  let keep = Math.min(PERSIST_TURNS, turns.length);
  while (keep >= 1) {
    const omitted = omittedBefore + turns.length - keep;
    const next = JSON.stringify({
      ...thread,
      turns: turns.slice(-keep),
      ...(omitted ? { [PARTIAL_KEY]: omitted } : {}),
    });
    if (next.length <= PERSIST_MAX_CHARS) return next;
    keep = Math.floor(keep / 2);
  }
  return null;
}

export function isPartialThread(data: unknown) {
  return Boolean(
    data && typeof data === "object" && (data as any)[PARTIAL_KEY],
  );
}

function compactThread(thread: ThreadSummary): ThreadSummary {
  return {
    agentId: thread.agentId,
    id: thread.id,
    providerId: thread.providerId,
    name: thread.name,
    preview: thread.preview,
    cwd: thread.cwd,
    model: thread.model,
    resolvedModel: thread.resolvedModel,
    reasoningEffort: thread.reasoningEffort,
    status: thread.status,
    activeTurnId: thread.activeTurnId,
    updatedAt: thread.updatedAt,
    archived: thread.archived,
    controlMode: thread.controlMode,
    locked: thread.locked,
    claudeConnected: thread.claudeConnected,
    permissionMode: thread.permissionMode,
    sessionMode: thread.sessionMode,
    sessionId: thread.sessionId,
    interruptedTurnId: thread.interruptedTurnId,
    forkedFromId: thread.forkedFromId,
    // 首页用量合计、上下文占比、“压缩上下文/失败”行都靠这几个小字段；
    // 不带上的话刷新后先显示“—”，等实时快照到了再跳成真实值。
    // lastError 可能带出模型/命令输出的原文，仍然不落盘，只留错误码。
    tokenUsage: thread.tokenUsage,
    errorCode: thread.errorCode,
    compacting: thread.compacting,
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
    // 首页「运行健康」的供应商异常行。
    error: provider.error,
  };
}

/** 活动只缓存首页要画的部分：当前步骤 + 上一轮结果与回复开头。 */
function compactActivity(activity: ThreadActivity): ThreadActivity {
  return {
    agentId: activity.agentId,
    threadId: activity.threadId,
    turnId: activity.turnId,
    turnStartedAt: activity.turnStartedAt,
    lastEventAt: activity.lastEventAt,
    step: activity.step
      ? {
          startedAt: activity.step.startedAt,
          // 命令/子代理 prompt 可能是整段 heredoc，首页只显示一行。
          item: {
            ...activity.step.item,
            command: activity.step.item.command?.slice(0, 300),
            prompt: activity.step.item.prompt?.slice(0, 300),
          },
        }
      : undefined,
    lastTurn: activity.lastTurn
      ? {
          ...activity.lastTurn,
          reply: activity.lastTurn.reply?.slice(0, 240),
        }
      : undefined,
  };
}

export function compactSnapshot(snapshot: Snapshot): Snapshot {
  return {
    // agent 列表决定新建弹窗的可选 agent、会话菜单的能力开关和首页健康面板；
    // 不缓存的话冷启动时这些地方先按“只有 Codex”渲染，快照到了再整块重排。
    agents: snapshot.agents,
    agentProfiles: snapshot.agentProfiles,
    providers: (snapshot.providers || []).map(compactProvider),
    threads: (snapshot.threads || []).map(compactThread),
    archivedThreads: (snapshot.archivedThreads || []).map(compactThread),
    projects: snapshot.projects,
    preferences: snapshot.preferences,
    // watcher/代号列表极小，带上它们首页「deck-wake 监督中」与会话页
    // 图标才能随快照缓存秒出，不必再等一次接口往返。
    wakeCodes: snapshot.wakeCodes,
    wakeWatchers: snapshot.wakeWatchers,
    wakeLost: snapshot.wakeLost,
    messageDeliveries: snapshot.messageDeliveries,
    runtime: snapshot.runtime
      ? {
          online: snapshot.runtime.online,
          starting: snapshot.runtime.starting,
          remoteUrl: snapshot.runtime.remoteUrl,
          error: snapshot.runtime.error,
          runtimeWsl: snapshot.runtime.runtimeWsl,
          modelConfig: snapshot.runtime.modelConfig,
          // 首页「用量与额度」：不带上的话刷新后额度块要等实时快照才出现。
          // 账号只留套餐信息，不落邮箱。
          rateLimits: snapshot.runtime.rateLimits,
          rateLimitsError: snapshot.runtime.rateLimitsError,
          account: snapshot.runtime.account
            ? {
                authMode: snapshot.runtime.account.authMode,
                planType: snapshot.runtime.account.planType,
                chatgpt: snapshot.runtime.account.chatgpt,
              }
            : undefined,
        }
      : undefined,
    activities: snapshot.activities?.map(compactActivity),
    wakeDeliveries: snapshot.wakeDeliveries,
    tools: snapshot.tools,
    server: snapshot.server,
    // 审批不缓存：过期的审批卡片点了也只会报“已不存在”，宁可等实时快照。
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

function cachedThreadKey(thread: ThreadSummary) {
  return `${thread.agentId || "codex"}:${thread.id}`;
}

function retainPendingAgentThreads(
  incoming: ThreadSummary[],
  current: ThreadSummary[],
  snapshot: Snapshot,
) {
  const statuses = new Map(
    (snapshot.agents || []).map((agent) => [
      agent.id,
      // 待命的备选 agent、已停用的 agent：会话是服务端有意不下发的，
      // 缓存里的旧副本不该留下（否则会永远卡在侧栏里）。
      agent.standby || agent.enabled === false ? "ready" : agent.historyStatus,
    ]),
  );
  if (!statuses.size) return incoming;
  const merged = new Map(
    incoming.map((thread) => [cachedThreadKey(thread), thread]),
  );
  for (const thread of current) {
    const status = statuses.get(thread.agentId || "codex");
    if (status && status !== "ready") {
      const key = cachedThreadKey(thread);
      if (!merged.has(key)) merged.set(key, thread);
    }
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function reconcileSnapshot(
  current: Snapshot,
  incoming: Snapshot,
): Snapshot {
  return {
    ...incoming,
    threads: retainPendingAgentThreads(
      incoming.threads || [],
      current.threads || [],
      incoming,
    ),
    archivedThreads: retainPendingAgentThreads(
      incoming.archivedThreads || [],
      current.archivedThreads || [],
      incoming,
    ),
  };
}

/**
 * 保守合并：HTTP 快照请求发出后、又有 WS 事件落地时使用。
 * 此时响应可能是“旧的”（服务端先生成响应、WS 事件后到客户端），
 * 不能整体覆盖，否则 WS 刚推送的审批/运行状态会被回退。
 * - threads/archivedThreads：按 updatedAt 取新的一方；
 * - approvals：取并集，冲突时 incoming 胜出；
 * - 其余字段以 incoming 为准。
 * 残留边缘：请求发出前已 resolve 的审批，若响应生成晚于 resolve 则正常消失；
 * 若响应生成早于中途的 resolve/删除，被删条目会短暂复活，下次刷新自愈。
 */
export function mergeStaleSnapshot(
  current: Snapshot,
  incoming: Snapshot,
): Snapshot {
  return {
    ...incoming,
    threads: pickNewestThreads(incoming.threads, current.threads),
    archivedThreads: pickNewestThreads(
      incoming.archivedThreads,
      current.archivedThreads,
    ),
    approvals: mergeApprovals(incoming.approvals, current.approvals),
  };
}

function pickNewestThreads(
  primary?: ThreadSummary[],
  secondary?: ThreadSummary[],
): ThreadSummary[] {
  const merged = new Map<string, ThreadSummary>();
  for (const thread of primary || [])
    merged.set(cachedThreadKey(thread), thread);
  for (const thread of secondary || []) {
    const key = cachedThreadKey(thread);
    const prev = merged.get(key);
    if (!prev || (thread.updatedAt || 0) > (prev.updatedAt || 0))
      merged.set(key, thread);
  }
  return [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}

function approvalKey(item: Approval) {
  return `${item.agentId || "codex"}:${item.id}`;
}

function mergeApprovals(
  incoming?: Approval[],
  current?: Approval[],
): Approval[] {
  const merged = new Map<string, Approval>();
  for (const item of incoming || []) merged.set(approvalKey(item), item);
  for (const item of current || []) {
    const key = approvalKey(item);
    if (!merged.has(key)) merged.set(key, item);
  }
  return [...merged.values()];
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

/**
 * 会话缓存：先查内存（全文），再查落盘（可能只是尾部，见 isPartialThread）。
 * 只用来先画首屏；要当 304 复用体时用 readCompleteThreadCache。
 */
export function readThreadCache<T = unknown>(key: string): T | null {
  const entry = memoryThreads.get(key);
  if (entry) {
    rememberThread(key, entry.data, entry.size);
    return entry.data as T;
  }
  const store = getStore();
  const raw = store ? readRaw(store, THREAD_PREFIX + key) : null;
  if (!raw) return null;
  try {
    const cached = JSON.parse(raw) as T;
    if (cached) rememberThread(key, cached, raw.length);
    return cached;
  } catch {
    return null;
  }
}

/** 完整的会话全文（不是截过尾的落盘副本），条件请求 304 时才能拿它顶替响应体。 */
export function readCompleteThreadCache<T = unknown>(key: string): T | null {
  const cached = readThreadCache<T>(key);
  return cached && !isPartialThread(cached) ? cached : null;
}

/**
 * 连尾部副本都塞不进落盘上限的会话（单轮就超 400KB）。它们永远进不了
 * `cachedThreadKeys`，预取若不看这个集合，每次快照变化都会对它们重新
 * 拉全文——对 ACP agent 来说每次都等于一次完整 session/load 回放。
 */
const uncacheableThreads = new Set<string>();
export function isThreadUncacheable(key: string) {
  return uncacheableThreads.has(key);
}

/** 有没有缓存过这个会话（内存或落盘），不解析正文：预取判断用。 */
export function cachedThreadKeys() {
  const keys = new Set(memoryThreads.keys());
  for (const key of readJson<string[]>(THREAD_INDEX_KEY) || []) keys.add(key);
  return keys;
}

export function writeThreadCache(key: string, data: unknown) {
  let raw: string;
  try {
    raw = JSON.stringify(data);
  } catch {
    return;
  }
  rememberThread(key, data, raw.length);
  const index = [
    key,
    ...(readJson<string[]>(THREAD_INDEX_KEY) || []).filter(
      (item) => item !== key,
    ),
  ];
  const dropped = index.slice(MAX_CACHED_THREADS);
  const kept = index.slice(0, MAX_CACHED_THREADS);
  const store = getStore();
  for (const item of dropped) {
    forgetMemoryThread(item);
    dropThreadEtag(item);
    try {
      store?.removeItem(THREAD_PREFIX + item);
    } catch {
      // ignore
    }
  }
  const persisted = persistedThread(data, raw);
  if (persisted === null) {
    // 连最后一轮都放不下：不落盘，免得一个超长会话把其它会话的缓存挤光。
    // 标记为不可缓存：内存条目被 LRU 淘汰后也不要再为它预取全文。
    uncacheableThreads.add(key);
    try {
      store?.removeItem(THREAD_PREFIX + key);
    } catch {
      // ignore
    }
    writeJson(
      THREAD_INDEX_KEY,
      kept.filter((item) => item !== key),
    );
    return;
  }
  uncacheableThreads.delete(key);
  writeJson(THREAD_INDEX_KEY, kept);
  writeString(THREAD_PREFIX + key, persisted);
}

function readEtagMap(): Record<string, string> {
  const cached = readJson<Record<string, string>>(THREAD_ETAG_KEY);
  return cached && typeof cached === "object" ? cached : {};
}

export function readThreadEtag(key: string) {
  if (memoryEtags.has(key)) return memoryEtags.get(key) || null;
  const etag = readEtagMap()[key];
  if (typeof etag === "string") {
    memoryEtags.set(key, etag);
    return etag;
  }
  return null;
}

export function writeThreadEtag(key: string, etag: string) {
  memoryEtags.set(key, etag);
  const map = readEtagMap();
  map[key] = etag;
  writeJson(THREAD_ETAG_KEY, map);
}

function dropThreadEtag(key: string) {
  memoryEtags.delete(key);
  const map = readEtagMap();
  if (key in map) {
    delete map[key];
    writeJson(THREAD_ETAG_KEY, map);
  }
}

export function dedupeThreadLoad<T>(
  key: string,
  load: () => Promise<T>,
  fresh = false,
): Promise<T> {
  const existing = inflightThreads.get(key);
  // A mutation (revert/unrevert) needs a request started after any older load.
  // Otherwise the older response can keep the just-removed turns on screen.
  if (fresh && existing)
    return existing
      .catch(() => undefined)
      .then(() => dedupeThreadLoad(key, load));
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

/** 只是缓存（随时可重建）的键前缀；令牌、外观、设置等偏好不在其中。 */
const CACHE_KEY_PREFIXES = [
  "codex-deck:snapshot:",
  "codex-deck:thread:",
  "codex-deck:thread-index:",
  "codex-deck:thread-etag:",
  "codex-deck:swr:",
];
const CLEAR_ON_BOOT_KEY = "codex-deck:clear-cache-on-boot";

function cacheKeys(store: Storage) {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (key && CACHE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)))
      keys.push(key);
  }
  return keys;
}

/** 本地缓存占用（UTF-16 粗估字节数）与缓存的会话全文条数。 */
export function localCacheUsage() {
  const store = getStore();
  let bytes = 0;
  let threads = 0;
  if (!store) return { bytes, threads };
  try {
    for (const key of cacheKeys(store)) {
      bytes += (key.length + (readRaw(store, key)?.length || 0)) * 2;
      if (key.startsWith(THREAD_PREFIX)) threads += 1;
    }
  } catch {
    // 存储不可用：按 0 计
  }
  return { bytes, threads };
}

/**
 * 预约「下次启动时清缓存」再刷新页面。不能当场删：页面卸载时 App 会把
 * 内存里的快照立刻落盘（pagehide flush），当场删完又被写回来。
 */
export function requestLocalCacheClear() {
  try {
    sessionStorage.setItem(CLEAR_ON_BOOT_KEY, "1");
  } catch {
    // sessionStorage 不可用就退回当场删
    clearLocalCacheNow();
  }
}

function clearLocalCacheNow() {
  for (const store of [getStore(), typeof sessionStorage === "undefined" ? null : sessionStorage]) {
    if (!store) continue;
    try {
      for (const key of cacheKeys(store)) store.removeItem(key);
    } catch {
      // ignore
    }
  }
  resetCacheForTests();
}

/** 启动时（读缓存之前）调用：有预约就清掉缓存。 */
export function applyPendingLocalCacheClear() {
  try {
    if (sessionStorage.getItem(CLEAR_ON_BOOT_KEY) !== "1") return false;
    sessionStorage.removeItem(CLEAR_ON_BOOT_KEY);
  } catch {
    return false;
  }
  clearLocalCacheNow();
  return true;
}

export function resetCacheForTests() {
  memorySnapshot.current = null;
  memoryThreads.clear();
  memoryThreadChars = 0;
  memoryEtags.clear();
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
