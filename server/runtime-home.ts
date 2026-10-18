import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
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

export async function resolveWslDeckHome() {
  const { stdout } = await execFileAsync(
    "wsl.exe",
    [
      "--exec", "sh", "-lc",
      'printf %s "${CODEX_DECK_HOME:-$HOME/.codex-deck}"',
    ],
    { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 },
  );
  const value = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (value?.startsWith("/")) return value;
  throw new Error("WSL 返回了无效的 deck 发现目录");
}

export async function wslWindowsPath(pathInWsl: string) {
  const { stdout } = await execFileAsync(
    "wsl.exe",
    ["--exec", "wslpath", "-w", pathInWsl],
    { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 },
  );
  const value = stdout.trim();
  if (!value || /[\r\n]/.test(value))
    throw new Error("WSL 返回了无效的 Windows 路径");
  return value;
}

/**
 * Windows 原生 Deck + WSL agent 时，把 deck-api 的发现文件写进 WSL 的
 * `$HOME/.codex-deck`。WSL 里读 Windows 路径不可靠，所以用 wslpath 取 UNC
 * 路径，再通过 wsl.exe 补 POSIX 权限。
 */
export async function writeWslDiscovery(
  deckHome: string,
  url: string,
  token: string,
) {
  await execFileAsync("wsl.exe", ["--exec", "mkdir", "-p", deckHome], {
    windowsHide: true,
    timeout: 5_000,
  });
  const windowsHome = await wslWindowsPath(deckHome);
  await mkdir(windowsHome, { recursive: true, mode: 0o700 });
  await writeFile(path.join(windowsHome, "url"), `${url}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(path.join(windowsHome, "token"), `${token}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await execFileAsync(
    "wsl.exe",
    [
      "--exec", "sh", "-c",
      'chmod 700 "$1"; chmod 600 "$1/url" "$1/token"',
      "sh", deckHome,
    ],
    { windowsHide: true, timeout: 5_000 },
  ).catch(() => undefined);
}

export async function installWslScripts(
  deckHome: string,
  scripts: { name: string; content: string }[],
) {
  const bin = path.posix.join(deckHome, "bin");
  await execFileAsync("wsl.exe", ["--exec", "mkdir", "-p", bin], {
    windowsHide: true,
    timeout: 5_000,
  });
  const windowsBin = await wslWindowsPath(bin);
  await mkdir(windowsBin, { recursive: true, mode: 0o700 });
  for (const script of scripts) {
    const target = path.join(windowsBin, script.name);
    const current = await readFile(target, "utf8").catch(() => "");
    if (current === script.content) continue;
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, script.content, {
      encoding: "utf8",
      mode: 0o755,
    });
    await rename(temporary, target);
  }
  await execFileAsync(
    "wsl.exe",
    ["--exec", "sh", "-c", 'chmod 700 "$1"; chmod 755 "$1"/*', "sh", bin],
    { windowsHide: true, timeout: 5_000 },
  ).catch(() => undefined);
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
