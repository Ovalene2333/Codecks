import { spawnSync } from "node:child_process";

/**
 * 整棵进程树结束（尽力而为，绝不抛错）。
 *
 * 只有 Windows 需要：经 `cmd.exe` / `.bat` / `.cmd` 包裹启动的子进程，
 * 直接杀外层会留下真正的孙进程成为孤儿，所以用 `taskkill /T` 连带结束。
 * `pid` 只接受数字并以参数数组形式传递，不经过 shell。
 * 非 Windows 上直接返回，调用方随后仍会杀直接子进程。
 */
export function killProcessTree(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform !== "win32") return;
  try {
    spawnSync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", `taskkill /PID ${pid} /T /F`],
      { windowsHide: true, stdio: "ignore" },
    );
  } catch {
    // taskkill 失败也不要紧：调用方随后还会尝试直接 kill。
  }
}

export interface KillableChild {
  pid?: number;
  kill(...args: any[]): unknown;
}

/**
 * 先杀整棵树再杀直接子进程兜底，一律吞错。
 * 所有 spawn 子进程的停止路径都应走这里，而不是裸 `child.kill()`。
 */
export function stopChildProcess(
  child: KillableChild | undefined | null,
  killTree: (pid: number) => void = killProcessTree,
): void {
  if (!child) return;
  if (typeof child.pid === "number") {
    try {
      killTree(child.pid);
    } catch {
      // 忽略，继续尝试直接 kill。
    }
  }
  try {
    child.kill();
  } catch {
    // 忽略：进程可能已经退出。
  }
}
