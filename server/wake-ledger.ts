import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LostWakeWatcher, WakeWatcher } from "./types.js";

/**
 * watcher 台账：记住见过的 watcher，等它从进程列表里消失时看日志判定结局。
 *
 * - 日志最后一行是「已唤醒」：正常结束，会话已收到唤醒。
 * - 「已停止」或经 Deck 停止：主动停止。
 * - 其余（被 kill、机器重启、唤醒发不出去…）：失联，进「需要处理」。
 *
 * Deck 仍不托管 watcher 生命周期（不拉起、不重启），这里只做事后记账；
 * 持久化是为了 Deck 停机期间消失的 watcher 在重启后也能被发现。
 */

const LOST_KEEP = 50;
const LINE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (.*)$/;

export type WatcherOutcome =
  | { kind: "woke" }
  | { kind: "stopped" }
  | { kind: "lost"; reason: string; lastLine?: string };

/** 按日志里最后一条带时间戳的行判定结局（脚本报错之类的杂行不算）。 */
export function classifyWatcherExit(log: string | undefined): WatcherOutcome {
  if (log == null) return { kind: "lost", reason: "watcher 已退出，找不到它的日志" };
  const lines = log
    .split(/\r?\n/)
    .map((line) => LINE_RE.exec(line.trim())?.[1])
    .filter((line): line is string => Boolean(line));
  const last = lines.at(-1);
  if (!last) return { kind: "lost", reason: "watcher 已退出，日志里没有任何记录" };
  if (last.startsWith("已唤醒")) return { kind: "woke" };
  if (last.startsWith("已停止")) return { kind: "stopped" };
  if (last.startsWith("唤醒失败"))
    return { kind: "lost", reason: "任务结束了，但唤醒请求一直没能送到 Deck", lastLine: last };
  if (/^收到 [A-Z0-9]+/.test(last))
    return { kind: "lost", reason: "watcher 被外部终止（如关机或 kill），远端任务可能仍在运行", lastLine: last };
  return { kind: "lost", reason: "watcher 意外退出，没有发出唤醒，远端任务可能仍在运行", lastLine: last };
}

/** pid 会复用，但同 pid 同代号同命令几乎不可能——也不依赖抖动的启动时刻。 */
export const watcherKey = (watcher: Pick<WakeWatcher, "pid" | "code" | "command">) =>
  `${watcher.pid}\u0000${watcher.code}\u0000${watcher.command}`;

interface Options {
  file: string;
  /** 读取日志末尾；读不到返回 undefined。 */
  readLog: (file: string) => Promise<string | undefined>;
  now?: () => number;
  onChanged?: () => void;
}

export class WakeWatcherLedger {
  private seen = new Map<string, WakeWatcher>();
  private lostItems: LostWakeWatcher[] = [];
  /** Deck 主动停止的 watcher：消失时记为停止而不是失联（旧版脚本不写停止行）。 */
  private stopping = new Set<string>();
  private writes = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.options.file, "utf8"));
      if (parsed?.version !== 1) return;
      const valid = (item: any) =>
        item &&
        typeof item.pid === "number" &&
        typeof item.code === "string" &&
        typeof item.command === "string";
      for (const item of Array.isArray(parsed.seen) ? parsed.seen : [])
        if (valid(item)) this.seen.set(watcherKey(item), item);
      this.lostItems = (Array.isArray(parsed.lost) ? parsed.lost : []).filter(
        (item: any) => valid(item) && typeof item.id === "string",
      );
    } catch (error: any) {
      if (error?.code !== "ENOENT")
        console.error("watcher 台账文件损坏，已回退为空:", error?.message || error);
    }
  }

  lost(): LostWakeWatcher[] {
    return [...this.lostItems];
  }

  find(id: string) {
    return this.lostItems.find((item) => item.id === id);
  }

  /** Deck 即将停止这个 watcher。 */
  markStopping(watcher: WakeWatcher) {
    this.stopping.add(watcherKey(watcher));
  }

  /** 喂入一次完整扫描结果（扫描失败时不要调用）。 */
  async observe(running: WakeWatcher[]) {
    let changed = false;
    const present = new Set<string>();
    for (const watcher of running) {
      const key = watcherKey(watcher);
      present.add(key);
      const before = this.seen.get(key);
      // 只在影响事后展示的字段变化时写盘（状态、绑定会话）。
      if (
        !before ||
        before.state !== watcher.state ||
        before.threadId !== watcher.threadId ||
        before.log !== watcher.log
      )
        changed = true;
      this.seen.set(key, watcher);
    }
    for (const [key, watcher] of [...this.seen]) {
      if (present.has(key)) continue;
      this.seen.delete(key);
      changed = true;
      if (this.stopping.delete(key)) continue;
      const outcome = classifyWatcherExit(
        watcher.log ? await this.options.readLog(watcher.log) : undefined,
      );
      if (outcome.kind !== "lost") continue;
      this.lostItems.push({
        ...watcher,
        // 正在失败计数的状态对失联条目没有意义。
        failures: undefined,
        id: randomBytes(6).toString("hex"),
        endedAt: this.now(),
        reason: outcome.reason,
        ...(outcome.lastLine ? { lastLine: outcome.lastLine } : {}),
      });
    }
    if (this.lostItems.length > LOST_KEEP)
      this.lostItems.splice(0, this.lostItems.length - LOST_KEEP);
    if (!changed) return;
    await this.save();
    this.options.onChanged?.();
  }

  async dismiss(id: string) {
    const index = this.lostItems.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("失联记录不存在");
    this.lostItems.splice(index, 1);
    await this.save();
    this.options.onChanged?.();
  }

  private save() {
    const snapshot = JSON.stringify({
      version: 1,
      seen: [...this.seen.values()],
      lost: this.lostItems,
    });
    const attempt = this.writes.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.options.file), { recursive: true });
      const temporary = `${this.options.file}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.options.file);
    });
    this.writes = attempt.catch(() => undefined);
    return attempt.catch((error: any) =>
      console.error("watcher 台账写盘失败:", error?.message || error),
    );
  }
}
