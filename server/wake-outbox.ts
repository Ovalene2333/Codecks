import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentId, DeckDeliveryMode, WakeDelivery } from "./types.js";

/**
 * 唤醒投递发件箱：`POST /api/wake/:code` 先落盘再应答，之后由这里负责把
 * prompt 送进会话。agent 闪断、会话忙、Deck 重启都只是继续重试的理由，
 * 不再把「送达」的责任推回给 watcher 脚本的有限重试窗口。
 *
 * 持久态只有 pending / delivered / dead 三种；「投递中」只存在于内存
 * （inflight），崩溃重启后自然落回 pending，不需要 crash recovery 状态。
 */

/** 携带 dedupeKey 的条目（ask 回传重试）：同 key 已投递未过窗口视为同一条。 */
const DEDUPE_TTL_MS = 5 * 60_000;
/** 暂态错误的最长重试期，超过即判 dead 交给人处理。 */
const MAX_AGE_MS = 24 * 3_600_000;
/** dead 条目的保留上限（它们是「需要处理」列表，不该无声消失，但也不能无限涨）。 */
const DEAD_KEEP = 100;
const PREVIEW_LIMIT = 300;
const RETRY_BASE_MS = 15_000;
const RETRY_CAP_MS = 30 * 60_000;

/** 第 attempts 次失败后的等待时长：15s、30s、1m… 封顶 30m。 */
export function retryDelayMs(attempts: number) {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_CAP_MS);
}

/**
 * 重试也救不活的错误：会话没了、归档了、adapter 不支持发送。
 * 其余一律按暂态处理——包括「Agent 不存在/未启用」（重新启用即自愈）
 * 和「会话正在运行」（回合结束就能送达）。
 */
const PERMANENT_RE = /会话不存在|已归档|不支持此操作/;

export interface WakeTarget {
  agentId: AgentId;
  threadId: string;
}

interface StoredDelivery extends WakeDelivery {
  /** 投递给会话的完整 prompt；Snapshot 只下发 preview。 */
  prompt: string;
  /** 幂等键（如 ask 消息 id）：同 key 的重复入队视为同一条投递。 */
  dedupeKey?: string;
}

interface Options {
  file: string;
  /** 每次尝试时按代号重新解析目标：代号被解绑即视为取消投递。 */
  resolve: (code: string) => WakeTarget | undefined;
  send: (agentId: AgentId, threadId: string, prompt: string, delivery: WakeDelivery) => Promise<unknown>;
  /** 队列有任何变化时调用（接 snapshot 广播）。 */
  onChanged?: () => void;
  now?: () => number;
  /** false 时不挂内部定时器，由调用方手动 tick（测试用）。 */
  timer?: boolean;
}

const previewOf = (prompt: string) =>
  prompt
    .replace(/^\[wake:[^\]]+\]\s*/, "")
    .trim()
    .slice(0, PREVIEW_LIMIT);

export class WakeOutbox {
  private items: StoredDelivery[] = [];
  private inflight = new Set<string>();
  private timerHandle: NodeJS.Timeout | undefined;
  private closed = false;
  private writes = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.options.file, "utf8"));
      if (parsed?.version === 1 && Array.isArray(parsed.items))
        this.items = parsed.items.flatMap((item: any) => {
          if (
            !item ||
            typeof item.id !== "string" ||
            typeof item.code !== "string" ||
            typeof item.prompt !== "string" ||
            typeof item.agentId !== "string" ||
            typeof item.threadId !== "string" ||
            typeof item.createdAt !== "number" ||
            !["pending", "delivered", "dead"].includes(item.status)
          )
            return [];
          return [
            {
              ...item,
              preview:
                typeof item.preview === "string"
                  ? item.preview
                  : previewOf(item.prompt),
              attempts: Number(item.attempts) || 0,
              updatedAt: Number(item.updatedAt) || item.createdAt,
            } as StoredDelivery,
          ];
        });
    } catch (error: any) {
      // 脏 JSON 同其它 store：回退空队列并保留现场，不能杀死启动。
      if (error?.code !== "ENOENT")
        console.error(
          "唤醒队列文件损坏，已回退为空（原文件保留）:",
          error?.message || error,
        );
    }
    this.prune();
    this.schedule();
  }

  list(): WakeDelivery[] {
    return [...this.items]
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map((item) => this.view(item));
  }

  /**
   * 入队即持久化（先落盘再应答是可靠性的根基，调用方必须 await）。
   * 去重只作用于「同一条投递的重复提交」，绝不吞掉新事件：
   * - 带 dedupeKey（ask 回传）：同 key 的 pending/在途返回同一条；
   *   已投递未过 TTL 返回同一条；dead 复活重投；
   * - 不带 key（外部 wake 事件）：仅同内容的 pending/在途返回同一条
   *   （挡 HTTP 超时后的重发）；已投递/已 dead 后再次 POST 按新事件入队。
   */
  async enqueue(input: WakeTarget & { code: string; prompt: string; mode?: DeckDeliveryMode; dedupeKey?: string }) {
    const now = this.now();
    const existing = input.dedupeKey
      ? this.items.find(
          (item) => item.dedupeKey === input.dedupeKey &&
            item.agentId === input.agentId && item.threadId === input.threadId,
        )
      : this.items.find(
          (item) => !item.dedupeKey && item.code === input.code && item.prompt === input.prompt &&
            item.mode === input.mode && item.agentId === input.agentId && item.threadId === input.threadId,
        );
    if (existing && (existing.status === "pending" || this.inflight.has(existing.id)))
      return this.view(existing);
    if (existing && input.dedupeKey) {
      if (
        existing.status === "delivered" &&
        now - (existing.deliveredAt ?? 0) <= DEDUPE_TTL_MS
      )
        return this.view(existing);
      if (existing.status === "dead") {
        existing.status = "pending";
        existing.attempts = 0;
        // 新一轮投递周期：重算基准时间，否则旧 createdAt 会立刻撞上 MAX_AGE。
        existing.createdAt = now;
        existing.updatedAt = now;
        existing.nextAttemptAt = now;
        delete existing.deliveredAt;
        delete existing.lastError;
        await this.save();
        this.options.onChanged?.();
        this.schedule();
        return this.view(existing);
      }
      // keyed 已投递过了 TTL：旧记录只剩占地方，删掉再按新条目走。
      this.items.splice(this.items.indexOf(existing), 1);
    }
    const item: StoredDelivery = {
      id: randomBytes(6).toString("hex"),
      mode: input.mode,
      code: input.code,
      prompt: input.prompt,
      preview: previewOf(input.prompt),
      ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
      status: "pending",
      agentId: input.agentId,
      threadId: input.threadId,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: now,
    };
    this.items.push(item);
    await this.save();
    this.options.onChanged?.();
    this.schedule();
    return this.view(item);
  }

  /** 立即重投（dead 复活、pending 提前到本轮）。已投递的不能重发。 */
  async retry(id: string) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) throw new Error("投递记录不存在");
    if (item.status === "delivered") throw new Error("该唤醒已投递");
    item.status = "pending";
    item.attempts = 0;
    item.createdAt = this.now();
    item.nextAttemptAt = item.createdAt;
    item.updatedAt = item.nextAttemptAt;
    delete item.lastError;
    await this.save();
    this.options.onChanged?.();
    this.schedule();
    return this.view(item);
  }

  /** 移除条目。pending 时被移除等于取消——在途的一次发送可能仍会送达。 */
  async dismiss(id: string) {
    const index = this.items.findIndex((entry) => entry.id === id);
    if (index < 0) throw new Error("投递记录不存在");
    this.items.splice(index, 1);
    await this.save();
    this.options.onChanged?.();
    this.schedule();
  }

  /** 把所有到期的 pending 尝试一遍；由定时器或测试驱动。 */
  async tick() {
    const now = this.now();
    const due = this.items.filter(
      (item) =>
        item.status === "pending" &&
        !this.inflight.has(item.id) &&
        (item.nextAttemptAt ?? 0) <= now,
    );
    await Promise.all(due.map((item) => this.attempt(item)));
  }

  close() {
    this.closed = true;
    if (this.timerHandle) clearTimeout(this.timerHandle);
    this.timerHandle = undefined;
  }

  private async attempt(item: StoredDelivery) {
    this.inflight.add(item.id);
    try {
      const target = this.options.resolve(item.code);
      if (!target || target.agentId !== item.agentId || target.threadId !== item.threadId) {
        // 代号被解绑视为取消：不是错误，但人需要知道这次唤醒不会到了。
        await this.fail(item, "唤醒代号已解绑", true);
        return;
      }
      await this.options.send(target.agentId, target.threadId, item.prompt, this.view(item));
      // 在途期间条目可能已被 dismiss：不再回写状态。
      if (!this.items.includes(item)) return;
      const now = this.now();
      item.status = "delivered";
      item.deliveredAt = now;
      item.updatedAt = now;
      delete item.nextAttemptAt;
      delete item.lastError;
      await this.changed();
    } catch (error) {
      const message = String(
        (error as any)?.message || error || "投递失败",
      ).slice(0, 500);
      await this.fail(item, message, PERMANENT_RE.test(message));
    } finally {
      this.inflight.delete(item.id);
      this.schedule();
    }
  }

  private async fail(item: StoredDelivery, message: string, permanent: boolean) {
    if (!this.items.includes(item)) return;
    const now = this.now();
    item.attempts += 1;
    item.lastError = message;
    item.updatedAt = now;
    if (permanent || now - item.createdAt >= MAX_AGE_MS) {
      item.status = "dead";
      delete item.nextAttemptAt;
    } else {
      item.nextAttemptAt = now + retryDelayMs(item.attempts);
    }
    await this.changed();
  }

  private view(item: StoredDelivery): WakeDelivery {
    const { prompt: _prompt, ...rest } = item;
    return { ...rest };
  }

  /** delivered 过 TTL 即剪（去重窗口同步结束）；dead 超上限丢最旧。 */
  private prune() {
    const now = this.now();
    this.items = this.items.filter(
      (item) =>
        item.status !== "delivered" ||
        now - (item.deliveredAt ?? now) <= DEDUPE_TTL_MS,
    );
    let dead = 0;
    for (const item of this.items) if (item.status === "dead") dead += 1;
    for (const item of this.items) {
      if (dead <= DEAD_KEEP) break;
      if (item.status === "dead") {
        this.items.splice(this.items.indexOf(item), 1);
        dead -= 1;
      }
    }
  }

  private async changed() {
    this.prune();
    try {
      await this.save();
    } catch (error: any) {
      // 状态仍在内存里，下一次写链会带上；不能让一次 IO 错误弄丢投递进度。
      console.error("唤醒队列写盘失败:", error?.message || error);
    }
    this.options.onChanged?.();
  }

  private save() {
    const snapshot = JSON.stringify({ version: 1, items: this.items });
    const attempt = this.writes.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.options.file), { recursive: true });
      const temporary = `${this.options.file}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.options.file);
    });
    this.writes = attempt.catch(() => undefined);
    return attempt;
  }

  private schedule() {
    if (this.options.timer === false || this.closed) return;
    if (this.timerHandle) clearTimeout(this.timerHandle);
    this.timerHandle = undefined;
    let soonest = Infinity;
    for (const item of this.items)
      if (item.status === "pending" && !this.inflight.has(item.id))
        soonest = Math.min(soonest, item.nextAttemptAt ?? 0);
    if (soonest === Infinity) return;
    this.timerHandle = setTimeout(() => {
      this.timerHandle = undefined;
      void this.tick();
    }, Math.max(0, soonest - this.now()));
    this.timerHandle.unref();
  }
}
