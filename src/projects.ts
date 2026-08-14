import type {
  DeckPreferences,
  ProjectRecord,
  Provider,
  ThreadSummary,
} from "./types";

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
  if (doubled)
    return `/mnt/${doubled[1]}${doubled[2] ? `/${doubled[2]}` : ""}`;
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

export function previewSessions<T>(sessions: T[], expanded: boolean) {
  if (expanded || sessions.length <= 1) return sessions;
  return sessions.slice(0, 1);
}

export function filterProjectGroups(
  groups: ProjectGroup[],
  query: string,
  options?: { providerName?: (providerId: string) => string },
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
            return (
              thread.name.toLowerCase().includes(needle) ||
              thread.preview.toLowerCase().includes(needle) ||
              thread.model.toLowerCase().includes(needle) ||
              thread.cwd.toLowerCase().includes(needle) ||
              provider.toLowerCase().includes(needle)
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
}) {
  const online = input.providers.filter((provider) => provider.online);
  const defaults = input.project?.defaults;
  const prefs = input.preferences;
  const preferredProviderId = defaults?.providerId || prefs?.lastProviderId;
  const preferredProvider = online.find(
    (provider) => provider.id === preferredProviderId,
  );
  const providerId =
    preferredProvider?.id || online[0]?.id || input.providers[0]?.id || "";
  const provider = input.providers.find((item) => item.id === providerId);
  return {
    providerId,
    cwd: input.cwd || input.project?.cwd || "",
    model: defaults?.model || prefs?.lastModel || provider?.model || "",
    reasoningEffort:
      defaults?.reasoningEffort || prefs?.lastReasoningEffort || "",
    sandbox: defaults?.sandbox || prefs?.lastSandbox || "workspace-write",
    approvalPolicy:
      defaults?.approvalPolicy || prefs?.lastApprovalPolicy || "on-request",
  };
}
