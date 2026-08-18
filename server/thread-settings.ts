import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ApprovalPolicy,
  ApprovalsReviewer,
  ClaudePermissionMode,
  Personality,
  SandboxMode,
  ThreadSummary,
} from "./types.js";
import type { AgentId } from "./agents/types.js";

export interface ThreadSettings {
  providerId?: string;
  model?: string;
  reasoningEffort?: string;
  personality?: Personality;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  approvalsReviewer?: ApprovalsReviewer;
  permissionMode?: ClaudePermissionMode;
  serviceTier?: string;
}

type ThreadSettingsInput = Omit<ThreadSettings, "serviceTier"> & {
  serviceTier?: string | null;
};

interface StoredThreadSettings {
  version: 1;
  settings: Partial<Record<AgentId, Record<string, ThreadSettings>>>;
}

const empty = (): StoredThreadSettings => ({ version: 1, settings: {} });

function clean(settings: ThreadSettingsInput) {
  return Object.fromEntries(
    Object.entries(settings).filter(([, value]) => value !== undefined),
  ) as ThreadSettings;
}

/**
 * The Codex and Claude history indexes do not reliably retain mutable session
 * settings. Keep the explicit choices made in Deck separate from those
 * indexes, so a runtime restart cannot replace them with provider defaults.
 */
export class ThreadSettingsStore {
  private data: StoredThreadSettings = empty();
  private file: string;
  private writes = Promise.resolve();

  constructor(private dataDir: string) {
    this.file = path.join(dataDir, "thread-settings.json");
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (parsed?.version !== 1 || !parsed?.settings) return;
      this.data = {
        version: 1,
        settings: {
          codex:
            parsed.settings.codex && typeof parsed.settings.codex === "object"
              ? parsed.settings.codex
              : {},
          claude:
            parsed.settings.claude && typeof parsed.settings.claude === "object"
              ? parsed.settings.claude
              : {},
        },
      };
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  get(agentId: AgentId, threadId: string): ThreadSettings | undefined {
    const settings = this.data.settings[agentId]?.[threadId];
    return settings ? { ...settings } : undefined;
  }

  async update(
    agentId: AgentId,
    threadId: string,
    settings: ThreadSettingsInput,
  ) {
    const next = clean(settings);
    const group = (this.data.settings[agentId] ||= {});
    const merged = { ...group[threadId], ...next };
    if (settings.serviceTier === null) delete merged.serviceTier;
    if (!Object.keys(merged).length) delete group[threadId];
    else group[threadId] = merged;
    await this.save();
    return this.get(agentId, threadId);
  }

  /** Migrate the last in-memory summary once, without replacing saved choices. */
  async seedFromThreads(threads: ThreadSummary[]) {
    let changed = false;
    for (const thread of threads) {
      const agentId = thread.agentId || "codex";
      if (this.data.settings[agentId]?.[thread.id]) continue;
      const settings = clean({
        ...(agentId === "claude" ? { providerId: thread.providerId } : {}),
        model: thread.model,
        reasoningEffort: thread.reasoningEffort,
        personality: thread.personality,
        sandbox: thread.sandbox,
        approvalPolicy: thread.approvalPolicy,
        approvalsReviewer: thread.approvalsReviewer,
        permissionMode: thread.permissionMode,
        serviceTier: thread.serviceTier,
      });
      if (!Object.keys(settings).length) continue;
      (this.data.settings[agentId] ||= {})[thread.id] = settings;
      changed = true;
    }
    if (changed) await this.save();
  }

  async remove(agentId: AgentId, threadId: string) {
    const group = this.data.settings[agentId];
    if (!group?.[threadId]) return;
    delete group[threadId];
    if (!Object.keys(group).length) delete this.data.settings[agentId];
    await this.save();
  }

  private save() {
    const snapshot = JSON.stringify(this.data);
    this.writes = this.writes.then(async () => {
      await mkdir(this.dataDir, { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
    });
    return this.writes;
  }
}
