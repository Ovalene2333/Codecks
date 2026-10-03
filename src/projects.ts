import type {
  DeckPreferences,
  ProjectRecord,
  Provider,
  ThreadSummary,
} from "./types";
import { toWslCwd } from "./wsl-path";

export interface ProjectGroup {
  key: string;
  cwd: string;
  name: string;
  pinned?: boolean;
  hidden?: boolean;
  defaults?: ProjectRecord["defaults"];
  sessions: ThreadSummary[];
  updatedAt: number;
}

export function normalizeProjectPath(cwd: string) {
  // mergeProjectGroups/filterProjectGroups 在每次快照推送时对每条 thread 调多次
  // （分组一次 + 归属判断 N 次），正则 + toLowerCase 虽小但架不住量大，加有界缓存。
  const hit = normalizeCache.get(cwd);
  if (hit !== undefined) return hit;
  const normalized = normalizeProjectPathSlow(cwd);
  normalizeCache.set(cwd, normalized);
  if (normalizeCache.size > NORMALIZE_CACHE_MAX) normalizeCache.clear();
  return normalized;
}

const NORMALIZE_CACHE_MAX = 2000;
const normalizeCache = new Map<string, string>();

function normalizeProjectPathSlow(cwd: string) {
  let value = cwd.trim().replace(/\\/g, "/");
  // Codex rollouts often persist Windows paths with the \\?\ prefix.
  value = value.replace(/^\/\/\?\/unc\//i, "//");
  if (value.startsWith("//?/")) value = value.slice(4);
  value = value.replace(/\/+$/, "");
  const wslUnc = value.match(
    /^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(?:\/(.*))?$/i,
  );
  if (wslUnc) value = wslUnc[1] ? `/${wslUnc[1]}` : "/";
  const driveOnly = value.match(/^([a-zA-Z]):$/);
  if (driveOnly) return `/mnt/${driveOnly[1].toLowerCase()}`;
  const windows = value.match(/^([a-zA-Z]):\/(.*)$/);
  if (windows) {
    const rest = windows[2];
    const nested = rest.match(/^mnt\/([a-zA-Z])(?:\/(.*))?$/i);
    if (nested) {
      const tail = nested[2] || "";
      return `/mnt/${nested[1].toLowerCase()}${tail ? `/${tail.toLowerCase()}` : ""}`;
    }
    return `/mnt/${windows[1].toLowerCase()}/${rest}`.toLowerCase();
  }
  value = value.toLowerCase() || "未指定路径";
  const doubled = value.match(/^\/mnt\/([a-z])\/mnt\/\1(?:\/(.*))?$/);
  if (doubled) return `/mnt/${doubled[1]}${doubled[2] ? `/${doubled[2]}` : ""}`;
  return value;
}

export function projectBasename(cwd: string) {
  return cwd.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || cwd;
}

export function groupThreadsByProject(
  threads: ThreadSummary[],
): ProjectGroup[] {
  return mergeProjectGroups([], threads);
}

export function mergeProjectGroups(
  records: ProjectRecord[],
  threads: ThreadSummary[],
): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const record of records) {
    const key = normalizeProjectPath(record.key || record.cwd);
    const existing = groups.get(key);
    groups.set(key, {
      key,
      cwd: existing?.cwd || record.cwd,
      name: existing?.name || record.name || projectBasename(record.cwd),
      pinned: existing?.pinned || record.pinned,
      hidden: existing?.hidden || record.hidden,
      defaults: existing?.defaults || record.defaults,
      sessions: existing?.sessions || [],
      updatedAt: Math.max(existing?.updatedAt || 0, record.updatedAt || 0),
    });
  }
  for (const thread of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = normalizeProjectPath(thread.cwd || "未指定路径");
    const group = groups.get(key) || {
      key,
      cwd: thread.cwd || "未指定路径",
      name: projectBasename(thread.cwd || "未指定路径"),
      sessions: [],
      updatedAt: thread.updatedAt,
    };
    group.sessions.push(thread);
    group.updatedAt = Math.max(group.updatedAt, thread.updatedAt);
    if (!group.cwd || group.cwd === "未指定路径") group.cwd = thread.cwd;
    groups.set(key, group);
  }
  return [...groups.values()]
    .filter((group) => !group.hidden || group.sessions.length > 0)
    .sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
}

export function threadsForProject(
  threads: ThreadSummary[],
  projectKey: string,
) {
  const key = normalizeProjectPath(projectKey);
  return threads.filter(
    (thread) => normalizeProjectPath(thread.cwd || "未指定路径") === key,
  );
}

/**
 * 「新建」快捷面板的候选项目：沿用 mergeProjectGroups 的顺序（置顶优先、
 * 再按最近活动），跳过隐藏项目和没有真实路径的占位分组。
 */
export function quickNewProjects(groups: ProjectGroup[], limit = 5) {
  return groups
    .filter(
      (group) => !group.hidden && group.cwd && group.cwd !== "未指定路径",
    )
    .slice(0, limit);
}

/** Sessions updated within this window stay visible while a project is collapsed. */
export const COLLAPSED_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Upper bound for a collapsed preview; active sessions are never dropped by it. */
export const COLLAPSED_PREVIEW_LIMIT = 8;

export function isActiveThread(thread: ThreadSummary) {
  return (
    thread.status === "starting" ||
    thread.status === "running" ||
    thread.status === "waiting" ||
    thread.status === "error" ||
    Boolean(thread.compacting)
  );
}

export interface CollapsedPreviewOptions {
  now?: number;
  recentWindowMs?: number;
  limit?: number;
  /** Extra sessions to keep even when they fall outside the recent window. */
  isPinned?: (thread: ThreadSummary) => boolean;
}

/**
 * A collapsed project still needs to answer "what is going on here?", so it
 * keeps every session that needs attention (running / waiting / error), every
 * session touched inside the recent window, and any pinned session. The rest
 * collapses into the "其余 N 条" affordance.
 */
export function previewSessions(
  sessions: ThreadSummary[],
  expanded: boolean,
  options: CollapsedPreviewOptions = {},
): ThreadSummary[] {
  if (expanded || sessions.length <= 1) return sessions;
  const now = options.now ?? Date.now();
  const window = options.recentWindowMs ?? COLLAPSED_RECENT_WINDOW_MS;
  const limit = Math.max(1, options.limit ?? COLLAPSED_PREVIEW_LIMIT);
  const active: ThreadSummary[] = [];
  const recent: ThreadSummary[] = [];
  for (const thread of sessions) {
    if (isActiveThread(thread)) {
      active.push(thread);
      continue;
    }
    const fresh =
      Number.isFinite(thread.updatedAt) && now - thread.updatedAt <= window;
    if (fresh || options.isPinned?.(thread)) recent.push(thread);
  }
  if (!active.length && !recent.length) return sessions.slice(0, 1);
  const room = Math.max(0, limit - active.length);
  const keep = new Set([...active, ...recent.slice(0, room)]);
  // Filter instead of concatenating so the preview keeps the caller's order.
  return sessions.filter((thread) => keep.has(thread));
}

export function filterProjectGroups(
  groups: ProjectGroup[],
  query: string,
  options?: {
    providerName?: (providerId: string) => string;
    matchingThread?: (thread: ThreadSummary) => boolean;
  },
) {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups
    .map((group) => {
      const projectHit =
        group.name.toLowerCase().includes(needle) ||
        group.cwd.toLowerCase().includes(needle);
      const sessions = projectHit
        ? group.sessions
        : group.sessions.filter((thread) => {
            const provider = options?.providerName?.(thread.providerId) || "";
            const agent =
              thread.agentId === "claude"
                ? "Claude Code"
                : thread.agentId === "opencode"
                  ? "OpenCode"
                  : !thread.agentId || thread.agentId === "codex"
                    ? "Codex"
                    : thread.agentId;
            return (
              Boolean(options?.matchingThread?.(thread)) ||
              thread.name.toLowerCase().includes(needle) ||
              thread.preview.toLowerCase().includes(needle) ||
              thread.model.toLowerCase().includes(needle) ||
              thread.cwd.toLowerCase().includes(needle) ||
              provider.toLowerCase().includes(needle) ||
              agent.toLowerCase().includes(needle)
            );
          });
      return { ...group, sessions };
    })
    .filter(
      (group) =>
        group.sessions.length > 0 ||
        group.name.toLowerCase().includes(needle) ||
        group.cwd.toLowerCase().includes(needle),
    );
}

export function resolveNewThreadDefaults(input: {
  cwd?: string;
  project?: ProjectRecord | ProjectGroup;
  preferences?: DeckPreferences;
  providers: Provider[];
  runtimeWsl?: boolean;
}) {
  const online = input.providers.filter((provider) => provider.online);
  const defaults = input.project?.defaults;
  const prefs = input.preferences;
  const hasProjectApprovalDefaults = Boolean(
    defaults?.approvalPolicy || defaults?.approvalsReviewer,
  );
  const legacyWorkspaceNever = Boolean(
    defaults?.sandbox === "workspace-write" &&
    defaults.approvalPolicy === "never" &&
    !defaults.approvalsReviewer,
  );
  // online 是 Runtime 的瞬时状态，不是用户的供应商偏好。启动/重连时
  // 仍保留明确选择；项目供应商已删除或属于别的 Agent 时继续查全局默认。
  const preferredProvider =
    input.providers.find((provider) => provider.id === defaults?.providerId) ||
    input.providers.find((provider) => provider.id === prefs?.lastProviderId);
  const providerId =
    preferredProvider?.id ||
    online.find((provider) => provider.current)?.id ||
    online[0]?.id ||
    input.providers.find((provider) => provider.current)?.id ||
    input.providers[0]?.id || "";
  const provider = input.providers.find((item) => item.id === providerId);
  const cwd = input.cwd || input.project?.cwd || "";
  // "default" 是 Claude/OpenCode 的占位写法，串到 Codex 会被当成真实模型 id。
  // 这里提前过滤，留空=用供应商默认。
  const rawModel = defaults?.model || prefs?.lastModel || provider?.model || "";
  const model = rawModel.trim() === "default" ? "" : rawModel;
  return {
    providerId,
    cwd: input.runtimeWsl ? toWslCwd(cwd) : cwd,
    model,
    reasoningEffort:
      defaults?.reasoningEffort || prefs?.lastReasoningEffort || "",
    sandbox: defaults?.sandbox || prefs?.lastSandbox || "workspace-write",
    approvalPolicy: legacyWorkspaceNever
      ? "on-request"
      : hasProjectApprovalDefaults
        ? defaults?.approvalPolicy || "on-request"
        : prefs?.lastApprovalPolicy || "on-request",
    approvalsReviewer: legacyWorkspaceNever
      ? "auto_review"
      : hasProjectApprovalDefaults
        ? defaults?.approvalsReviewer || "user"
        : prefs?.lastApprovalsReviewer || "auto_review",
    permissionMode:
      defaults?.permissionMode || prefs?.lastPermissionMode || "default",
  };
}
