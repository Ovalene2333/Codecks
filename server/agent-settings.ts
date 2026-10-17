import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentId } from "./types.js";

interface StoredAgentSettings {
  version: 1;
  agents: Record<AgentId, { enabled: boolean }>;
}

/**
 * Deck 级的 Agent 启用开关。只记录用户在设置里的显式选择；没有记录的
 * agent 由默认策略决定（内置 ACP agent 装了才加载，见 acp-agents.ts）。
 * 这样 CLI 事后安装/卸载时，默认值能自己跟着变，不会被旧选择钉死。
 */
export class AgentSettingsStore {
  private data: StoredAgentSettings = { version: 1, agents: {} };
  private file: string;
  private writes = Promise.resolve();

  constructor(private dataDir: string) {
    this.file = path.join(dataDir, "agent-settings.json");
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      const agents: StoredAgentSettings["agents"] = {};
      if (
        parsed?.version === 1 &&
        parsed.agents &&
        typeof parsed.agents === "object" &&
        !Array.isArray(parsed.agents)
      ) {
        for (const [id, entry] of Object.entries(parsed.agents)) {
          const enabled = (entry as { enabled?: unknown } | null)?.enabled;
          if (typeof enabled === "boolean") agents[id] = { enabled };
        }
      }
      this.data = { version: 1, agents };
    } catch (error: any) {
      // 与 ThreadSettingsStore 一致：坏文件/首次运行都回退为空，不能拖垮启动。
      if (error?.code !== "ENOENT")
        console.error(
          "Agent 设置文件损坏，已回退为空（原文件保留）:",
          error?.message || error,
        );
    }
  }

  /** 用户的显式选择；没有选择过返回 undefined。 */
  enabled(id: AgentId): boolean | undefined {
    return this.data.agents[id]?.enabled;
  }

  /** `null` 清除显式选择，回到默认策略。 */
  async setEnabled(id: AgentId, enabled: boolean | null) {
    if (enabled === null) {
      if (!(id in this.data.agents)) return;
      delete this.data.agents[id];
    } else {
      if (this.data.agents[id]?.enabled === enabled) return;
      this.data.agents[id] = { enabled };
    }
    await this.save();
  }

  private save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    // 写链自愈：一次瞬时 IO 错误不能让后续所有 save 永久失败。
    const attempt = this.writes
      .catch(() => undefined)
      .then(async () => {
        await mkdir(this.dataDir, { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        await writeFile(temporary, `${snapshot}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, this.file);
      });
    this.writes = attempt.catch(() => undefined);
    return attempt;
  }
}
