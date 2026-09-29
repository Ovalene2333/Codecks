import { randomBytes } from "node:crypto";
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
import type { AgentId } from "./types.js";

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
  /** ACP `session/set_mode` 的 modeId（如 devin 的 normal/plan/bypass）。 */
  sessionMode?: string;
  /** Deck 侧重命名（ACP 会话没有原生 rename 接口）。 */
  name?: string;
  /**
   * Deck 侧软归档标记（OpenCode serve 没有原生归档接口）。
   * 只存 `true`；恢复时用 `null` 清除。
   */
  archived?: boolean;
  /**
   * 唤醒代号：`POST /api/wake/:code` 命中后向该会话注入一条 prompt。
   * 由 ensureWakeCode 生成或认领，随会话删除（remove）一并清除。
   */
  wakeCode?: string;
}

type ThreadSettingsInput = Omit<ThreadSettings, "serviceTier" | "archived"> & {
  serviceTier?: string | null;
  archived?: boolean | null;
};

/**
 * 单个 turn 实际运行时使用的模型快照。Claude JSONL / OpenCode message info
 * 自带逐回合模型；Codex rollout 和 ACP 回放没有这一字段，由 adapter 在
 * turn 开始时记录，readThread 回填到 turn.model / turn.reasoningEffort，
 * 避免会话中途切换模型后，旧回合的时间线也被标成新模型。
 */
export interface TurnModelStamp {
  turnId: string;
  model?: string;
  reasoningEffort?: string;
}

/** 单会话保留的快照上限，超出按时间顺序丢最旧的。 */
const MAX_TURN_MODELS = 1_000;

interface StoredThreadSettings {
  version: 1;
  settings: Partial<Record<AgentId, Record<string, ThreadSettings>>>;
  turnModels?: Partial<Record<AgentId, Record<string, TurnModelStamp[]>>>;
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
      // agentId 是开放集合（ACP adapter 动态注册），按文件里的原样保留所有分组。
      const settings: Partial<Record<AgentId, Record<string, ThreadSettings>>> =
        {};
      for (const [agentId, group] of Object.entries(parsed.settings)) {
        if (group && typeof group === "object" && !Array.isArray(group))
          settings[agentId] = group as Record<string, ThreadSettings>;
      }
      const turnModels: StoredThreadSettings["turnModels"] = {};
      const rawTurnModels = parsed.turnModels;
      if (rawTurnModels && typeof rawTurnModels === "object") {
        for (const [agentId, group] of Object.entries(rawTurnModels)) {
          if (!group || typeof group !== "object" || Array.isArray(group))
            continue;
          for (const [threadId, list] of Object.entries(group)) {
            if (!Array.isArray(list)) continue;
            const cleaned = list.flatMap((entry) => {
              if (
                !entry ||
                typeof entry !== "object" ||
                typeof entry.turnId !== "string" ||
                !entry.turnId
              )
                return [];
              const stamp: TurnModelStamp = { turnId: entry.turnId };
              if (typeof entry.model === "string" && entry.model)
                stamp.model = entry.model;
              if (
                typeof entry.reasoningEffort === "string" &&
                entry.reasoningEffort
              )
                stamp.reasoningEffort = entry.reasoningEffort;
              return [stamp];
            });
            if (cleaned.length)
              (turnModels[agentId as AgentId] ||= {})[threadId] = cleaned;
          }
        }
      }
      this.data = { version: 1, settings, turnModels };
    } catch (error: any) {
      // 脏 JSON（崩溃写一半、手工改坏）视为可恢复：回退空设置并保留现场文件，
      // 绝不能因此杀死整机启动。ENOENT（首次运行）同样走这里。
      if (error?.code !== "ENOENT")
        console.error(
          "线程设置文件损坏，已回退为空（原文件保留）:",
          error?.message || error,
        );
    }
  }

  get(agentId: AgentId, threadId: string): ThreadSettings | undefined {
    const settings = this.data.settings[agentId]?.[threadId];
    if (!settings) return undefined;
    const next = { ...settings };
    // 历史脏数据：Codex 没有字面量 "default" 模型，读出时直接丢掉，
    // 避免覆盖 thread/list 回填的真实模型。
    if (agentId === "codex" && next.model?.trim() === "default")
      delete next.model;
    return next;
  }

  async update(
    agentId: AgentId,
    threadId: string,
    settings: ThreadSettingsInput,
  ) {
    const next = clean(settings);
    const group = (this.data.settings[agentId] ||= {});
    const merged = { ...group[threadId], ...next };
    if (agentId === "codex" && merged.model?.trim() === "default")
      delete merged.model;
    if (settings.serviceTier === null) delete merged.serviceTier;
    if (settings.archived === null || settings.archived === false)
      delete merged.archived;
    // 空串 effort 表示「回默认」：键本身要删掉，否则下次 get 还原出
    // 无效值。没传 effort 的更新不受影响（clean 已去掉 undefined）。
    if (settings.reasoningEffort === "") delete merged.reasoningEffort;
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
        sessionMode: thread.sessionMode,
        serviceTier: thread.serviceTier,
      });
      if (!Object.keys(settings).length) continue;
      (this.data.settings[agentId] ||= {})[thread.id] = settings;
      changed = true;
    }
    if (changed) await this.save();
  }

  /** 记录某回合启动时的模型快照；同 turnId 重复记录时原位覆盖。 */
  async recordTurnModel(
    agentId: AgentId,
    threadId: string,
    turnId: string,
    stamp: { model?: string; reasoningEffort?: string },
  ) {
    if (!turnId) return;
    const perAgent = ((this.data.turnModels ||= {})[agentId] ||= {});
    const list = (perAgent[threadId] ||= []);
    const entry: TurnModelStamp = {
      turnId,
      ...(stamp.model ? { model: stamp.model } : {}),
      ...(stamp.reasoningEffort
        ? { reasoningEffort: stamp.reasoningEffort }
        : {}),
    };
    const index = list.findIndex((item) => item.turnId === turnId);
    if (index >= 0) list[index] = entry;
    else list.push(entry);
    if (list.length > MAX_TURN_MODELS)
      list.splice(0, list.length - MAX_TURN_MODELS);
    await this.save();
  }

  turnModel(agentId: AgentId, threadId: string, turnId: string) {
    return this.data.turnModels?.[agentId]?.[threadId]?.find(
      (entry) => entry.turnId === turnId,
    );
  }

  /** 按发送顺序的全部快照；回放生成合成 turnId 的 agent 可按位置回填。 */
  turnModelList(agentId: AgentId, threadId: string): TurnModelStamp[] {
    const list = this.data.turnModels?.[agentId]?.[threadId];
    return Array.isArray(list) ? list : [];
  }

  async remove(agentId: AgentId, threadId: string) {
    const group = this.data.settings[agentId];
    const models = this.data.turnModels?.[agentId];
    if (!group?.[threadId] && !models?.[threadId]) return;
    if (group?.[threadId]) {
      delete group[threadId];
      if (!Object.keys(group).length) delete this.data.settings[agentId];
    }
    if (models?.[threadId]) {
      delete models[threadId];
      if (!Object.keys(models).length)
        delete (this.data.turnModels || {})[agentId];
    }
    await this.save();
  }

  /** 自定义代号限定小写字母/数字/连字符，保证可以直接拼进 URL 路径。 */
  static readonly WAKE_CODE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

  findByWakeCode(
    code: string,
  ): { agentId: AgentId; threadId: string } | undefined {
    for (const [agentId, group] of Object.entries(this.data.settings)) {
      for (const [threadId, settings] of Object.entries(group ?? {})) {
        if (settings.wakeCode === code)
          return { agentId: agentId as AgentId, threadId };
      }
    }
    return undefined;
  }

  listWakeCodes(): { code: string; agentId: AgentId; threadId: string }[] {
    const items: { code: string; agentId: AgentId; threadId: string }[] = [];
    for (const [agentId, group] of Object.entries(this.data.settings)) {
      for (const [threadId, settings] of Object.entries(group ?? {})) {
        if (settings.wakeCode)
          items.push({
            code: settings.wakeCode,
            agentId: agentId as AgentId,
            threadId,
          });
      }
    }
    return items;
  }

  /**
   * 取回已有代号，没有则生成（或认领 preferred）。preferred 与已有代号
   * 不同时直接忽略——改代号应先 clearWakeCode 再重新认领，避免误改。
   */
  async ensureWakeCode(agentId: AgentId, threadId: string, preferred?: string) {
    const existing = this.data.settings[agentId]?.[threadId]?.wakeCode;
    if (existing) return existing;
    let code: string;
    if (preferred) {
      if (!ThreadSettingsStore.WAKE_CODE_RE.test(preferred))
        throw new Error("wake code 需为 2-31 位小写字母、数字或连字符");
      if (this.findByWakeCode(preferred))
        throw new Error(`wake code ${preferred} 已被占用`);
      code = preferred;
    } else {
      code = this.generateWakeCode();
    }
    await this.update(agentId, threadId, { wakeCode: code });
    return code;
  }

  async clearWakeCode(agentId: AgentId, threadId: string) {
    const group = this.data.settings[agentId];
    const settings = group?.[threadId];
    if (!settings?.wakeCode) return;
    delete settings.wakeCode;
    if (!Object.keys(settings).length) delete group![threadId];
    await this.save();
  }

  private generateWakeCode() {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const code = randomBytes(4).toString("hex");
      if (!this.findByWakeCode(code)) return code;
    }
    throw new Error("wake code 分配失败");
  }

  private save() {
    const snapshot = JSON.stringify(this.data);
    // 写链自愈：一次瞬时 IO 错误后重置链，避免后续所有 save 带着旧错误永久失败。
    const attempt = this.writes.catch(() => undefined).then(async () => {
      await mkdir(this.dataDir, { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.writes = attempt.catch(() => undefined);
    return attempt;
  }
}
