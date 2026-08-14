import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function resolveWslHome() {
  try {
    const { stdout } = await execFileAsync("wsl.exe", [
      "--exec",
      "sh",
      "-lc",
      'printf %s "$HOME"',
    ]);
    const home = stdout.trim();
    if (home.startsWith("/")) return home;
  } catch (error: any) {
    throw new Error(
      `无法读取 WSL 用户目录：${error.message || "未知错误"}`,
    );
  }
  throw new Error("WSL 返回了无效的用户目录");
}

export async function resolveRuntimeCodexHome(
  configuredHome: string | undefined,
  dataDir: string,
  options: { useWsl?: boolean; wslHome?: string } = {},
) {
  if (options.useWsl) {
    if (configuredHome) return configuredHome;
    return path.posix.join(options.wslHome || (await resolveWslHome()), ".codex");
  }
  const nativeHome = path.join(os.homedir(), ".codex");
  if (!configuredHome) return nativeHome;

  const configured = path.resolve(configuredHome);
  const legacyRuntimeHome = path.resolve(dataDir, "runtime-home");
  const samePath =
    process.platform === "win32"
      ? configured.toLowerCase() === legacyRuntimeHome.toLowerCase()
      : configured === legacyRuntimeHome;
  if (!samePath) return configured;

  try {
    // Older Deck releases used a runtime home whose sessions directory was a
    // junction into the native Codex home. New Codex versions resolve that
    // junction and reject the rollout as being outside CODEX_HOME.
    const sessions = await realpath(path.join(configured, "sessions"));
    if (path.basename(sessions).toLowerCase() === "sessions")
      return path.dirname(sessions);
  } catch {}
  return nativeHome;
}

export function parseWindowsSandboxMode(
  toml: string,
): "elevated" | "unelevated" | undefined {
  const section = toml.match(/\[windows\]([\s\S]*?)(?=\n\[|$)/i);
  if (!section) return undefined;
  const match = section[1].match(
    /^\s*sandbox\s*=\s*["']?(elevated|unelevated)["']?/im,
  );
  if (match?.[1] === "elevated" || match?.[1] === "unelevated") return match[1];
}

export async function nativeWindowsSandboxMode(nativeHome: string) {
  try {
    return parseWindowsSandboxMode(
      await readFile(path.join(nativeHome, "config.toml"), "utf8"),
    );
  } catch {
    return undefined;
  }
}
