import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import {
  access,
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  query as createQuery,
  type CanUseTool,
  type PermissionResult,
  type PermissionMode,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SpawnOptions,
  type SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { CcSwitchSource, type ClaudeProfile } from "../cc-switch.js";
import {
  exposeEnvironmentToWsl,
  windowsPathToWsl,
  WSL_CLAUDE_SHELL_COMMAND,
  wslPathToWindows,
} from "../runtime-platform.js";
import type {
  ApprovalKind,
  ClaudePermissionMode,
  ModelInfo,
  ThreadSummary,
  TurnImage,
} from "../types.js";
import {
  readClaudeHistory,
  type ClaudeHistoryThread,
} from "./claude-history.js";
import type { AgentCapabilities, AgentDescriptor, AgentId } from "./types.js";

const CLAUDE_CAPABILITIES: AgentCapabilities = {
  approvals: true,
  archive: false,
  delete: true,
  fork: false,
  images: true,
  interrupt: true,
  mcp: false,
  models: true,
  review: false,
  sessionSettings: true,
  shell: false,
  skills: false,
};

const CLAUDE_MODELS: ModelInfo[] = [
  {
    id: "default",
    model: "default",
    displayName: "Default",
    isDefault: true,
  },
  { id: "sonnet", model: "sonnet", displayName: "Sonnet" },
  { id: "opus", model: "opus", displayName: "Opus" },
  { id: "haiku", model: "haiku", displayName: "Haiku" },
];

type QueryFactory = typeof createQuery;
const execFileAsync = promisify(execFile);

export function findClaudeExecutable(
  explicit?: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = existsSync,
) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const names = explicit ? [explicit] : ["claude"];
  for (const name of names) {
    if (pathApi.isAbsolute(name) || /[\\/]/.test(name)) {
      const candidate = exists(name) || explicit ? name : undefined;
      return candidate;
    }
    const pathValue = env.Path || env.PATH || "";
    for (const directory of pathValue.split(platform === "win32" ? ";" : ":")) {
      if (!directory) continue;
      const candidates =
        platform === "win32"
          ? [pathApi.join(directory, `${name}.exe`)]
          : [pathApi.join(directory, name)];
      const found = candidates.find(
        (candidate) =>
          exists(candidate) &&
          (explicit != null ||
            platform === "win32" ||
            !/^\/mnt\/[a-z]\//i.test(candidate)),
      );
      if (found) return found;
    }
  }
  return explicit;
}

export function defaultClaudeHome(
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
) {
  return platform === "win32"
    ? path.win32.join(home, ".claude")
    : path.posix.join(home, ".claude");
}

export function claudeRuntimePreference(
  platform: NodeJS.Platform,
  useWsl: boolean,
  wslAvailable: boolean,
  cwd: string,
): "native" | "wsl" {
  if (platform !== "win32" || !useWsl) return "native";
  if (wslAvailable) return "wsl";
  if (/^\/mnt\/[a-z](?:\/|$)/i.test(windowsPathToWsl(cwd))) return "native";
  throw new Error(
    `WSL 工作目录 ${cwd} 需要在 WSL 中安装 Claude Code，或设置 CLAUDE_WSL_BIN`,
  );
}

interface ClaudeAdapterOptions {
  claudeHome?: string;
  claudeBin?: string;
  ccSwitchPath?: string;
  queryFactory?: QueryFactory;
  historyFiles?: () => Promise<string[]>;
  historyIndexFile?: string;
  historyReader?: typeof readClaudeHistory;
  initialThreads?: ThreadSummary[];
  initialProfiles?: ClaudeProfile[];
  useWsl?: boolean;
  claudeWslBin?: string;
  wslProbe?: (bin: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
}

interface ClaudeHistoryIndexEntry {
  size: number;
  mtimeMs: number;
  summary: ThreadSummary;
}

interface PendingApproval {
  id: string;
  threadId: string;
  toolName: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  kind: ApprovalKind;
  resolve: (result: PermissionResult) => void;
}

interface ActiveQuery {
  query: Query;
  turnId: string;
}

function approvalKind(toolName: string): ApprovalKind {
  if (["Edit", "Write", "NotebookEdit"].includes(toolName)) return "file";
  if (toolName === "AskUserQuestion") return "question";
  return "command";
}

function publicProfile(profile: ClaudeProfile) {
  return {
    id: profile.id,
    agentId: "claude" as const,
    name: profile.name,
    color: profile.color,
    current: profile.current,
    enabled: true,
  };
}

function historyHome(file: string) {
  const projects = path.dirname(path.dirname(file));
  return path.basename(projects) === "projects"
    ? path.dirname(projects)
    : undefined;
}

function imagePart(image: TurnImage) {
  const match = image.url.match(
    /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s,
  );
  if (!match)
    return { type: "text", text: `[图片：${image.name || image.url}]` };
  return {
    type: "image",
    source: { type: "base64", media_type: match[1], data: match[2] },
  };
}

function promptStream(
  sessionId: string,
  text: string,
  images: TurnImage[] | undefined,
): AsyncIterable<SDKUserMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      const content: any[] = [];
      if (text) content.push({ type: "text", text });
      for (const image of images || []) content.push(imagePart(image));
      yield {
        type: "user",
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { role: "user", content: content.length ? content : "" },
      } as SDKUserMessage;
    },
  };
}

export function windowsClaudeLaunchSpec(
  options: SpawnOptions,
  platform: NodeJS.Platform = process.platform,
) {
  if (platform !== "win32" || !/\.(?:cmd|bat)$/i.test(options.command))
    return { command: options.command, args: options.args };
  return {
    command: options.env.ComSpec || options.env.COMSPEC || "cmd.exe",
    args: ["/d", "/s", "/c", options.command, ...options.args],
  };
}

export function wslClaudeLaunchSpec(options: SpawnOptions, claudeBin: string) {
  const shell =
    options.env.CLAUDE_WSL_SHELL || options.env.CODEX_WSL_SHELL || "bash";
  if ([claudeBin, shell].some((value) => /[\r\n]/.test(value)))
    throw new Error("Claude WSL 启动命令不能包含换行符");
  return {
    command: options.env.WSL_EXE || "wsl.exe",
    args: [
      "--exec",
      shell,
      "-lc",
      WSL_CLAUDE_SHELL_COMMAND,
      "claude-deck",
      claudeBin,
      options.cwd || ".",
      claudeBin,
      ...options.args,
    ],
  };
}

function spawnClaudeCodeProcess(
  options: SpawnOptions,
  stderr: (data: string) => void,
): SpawnedProcess {
  const launch = windowsClaudeLaunchSpec(options);
  const child = spawn(launch.command, launch.args, {
    cwd: options.cwd,
    env: options.env,
    signal: options.signal,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (data) => stderr(String(data)));
  return child;
}

function spawnWslClaudeCodeProcess(
  options: SpawnOptions,
  claudeBin: string,
  stderr: (data: string) => void,
): SpawnedProcess {
  const launch = wslClaudeLaunchSpec(options, claudeBin);
  const child = spawn(launch.command, launch.args, {
    env: options.env,
    signal: options.signal,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (data) => stderr(String(data)));
  return child;
}

async function hasWslClaude(bin: string, env: NodeJS.ProcessEnv) {
  const shell = env.CLAUDE_WSL_SHELL || env.CODEX_WSL_SHELL || "bash";
  if ([bin, shell].some((value) => /[\r\n]/.test(value))) return false;
  try {
    await execFileAsync(
      env.WSL_EXE || "wsl.exe",
      [
        "--exec",
        shell,
        "-lc",
        'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; resolved=$(command -v "$1" 2>/dev/null || true); case "$resolved" in ""|/mnt/*) exit 1;; esac',
        "claude-deck-probe",
        bin,
      ],
      { env, windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

async function existing(pathname: string) {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

export class ClaudeAdapter extends EventEmitter {
  readonly id: AgentId = "claude";
  private threads = new Map<string, ThreadSummary>();
  private history = new Map<string, string>();
  private historyHomes = new Map<string, string>();
  private active = new Map<string, ActiveQuery>();
  private approvals = new Map<string, PendingApproval>();
  private profiles: ClaudeProfile[] = [];
  private online = false;
  private starting = false;
  private startingTask?: Promise<void>;
  private error?: string;
  private queryFactory: QueryFactory;
  private historyStatus: AgentDescriptor["historyStatus"];
  private historyError?: string;
  private historyIndex = new Map<string, ClaudeHistoryIndexEntry>();
  private historyIndexLoaded = false;
  private wslClaudeAvailable?: boolean;

  constructor(private options: ClaudeAdapterOptions = {}) {
    super();
    this.options.claudeBin = findClaudeExecutable(options.claudeBin);
    this.queryFactory = options.queryFactory || createQuery;
    this.profiles = [...(options.initialProfiles || [])];
    for (const thread of options.initialThreads || []) {
      if (thread.agentId !== "claude") continue;
      this.threads.set(thread.id, { ...thread, agentId: "claude" });
    }
    this.historyStatus = this.threads.size ? "cached" : "loading";
  }

  descriptor(): AgentDescriptor {
    const available = this.hasSupportedProfile();
    return {
      id: this.id,
      name: "Claude Code",
      available,
      online: this.online && available,
      starting: this.starting,
      error: this.error,
      historyStatus: this.historyStatus,
      historyError: this.historyError,
      capabilities: CLAUDE_CAPABILITIES,
    };
  }

  snapshot() {
    return {
      threads: this.listThreads(),
      approvals: [...this.approvals.values()].map((approval) =>
        this.approvalView(approval),
      ),
    };
  }

  publicProfiles() {
    return this.profiles.map((profile) => ({
      ...publicProfile(profile),
      official: profile.official,
      enabled: profile.supported,
      online: this.online && profile.supported,
    }));
  }

  listModels(providerId?: string) {
    this.resolveProfile(providerId);
    return CLAUDE_MODELS.map((model) => ({ ...model }));
  }

  startAll() {
    if (this.startingTask) return this.startingTask;
    const task = this.startOnce();
    this.startingTask = task;
    return task.finally(() => {
      if (this.startingTask === task) this.startingTask = undefined;
    });
  }

  private async startOnce() {
    this.starting = true;
    this.broadcast("agent.status", this.descriptor());
    try {
      await this.refreshAll();
    } catch (error: any) {
      this.online = false;
      this.error = this.redact(error?.message || String(error));
      throw error;
    } finally {
      this.starting = false;
      this.broadcast("agent.status", this.descriptor());
    }
  }

  async refreshAll() {
    this.historyStatus = "loading";
    this.historyError = undefined;
    this.broadcast("snapshot", this.snapshot());
    try {
      await this.loadProfiles();
      await this.loadHistoryIndex();
      const files = this.options.historyFiles
        ? await this.options.historyFiles()
        : await this.discoverHistoryFiles();
      const seen = new Set<string>();
      const histories = await Promise.allSettled(
        files.map((file) => this.readHistorySummary(file)),
      );
      histories.forEach((result, index) => {
        if (result.status !== "fulfilled" || !result.value) {
          const cachedId = this.historyIndex.get(files[index])?.summary.id;
          if (cachedId) seen.add(cachedId);
          return;
        }
        const parsed = result.value;
        seen.add(parsed.summary.id);
        this.history.set(parsed.summary.id, files[index]);
        const home = historyHome(files[index]);
        if (home) this.historyHomes.set(parsed.summary.id, home);
        const existing = this.threads.get(parsed.summary.id);
        const active = this.active.has(parsed.summary.id);
        this.threads.set(parsed.summary.id, {
          ...parsed.summary,
          providerId: existing?.providerId || parsed.summary.providerId,
          permissionMode: existing?.permissionMode || "default",
          status: active
            ? existing?.status || "running"
            : parsed.summary.status,
          activeTurnId: active ? existing?.activeTurnId : undefined,
          controlMode: active ? "managed" : "history",
        });
      });
      for (const [id] of this.threads)
        if (!seen.has(id) && !this.active.has(id)) {
          this.history.delete(id);
          this.historyHomes.delete(id);
          this.threads.delete(id);
        }
      const availableFiles = new Set(files);
      for (const file of this.historyIndex.keys())
        if (!availableFiles.has(file)) this.historyIndex.delete(file);
      await this.saveHistoryIndex();
      this.historyStatus = "ready";
      this.historyError = undefined;
      this.syncAvailability();
      this.broadcast("agent.status", this.descriptor());
      this.broadcast("snapshot", this.snapshot());
    } catch (error: any) {
      this.historyStatus = "error";
      this.historyError = this.redact(error?.message || String(error));
      this.broadcast("snapshot", this.snapshot());
      throw error;
    }
  }

  busyThreads() {
    return this.listThreads().filter(
      (thread) => thread.status === "running" || thread.status === "waiting",
    );
  }

  restart() {
    for (const current of this.active.values()) {
      void current.query.interrupt().catch(() => undefined);
      void current.query.return(undefined).catch(() => undefined);
    }
    for (const approval of this.approvals.values())
      approval.resolve({
        behavior: "deny",
        message: "Claude Code adapter 已停止",
        interrupt: true,
      });
    this.active.clear();
    this.approvals.clear();
    for (const thread of this.threads.values())
      if (thread.status === "running" || thread.status === "waiting") {
        thread.status = "offline";
        thread.activeTurnId = undefined;
      }
    this.online = false;
  }

  listThreads() {
    return [...this.threads.values()].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
  }

  async createThread(
    providerId: string,
    input: {
      cwd: string;
      name?: string;
      model?: string;
      approvalPolicy?: string;
      sandbox?: string;
      permissionMode?: ClaudePermissionMode;
    },
  ) {
    const profile = this.resolveProfile(providerId);
    const id = randomUUID();
    const thread: ThreadSummary = {
      agentId: this.id,
      id,
      providerId: profile.id,
      name: input.name || "新 Claude 会话",
      preview: "新 Claude 会话",
      cwd: input.cwd,
      model: input.model || "default",
      status: "idle",
      updatedAt: Date.now(),
      sessionId: id,
      sandbox: input.sandbox as ThreadSummary["sandbox"],
      approvalPolicy: input.approvalPolicy as ThreadSummary["approvalPolicy"],
      permissionMode: input.permissionMode || "default",
      controlMode: "managed",
    };
    this.threads.set(id, thread);
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async readThread(_providerId: string, threadId: string) {
    const summary = this.threads.get(threadId);
    if (!summary) throw new Error("Claude Code 会话不存在");
    const file = this.history.get(threadId);
    let parsed: ClaudeHistoryThread | undefined;
    if (file) parsed = await readClaudeHistory(file);
    return {
      ...(parsed?.thread || {
        id: threadId,
        cwd: summary.cwd,
        model: summary.model,
        turns: [],
      }),
      agentId: this.id,
      providerId: summary.providerId,
    };
  }

  async renameThread(_providerId: string, threadId: string, name: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Claude Code 会话不存在");
    const nextName = name.trim();
    if (!nextName) throw new Error("会话名称不能为空");
    const file = this.history.get(threadId);
    if (file) {
      const handle = await open(file, "r");
      try {
        const info = await handle.stat();
        const tail = Buffer.alloc(1);
        if (info.size > 0) await handle.read(tail, 0, 1, info.size - 1);
        const prefix = info.size > 0 && tail[0] !== 10 ? "\n" : "";
        await appendFile(
          file,
          `${prefix}${JSON.stringify({
            type: "custom-title",
            customTitle: nextName,
            sessionId: threadId,
            timestamp: new Date().toISOString(),
            uuid: randomUUID(),
          })}\n`,
        );
      } finally {
        await handle.close();
      }
      this.historyIndex.delete(file);
      await this.saveHistoryIndex();
    }
    thread.name = nextName;
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async updateThreadSettings(
    _providerId: string,
    threadId: string,
    settings: { model?: string; permissionMode?: ClaudePermissionMode },
  ) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Claude Code 会话不存在");
    if (this.active.has(threadId))
      throw new Error("任务结束后才能修改 Claude 会话设置");
    if (settings.model) thread.model = settings.model;
    if (settings.permissionMode)
      thread.permissionMode = settings.permissionMode;
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async deleteThread(_providerId: string, threadId: string) {
    if (this.active.has(threadId))
      throw new Error("运行中的 Claude 会话不能删除");
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Claude Code 会话不存在");
    const file = this.history.get(threadId);
    if (file) {
      await unlink(file);
      this.historyIndex.delete(file);
      await this.saveHistoryIndex();
    }
    this.history.delete(threadId);
    this.historyHomes.delete(threadId);
    this.threads.delete(threadId);
    this.broadcast("thread.deleted", { agentId: this.id, threadId });
    return { ok: true };
  }

  async sendTurn(
    _providerId: string,
    threadId: string,
    text: string,
    images?: TurnImage[],
  ) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Claude Code 会话不存在");
    if (this.active.has(threadId)) throw new Error("Claude Code 会话正在运行");
    if (!text.trim() && !images?.length) throw new Error("请输入指令或图片");
    const turnId = randomUUID();
    thread.status = "running";
    thread.activeTurnId = turnId;
    thread.updatedAt = Date.now();
    thread.lastError = undefined;
    thread.controlMode = "managed";
    this.broadcast("thread.updated", thread);
    this.emitAgentEvent(thread, {
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    void this.runTurn(thread, turnId, text, images);
    return { turn: { id: turnId, status: "inProgress" } };
  }

  async interrupt(_providerId: string, threadId: string, _turnId: string) {
    const current = this.active.get(threadId);
    if (!current) throw new Error("Claude Code 会话没有正在运行的任务");
    await current.query.interrupt();
    return { ok: true };
  }

  async resolveApproval(
    approvalId: string,
    body: string | { decision?: string; answers?: unknown },
  ) {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error("审批已处理或不存在");
    const payload = typeof body === "string" ? { decision: body } : body;
    const allow =
      payload.decision === "accept" ||
      payload.decision === "acceptForSession" ||
      (approval.kind === "question" && payload.answers != null);
    if (allow) {
      approval.resolve({
        behavior: "allow",
        updatedInput:
          approval.kind === "question"
            ? { ...approval.input, answers: payload.answers }
            : approval.input,
        ...(payload.decision === "acceptForSession" && approval.suggestions
          ? { updatedPermissions: approval.suggestions }
          : {}),
      });
    } else {
      approval.resolve({
        behavior: "deny",
        message: "用户拒绝了此操作",
        interrupt: payload.decision === "cancel",
      });
    }
    this.approvals.delete(approvalId);
    const thread = this.threads.get(approval.threadId);
    if (thread) {
      thread.status = "running";
      this.broadcast("thread.updated", thread);
    }
    this.broadcast("approval.resolved", {
      agentId: this.id,
      approvalId,
    });
    return { ok: true };
  }

  private async runTurn(
    thread: ThreadSummary,
    turnId: string,
    text: string,
    images?: TurnImage[],
  ) {
    const materialized = this.history.has(thread.id);
    const profile = this.resolveProfile(thread.providerId);
    const canUseTool: CanUseTool = (toolName, input, options) =>
      this.requestApproval(
        thread,
        toolName,
        input,
        options.suggestions,
        options.signal,
      );
    const permissionMode = (thread.permissionMode ||
      (thread.approvalPolicy === "never"
        ? "bypassPermissions"
        : "default")) as PermissionMode;
    let query: Query | undefined;
    try {
      const runtime = await this.turnRuntime(thread.cwd);
      const onStderr = (line: string) => {
        if (line.trim()) this.error = this.redact(line.trim().slice(-500));
      };
      query = this.queryFactory({
        prompt: images?.length ? promptStream(thread.id, text, images) : text,
        options: {
          cwd:
            runtime === "wsl"
              ? windowsPathToWsl(thread.cwd)
              : process.platform === "win32"
                ? wslPathToWindows(thread.cwd)
                : /^[a-z]:[\\/]/i.test(thread.cwd)
                  ? windowsPathToWsl(thread.cwd)
                  : thread.cwd,
          ...(materialized
            ? { resume: thread.id }
            : { extraArgs: { "session-id": thread.id } }),
          ...(thread.model && thread.model !== "default"
            ? { model: thread.model }
            : {}),
          includePartialMessages: true,
          canUseTool,
          permissionMode,
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["user", "project", "local"],
          ...(runtime === "wsl"
            ? {
                pathToClaudeCodeExecutable:
                  this.options.claudeWslBin || "claude",
              }
            : this.options.claudeBin
              ? { pathToClaudeCodeExecutable: this.options.claudeBin }
              : {}),
          env: this.runtimeEnv(
            profile,
            this.historyHomes.get(thread.id),
            runtime,
          ),
          stderr: onStderr,
          ...(runtime === "wsl"
            ? {
                spawnClaudeCodeProcess: (options: SpawnOptions) =>
                  spawnWslClaudeCodeProcess(
                    options,
                    this.options.claudeWslBin || "claude",
                    onStderr,
                  ),
              }
            : process.platform === "win32" &&
                /\.(?:cmd|bat)$/i.test(this.options.claudeBin || "")
              ? {
                  spawnClaudeCodeProcess: (options: SpawnOptions) =>
                    spawnClaudeCodeProcess(options, onStderr),
                }
              : {}),
        },
      });
      this.active.set(thread.id, { query, turnId });
      for await (const message of query)
        this.onMessage(thread, turnId, message);
      if (thread.status === "running" || thread.status === "waiting")
        this.completeTurn(thread, turnId);
    } catch (error: any) {
      this.failTurn(
        thread,
        turnId,
        this.redact(error?.message || String(error)),
      );
    } finally {
      this.active.delete(thread.id);
      for (const [id, approval] of this.approvals)
        if (approval.threadId === thread.id) {
          approval.resolve({
            behavior: "deny",
            message: "Claude Code 任务已结束",
          });
          this.approvals.delete(id);
          this.broadcast("approval.resolved", {
            agentId: this.id,
            approvalId: id,
          });
        }
      await this.refreshThreadFromDisk(thread.id).catch(() => undefined);
    }
  }

  private onMessage(
    thread: ThreadSummary,
    turnId: string,
    message: SDKMessage,
  ) {
    if (message.type === "system" && message.subtype === "init") {
      thread.model = message.model || thread.model;
      thread.cwd = message.cwd || thread.cwd;
      return;
    }
    if (message.type === "stream_event") {
      const event: any = message.event;
      if (event.type === "content_block_delta") {
        const delta = event.delta?.text || event.delta?.thinking || "";
        if (delta)
          this.emitAgentEvent(thread, {
            method: "item/agentMessage/delta",
            params: {
              threadId: thread.id,
              turnId,
              itemId: `${message.uuid}:${event.index}`,
              delta,
            },
          });
      }
      if (event.type === "content_block_stop")
        this.emitAgentEvent(thread, {
          method: "item/completed",
          params: {
            threadId: thread.id,
            turnId,
            item: {
              id: `${message.uuid}:${event.index}`,
              type: "agentMessage",
            },
          },
        });
      return;
    }
    if (message.type === "result") {
      const input = Number(message.usage.input_tokens) || 0;
      const cached = Number(message.usage.cache_read_input_tokens) || 0;
      const created = Number(message.usage.cache_creation_input_tokens) || 0;
      const output = Number(message.usage.output_tokens) || 0;
      const modelUsage = Object.values(message.modelUsage || {})[0];
      thread.tokenUsage = {
        total: input + cached + created + output,
        used: input + cached + created + output,
        ...(modelUsage?.contextWindow
          ? { limit: modelUsage.contextWindow }
          : {}),
        input: input + created,
        cachedInput: cached,
        output,
      };
      if (message.is_error) {
        const detail =
          "errors" in message
            ? message.errors.join("; ")
            : "Claude Code 任务失败";
        this.failTurn(thread, turnId, detail);
      } else this.completeTurn(thread, turnId);
    }
  }

  private completeTurn(thread: ThreadSummary, turnId: string) {
    thread.status = "idle";
    thread.activeTurnId = undefined;
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    this.emitAgentEvent(thread, {
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turn: { id: turnId, status: "completed" },
      },
    });
  }

  private failTurn(thread: ThreadSummary, turnId: string, detail: string) {
    detail = this.redact(detail);
    thread.status = "error";
    thread.activeTurnId = undefined;
    thread.lastError = detail || "Claude Code 任务失败";
    thread.updatedAt = Date.now();
    this.error = thread.lastError;
    this.broadcast("thread.updated", thread);
    this.emitAgentEvent(thread, {
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turn: { id: turnId, status: "failed", error: { message: detail } },
      },
    });
  }

  private requestApproval(
    thread: ThreadSummary,
    toolName: string,
    input: Record<string, unknown>,
    suggestions?: PermissionUpdate[],
    signal?: AbortSignal,
  ) {
    const id = `${thread.id}:${randomUUID()}`;
    return new Promise<PermissionResult>((resolve) => {
      const approval: PendingApproval = {
        id,
        threadId: thread.id,
        toolName,
        input,
        suggestions,
        kind: approvalKind(toolName),
        resolve,
      };
      this.approvals.set(id, approval);
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.approvals.delete(id)) return;
          resolve({
            behavior: "deny",
            message: "Claude Code 任务已取消",
            interrupt: true,
          });
          this.broadcast("approval.resolved", {
            agentId: this.id,
            approvalId: id,
          });
        },
        { once: true },
      );
      thread.status = "waiting";
      this.broadcast("thread.updated", thread);
      this.broadcast("approval.requested", this.approvalView(approval));
    });
  }

  private approvalView(approval: PendingApproval) {
    const command =
      approval.toolName === "Bash"
        ? String(approval.input.command || "")
        : `${approval.toolName} ${JSON.stringify(approval.input)}`;
    return {
      id: approval.id,
      agentId: this.id,
      providerId: this.threads.get(approval.threadId)?.providerId,
      kind: approval.kind,
      cwd: this.threads.get(approval.threadId)?.cwd,
      command,
      reason: `Claude Code 请求使用 ${approval.toolName}`,
      ...(approval.kind === "question"
        ? { questions: approval.input.questions || [] }
        : {
            availableDecisions: ["decline", "accept", "acceptForSession"],
          }),
      ...(approval.kind === "file"
        ? {
            changes: [
              {
                path: String(
                  approval.input.file_path ||
                    approval.input.notebook_path ||
                    "",
                ),
                kind: approval.toolName === "Write" ? "add" : "update",
              },
            ],
          }
        : {}),
      request: {
        method:
          approval.kind === "question"
            ? "item/requestUserInput"
            : approval.kind === "file"
              ? "item/fileChange/requestApproval"
              : "item/commandExecution/requestApproval",
        params: {
          threadId: approval.threadId,
          toolName: approval.toolName,
          input: approval.input,
          command,
        },
      },
    };
  }

  private emitAgentEvent(thread: ThreadSummary, event: any) {
    this.broadcast("agent.event", {
      agentId: this.id,
      providerId: thread.providerId,
      ...event,
    });
  }

  private broadcast(type: string, data: unknown) {
    this.emit("event", { type, data });
  }

  private resolveProfile(id?: string) {
    if (!id || id === "claude-current") {
      const profile =
        this.profiles.find((item) => item.current && item.supported) ||
        this.profiles.find((item) => item.supported);
      if (profile) return profile;
      throw new Error(
        "Claude Code 不支持 Official，请先在 CC Switch 配置可用的 Claude 中转",
      );
    }
    const profile = this.profiles.find((item) => item.id === id);
    if (!profile) throw new Error("Claude Code 配置档不存在");
    if (profile.official)
      throw new Error(
        "Claude Code 不支持 Official，请选择 CC Switch 中的 Claude 中转",
      );
    if (!profile.supported)
      throw new Error("Claude Code 中转配置缺少 API 地址或认证凭据");
    return profile;
  }

  private hasSupportedProfile() {
    return this.profiles.some((profile) => profile.supported);
  }

  private syncAvailability() {
    this.online = this.hasSupportedProfile();
    this.error = this.online
      ? undefined
      : "Claude Code 仅支持配置了自定义 API 地址和凭据的 CC Switch 中转配置";
  }

  private runtimeEnv(
    profile?: ClaudeProfile,
    historyHome?: string,
    runtime: "native" | "wsl" = "native",
  ) {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    delete env.ANTHROPIC_BASE_URL;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    Object.assign(env, profile?.env || {});
    const claudeHome =
      this.options.claudeHome || historyHome || defaultClaudeHome();
    env.CLAUDE_CONFIG_DIR =
      runtime === "wsl" ? windowsPathToWsl(claudeHome) : claudeHome;
    return runtime === "wsl"
      ? exposeEnvironmentToWsl(env, [
          ...Object.keys(profile?.env || {}),
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_BASE_URL",
          "CLAUDE_CODE_OAUTH_TOKEN",
          "CLAUDE_CONFIG_DIR",
        ])
      : env;
  }

  private async turnRuntime(cwd: string): Promise<"native" | "wsl"> {
    if (process.platform !== "win32" || !this.options.useWsl) return "native";
    if (this.wslClaudeAvailable === undefined) {
      const bin = this.options.claudeWslBin || "claude";
      this.wslClaudeAvailable = await (this.options.wslProbe || hasWslClaude)(
        bin,
        process.env,
      );
    }
    return claudeRuntimePreference(
      process.platform,
      Boolean(this.options.useWsl),
      Boolean(this.wslClaudeAvailable),
      cwd,
    );
  }

  private async loadProfiles() {
    if (!this.options.ccSwitchPath) return;
    this.profiles = new CcSwitchSource(
      this.options.ccSwitchPath,
    ).readClaudeProfiles();
  }

  private async loadHistoryIndex() {
    if (this.historyIndexLoaded) return;
    this.historyIndexLoaded = true;
    if (!this.options.historyIndexFile) return;
    try {
      const parsed = JSON.parse(
        await readFile(this.options.historyIndexFile, "utf8"),
      );
      if (parsed?.version !== 1 || !parsed.entries) return;
      for (const [file, entry] of Object.entries(parsed.entries)) {
        const value = entry as ClaudeHistoryIndexEntry;
        if (
          typeof value?.size === "number" &&
          typeof value?.mtimeMs === "number" &&
          value.summary?.id
        )
          this.historyIndex.set(file, value);
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
  }

  private async readHistorySummary(
    file: string,
  ): Promise<ClaudeHistoryThread | undefined> {
    const info = await stat(file);
    const cached = this.historyIndex.get(file);
    if (cached?.size === info.size && cached.mtimeMs === info.mtimeMs)
      return {
        summary: cached.summary,
        thread: {
          id: cached.summary.id,
          cwd: cached.summary.cwd || "",
          model: cached.summary.model || "default",
          turns: [],
          tokenUsage: cached.summary.tokenUsage,
        },
      };
    const parsed = await (this.options.historyReader || readClaudeHistory)(
      file,
    );
    if (parsed)
      this.historyIndex.set(file, {
        size: info.size,
        mtimeMs: info.mtimeMs,
        summary: parsed.summary,
      });
    return parsed;
  }

  private async saveHistoryIndex() {
    const file = this.options.historyIndexFile;
    if (!file) return;
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        version: 1,
        entries: Object.fromEntries(this.historyIndex),
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, file);
  }

  private async discoverHistoryFiles() {
    const homes = await this.claudeHomes();
    const files: string[] = [];
    for (const home of homes) {
      const projects = path.join(home, "projects");
      let dirs;
      try {
        dirs = await readdir(projects, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const projectDir = path.join(projects, dir.name);
        let entries;
        try {
          entries = await readdir(projectDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries)
          if (entry.isFile() && /^[0-9a-f-]{36}\.jsonl$/i.test(entry.name))
            files.push(path.join(projectDir, entry.name));
      }
    }
    return files;
  }

  private async claudeHomes() {
    const explicit =
      this.options.claudeHome ||
      process.env.CLAUDE_CONFIG_DIR ||
      process.env.CLAUDE_HOME;
    if (explicit) return [path.resolve(explicit)];
    const candidates = [path.join(os.homedir(), ".claude")];
    if (process.platform !== "win32") {
      try {
        const users = await readdir("/mnt/c/Users", { withFileTypes: true });
        for (const user of users)
          if (user.isDirectory())
            candidates.push(path.join("/mnt/c/Users", user.name, ".claude"));
      } catch {}
    }
    const available: string[] = [];
    for (const candidate of candidates)
      if (await existing(candidate)) available.push(candidate);
    return available;
  }

  private async refreshThreadFromDisk(threadId: string) {
    if (!this.history.has(threadId)) {
      const files = this.options.historyFiles
        ? await this.options.historyFiles()
        : await this.discoverHistoryFiles();
      const file = files.find((candidate) =>
        candidate.endsWith(`${path.sep}${threadId}.jsonl`),
      );
      if (file) {
        this.history.set(threadId, file);
        const home = historyHome(file);
        if (home) this.historyHomes.set(threadId, home);
      }
    }
    const file = this.history.get(threadId);
    if (!file) return;
    const parsed = await readClaudeHistory(file);
    if (!parsed) return;
    const current = this.threads.get(threadId);
    this.threads.set(threadId, {
      ...parsed.summary,
      providerId: current?.providerId || parsed.summary.providerId,
      status: current?.status || parsed.summary.status,
      lastError: current?.lastError,
      permissionMode: current?.permissionMode || "default",
      controlMode: "managed",
    });
    this.broadcast("thread.updated", this.threads.get(threadId));
  }

  private redact(value: string) {
    let redacted = value;
    for (const profile of this.profiles)
      for (const [key, secret] of Object.entries(profile.env))
        if (/token|secret|api.?key|password/i.test(key) && secret)
          redacted = redacted.split(secret).join("[REDACTED]");
    return redacted;
  }
}
