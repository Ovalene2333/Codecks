import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentId } from "./types.js";

export interface ModelAffinityParams {
  providerId?: string;
  directory?: string;
}

export interface ModelAffinity {
  /** 收藏的模型 id（model 字段），跨项目/供应商共享，保持用户收藏顺序。 */
  starred: string[];
  /** 每个模型的累计选中次数。 */
  counts: Record<string, number>;
  /** 最近一次选中的模型 id。 */
  last: string | null;
  updatedAt: number;
}

interface ModelAffinityScope {
  counts: Record<string, number>;
  last: string | null;
  updatedAt: number;
}

interface StoredModelAffinity {
  version: 2;
  /** agent 级收藏：同一 agent 的所有项目/供应商共享。 */
  starred: Record<string, string[]>;
  scopes: Partial<Record<string, ModelAffinityScope>>;
}

/** 单作用域保留的选择记录上限，超出按次数从低往高裁。 */
const MAX_COUNTS_PER_SCOPE = 200;
/** 单 agent 收藏上限。 */
const MAX_STARRED_PER_AGENT = 100;

const empty = (): StoredModelAffinity => ({
  version: 2,
  starred: Object.create(null) as Record<string, string[]>,
  scopes: {},
});

function cleanModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1024) return undefined;
  return trimmed;
}

/** agent + 供应商/目录 → 作用域键：和模型目录请求键保持同一粒度。 */
export function modelAffinityScope(
  agentId: AgentId,
  params: ModelAffinityParams,
): string {
  const qualifier =
    cleanModelId(params.providerId) ||
    cleanModelId(params.directory) ||
    "default";
  return `${agentId}:${qualifier}`;
}

/**
 * 模型的「上次选择 / 常用 / 收藏」。多端入口（手机、桌面）共享同一个
 * agent + 供应商/目录作用域，所以必须落服务端，不能放浏览器本地存储。
 */
export class ModelAffinityStore {
  private data: StoredModelAffinity = empty();
  private file: string;
  private writes = Promise.resolve();

  constructor(private dataDir: string) {
    this.file = path.join(dataDir, "model-affinity.json");
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      const version = parsed?.version;
      if ((version !== 1 && version !== 2) || !parsed?.scopes) return;
      const starred: Record<string, string[]> = Object.create(null);
      const rememberStar = (agent: string, id: string) => {
        const list = (starred[agent] ||= []);
        if (!list.includes(id)) list.push(id);
      };
      if (version === 2 && parsed.starred && typeof parsed.starred === "object") {
        for (const [agent, list] of Object.entries(parsed.starred)) {
          if (!Array.isArray(list)) continue;
          for (const item of list) {
            const id = cleanModelId(item);
            if (id) rememberStar(agent, id);
          }
        }
      }
      const scopes: Partial<Record<string, ModelAffinityScope>> = {};
      for (const [key, entry] of Object.entries(parsed.scopes)) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          continue;
        const scope: ModelAffinityScope = {
          counts: {},
          last: null,
          updatedAt: 0,
        };
        const record = entry as Record<string, unknown>;
        // v1 的收藏按作用域存；升级时并入 agent 级收藏，之后不再分项目。
        if (version === 1 && Array.isArray(record.starred)) {
          const separator = key.indexOf(":");
          const agent = separator < 0 ? key : key.slice(0, separator);
          for (const item of record.starred) {
            const id = cleanModelId(item);
            if (id) rememberStar(agent, id);
          }
        }
        if (record.counts && typeof record.counts === "object") {
          for (const [model, count] of Object.entries(
            record.counts as Record<string, unknown>,
          )) {
            const id = cleanModelId(model);
            const value = Number(count);
            if (id && Number.isFinite(value) && value > 0)
              scope.counts[id] = Math.floor(value);
          }
        }
        const last = cleanModelId(record.last);
        if (last) scope.last = last;
        const updatedAt = Number(record.updatedAt);
        if (Number.isFinite(updatedAt) && updatedAt > 0)
          scope.updatedAt = updatedAt;
        scopes[key] = scope;
      }
      for (const [agent, list] of Object.entries(starred))
        starred[agent] = list.slice(0, MAX_STARRED_PER_AGENT);
      this.data = { version: 2, starred, scopes };
    } catch (error: any) {
      // 脏 JSON / 首次运行都回退为空，绝不能拖垮启动。
      if (error?.code !== "ENOENT")
        console.error(
          "模型偏好文件损坏，已回退为空（原文件保留）:",
          error?.message || error,
        );
    }
  }

  get(agentId: AgentId, params: ModelAffinityParams): ModelAffinity {
    const scope = this.data.scopes[modelAffinityScope(agentId, params)];
    return {
      starred: [...(this.data.starred[agentId] || [])],
      counts: scope ? { ...scope.counts } : {},
      last: scope?.last ?? null,
      updatedAt: scope?.updatedAt ?? 0,
    };
  }

  /** 记录一次选中：次数 +1 并记为上次选择。 */
  async recordUse(agentId: AgentId, params: ModelAffinityParams, model: string) {
    const id = cleanModelId(model);
    if (!id) return this.get(agentId, params);
    const key = modelAffinityScope(agentId, params);
    const scope = (this.data.scopes[key] ||= {
      counts: {},
      last: null,
      updatedAt: 0,
    });
    scope.counts[id] = (scope.counts[id] || 0) + 1;
    scope.last = id;
    scope.updatedAt = Date.now();
    this.prune(scope);
    await this.save();
    return this.get(agentId, params);
  }

  /** 收藏 / 取消收藏：写入 agent 级收藏，所有项目/供应商共享。 */
  async setStarred(
    agentId: AgentId,
    params: ModelAffinityParams,
    model: string,
    on: boolean,
  ) {
    const id = cleanModelId(model);
    if (!id) return this.get(agentId, params);
    const starred = (this.data.starred[agentId] || []).filter(
      (item) => item !== id,
    );
    if (on) starred.unshift(id);
    this.data.starred[agentId] = starred.slice(0, MAX_STARRED_PER_AGENT);
    await this.save();
    return this.get(agentId, params);
  }

  private prune(scope: ModelAffinityScope) {
    const models = Object.keys(scope.counts);
    if (models.length <= MAX_COUNTS_PER_SCOPE) return;
    // 留次数最高的；并列时后选中的优先（last 排最前）。
    models.sort((a, b) => {
      const delta = (scope.counts[b] || 0) - (scope.counts[a] || 0);
      if (delta !== 0) return delta;
      if (a === scope.last) return -1;
      if (b === scope.last) return 1;
      return 0;
    });
    const keep = new Set(models.slice(0, MAX_COUNTS_PER_SCOPE));
    for (const model of models) {
      if (!keep.has(model)) delete scope.counts[model];
    }
  }

  private save() {
    const snapshot = JSON.stringify(this.data);
    // 与 ThreadSettingsStore 一致的写链自愈：瞬时 IO 错误不毒化后续写入。
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
