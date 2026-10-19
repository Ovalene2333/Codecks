import { execFile } from "node:child_process";
import type { GitContext } from "./types.js";

/**
 * 会话所在工作区的 Git 上下文。只读、只取展示需要的最小信息：
 * 分支名、是否 detached、仓库根、以及该目录是不是一个独立 worktree。
 *
 * Deck 不拥有分支，也不替 Agent 切分支；这里只让「会话挂在哪条分支上」
 * 可见，避免多个 Agent 在同一 checkout 上互相踩。
 */
export interface GitProbeOptions {
  /** 缓存时长：多个会话共享同一 cwd，同一轮快照只探测一次。 */
  ttlMs?: number;
  /** 工作目录不在本机（例如 WSL/远端）时不探测，返回 unavailable。 */
  enabled?: boolean;
}

const GIT_TIMEOUT_MS = 4_000;

type CacheEntry = { at: number; value: GitContext };

const DEFAULT_TTL = 3_000;

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd,
          encoding: "utf8",
          maxBuffer: 1024 * 1024,
          timeout: GIT_TIMEOUT_MS,
          windowsHide: true,
          // 锁定输出语言：错误分类按英文文案匹配，本地化 git 会让分类失效。
          env: { ...process.env, LC_ALL: "C", LANG: "C" },
        },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

const errorText = (error: any) =>
  String(error?.stderr || error?.stdout || error?.message || "").trim();

const notRepository = (error: any) =>
  /not a git repository/i.test(errorText(error));

/**
 * 解析 `git worktree list --porcelain`，找出 cwd 对应的 worktree 条目。
 * 主 checkout 与 linked worktree 的区别是：linked worktree 的 `.git` 是
 * 文件而不是目录，porcelain 输出里不会标 bare，但主 checkout 的路径等于
 * 仓库根，而 linked worktree 的路径不等于。
 */
function parseWorktreeList(output: string) {
  const entries: { path: string; branch?: string; detached: boolean; bare: boolean }[] = [];
  let current: { path: string; branch?: string; detached: boolean; bare: boolean } | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), detached: false, bare: false };
      continue;
    }
    if (!current) continue;
    if (line === "detached") current.detached = true;
    else if (line === "bare") current.bare = true;
    else if (line.startsWith("branch refs/heads/"))
      current.branch = line.slice("branch refs/heads/".length);
  }
  if (current) entries.push(current);
  return entries;
}

export class GitContextProbe {
  private cache = new Map<string, CacheEntry>();
  private pending = new Map<string, Promise<GitContext>>();

  constructor(private readonly options: GitProbeOptions = {}) {}

  private get ttl() {
    return this.options.ttlMs ?? DEFAULT_TTL;
  }

  /** 探测 cwd 的分支；失败（非仓库、git 缺失、超时）都归一成 available:false。 */
  probe(cwd: string | undefined): Promise<GitContext> {
    if (this.options.enabled === false)
      return Promise.resolve({ available: false, reason: "disabled" });
    if (!cwd || !cwd.trim())
      return Promise.resolve({ available: false, reason: "no-cwd" });
    const key = cwd.trim();
    const hit = this.cache.get(key);
    const now = Date.now();
    if (hit && now - hit.at < this.ttl) return Promise.resolve(hit.value);
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const task = this.read(key)
      .then((value) => {
        this.cache.set(key, { at: Date.now(), value });
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  /** 只清缓存，不动任何仓库状态。 */
  invalidate() {
    this.cache.clear();
  }

  private async read(cwd: string): Promise<GitContext> {
    try {
      // 三次调用并发：分支、worktree 清单、当前目录是否为 linked worktree。
      const [branchOut, listOut, gitPath] = await Promise.all([
        runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
        runGit(cwd, ["worktree", "list", "--porcelain"]),
        runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]),
      ]);
      const branch = branchOut.trim();
      const entries = parseWorktreeList(listOut);
      const own = entries.find((entry) => samePath(entry.path, cwd));
      const gitDir = gitPath.trim();
      return {
        available: true,
        branch: branch && branch !== "HEAD" ? branch : undefined,
        detached: !branch || branch === "HEAD",
        root: samePath(own?.path || "", cwd) ? own!.path : undefined,
        worktree: own?.path,
        // linked worktree 的 .git 是文件，指向主仓库的 .git/worktrees/<name>。
        linked: Boolean(gitDir && /[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/.test(gitDir)),
      };
    } catch (error) {
      if (notRepository(error))
        return { available: false, reason: "not-repository" };
      return {
        available: false,
        reason: "error",
        error: errorText(error).slice(0, 300) || "git 命令失败",
      };
    }
  }
}

function normalize(value: string) {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function samePath(left: string, right: string) {
  return normalize(left) === normalize(right);
}
