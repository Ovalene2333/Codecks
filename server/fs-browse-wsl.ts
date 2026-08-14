import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { DirListing } from "./fs-browse.js";

const execFileAsync = promisify(execFile);

export const WSL_DIR_LIST_SCRIPT = [
  "target=$1",
  "case $target in *$'\\n'*|*$'\\r'*) printf >&2 '%s\\n' '非法路径'; exit 1;; esac",
  'if [ ! -d "$target" ]; then printf >&2 "%s\\n" "不是目录"; exit 2; fi',
  'resolved=$(CDPATH= cd -- "$target" && pwd) || { printf >&2 "%s\\n" "不是目录"; exit 2; }',
  'if [ "$resolved" = / ]; then parent=; else parent=$(dirname -- "$resolved"); fi',
  'printf "%s\\n" "$resolved"',
  'printf "%s\\n" "$parent"',
  'printf "%s\\n" "${HOME:-/}"',
  'set -- "$resolved"/*',
  "for entry do",
  '  [ -e "$entry" ] || continue',
  '  [ -d "$entry" ] || continue',
  '  printf "%s\\n" "${entry##*/}"',
  "done",
].join("\n");

export type WslExec = (
  command: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

export function wslDirListArgs(target: string) {
  return ["--exec", "sh", "-c", WSL_DIR_LIST_SCRIPT, "wsl-ls", target];
}

export function parseWslDirListing(stdout: string): DirListing {
  const lines = stdout.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length < 3) throw new Error("无法解析 WSL 目录列表");
  const [resolved, parent, home, ...names] = lines;
  if (!resolved.startsWith("/")) throw new Error("WSL 返回了无效路径");
  const entries = names
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, "zh"))
    .slice(0, 200)
    .map((name) => ({ name, path: path.posix.join(resolved, name) }));
  return {
    path: resolved,
    parent: parent && parent !== resolved ? parent : null,
    home: home || "/",
    entries,
  };
}

async function defaultWslExec(command: string, args: string[]) {
  return execFileAsync(command, args, {
    timeout: 20_000,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 2_000_000,
  });
}

export async function listWslDirectories(
  target: string,
  exec: WslExec = defaultWslExec,
): Promise<DirListing> {
  if (!target || target.includes("\0") || /[\r\n]/.test(target))
    throw new Error("非法路径");
  try {
    const { stdout } = await exec("wsl.exe", wslDirListArgs(target));
    return parseWslDirListing(stdout);
  } catch (error: any) {
    const detail = String(error?.stderr || error?.message || "未知错误").trim();
    if (/不是目录/.test(detail)) throw new Error("不是目录");
    if (/非法路径/.test(detail)) throw new Error("非法路径");
    throw new Error(`无法读取 WSL 目录：${detail.split(/\r?\n/)[0]}`);
  }
}
