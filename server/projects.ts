import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ApprovalPolicy,
  ApprovalsReviewer,
  ConnectionOverlay,
  DeckPreferences,
  ProjectDefaults,
  ProjectRecord,
  SandboxMode,
} from "./types.js";

const emptyPrefs = (): DeckPreferences => ({ recentDirs: [] });

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
  if (doubled) return `/mnt/${doubled[1]}${doubled[2] ? `/${doubled[2]}` : ""}`;
  return value;
}

const CONNECTION_KEYS = [
  "requestMaxRetries",
  "streamMaxRetries",
  "streamIdleTimeoutMs",
] as const;

export function pickConnectionOverlay(
  source?: Partial<ConnectionOverlay> | null,
): ConnectionOverlay {
  const next: ConnectionOverlay = {};
  const requestMaxRetries = source?.requestMaxRetries;
  const streamMaxRetries = source?.streamMaxRetries;
  const streamIdleTimeoutMs = source?.streamIdleTimeoutMs;
  if (isRetryCount(requestMaxRetries))
    next.requestMaxRetries = requestMaxRetries;
  if (isRetryCount(streamMaxRetries)) next.streamMaxRetries = streamMaxRetries;
  if (isIdleTimeout(streamIdleTimeoutMs))
    next.streamIdleTimeoutMs = streamIdleTimeoutMs;
  return next;
}

export function hasConnectionOverlay(
  source?: Partial<ConnectionOverlay> | null,
) {
  return Object.keys(pickConnectionOverlay(source)).length > 0;
}

export function sameConnectionOverlay(
  left?: Partial<ConnectionOverlay> | null,
  right?: Partial<ConnectionOverlay> | null,
) {
  const a = pickConnectionOverlay(left);
  const b = pickConnectionOverlay(right);
  return (
    a.requestMaxRetries === b.requestMaxRetries &&
    a.streamMaxRetries === b.streamMaxRetries &&
    a.streamIdleTimeoutMs === b.streamIdleTimeoutMs
  );
}

export function resolveConnectionOverlay(
  providerId: string,
  records: ProjectRecord[],
  prefs?: DeckPreferences,
): ConnectionOverlay {
  const scoped = records
    .filter(
      (item) =>
        item.defaults?.providerId === providerId &&
        hasConnectionOverlay(item.defaults),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (scoped[0]) return pickConnectionOverlay(scoped[0].defaults);
  const unscoped = records
    .filter(
      (item) =>
        !item.defaults?.providerId && hasConnectionOverlay(item.defaults),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (unscoped[0]) return pickConnectionOverlay(unscoped[0].defaults);
  return pickConnectionOverlay(prefs);
}

function isRetryCount(value?: number | null): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 100
  );
}

function isIdleTimeout(value?: number | null): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1_000 &&
    value <= 3_600_000
  );
}

export class ProjectStore {
  private projects = new Map<string, ProjectRecord>();
  private prefs: DeckPreferences = emptyPrefs();
  private projectsFile: string;
  private prefsFile: string;
  private connectionRevisionValue = 0;

  constructor(private dataDir: string) {
    this.projectsFile = path.join(dataDir, "projects.json");
    this.prefsFile = path.join(dataDir, "preferences.json");
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    this.projects = new Map();
    try {
      const rows = JSON.parse(
        await readFile(this.projectsFile, "utf8"),
      ) as ProjectRecord[];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row?.key && !row?.cwd) continue;
        const key = normalizeProjectPath(row.key || row.cwd);
        const existing = this.projects.get(key);
        const defaults = { ...existing?.defaults, ...row.defaults };
        this.projects.set(key, {
          ...existing,
          ...row,
          key,
          cwd: existing?.cwd || row.cwd,
          name: row.name || existing?.name,
          pinned: row.pinned ?? existing?.pinned,
          hidden: row.hidden ?? existing?.hidden,
          defaults: Object.keys(defaults).length ? defaults : undefined,
          updatedAt: Math.max(existing?.updatedAt || 0, row.updatedAt || 0),
        });
      }
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      this.prefs = {
        ...emptyPrefs(),
        ...JSON.parse(await readFile(this.prefsFile, "utf8")),
      };
      this.prefs.recentDirs = Array.isArray(this.prefs.recentDirs)
        ? this.prefs.recentDirs
        : [];
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
      this.prefs = emptyPrefs();
    }
  }

  list(): ProjectRecord[] {
    return [...this.projects.values()].sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }

  get(key: string) {
    return this.projects.get(normalizeProjectPath(key));
  }

  getPreferences() {
    return this.prefs;
  }

  get connectionRevision() {
    return this.connectionRevisionValue;
  }

  private nextUpdatedAt() {
    let latest = 0;
    for (const project of this.projects.values()) {
      latest = Math.max(latest, project.updatedAt || 0);
    }
    return Math.max(Date.now(), latest + 1);
  }

  overlayForProvider(providerId: string) {
    return resolveConnectionOverlay(providerId, this.list(), this.prefs);
  }

  async rememberSeen(cwd: string, updatedAt?: number) {
    return this.rememberSeenMany([{ cwd, updatedAt }]);
  }

  async rememberSeenMany(
    items: { cwd?: string; updatedAt?: number }[],
  ): Promise<boolean> {
    let changed = false;
    for (const item of items) {
      const cwd = (item.cwd || "").trim();
      if (!cwd) continue;
      const key = normalizeProjectPath(cwd);
      if (key === "未指定路径") continue;
      if (this.projects.has(key)) continue;
      this.projects.set(key, {
        key,
        cwd,
        updatedAt: item.updatedAt || Date.now(),
      });
      changed = true;
    }
    if (changed) await this.saveProjects();
    return changed;
  }

  async setConnectionOverlay(overlay: ConnectionOverlay) {
    const next = pickConnectionOverlay(overlay);
    const prev = pickConnectionOverlay(this.prefs);
    this.prefs.requestMaxRetries = next.requestMaxRetries ?? undefined;
    this.prefs.streamMaxRetries = next.streamMaxRetries ?? undefined;
    this.prefs.streamIdleTimeoutMs = next.streamIdleTimeoutMs ?? undefined;
    if (next.requestMaxRetries == null) delete this.prefs.requestMaxRetries;
    if (next.streamMaxRetries == null) delete this.prefs.streamMaxRetries;
    if (next.streamIdleTimeoutMs == null) delete this.prefs.streamIdleTimeoutMs;
    this.touchConnection(prev, next);
    await this.savePrefs();
    return this.prefs;
  }

  async upsert(
    input: Partial<ProjectRecord> & {
      cwd?: string;
      key?: string;
      defaults?: ProjectDefaults &
        Partial<Record<keyof ConnectionOverlay, number | null>>;
    },
  ): Promise<ProjectRecord> {
    const cwd = (input.cwd || input.key || "").trim();
    if (!cwd) throw new Error("需要工作目录");
    const key = normalizeProjectPath(input.key || cwd);
    const old = this.projects.get(key);
    const defaults = mergeDefaults(old?.defaults, input.defaults);
    const record: ProjectRecord = {
      key,
      cwd: old?.cwd || cwd,
      name:
        input.name !== undefined ? input.name.trim() || undefined : old?.name,
      pinned: input.pinned ?? old?.pinned,
      hidden: input.hidden ?? old?.hidden,
      defaults: defaults && Object.keys(defaults).length ? defaults : undefined,
      updatedAt: this.nextUpdatedAt(),
    };
    if (input.defaults) this.touchConnection(old?.defaults, record.defaults);
    this.projects.set(key, record);
    await this.saveProjects();
    return record;
  }

  async remove(key: string) {
    this.projects.delete(normalizeProjectPath(key));
    await this.saveProjects();
  }

  async rememberCreate(input: {
    agentId?: "codex" | "claude";
    cwd: string;
    providerId?: string;
    model?: string;
    reasoningEffort?: string;
    sandbox?: SandboxMode;
    approvalPolicy?: ApprovalPolicy;
    approvalsReviewer?: ApprovalsReviewer;
  }) {
    const key = normalizeProjectPath(input.cwd);
    const old = this.projects.get(key);
    const defaults: ProjectDefaults = { ...old?.defaults };
    if (input.agentId) defaults.agentId = input.agentId;
    if (!defaults.providerId && input.providerId)
      defaults.providerId = input.providerId;
    if (!defaults.model && input.model) defaults.model = input.model;
    if (!defaults.reasoningEffort && input.reasoningEffort)
      defaults.reasoningEffort = input.reasoningEffort;
    if (!defaults.sandbox && input.sandbox) defaults.sandbox = input.sandbox;
    if (!defaults.approvalPolicy && !defaults.approvalsReviewer) {
      if (input.approvalPolicy) defaults.approvalPolicy = input.approvalPolicy;
      if (input.approvalsReviewer)
        defaults.approvalsReviewer = input.approvalsReviewer;
    }
    this.projects.set(key, {
      key,
      cwd: old?.cwd || input.cwd,
      name: old?.name,
      pinned: old?.pinned,
      hidden: old?.hidden,
      defaults: Object.keys(defaults).length ? defaults : undefined,
      updatedAt: this.nextUpdatedAt(),
    });
    this.prefs = {
      ...this.prefs,
      lastAgentId: input.agentId || this.prefs.lastAgentId,
      lastProviderId: input.providerId || this.prefs.lastProviderId,
      lastModel: input.model || this.prefs.lastModel,
      lastReasoningEffort:
        input.reasoningEffort || this.prefs.lastReasoningEffort,
      lastSandbox: input.sandbox || this.prefs.lastSandbox,
      lastApprovalPolicy: input.approvalPolicy || this.prefs.lastApprovalPolicy,
      lastApprovalsReviewer:
        input.approvalsReviewer || this.prefs.lastApprovalsReviewer,
      recentDirs: [
        input.cwd,
        ...this.prefs.recentDirs.filter(
          (dir) => normalizeProjectPath(dir) !== key,
        ),
      ].slice(0, 20),
    };
    await this.saveProjects();
    await this.savePrefs();
  }

  async updatePreferences(input: Partial<DeckPreferences>) {
    const oldPrefs = this.prefs;
    this.prefs = {
      ...this.prefs,
      ...stripUndefined(input),
      recentDirs: Array.isArray(input.recentDirs)
        ? input.recentDirs.slice(0, 20)
        : this.prefs.recentDirs,
    };
    if (
      CONNECTION_KEYS.some((key) =>
        Object.prototype.hasOwnProperty.call(input, key),
      )
    )
      this.touchConnection(oldPrefs, this.prefs);
    await this.savePrefs();
    return this.prefs;
  }

  private touchConnection(
    prev?: Partial<ConnectionOverlay> | null,
    next?: Partial<ConnectionOverlay> | null,
  ) {
    if (!sameConnectionOverlay(prev, next)) this.connectionRevisionValue += 1;
  }

  private async saveProjects() {
    await writeFile(this.projectsFile, JSON.stringify(this.list(), null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  private async savePrefs() {
    await writeFile(this.prefsFile, JSON.stringify(this.prefs, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

function stripUndefined<T extends object>(value?: T): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== undefined && item !== null,
    ),
  ) as Partial<T>;
}

function mergeDefaults(
  old?: ProjectDefaults,
  input?:
    | (ProjectDefaults &
        Partial<Record<keyof ConnectionOverlay, number | null>>)
    | undefined,
): ProjectDefaults | undefined {
  if (!input) return old;
  const defaults: ProjectDefaults = {
    ...old,
    ...stripUndefined(input),
  };
  for (const [key, value] of Object.entries(input)) {
    if (value === null) delete defaults[key as keyof ProjectDefaults];
  }
  return Object.keys(defaults).length ? defaults : undefined;
}
