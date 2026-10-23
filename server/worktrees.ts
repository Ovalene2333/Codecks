import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Deck 托管的 Git worktree。
 *
 * 只做「给会话一个独立 checkout」这一件事：在 `<dataDir>/worktrees/` 下
 * 创建 linked worktree，让会话的 cwd 指向它，避免多个 Agent 在同一
 * checkout 里互相踩。不接管用户已有的 worktree，也不替用户切主仓库分支。
 *
 * 命名与 Codex app 对齐：默认 detached HEAD，不占用分支名；需要保留成果
 * 时由用户自己 `git switch -c`。台账记录 Deck 创建了哪些目录，删除会话
 * 时只清理台账里的，并且必须确认没有未提交内容。
 */
export interface WorktreeRecord {
  /** 会话 id（codex/opencode 的 thread id），一对一。 */
  threadId: string;
  /** worktree 绝对路径。 */
  path: string;
  /** 主 checkout 路径。 */
  root: string;
  /** 创建时的基准提交。 */
  commit: string;
  createdAt: number;
}

interface Store {
  version: 1;
  items: WorktreeRecord[];
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class WorktreeError extends Error {}

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new WorktreeError(
              String(stderr || stdout || error.message || "git 命令失败").trim(),
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** 从 `git worktree list --porcelain` 里取出路径与分支。 */
export function parseWorktreePorcelain(output: string) {
  const entries: { path: string; branch?: string; detached: boolean }[] = [];
  let current: { path: string; branch?: string; detached: boolean } | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice(9), detached: false };
      continue;
    }
    if (!current) continue;
    if (line === "detached") current.detached = true;
    else if (line.startsWith("branch refs/heads/"))
      current.branch = line.slice("branch refs/heads/".length);
  }
  if (current) entries.push(current);
  return entries;
}

const normalize = (value: string) =>
  value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

export class WorktreeStore {
  private data: Store = { version: 1, items: [] };
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly options: { enabled?: boolean } = {},
  ) {}

  get enabled() {
    return this.options.enabled !== false;
  }

  private get file() {
    return path.join(this.dataDir, "worktrees.json");
  }

  /** Deck 自己创建的 worktree 根目录；不在这里的目录一律不碰。 */
  get baseDir() {
    return path.join(this.dataDir, "worktrees");
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.items)) return;
      this.data.items = parsed.items.filter(
        (item: any) =>
          item &&
          typeof item.threadId === "string" &&
          typeof item.path === "string" &&
          typeof item.root === "string" &&
          typeof item.commit === "string" &&
          Number.isFinite(item.createdAt),
      );
    } catch {
      // 首次运行或文件损坏：当作没有台账，不碰磁盘上已有目录。
    }
  }

  get(threadId: string) {
    return this.data.items.find((item) => item.threadId === threadId);
  }

  list() {
    return [...this.data.items];
  }

  private async save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    const write = this.writes.catch(() => undefined).then(async () => {
      await mkdir(this.dataDir, { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, snapshot, { encoding: "utf8", mode: 0o600 });
      const { rename } = await import("node:fs/promises");
      await rename(temp, this.file);
    });
    this.writes = write;
    await write;
  }

  /** 仓库根与当前提交；非 Git 仓库直接拒绝。 */
  private async inspect(root: string) {
    let toplevel: string;
    try {
      toplevel = (await run(root, ["rev-parse", "--show-toplevel"])).trim();
    } catch {
      throw new WorktreeError("所选目录不是 Git 仓库，无法创建 worktree");
    }
    const commit = (await run(toplevel, ["rev-parse", "HEAD"])).trim();
    return { root: toplevel, commit };
  }

  /**
   * 为会话创建一个 detached worktree。
   * base: "head" 从当前提交开始；也接受一个存在的分支名，从该分支 tip 开始。
   */
  async create(
    threadId: string,
    root: string,
    options: { name?: string; base?: string } = {},
  ) {
    if (!this.enabled) throw new WorktreeError("当前运行时不支持 worktree（WSL 会话请在主运行时创建）");
    const info = await this.inspect(root);
    const name = (options.name || threadId).replace(/[^A-Za-z0-9._-]/g, "-");
    if (!NAME_RE.test(name)) throw new WorktreeError("worktree 名称只能包含字母、数字、点、下划线和连字符");
    const target = path.join(this.baseDir, name);
    if (this.data.items.some((item) => normalize(item.path) === normalize(target)))
      throw new WorktreeError(`worktree ${name} 已被其他会话占用`);
    await mkdir(this.baseDir, { recursive: true });
    const base = options.base?.trim();
    let commit = info.commit;
    const args = ["worktree", "add", "--detach", target];
    if (base && base !== "head") {
      // 只接受已存在的提交/分支，避免把任意 rev 当分支名注入参数。
      const exists = await run(info.root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`])
        .then((value) => value.trim())
        .catch(() => "");
      if (!exists) throw new WorktreeError(`找不到分支或提交 ${base}`);
      commit = exists;
      args.push(exists);
    } else {
      args.push(info.commit);
    }
    await run(info.root, args);
    const record: WorktreeRecord = {
      threadId,
      path: target,
      root: info.root,
      commit,
      createdAt: Date.now(),
    };
    this.data.items.push(record);
    await this.save();
    return record;
  }

  /**
   * 创建完成、拿到真实会话 id 后改挂台账。
   * 目录已经落盘，这里只改记录，失败不会影响会话。
   */
  async rebind(fromThreadId: string, toThreadId: string) {
    const record = this.data.items.find((item) => item.threadId === fromThreadId);
    if (!record) return false;
    if (this.data.items.some((item) => item.threadId === toThreadId)) return false;
    record.threadId = toThreadId;
    await this.save();
    return true;
  }

  /** 该 worktree 是否还有未提交内容（含未跟踪文件）。 */
  async dirty(record: Pick<WorktreeRecord, "path">) {
    try {
      const status = await run(record.path, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      return status.trim().length > 0;
    } catch {
      // 目录已被外部删除时不算脏，允许清理台账。
      return false;
    }
  }

  /**
   * 删除 Deck 创建的 worktree。force=false 时有未提交内容就拒绝，
   * 由用户决定是否强删。只处理台账里、且位于 baseDir 下的目录。
   */
  async remove(threadId: string, options: { force?: boolean } = {}) {
    const record = this.get(threadId);
    if (!record) return { removed: false, reason: "not-managed" as const };
    if (!normalize(record.path).startsWith(normalize(this.baseDir) + "/"))
      return { removed: false, reason: "outside-root" as const };
    if (!options.force && (await this.dirty(record))) {
      return { removed: false, reason: "dirty" as const };
    }
    try {
      await run(record.root, ["worktree", "remove", ...(options.force ? ["--force"] : []), record.path]);
    } catch (error) {
      // 目录已经不存在时，清理元数据即可。
      const message = String((error as Error).message || "");
      if (!/not a working tree|No such file/i.test(message)) throw error;
      await run(record.root, ["worktree", "prune"]).catch(() => undefined);
      await rm(record.path, { recursive: true, force: true }).catch(() => undefined);
    }
    this.data.items = this.data.items.filter((item) => item.threadId !== threadId);
    await this.save();
    return { removed: true as const };
  }
}
