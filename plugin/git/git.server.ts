import { execFile } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import { windowsPathToWsl } from "../../server/runtime-platform.js";
import type { DeckTool, ToolDescriptor } from "../server-registry.js";
import type { GitChange, GitSnapshot } from "./git.types.js";

const cwdSchema = z.string().trim().min(1).max(4_096);
const pathsSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !value.includes("\0")),
  )
  .min(1)
  .max(1_000);
const branchSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine(
    (value) =>
      !value.includes("..") &&
      !value.includes("//") &&
      !value.endsWith(".") &&
      !value.endsWith("/"),
    "分支名称无效",
  );

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status"), cwd: cwdSchema }),
  z.object({ action: z.literal("init"), cwd: cwdSchema }),
  z.object({ action: z.literal("stage"), cwd: cwdSchema, paths: pathsSchema }),
  z.object({
    action: z.literal("unstage"),
    cwd: cwdSchema,
    paths: pathsSchema,
  }),
  z.object({
    action: z.literal("commit"),
    cwd: cwdSchema,
    message: z.string().trim().min(1).max(4_000),
  }),
  z.object({ action: z.literal("fetch"), cwd: cwdSchema }),
  z.object({ action: z.literal("pull"), cwd: cwdSchema }),
  z.object({ action: z.literal("push"), cwd: cwdSchema }),
  z.object({
    action: z.literal("switch"),
    cwd: cwdSchema,
    branch: branchSchema,
  }),
  z.object({
    action: z.literal("createBranch"),
    cwd: cwdSchema,
    branch: branchSchema,
  }),
]);

export interface GitCommandSpec {
  file: string;
  args: string[];
  cwd: string;
}

export function gitCommandSpec(
  cwd: string,
  args: string[],
  options: {
    platform?: NodeJS.Platform;
    useWsl?: boolean;
    processCwd?: string;
  } = {},
): GitCommandSpec {
  const platform = options.platform || process.platform;
  if (platform === "win32" && options.useWsl)
    return {
      file: "wsl.exe",
      args: ["--cd", windowsPathToWsl(cwd), "git", ...args],
      cwd: options.processCwd || process.cwd(),
    };
  return { file: "git", args, cwd };
}

export function parseGitStatus(output: string): GitChange[] {
  const entries = output.split("\0");
  const changes: GitChange[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || entry.length < 4) continue;
    const indexStatus = entry[0];
    const worktreeStatus = entry[1];
    const renamed = indexStatus === "R" || indexStatus === "C";
    const change: GitChange = {
      path: entry.slice(3),
      indexStatus,
      worktreeStatus,
      staged: indexStatus !== " " && indexStatus !== "?",
      unstaged: worktreeStatus !== " " || indexStatus === "?",
      untracked: indexStatus === "?" && worktreeStatus === "?",
    };
    if (renamed) change.originalPath = entries[++index] || undefined;
    changes.push(change);
  }
  return changes;
}

type RunGit = (cwd: string, args: string[]) => Promise<string>;

function commandError(error: any) {
  return String(
    error?.stderr || error?.stdout || error?.message || "Git 命令失败",
  ).trim();
}

export class GitTool implements DeckTool {
  private runGit: RunGit;

  constructor(
    private options: {
      platform?: NodeJS.Platform;
      useWsl?: boolean;
      processCwd?: string;
      runGit?: RunGit;
    } = {},
  ) {
    this.runGit = options.runGit || this.exec.bind(this);
  }

  descriptor(): ToolDescriptor {
    return {
      id: "git",
      name: "Git 管理",
      description: "查看改动、管理暂存区与分支，并同步远端仓库",
      icon: "git-branch",
      available: true,
      pagePath: "/git",
      defaultCwd: this.options.processCwd || process.cwd(),
    };
  }

  private async exec(cwd: string, args: string[]) {
    const platform = this.options.platform || process.platform;
    const absolute =
      platform === "win32"
        ? path.win32.isAbsolute(cwd) ||
          Boolean(this.options.useWsl && cwd.startsWith("/"))
        : path.posix.isAbsolute(cwd);
    if (!absolute) throw new Error("工作目录必须是绝对路径");
    const spec = gitCommandSpec(cwd, args, this.options);
    return new Promise<string>((resolve, reject) => {
      execFile(
        spec.file,
        spec.args,
        {
          cwd: spec.cwd,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          timeout: 120_000,
          windowsHide: true,
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

  private async snapshot(cwd: string, message?: string): Promise<GitSnapshot> {
    let root: string;
    try {
      root = (await this.runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
    } catch (error) {
      if (!commandError(error).toLowerCase().includes("not a git repository"))
        throw new Error(commandError(error));
      return {
        repository: false,
        cwd,
        branches: [],
        remotes: [],
        ahead: 0,
        behind: 0,
        changes: [],
        message,
      };
    }

    const settled = await Promise.allSettled([
      this.runGit(root, ["branch", "--show-current"]),
      this.runGit(root, ["branch", "--format=%(refname:short)"]),
      this.runGit(root, ["remote"]),
      this.runGit(root, [
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...@{upstream}",
      ]),
      this.runGit(root, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
      this.runGit(root, ["rev-parse", "--short", "HEAD"]),
    ]);
    const rawValue = (index: number) =>
      settled[index].status === "fulfilled" ? settled[index].value : "";
    const value = (index: number) => rawValue(index).trim();
    const [aheadText = "0", behindText = "0"] = value(3).split(/\s+/);
    const currentBranch = value(0);
    return {
      repository: true,
      cwd,
      root,
      branch: currentBranch || (value(5) ? `detached@${value(5)}` : "未提交"),
      branches: value(1).split(/\r?\n/).filter(Boolean),
      remotes: value(2).split(/\r?\n/).filter(Boolean),
      behind: Number(behindText) || 0,
      ahead: Number(aheadText) || 0,
      changes: parseGitStatus(rawValue(4)),
      message,
    };
  }

  async run(input: Record<string, unknown>) {
    const request = requestSchema.parse(input);
    if (request.action === "status") return this.snapshot(request.cwd);
    try {
      let output = "";
      if (request.action === "init")
        output = await this.runGit(request.cwd, ["init"]);
      if (request.action === "stage")
        output = await this.runGit(request.cwd, [
          "add",
          "--",
          ...request.paths,
        ]);
      if (request.action === "unstage")
        try {
          output = await this.runGit(request.cwd, [
            "restore",
            "--staged",
            "--",
            ...request.paths,
          ]);
        } catch (error) {
          if (!commandError(error).includes("HEAD")) throw error;
          output = await this.runGit(request.cwd, [
            "rm",
            "--cached",
            "-r",
            "--",
            ...request.paths,
          ]);
        }
      if (request.action === "commit")
        output = await this.runGit(request.cwd, [
          "commit",
          "-m",
          request.message,
        ]);
      if (request.action === "fetch")
        output = await this.runGit(request.cwd, ["fetch", "--prune"]);
      if (request.action === "pull")
        output = await this.runGit(request.cwd, ["pull", "--ff-only"]);
      if (request.action === "push")
        output = await this.runGit(request.cwd, ["push"]);
      if (request.action === "switch")
        output = await this.runGit(request.cwd, [
          "switch",
          "--",
          request.branch,
        ]);
      if (request.action === "createBranch")
        output = await this.runGit(request.cwd, [
          "switch",
          "-c",
          request.branch,
        ]);
      const fallback: Record<typeof request.action, string> = {
        init: "仓库已初始化",
        stage: "已暂存所选文件",
        unstage: "已取消暂存所选文件",
        commit: "提交已创建",
        fetch: "远端信息已更新",
        pull: "已拉取远端更新",
        push: "已推送到远端",
        switch: `已切换到 ${"branch" in request ? request.branch : "分支"}`,
        createBranch: `已创建并切换到 ${"branch" in request ? request.branch : "新分支"}`,
      };
      return this.snapshot(
        request.cwd,
        output.trim() || fallback[request.action],
      );
    } catch (error) {
      throw new Error(commandError(error));
    }
  }
}
