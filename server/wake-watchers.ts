import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { WakeWatcher } from "./types.js";

/**
 * deck-wake watcher 的只读发现。
 *
 * watcher 是 `setsid nohup` 脱离出去的独立进程，Deck 不托管它的生命周期：
 * 开发中频繁重启 Deck 不会杀掉或重复拉起 watcher，这里也不保存任何状态。
 * 识别依据是脚本的稳定约定——进程参数 `deck-wake _watch|_poll <代号> … -- <命令>`，
 * 各项目里的脚本拷贝都一样；轮询任务的当前状态取自日志末尾的「状态：A -> B」。
 */

const CODE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
/** Linux 用户态时钟频率固定为 100（USER_HZ），/proc/<pid>/stat 的 starttime 以它计数。 */
const USER_HZ = 100;
const LOG_TAIL_BYTES = 8 * 1024;
/** spawn 先按当前时间定日志名再起子进程，两者相差通常不到一秒。 */
const LOG_MATCH_SLACK_MS = 10_000;
const STATE_LIMIT = 160;

const execFileAsync = promisify(execFile);

export interface WatcherArgs {
  code: string;
  mode: "watch" | "poll";
  label: string;
  intervalSec?: number;
  command: string;
}

/** `bash …/deck-wake _poll <code> <label> <interval> <re> <all> -- cmd…` / `_watch <code> <label> <lines> -- cmd…` */
export function parseWatcherArgv(argv: string[]): WatcherArgs | undefined {
  const at = argv.findIndex(
    (arg, index) =>
      (arg === "_watch" || arg === "_poll") &&
      index > 0 &&
      path.posix.basename(argv[index - 1]) === "deck-wake",
  );
  if (at < 0) return undefined;
  const rest = argv.slice(at + 1);
  const dash = rest.indexOf("--");
  if (dash < 2) return undefined;
  const [code, label, interval] = rest;
  if (!CODE_RE.test(code)) return undefined;
  const mode = argv[at] === "_watch" ? "watch" : "poll";
  const seconds = Number(interval);
  return {
    code,
    mode,
    label: label || code,
    ...(mode === "poll" && seconds > 0 ? { intervalSec: seconds } : {}),
    command: rest.slice(dash + 1).join(" "),
  };
}

/** ps 的 etime：`[[dd-]hh:]mm:ss`。 */
export function parseEtime(value: string): number | undefined {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const [, days, hours, minutes, seconds] = match;
  return (
    ((Number(days || 0) * 24 + Number(hours || 0)) * 60 + Number(minutes)) * 60 +
    Number(seconds)
  ) * 1_000;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 日志名 `<code>-YYYYmmdd-HHMMSS.log`（本机时区）：挑开始时间最接近进程启动的那份。 */
export function pickLog(names: string[], code: string, startedAt: number) {
  const pattern = new RegExp(`^${escapeRegExp(code)}-(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})\\.log$`);
  let best: { name: string; gap: number } | undefined;
  for (const name of names) {
    const match = pattern.exec(name);
    if (!match) continue;
    const [, y, mo, d, h, mi, s] = match.map(Number);
    const gap = Math.abs(new Date(y, mo - 1, d, h, mi, s).getTime() - startedAt);
    if (gap <= LOG_MATCH_SLACK_MS && (!best || gap < best.gap)) best = { name, gap };
  }
  return best?.name;
}

const LINE_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) (.*)$/;

export interface LogState {
  state?: string;
  stateAt?: number;
  /** 最近一次状态之后的连续连接失败次数及最后一次失败的时间。 */
  failures?: number;
  failedAt?: number;
}

/** 从日志末尾读出最近一次状态，以及其后的连续连接失败。 */
export function parseLogState(text: string): LogState {
  const result: LogState = {};
  for (const line of text.split(/\r?\n/)) {
    const match = LINE_RE.exec(line);
    if (!match) continue;
    const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number);
    const body = match[7];
    if (body.startsWith("状态：")) {
      const arrow = body.indexOf(" -> ");
      const state = (arrow >= 0 ? body.slice(arrow + 4) : body.slice(3)).trim();
      result.state = state.length > STATE_LIMIT ? `${state.slice(0, STATE_LIMIT)}…` : state;
      result.stateAt = new Date(y, mo - 1, d, h, mi, s).getTime();
      delete result.failures;
      delete result.failedAt;
      continue;
    }
    const failed = /^连接失败（(\d+)\/\d+）/.exec(body);
    if (failed) {
      result.failures = Number(failed[1]);
      result.failedAt = new Date(y, mo - 1, d, h, mi, s).getTime();
    }
  }
  return result;
}

interface ProcessInfo {
  pid: number;
  argv: string[];
  startedAt: number;
}

/** Linux（含 WSL）：/proc 给出精确的 argv 与启动时刻，不必解析 ps 的空格拼接。 */
async function linuxProcesses(): Promise<ProcessInfo[]> {
  const [entries, stat] = await Promise.all([
    fs.readdir("/proc"),
    fs.readFile("/proc/stat", "utf8"),
  ]);
  const boot = Number(/^btime (\d+)$/m.exec(stat)?.[1]);
  const found: ProcessInfo[] = [];
  await Promise.all(
    entries
      .filter((entry) => /^\d+$/.test(entry))
      .map(async (entry) => {
        try {
          const raw = await fs.readFile(`/proc/${entry}/cmdline`, "utf8");
          if (!raw.includes("deck-wake")) return;
          const argv = raw.split("\0");
          if (argv.at(-1) === "") argv.pop();
          const line = await fs.readFile(`/proc/${entry}/stat`, "utf8");
          // comm 字段可能含空格和括号，从最后一个 ")" 之后数：第 22 列 starttime。
          const ticks = Number(line.slice(line.lastIndexOf(")") + 2).split(" ")[19]);
          found.push({ pid: Number(entry), argv, startedAt: (boot + ticks / USER_HZ) * 1_000 });
        } catch {
          // 进程刚好退出，或没有读权限。
        }
      }),
  );
  return found;
}

/** macOS 等：ps 的 command 是空格拼接的，标签含空格时会解析偏，但只影响展示。 */
async function psProcesses(now: number): Promise<ProcessInfo[]> {
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,etime=,command="], {
    maxBuffer: 8 * 1024 * 1024,
  });
  const found: ProcessInfo[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.includes("deck-wake")) continue;
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    const elapsed = match ? parseEtime(match[2]) : undefined;
    if (!match || elapsed == null) continue;
    found.push({ pid: Number(match[1]), argv: match[3].split(/\s+/), startedAt: now - elapsed });
  }
  return found;
}

export async function readTail(file: string) {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    // 截断处可能落在多字节字符或半行中间，丢掉第一行。
    return length < size ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

const WATCHER_TTL_MS = 5_000;

/**
 * watcher 列表的 TTL 缓存（stale-while-revalidate）：/proc 全量扫描没法放进
 * 每次快照构建，读取方拿最近一次结果，过期则后台重扫；内容变化经 onChange
 * 补发快照。接口轮询、快照与启动预热共用同一份缓存，首页不必再等扫描。
 */
export class WakeWatcherCache {
  private items: WakeWatcher[] = [];
  private scannedAt = 0;
  private inflight?: Promise<void>;

  constructor(
    private scan: () => Promise<WakeWatcher[]>,
    private options: {
      ttlMs?: number;
      onChange?: (items: WakeWatcher[]) => void;
    } = {},
  ) {}

  /** 最近一次扫描结果；过期或尚未扫描时后台重扫，不阻塞调用方。 */
  current(): WakeWatcher[] {
    void this.refresh();
    return this.items;
  }

  /** 让下一次读取立即重扫（Deck 刚停掉某个 watcher 时用）。 */
  invalidate() {
    this.scannedAt = 0;
  }

  /** 新鲜结果：缓存未过期直接返回；过期则等本轮重扫落地再返回。 */
  async ready(): Promise<WakeWatcher[]> {
    await this.refresh();
    return this.items;
  }

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (
      this.scannedAt &&
      Date.now() - this.scannedAt < (this.options.ttlMs ?? WATCHER_TTL_MS)
    )
      return Promise.resolve();
    const run = Promise.resolve()
      .then(() => this.scan())
      .then((items) => {
        if (JSON.stringify(items) !== JSON.stringify(this.items)) {
          this.items = items;
          this.options.onChange?.(items);
        }
      })
      // 扫描失败沿用旧数据；本轮也计入时间戳，避免每次读取都触发重试。
      .catch(() => {})
      .finally(() => {
        this.scannedAt = Date.now();
        this.inflight = undefined;
      });
    this.inflight = run;
    return run;
  }
}

/**
 * 列出本机正在运行的 watcher。进程列表读不到时抛错（缓存会沿用旧结果）——
 * 不能返回空表，否则台账会把所有 watcher 误判为已退出；日志等其余信息
 * 读取失败只是少一些字段。
 */
export async function listWakeWatchers(logDir: string, now = Date.now()): Promise<WakeWatcher[]> {
  if (process.platform === "win32") return [];
  const processes =
    process.platform === "linux" ? await linuxProcesses() : await psProcesses(now);
  const running = processes.flatMap((info) => {
    const args = parseWatcherArgv(info.argv);
    return args ? [{ ...info, args }] : [];
  });
  if (!running.length) return [];
  const logs = await fs.readdir(logDir).catch(() => [] as string[]);
  const watchers = await Promise.all(
    running.map(async ({ pid, startedAt, args }) => {
      const watcher: WakeWatcher = { pid, startedAt: Math.round(startedAt), ...args };
      const name = pickLog(logs, args.code, startedAt);
      if (name) {
        watcher.log = path.join(logDir, name);
        if (args.mode === "poll") {
          const { state, stateAt, failures, failedAt } = parseLogState(
            await readTail(watcher.log).catch(() => ""),
          );
          if (state) Object.assign(watcher, { state, stateAt });
          // 连上之后脚本只清零计数、不写日志：两个轮询周期内没有新的失败就视为已恢复。
          const period = (args.intervalSec ?? 60) * 1_000;
          if (failures && failedAt && now - failedAt <= period * 2 + 30_000)
            watcher.failures = failures;
        }
      }
      return watcher;
    }),
  );
  return watchers.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
}
