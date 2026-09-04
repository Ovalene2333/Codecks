import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { killProcessTree } from "./process-tree.js";

export const RUNTIME_LOCK_FILE = "runtime-lock.json";

export interface RuntimeLock {
  pid: number;
  childPid?: number;
  port: number;
  useWsl: boolean;
  listen?: string;
  startedAt: number;
}

export interface RuntimeLockHooks {
  alive?: (pid: number) => boolean;
  kill?: (pid: number) => void;
  now?: () => number;
  /**
   * 杀残留子进程前的归属校验。默认实现见 defaultVerifyStaleChild；
   * 返回 false 时跳过 kill（宁可端口冲突报错，不误杀疑似 PID 复用的进程）。
   */
  verifyStaleChild?: (pid: number) => boolean;
}

export type AcquireRuntimeLockResult =
  | { status: "acquired"; staleChildKilled?: number }
  | { status: "blocked"; lock: RuntimeLock };

export function runtimeLockPath(dataDir: string) {
  return path.join(dataDir, RUNTIME_LOCK_FILE);
}

export function isPidAlive(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    // EPERM 表示进程存在但无权发信号（如其他账户的进程）：必须视为存活，
    // 否则会被误判为 stale，后续逻辑可能杀掉无辜进程或错误放行。
    return error?.code === "EPERM";
  }
}

export function killRecordedPid(
  pid: number,
  platform = process.platform,
) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    // 同步 taskkill：旧的 fire-and-forget spawn 会留僵尸句柄，
    // 且调用方无法确认残留子进程已被回收。
    killProcessTree(pid);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

/**
 * win32 下杀残留子进程前的 PID 归属校验：Windows 会激进复用 PID，
 * 硬崩溃残留的锁可能指向完全无关的新进程。
 * 用 wmic 查该 PID 进程的创建时间：若晚于锁文件最后一次写入（2 秒容差），
 * 说明是锁写下之后才启动的进程，不可能是记录中的残留子进程，拒绝 kill。
 * 查不到（wmic 缺失、解析失败）时同样拒绝：宁可报端口冲突，不误杀。
 * 非 win32 保持旧行为（单发 SIGTERM，破坏力远小于 taskkill /T /F）。
 */
export function defaultVerifyStaleChild(dataDir: string, pid: number): boolean {
  if (process.platform !== "win32") return true;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    const mtimeMs = statSync(runtimeLockPath(dataDir)).mtimeMs;
    const createdMs = win32ProcessCreationMs(pid);
    if (createdMs === undefined) return false;
    return createdMs <= mtimeMs + 2_000;
  } catch {
    return false;
  }
}

function win32ProcessCreationMs(pid: number): number | undefined {
  const output = execFileSync(
    "wmic",
    ["process", "where", `ProcessId=${pid}`, "get", "CreationDate", "/value"],
    { timeout: 3_000, stdio: ["ignore", "pipe", "ignore"] },
  ) as unknown as Buffer;
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(String(output));
  // wmic 经管道输出多为 UTF-16LE（带 BOM），缺失 PID 时则输出提示文本。
  const text =
    buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe
      ? buffer.toString("utf16le")
      : buffer.toString("utf8");
  const match = text.match(/CreationDate=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

export function readRuntimeLock(dataDir: string): RuntimeLock | undefined {
  try {
    const raw = JSON.parse(readFileSync(runtimeLockPath(dataDir), "utf8"));
    if (!raw || typeof raw.pid !== "number" || typeof raw.port !== "number")
      return undefined;
    return {
      pid: raw.pid,
      childPid:
        typeof raw.childPid === "number" ? raw.childPid : undefined,
      port: raw.port,
      useWsl: Boolean(raw.useWsl),
      listen: typeof raw.listen === "string" ? raw.listen : undefined,
      startedAt:
        typeof raw.startedAt === "number" ? raw.startedAt : 0,
    };
  } catch {
    return undefined;
  }
}

export function writeRuntimeLock(dataDir: string, lock: RuntimeLock) {
  writeFileSync(runtimeLockPath(dataDir), `${JSON.stringify(lock, null, 2)}\n`);
}

export function updateRuntimeLock(
  dataDir: string,
  patch: Partial<RuntimeLock>,
  ownerPid = process.pid,
) {
  const current = readRuntimeLock(dataDir);
  if (!current || current.pid !== ownerPid) return;
  writeRuntimeLock(dataDir, { ...current, ...patch });
}

export function clearRuntimeLock(dataDir: string, expectedPid?: number) {
  const current = readRuntimeLock(dataDir);
  if (!current) return;
  if (expectedPid != null && current.pid !== expectedPid) return;
  try {
    unlinkSync(runtimeLockPath(dataDir));
  } catch {}
}

export function acquireRuntimeLock(
  dataDir: string,
  self: {
    pid: number;
    port: number;
    useWsl: boolean;
    listen?: string;
  },
  hooks: RuntimeLockHooks = {},
): AcquireRuntimeLockResult {
  const alive = hooks.alive || isPidAlive;
  const kill = hooks.kill || killRecordedPid;
  const now = hooks.now || Date.now;
  const verify =
    hooks.verifyStaleChild || ((pid: number) => defaultVerifyStaleChild(dataDir, pid));

  const lock: RuntimeLock = {
    pid: self.pid,
    port: self.port,
    useWsl: self.useWsl,
    listen: self.listen,
    startedAt: now(),
  };
  // 原子创建：两个实例同时启动时只有一个 O_EXCL 成功，另一个走下面的
  // stale 判断，不会像先读后写那样双双 acquired。
  try {
    writeFileSync(
      runtimeLockPath(dataDir),
      `${JSON.stringify(lock, null, 2)}\n`,
      { flag: "wx" },
    );
    return { status: "acquired" };
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }
  const existing = readRuntimeLock(dataDir);
  if (!existing) {
    // 赢者建完又删了（如启动失败清理）：直接写入。
    writeRuntimeLock(dataDir, lock);
    return { status: "acquired" };
  }
  let staleChildKilled: number | undefined;

  if (existing.pid !== self.pid && alive(existing.pid))
    return { status: "blocked", lock: existing };

  if (existing.childPid && existing.pid !== self.pid && alive(existing.childPid)) {
    if (verify(existing.childPid)) {
      kill(existing.childPid);
      staleChildKilled = existing.childPid;
    } else {
      // 疑似 PID 复用或无法验证归属：跳过 kill，宁可让新实例报端口冲突，
      // 也不 taskkill 整棵无辜进程树。
      console.error(
        `跳过清理残留子进程 pid=${existing.childPid}：无法确认归属（疑似 PID 复用），请手工检查`,
      );
    }
  }

  writeRuntimeLock(dataDir, lock);
  return staleChildKilled
    ? { status: "acquired", staleChildKilled }
    : { status: "acquired" };
}

export function lockExists(dataDir: string) {
  return existsSync(runtimeLockPath(dataDir));
}
