import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

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
  } catch {
    return false;
  }
}

export function killRecordedPid(
  pid: number,
  platform = process.platform,
) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
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
  const existing = readRuntimeLock(dataDir);
  let staleChildKilled: number | undefined;

  if (existing && existing.pid !== self.pid && alive(existing.pid))
    return { status: "blocked", lock: existing };

  if (existing?.childPid && existing.pid !== self.pid && alive(existing.childPid)) {
    kill(existing.childPid);
    staleChildKilled = existing.childPid;
  }

  const lock: RuntimeLock = {
    pid: self.pid,
    port: self.port,
    useWsl: self.useWsl,
    listen: self.listen,
    startedAt: now(),
  };
  writeRuntimeLock(dataDir, lock);
  return staleChildKilled
    ? { status: "acquired", staleChildKilled }
    : { status: "acquired" };
}

export function lockExists(dataDir: string) {
  return existsSync(runtimeLockPath(dataDir));
}
