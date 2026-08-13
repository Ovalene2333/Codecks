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
  const driveOnly = value.match(/^([a-zA-Z]):$/);
  if (driveOnly) return `/mnt/${driveOnly[1].toLowerCase()}`;
  const windows = value.match(/^([a-zA-Z]):\/(.*)$/);
  if (windows)
    return `/mnt/${windows[1].toLowerCase()}/${windows[2]}`.toLowerCase();
  return value.toLowerCase() || "未指定路径";
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
    groups.set(record.key, {
      key: record.key,
      cwd: record.cwd,
      name: record.name || projectBasename(record.cwd),
      pinned: record.pinned,
      hidden: record.hidden,
      defaults: record.defaults,
      sessions: [],
      updatedAt: record.updatedAt,
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

export function filterProjectGroups(groups: ProjectGroup[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  return groups
    .map((group) => {
      const projectHit =
        group.name.toLowerCase().includes(needle) ||
        group.cwd.toLowerCase().includes(needle);
      const sessions = projectHit
        ? group.sessions
        : group.sessions.filter(
            (thread) =>
              thread.name.toLowerCase().includes(needle) ||
              thread.preview.toLowerCase().includes(needle) ||
              thread.model.toLowerCase().includes(needle),
          );
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
