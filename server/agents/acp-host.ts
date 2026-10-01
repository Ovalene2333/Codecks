import type { AgentSettingsStore } from "../agent-settings.js";
import type { ThreadSummary } from "../types.js";
import type { AcpAgentSpec } from "./acp-adapter.js";
import type { AcpAgentEntry } from "./acp-agents.js";
import type { AgentRegistry, AgentRegistration } from "./registry.js";
import type { AgentAdapter, AgentId } from "./types.js";

export interface AcpSyncReport {
  added: AgentId[];
  removed: AgentId[];
  /** 描述符变了（命令/参数/环境等），已用新配置重建。 */
  replaced: AgentId[];
  /** 有会话在运行，没有 force 时保留旧配置、跳过移除/重建。 */
  skippedBusy: AgentId[];
}

export interface AcpHostDeps {
  registry: AgentRegistry;
  settings: Pick<AgentSettingsStore, "enabled">;
  load: () => Promise<AcpAgentEntry[]>;
  /** 造 adapter（不启动）。`carried` 是被替换的旧 adapter 的会话缓存。 */
  create: (spec: AcpAgentSpec, carried?: ThreadSummary[]) => AgentAdapter;
}

/**
 * 让 registry 里的 ACP adapter 跟 `acp-agents.json` 保持一致，不需要重启
 * Deck：新增的注册、删掉的注销、配置变了的用新配置重建（旧会话缓存带过去）。
 * 只做注册，不启动——启动/重启由 `registry.reloadAll()` 统一负责。
 */
export class AcpAgentHost {
  private known = new Map<AgentId, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private deps: AcpHostDeps) {}

  /** 首次调用注册全部；之后每次调用按配置文件当前内容增删改。 */
  sync(options: { force?: boolean } = {}): Promise<AcpSyncReport> {
    const run = this.queue
      .catch(() => undefined)
      .then(() => this.apply(options));
    this.queue = run;
    return run;
  }

  private registration(entry: AcpAgentEntry): AgentRegistration {
    return {
      enabled:
        this.deps.settings.enabled(entry.spec.id) ?? entry.defaultEnabled,
      defaultEnabled: entry.defaultEnabled,
      defaultNote: entry.defaultNote,
    };
  }

  private async apply(options: { force?: boolean }): Promise<AcpSyncReport> {
    const { registry } = this.deps;
    const entries = await this.deps.load();
    const wanted = new Map(entries.map((entry) => [entry.spec.id, entry]));
    const report: AcpSyncReport = {
      added: [],
      removed: [],
      replaced: [],
      skippedBusy: [],
    };
    const carried = new Map<AgentId, ThreadSummary[]>();

    for (const [id, printed] of [...this.known]) {
      const entry = wanted.get(id);
      if (entry && JSON.stringify(entry.spec) === printed) continue;
      const adapter = registry.get(id);
      if (adapter.busyThreads().length && !options.force) {
        report.skippedBusy.push(id);
        continue;
      }
      if (entry) {
        const snapshot = adapter.snapshot();
        carried.set(id, [
          ...snapshot.threads,
          ...(snapshot.archivedThreads || []),
        ]);
      }
      await registry.unregister(id);
      this.known.delete(id);
      (entry ? report.replaced : report.removed).push(id);
    }

    for (const entry of entries) {
      const id = entry.spec.id;
      if (this.known.has(id)) {
        // 描述符没变，但默认策略可能变了（例如刚装上 CLI）：只刷新状态。
        registry.configure(id, this.registration(entry));
        continue;
      }
      registry.register(
        this.deps.create(entry.spec, carried.get(id)),
        this.registration(entry),
      );
      this.known.set(id, JSON.stringify(entry.spec));
      if (!report.replaced.includes(id)) report.added.push(id);
    }
    return report;
  }
}
