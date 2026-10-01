import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { isWslFsPath, listDirectories } from "../../server/fs-browse.js";
import type { WslExec } from "../../server/fs-browse-wsl.js";
import type { DeckTool, ToolDescriptor } from "../server-registry.js";
import type {
  FsEntry,
  FsFile,
  FsListing,
  FsWriteResult,
} from "./text-files.types.js";

const execFileAsync = promisify(execFile);

const MAX_ENTRIES = 500;
export const MAX_READ_BYTES = 1_048_576;
const MAX_WRITE_CHARS = 4_000_000;
const MAX_WRITE_BYTES = 8_000_000;
const BINARY_SNIFF_BYTES = 8_000;

const pathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"), "非法路径");

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), path: pathSchema.optional() }),
  z.object({ action: z.literal("read"), path: pathSchema }),
  z.object({
    action: z.literal("write"),
    path: pathSchema,
    content: z.string().max(MAX_WRITE_CHARS),
    baseMtimeMs: z.number().nonnegative().optional(),
    force: z.boolean().optional(),
    create: z.boolean().optional(),
  }),
  z.object({ action: z.literal("mkdir"), path: pathSchema }),
  z.object({ action: z.literal("remove"), path: pathSchema }),
  z.object({
    action: z.literal("rename"),
    path: pathSchema,
    name: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) => !/[\\/]|\0/.test(value) && value !== "." && value !== "..",
        "非法名称",
      ),
  }),
]);

function sortEntries(entries: FsEntry[]) {
  return entries.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name, "zh")
      : a.kind === "dir"
        ? -1
        : 1,
  );
}

function looksBinary(chunk: Buffer | string) {
  const probe =
    typeof chunk === "string"
      ? chunk.slice(0, BINARY_SNIFF_BYTES)
      : chunk.subarray(0, BINARY_SNIFF_BYTES);
  return probe.includes("\0");
}

function friendlyError(error: any): string {
  const stderr = String(error?.stderr || "").trim();
  const detail = (
    stderr.split(/\r?\n/)[0] || String(error?.message || "")
  ).trim();
  const code = error?.code;
  if (code === "ENOENT" && !stderr) return "路径不存在";
  if (code === "EACCES" || code === "EPERM") return "权限不足";
  if (code === "EEXIST") return "同名文件已存在";
  if (code === "ENOTEMPTY" || /directory not empty|目录非空/i.test(detail))
    return "目录非空，仅支持删除空目录";
  if (/file exists|已存在/i.test(detail)) return "同名文件已存在";
  return detail || "操作失败";
}

// WSL 列表脚本输出：前三行依次为 resolved / parent / home，之后每个条目一行，
// "d\t名称" 或 "f\t名称\tsize mtime"。隐藏文件也要覆盖（.env 这类配置文件是刚需），
// 用 .[!.]* 与 ..?* 两个 glob 避免把 . / .. 本身列出来。
export const WSL_LIST_SCRIPT = [
  "target=$1",
  "case $target in *$'\\n'*|*$'\\r'*) printf >&2 '%s\\n' '非法路径'; exit 1;; esac",
  'if [ ! -d "$target" ]; then printf >&2 "%s\\n" "不是目录"; exit 2; fi',
  'resolved=$(CDPATH= cd -- "$target" && pwd) || { printf >&2 "%s\\n" "不是目录"; exit 2; }',
  'if [ "$resolved" = / ]; then parent=; else parent=$(dirname -- "$resolved"); fi',
  'printf "%s\\n" "$resolved"',
  'printf "%s\\n" "$parent"',
  'printf "%s\\n" "${HOME:-/}"',
  'set -- "$resolved"/* "$resolved"/.[!.]* "$resolved"/..?*',
  "for entry do",
  '  [ -e "$entry" ] || continue',
  "  name=${entry##*/}",
  '  if [ -d "$entry" ]; then',
  '    printf "d\\t%s\\n" "$name"',
  '  elif [ -f "$entry" ]; then',
  '    meta=$(stat -c "%s %Y" -- "$entry" 2>/dev/null || printf "0 0")',
  '    printf "f\\t%s\\t%s\\n" "$name" "$meta"',
  "  fi",
  "done",
].join("\n");

export function wslListArgs(target: string) {
  return ["--exec", "sh", "-c", WSL_LIST_SCRIPT, "wsl-ls", target];
}

export function parseWslListing(stdout: string): FsListing {
  const lines = stdout.replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (lines.length < 3) throw new Error("无法解析 WSL 目录列表");
  const [resolved, parent, home, ...rows] = lines;
  if (!resolved.startsWith("/")) throw new Error("WSL 返回了无效路径");
  const entries: FsEntry[] = [];
  for (const row of rows) {
    const [tag, name, meta] = row.split("\t");
    if (!name) continue;
    const child = path.posix.join(resolved, name);
    if (tag === "d") {
      entries.push({ name, path: child, kind: "dir" });
    } else if (tag === "f") {
      const [size, mtime] = (meta || "").split(/\s+/);
      entries.push({
        name,
        path: child,
        kind: "file",
        size: Number(size) || 0,
        mtimeMs: (Number(mtime) || 0) * 1000,
      });
    }
    if (entries.length >= MAX_ENTRIES) break;
  }
  return {
    path: resolved,
    parent: parent && parent !== resolved ? parent : null,
    home: home || "/",
    entries: sortEntries(entries),
  };
}

// 文件内容经 base64 传输：execFile 的 utf8 解码会改动无效字节序，
// 让二进制探测与截断判断失真。第一行输出 size/mtime，其余为 base64。
export const WSL_READ_SCRIPT = [
  "target=$1",
  'if [ -d "$target" ]; then printf >&2 "%s\\n" "目标是目录"; exit 2; fi',
  'if [ ! -f "$target" ]; then printf >&2 "%s\\n" "文件不存在"; exit 2; fi',
  'stat -c "%s %Y" -- "$target"',
  `head -c ${MAX_READ_BYTES + 1} -- "$target" | base64`,
].join("\n");

export function wslReadArgs(target: string) {
  return ["--exec", "sh", "-c", WSL_READ_SCRIPT, "wsl-read", target];
}

export function parseWslRead(stdout: string, target: string): FsFile {
  const newline = stdout.indexOf("\n");
  if (newline < 0) throw new Error("无法解析 WSL 文件内容");
  const [size, mtime] = stdout.slice(0, newline).trim().split(/\s+/);
  const buffer = Buffer.from(
    stdout.slice(newline + 1).replace(/\s+/g, ""),
    "base64",
  );
  const fileSize = Number(size) || 0;
  const truncated = fileSize > MAX_READ_BYTES || buffer.length > MAX_READ_BYTES;
  const chunk = buffer.subarray(0, MAX_READ_BYTES);
  if (looksBinary(chunk)) throw new Error("二进制文件，无法作为文本查看");
  return {
    path: target,
    content: chunk.toString("utf8"),
    truncated,
    size: fileSize,
    mtimeMs: (Number(mtime) || 0) * 1000,
  };
}

// 写入经 stdin 传给 cat，避免超长内容撑爆命令行参数；末尾 stat 回传新元数据。
// create 模式借助 set -C（noclobber）兜底并发下的覆盖。
export const WSL_WRITE_SCRIPT = [
  "target=$1",
  'if [ -d "$target" ]; then printf >&2 "%s\\n" "目标是目录"; exit 2; fi',
  'parent=$(dirname -- "$target")',
  'if [ ! -d "$parent" ]; then printf >&2 "%s\\n" "父目录不存在"; exit 3; fi',
  'if [ "$2" = create ]; then set -C; fi',
  'if ! cat > "$target"; then printf >&2 "%s\\n" "写入失败"; exit 4; fi',
  'stat -c "%s %Y" -- "$target"',
].join("\n");

export function wslWriteArgs(target: string, create: boolean) {
  return [
    "--exec",
    "sh",
    "-c",
    WSL_WRITE_SCRIPT,
    "wsl-write",
    target,
    create ? "create" : "",
  ];
}

export function wslStatArgs(target: string) {
  return ["--exec", "stat", "-c", "%Y %s", "--", target];
}

export function wslMkdirArgs(target: string) {
  return ["--exec", "mkdir", "-p", "--", target];
}

export function wslRemoveArgs(target: string) {
  return [
    "--exec",
    "sh",
    "-c",
    'if [ -d "$1" ]; then rmdir -- "$1"; else rm -f -- "$1"; fi',
    "wsl-rm",
    target,
  ];
}

async function defaultWslExec(command: string, args: string[]) {
  return execFileAsync(command, args, {
    timeout: 30_000,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 2_500_000,
  });
}

async function wslWriteViaSpawn(
  target: string,
  content: string,
  create: boolean,
): Promise<FsWriteResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("wsl.exe", wslWriteArgs(target, create), {
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (code !== 0) {
        reject(
          Object.assign(new Error(stderr.split(/\r?\n/)[0] || "写入失败"), {
            stderr,
          }),
        );
        return;
      }
      const [size, mtime] = Buffer.concat(stdoutChunks)
        .toString("utf8")
        .trim()
        .split(/\s+/);
      resolve({
        status: "saved",
        path: target,
        size: Number(size) || 0,
        mtimeMs: (Number(mtime) || 0) * 1000,
      });
    });
    // 校验失败时脚本提前退出，stdin 会收到 EPIPE，忽略即可。
    child.stdin.on("error", () => {});
    child.stdin.end(content, "utf8");
  });
}

export class TextFilesTool implements DeckTool {
  private exec: WslExec;

  constructor(
    private options: {
      platform?: NodeJS.Platform;
      useWsl?: boolean;
      processCwd?: string;
      exec?: WslExec;
      wslWrite?: (
        target: string,
        content: string,
        create: boolean,
      ) => Promise<FsWriteResult>;
    } = {},
  ) {
    this.exec = options.exec || defaultWslExec;
  }

  descriptor(): ToolDescriptor {
    return {
      id: "text-editor",
      name: "文本编辑器",
      description: "浏览宿主机文件系统，查看、编辑、查找并保存文本文件",
      icon: "file-pen",
      available: true,
      pagePath: "/text-editor",
      defaultCwd: this.options.processCwd || process.cwd(),
    };
  }

  async run(input: Record<string, unknown>) {
    const request = requestSchema.parse(input);
    try {
      switch (request.action) {
        case "list":
          return await this.list(request.path);
        case "read":
          return await this.read(request.path);
        case "write":
          return await this.write(request);
        case "mkdir":
          return await this.mkdir(request.path);
        case "remove":
          return await this.remove(request.path);
        case "rename":
          return await this.rename(request.path, request.name);
      }
    } catch (error) {
      throw new Error(friendlyError(error));
    }
  }

  private viaWsl(target?: string) {
    return (
      (this.options.platform || process.platform) === "win32" &&
      this.options.useWsl &&
      isWslFsPath(target)
    );
  }

  private async list(target?: string): Promise<FsListing> {
    const platform = this.options.platform || process.platform;
    if (this.viaWsl(target)) {
      const { stdout } = await this.exec("wsl.exe", wslListArgs(target!));
      return parseWslListing(stdout);
    }
    if (!target) {
      if (platform === "win32") {
        const roots = await listDirectories(undefined);
        return {
          ...roots,
          entries: roots.entries.map((entry) => ({
            ...entry,
            kind: "dir" as const,
          })),
        };
      }
      target = "/";
    }
    const resolved = path.resolve(target);
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error("不是目录");
    const dirents = await readdir(resolved, { withFileTypes: true });
    const entries: FsEntry[] = [];
    for (const dirent of dirents) {
      if (entries.length >= MAX_ENTRIES) break;
      if (dirent.name === "." || dirent.name === "..") continue;
      const child = path.join(resolved, dirent.name);
      try {
        if (dirent.isDirectory()) {
          entries.push({ name: dirent.name, path: child, kind: "dir" });
        } else {
          const meta = await stat(child);
          if (meta.isDirectory())
            entries.push({ name: dirent.name, path: child, kind: "dir" });
          else if (meta.isFile())
            entries.push({
              name: dirent.name,
              path: child,
              kind: "file",
              size: meta.size,
              mtimeMs: meta.mtimeMs,
            });
        }
      } catch {
        // 悬空符号链接、权限不足的条目直接跳过，不影响整个列表。
      }
    }
    const parent = path.dirname(resolved);
    return {
      path: resolved,
      parent: parent === resolved ? (platform === "win32" ? "" : null) : parent,
      home: os.homedir(),
      entries: sortEntries(entries),
    };
  }

  private async read(target: string): Promise<FsFile> {
    if (this.viaWsl(target)) {
      const { stdout } = await this.exec("wsl.exe", wslReadArgs(target));
      return parseWslRead(stdout, target);
    }
    const resolved = path.resolve(target);
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("不是文件");
    const handle = await open(resolved, "r");
    try {
      const buffer = Buffer.alloc(Math.min(info.size, MAX_READ_BYTES + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const chunk = buffer.subarray(0, Math.min(bytesRead, MAX_READ_BYTES));
      if (looksBinary(chunk)) throw new Error("二进制文件，无法作为文本查看");
      return {
        path: resolved,
        content: chunk.toString("utf8"),
        truncated: info.size > MAX_READ_BYTES,
        size: info.size,
        mtimeMs: info.mtimeMs,
      };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  private async write(request: {
    path: string;
    content: string;
    baseMtimeMs?: number;
    force?: boolean;
    create?: boolean;
  }): Promise<FsWriteResult> {
    if (Buffer.byteLength(request.content, "utf8") > MAX_WRITE_BYTES)
      throw new Error("内容超过 8MB，无法保存");
    const exclusive = Boolean(request.create && !request.force);
    if (this.viaWsl(request.path)) {
      const conflict = await this.wslConflict(
        request.path,
        request.baseMtimeMs,
        exclusive,
        request.force,
      );
      if (conflict) return conflict;
      return (this.options.wslWrite || wslWriteViaSpawn)(
        request.path,
        request.content,
        exclusive,
      );
    }
    const resolved = path.resolve(request.path);
    const info = await stat(resolved).catch(() => undefined);
    if (info?.isDirectory()) throw new Error("目标是目录");
    if (
      info &&
      !request.force &&
      (exclusive ||
        (request.baseMtimeMs !== undefined &&
          info.mtimeMs !== request.baseMtimeMs))
    )
      return { status: "conflict", path: resolved, mtimeMs: info.mtimeMs };
    const parent = await stat(path.dirname(resolved)).catch(() => undefined);
    if (!parent?.isDirectory()) throw new Error("父目录不存在");
    await writeFile(resolved, request.content, {
      encoding: "utf8",
      flag: exclusive ? "wx" : "w",
    });
    const meta = await stat(resolved);
    return {
      status: "saved",
      path: resolved,
      size: meta.size,
      mtimeMs: meta.mtimeMs,
    };
  }

  private async wslConflict(
    target: string,
    baseMtimeMs: number | undefined,
    exclusive: boolean,
    force?: boolean,
  ): Promise<FsWriteResult | undefined> {
    if (force) return undefined;
    let mtimeMs: number;
    try {
      const { stdout } = await this.exec("wsl.exe", wslStatArgs(target));
      mtimeMs = (Number(stdout.trim().split(/\s+/)[0]) || 0) * 1000;
    } catch {
      return undefined;
    }
    if (exclusive || (baseMtimeMs !== undefined && mtimeMs !== baseMtimeMs))
      return { status: "conflict", path: target, mtimeMs };
    return undefined;
  }

  private async mkdir(target: string) {
    if (this.viaWsl(target)) {
      await this.exec("wsl.exe", wslMkdirArgs(target));
      return { path: target };
    }
    const resolved = path.resolve(target);
    await mkdir(resolved, { recursive: true });
    return { path: resolved };
  }

  private async rename(target: string, name: string) {
    const sep = target.includes("\\") ? "\\" : "/";
    const parent = target.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");
    const next = parent ? `${parent}${sep}${name}` : name;
    if (next === target) return { path: target };
    if (this.viaWsl(target)) {
      await this.exec("wsl.exe", ["--exec", "mv", "--", target, next]);
      return { path: next };
    }
    const resolved = path.resolve(target);
    const destination = path.join(path.dirname(resolved), name);
    await rename(resolved, destination);
    return { path: destination };
  }

  private async remove(target: string) {
    if (this.viaWsl(target)) {
      await this.exec("wsl.exe", wslRemoveArgs(target));
      return { path: target };
    }
    const resolved = path.resolve(target);
    const info = await stat(resolved);
    // 目录只走 rmdir（非递归）：误删整棵目录树的代价远大于多删几次的麻烦。
    if (info.isDirectory()) await rmdir(resolved);
    else await unlink(resolved);
    return { path: resolved };
  }
}
