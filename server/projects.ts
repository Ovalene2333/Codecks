import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ApprovalPolicy,
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

export class ProjectStore {
  private projects = new Map<string, ProjectRecord>();
  private prefs: DeckPreferences = emptyPrefs();
  private projectsFile: string;
  private prefsFile: string;

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

  async upsert(
    input: Partial<ProjectRecord> & { cwd?: string; key?: string },
  ): Promise<ProjectRecord> {
    const cwd = (input.cwd || input.key || "").trim();
    if (!cwd) throw new Error("需要工作目录");
    const key = normalizeProjectPath(input.key || cwd);
    const old = this.projects.get(key);
    const defaults = {
      ...old?.defaults,
      ...stripUndefined(input.defaults),
    };
    const record: ProjectRecord = {
      key,
      cwd: old?.cwd || cwd,
      name:
        input.name !== undefined ? input.name.trim() || undefined : old?.name,
      pinned: input.pinned ?? old?.pinned,
      hidden: input.hidden ?? old?.hidden,
      defaults: Object.keys(defaults).length ? defaults : undefined,
      updatedAt: Date.now(),
    };
    this.projects.set(key, record);
    await this.saveProjects();
    return record;
  }

  async remove(key: string) {
    this.projects.delete(normalizeProjectPath(key));
    await this.saveProjects();
  }

  async rememberCreate(input: {
    cwd: string;
    providerId?: string;
    model?: string;
    reasoningEffort?: string;
    sandbox?: SandboxMode;
    approvalPolicy?: ApprovalPolicy;
  }) {
    const key = normalizeProjectPath(input.cwd);
    const old = this.projects.get(key);
    const defaults: ProjectDefaults = { ...old?.defaults };
    if (!defaults.providerId && input.providerId)
      defaults.providerId = input.providerId;
    if (!defaults.model && input.model) defaults.model = input.model;
    if (!defaults.reasoningEffort && input.reasoningEffort)
      defaults.reasoningEffort = input.reasoningEffort;
    if (!defaults.sandbox && input.sandbox) defaults.sandbox = input.sandbox;
    if (!defaults.approvalPolicy && input.approvalPolicy)
      defaults.approvalPolicy = input.approvalPolicy;
    this.projects.set(key, {
      key,
      cwd: old?.cwd || input.cwd,
      name: old?.name,
      pinned: old?.pinned,
      hidden: old?.hidden,
      defaults: Object.keys(defaults).length ? defaults : undefined,
      updatedAt: Date.now(),
    });
    this.prefs = {
      ...this.prefs,
      lastProviderId: input.providerId || this.prefs.lastProviderId,
      lastModel: input.model || this.prefs.lastModel,
      lastReasoningEffort:
        input.reasoningEffort || this.prefs.lastReasoningEffort,
      lastSandbox: input.sandbox || this.prefs.lastSandbox,
      lastApprovalPolicy: input.approvalPolicy || this.prefs.lastApprovalPolicy,
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
    this.prefs = {
      ...this.prefs,
      ...stripUndefined(input),
      recentDirs: Array.isArray(input.recentDirs)
        ? input.recentDirs.slice(0, 20)
        : this.prefs.recentDirs,
    };
    await this.savePrefs();
    return this.prefs;
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
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}
