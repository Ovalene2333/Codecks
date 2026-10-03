import { randomUUID } from "node:crypto";
import { assertMessageInput, type AgentMessageInput, type AgentMessageAcceptance } from "./messages.js";
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
  type EffortLevel,
  type ModelInfo as SdkModelInfo,
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
import type { ThreadSettingsStore } from "../thread-settings.js";
import {
  branchClaudeHistory,
  claudeToolItem,
  readClaudeHistory,
  readClaudeHistoryCached,
  rewindAnchorUuid,
  turnEndUuid,
  type ClaudeHistoryThread,
} from "./claude-history.js";
import type {
  AgentCapabilities,
  AgentDescriptor,
  AgentId,
  AgentSkill,
} from "./types.js";

const CLAUDE_CAPABILITIES: AgentCapabilities = {
  messages: { busyBehavior: "reject", interruptScope: "session" },
  approvals: true,
  archive: false,
  delete: true,
  fork: true,
  images: true,
  interrupt: true,
  mcp: false,
  models: true,
  review: false,
  sessionSettings: true,
  shell: false,
  // 活跃会话走 SDK `reload_skills` 拿权威列表；未连接时按 Claude Code
  // 发现规则扫 `.claude/skills`（项目 + 用户目录）的 SKILL.md。
  skills: true,
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

/** Claude Code budgets Sonnet 5/5.5 at 200K behind an LLM gateway unless the
 * 1M variant is selected. Direct Anthropic API sessions use their native 1M
 * window. A persisted gateway profile is required before applying this rule. */
function gatewaySonnetContextWindow(
  resolvedModel: string | undefined,
  selectedModel: string | undefined,
  env: NodeJS.ProcessEnv,
) {
  if (
    !env.ANTHROPIC_BASE_URL ||
    !/^claude-sonnet-5(?:-5)?$/.test(resolvedModel || "")
  )
    return undefined;
  if (env.CLAUDE_CODE_MAX_CONTEXT_TOKENS || env.DISABLE_COMPACT)
    return undefined;
  if (env.CLAUDE_CODE_DISABLE_1M_CONTEXT === "1") return 200_000;
  return /\[1m\]/i.test(selectedModel || "") ? 1_000_000 : 200_000;
}

/** claude `--effort`/flag settings 接受的水平；其他值一律不下发。 */
const CLAUDE_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** 目录声明之外的输入（手填/旧数据）不下发给 CLI，避免 --effort 拒绝。 */
function claudeEffortLevel(value: unknown) {
  const effort = String(value || "").trim();
  return CLAUDE_EFFORT_LEVELS.has(effort) ? effort : "";
}

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

/** SKILL.md 递归发现：skills 目录下每层子目录一个 skill，深度与数量设上限。 */
async function findSkillFiles(
  root: string,
  depth = 0,
  budget: { left: number } = { left: 200 },
): Promise<string[]> {
  if (depth > 4 || budget.left <= 0) return [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (budget.left <= 0) break;
    const full = path.join(root, entry.name);
    if (entry.isDirectory())
      files.push(...(await findSkillFiles(full, depth + 1, budget)));
    else if (entry.isFile() && /^skill\.md$/i.test(entry.name)) {
      files.push(full);
      budget.left -= 1;
    }
  }
  return files;
}

/** 读取 SKILL.md frontmatter 里的 name/description（单行 key:value）。 */
async function skillFrontmatter(file: string) {
  try {
    const text = (await readFile(file, "utf8")).slice(0, 8192);
    if (!text.startsWith("---")) return {};
    const end = text.search(/\r?\n---(?:\r?\n|$)/);
    if (end < 0) return {};
    const block = text.slice(3, end);
    const pick = (key: string) => {
      const match = block.match(new RegExp(`^${key}\\s*:\\s*(.+?)\\s*$`, "m"));
      return match ? match[1].replace(/^["']|["']$/g, "") : undefined;
    };
    return { name: pick("name"), description: pick("description") };
  } catch {
    return {};
  }
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
  threadSettings?: ThreadSettingsStore;
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
  input: ClaudeInputQueue;
  turnId?: string;
  interrupted?: boolean;
  providerId: string;
  model: string;
  permissionMode: PermissionMode;
  profileEnv: Record<string, string>;
  /** Claude gives each stream wrapper a new UUID; retain the raw response ID. */
  streamMessageId?: string;
  streamBlocks: Map<number, "text" | "thinking" | "tool_use">;
  toolItems: Map<string, any>;
  /** 最近一次 API 调用自身的用量（真实上下文占用）；result.usage 是整回合各次调用的合计，不能当占用。 */
  lastCallUsage?: {
    input: number;
    cachedInput: number;
    limit?: number;
  };
}

/** Keep stdin open between turns so Claude retains its own background work. */
class ClaudeInputQueue implements AsyncIterable<SDKUserMessage> {
  private messages: SDKUserMessage[] = [];
  private waiter?: (value: IteratorResult<SDKUserMessage>) => void;
  private closed = false;

  push(message: SDKUserMessage) {
    if (this.closed) throw new Error("Claude Code 会话连接已关闭");
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter({ value: message, done: false });
    } else this.messages.push(message);
  }

  close() {
    this.closed = true;
    this.messages.length = 0;
    this.waiter?.({ value: undefined, done: true });
    this.waiter = undefined;
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.messages.length
        ? { value: this.messages.shift()!, done: false as const }
        : this.closed
          ? { value: undefined, done: true as const }
          : await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
              this.waiter = resolve;
            });
      if (next.done) return;
      yield next.value;
    }
  }
}

function approvalKind(toolName: string): ApprovalKind {
  if (["Edit", "Write", "NotebookEdit"].includes(toolName)) return "file";
  if (toolName === "AskUserQuestion") return "question";
  return "command";
}

function claudeQuestionAnswers(
  input: Record<string, unknown>,
  answers: unknown,
) {
  if (!Array.isArray(input.questions) || !Array.isArray(answers))
    return answers;
  const mapped: Record<string, string> = {};
  for (const [index, question] of input.questions.entries()) {
    const key = question?.question;
    const answer = answers[index];
    if (typeof key !== "string" || !key.trim() || !answer) continue;
    const value =
      typeof answer === "string"
        ? answer
        : typeof answer.other === "string" && answer.other.trim()
          ? answer.other
          : typeof answer.value === "string"
            ? answer.value
            : "";
    if (value.trim()) mapped[key] = value.trim();
  }
  return mapped;
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

const CLAUDE_LOCAL_PROFILE_ID = "claude-local";

/**
 * 追加「本机 Claude」兜底配置档：不注入自有 env，直接沿用 claude CLI 的
 * 当前登录态（~/.claude 凭据、settings.json 或环境变量）。CC Switch 没有
 * 可用中转、或只有 Official 时它让 adapter 仍然可用；配置了中转时它也是
 * 回退到官方登录的显式入口。仅在没有任何 supported+current 中转时承担
 * current 角色。
 */
function withLocalProfile(profiles: ClaudeProfile[]): ClaudeProfile[] {
  const rest = profiles.filter(
    (profile) => profile.id !== CLAUDE_LOCAL_PROFILE_ID,
  );
  return [
    ...rest,
    {
      id: CLAUDE_LOCAL_PROFILE_ID,
      name: "本机 Claude",
      color: "#d97757",
      current: !rest.some((profile) => profile.current && profile.supported),
      official: false,
      supported: true,
      env: {},
    },
  ];
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

function inputMessage(
  sessionId: string,
  text: string,
  images: TurnImage[] | undefined,
  uuid?: string,
): SDKUserMessage {
  const content: any[] = [];
  if (text) content.push({ type: "text", text });
  for (const image of images || []) content.push(imagePart(image));
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    // uuid 会原样写进 JSONL 的 user 记录：历史回放时 turn.id 用它当键，
    // 回合的模型/effort 快照才能按 id 对回来。
    uuid,
    message: { role: "user", content: content.length ? content : "" },
  } as SDKUserMessage;
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
  private queryTasks = new Map<string, Promise<void>>();
  private deleting = new Set<string>();
  private startingTurns = new Map<
    string,
    { turnId: string; abort: AbortController }
  >();
  private approvals = new Map<string, PendingApproval>();
  /**
   * SDK 经自定义 spawn 拉起的包装进程。只记录存活状态；生命周期由
   * SDK Query.close() 管理，绝不在 adapter 重载时杀外部 Claude 进程。
   */
  private spawnedClaude = new Set<SpawnedProcess>();
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
  /** 最近一次 query init 返回的官方模型目录（含逐模型 effort 档）。 */
  private sdkModels?: ModelInfo[];
  /**
   * 本进程内新建、尚未落盘 JSONL 的会话。refreshAll 的清扫以磁盘文件为准，
   * 没有它兜底，createThread 之后第一次写历史前遇到刷新就会把会话删掉。
   */
  private newThreads = new Set<string>();

  constructor(private options: ClaudeAdapterOptions = {}) {
    super();
    this.options.claudeBin = findClaudeExecutable(options.claudeBin);
    this.queryFactory = options.queryFactory || createQuery;
    this.profiles = withLocalProfile(options.initialProfiles || []);
    for (const thread of options.initialThreads || []) {
      if (thread.agentId !== "claude") continue;
      this.threads.set(thread.id, {
        ...thread,
        ...options.threadSettings?.get(this.id, thread.id),
        agentId: "claude",
        claudeConnected: false,
      });
    }
    this.historyStatus = this.threads.size ? "cached" : "loading";
  }

  descriptor(): AgentDescriptor {
    const available = this.hasSupportedProfile();
    return {
      id: this.id,
      name: "Claude Code",
      protocol: "native",
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
    return (this.sdkModels || CLAUDE_MODELS).map((model) => ({ ...model }));
  }

  /**
   * `initializationResult().models` 是 Claude Code 启动握手自带的权威模型
   * 目录：value 同时接受别名（sonnet）和全量 id（claude-opus-4-7），还带
   * supportedEffortLevels。缓存下来给选择器用；旧 CLI 没这个字段就继续用
   * 静态别名表。
   */
  private captureModelCatalog(models: SdkModelInfo[] | undefined) {
    if (!Array.isArray(models) || !models.length) return;
    const catalog: ModelInfo[] = [];
    for (const entry of models) {
      const value = String(entry?.value || "").trim();
      if (!value) continue;
      const levels = (entry.supportedEffortLevels || [])
        .map((level) => String(level))
        .filter((level) => CLAUDE_EFFORT_LEVELS.has(level));
      catalog.push({
        id: value,
        model: value,
        displayName: String(entry.displayName || value),
        ...(value === "default" ? { isDefault: true } : {}),
        ...(levels.length
          ? {
              supportedReasoningEfforts: levels.map((level) => ({
                reasoningEffort: level,
              })),
              ...(levels.includes("high")
                ? { defaultReasoningEffort: "high" }
                : {}),
            }
          : {}),
      });
    }
    if (!catalog.length) return;
    if (!catalog.some((model) => model.model === "default"))
      catalog.unshift({ ...CLAUDE_MODELS[0] });
    this.sdkModels = catalog;
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

  /**
   * 轻量重载：重新读取 CC Switch 配置档并重扫历史，不关闭任何已有的 Claude
   * 连接（restart() 会终止后台任务，重载不该有这个副作用）。新配置档只
   * 用于之后新建或分支的会话。
   */
  reload() {
    return this.startAll();
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
        this.newThreads.delete(parsed.summary.id);
        this.history.set(parsed.summary.id, files[index]);
        const home = historyHome(files[index]);
        if (home) this.historyHomes.set(parsed.summary.id, home);
        const existing = this.threads.get(parsed.summary.id);
        const live = this.active.get(parsed.summary.id);
        const settings = this.options.threadSettings?.get(
          this.id,
          parsed.summary.id,
        );
        const providerId =
          settings?.providerId ||
          existing?.providerId ||
          parsed.summary.providerId;
        const diskUsage = this.historicalTokenUsage(
          parsed.summary,
          providerId,
          settings?.model || existing?.model || parsed.summary.model,
        );
        // 连接在但回合间隙（turnId 空）也是 managed；startingTurns 覆盖
        // sendTurn 已置 running、SDK 进程尚未建连的窗口。activeTurnId 只认
        // 活跃回合来源，existing 里的残留不往回带。
        const busyTurnId =
          live?.turnId || this.startingTurns.get(parsed.summary.id)?.turnId;
        this.threads.set(parsed.summary.id, {
          ...parsed.summary,
          providerId,
          model: existing?.model || parsed.summary.model,
          permissionMode: existing?.permissionMode || "default",
          forkedFromId: existing?.forkedFromId,
          resolvedModel:
            live || busyTurnId
              ? existing?.resolvedModel || parsed.summary.resolvedModel
              : parsed.summary.resolvedModel || existing?.resolvedModel,
          tokenUsage:
            live || busyTurnId
              ? existing?.tokenUsage || diskUsage
              : diskUsage || existing?.tokenUsage,
          status: live
            ? existing?.status || "running"
            : busyTurnId
              ? "running"
              : parsed.summary.status,
          activeTurnId: busyTurnId,
          lastError: existing?.lastError,
          controlMode: live || busyTurnId ? "managed" : "history",
          claudeConnected: Boolean(live),
          ...settings,
        });
      });
      for (const [id] of this.threads)
        if (!seen.has(id) && !this.active.has(id) && !this.newThreads.has(id)) {
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
      (thread) =>
        thread.status === "running" ||
        thread.status === "waiting" ||
        this.startingTurns.has(thread.id),
    );
  }

  private isBusy(threadId: string) {
    return (
      Boolean(this.active.get(threadId)?.turnId) ||
      this.startingTurns.has(threadId)
    );
  }

  restart() {
    for (const pending of this.startingTurns.values()) pending.abort.abort();
    this.startingTurns.clear();
    for (const current of this.active.values()) {
      current.input.close();
      // Adapter shutdown is the only implicit process close. Never send a
      // turn interrupt or kill an unrelated Claude/Agent View worker here.
      current.query.close?.();
    }
    this.spawnedClaude.clear();
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
    for (const thread of this.threads.values()) thread.claudeConnected = false;
    this.online = false;
  }

  listThreads() {
    return [...this.threads.values()].sort(
      (left, right) => right.updatedAt - left.updatedAt,
    );
  }

  /**
   * 记录 SDK 拉起的包装进程并在其退出时摘除。只在 cmd/.bat 与 WSL
   * 包裹路径上使用；直接 spawn 的进程由 SDK 自行管理。
   */
  private trackClaudeProcess(child: SpawnedProcess): SpawnedProcess {
    this.spawnedClaude.add(child);
    try {
      (child as { once?: (...args: any[]) => void }).once?.("exit", () =>
        this.spawnedClaude.delete(child),
      );
    } catch {
      // 忽略不支持 exit 事件的自定义传输。
    }
    return child;
  }

  async createThread(
    providerId: string,
    input: {
      cwd: string;
      name?: string;
      model?: string;
      reasoningEffort?: string;
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
      claudeConnected: false,
    };
    const effort = String(input.reasoningEffort || "").trim();
    if (effort && !CLAUDE_EFFORT_LEVELS.has(effort))
      throw new Error(`不支持的推理强度：${effort}`);
    if (effort) thread.reasoningEffort = effort;
    await this.options.threadSettings?.update?.(this.id, id, {
      providerId: profile.id,
      model: thread.model,
      permissionMode: thread.permissionMode,
      reasoningEffort: thread.reasoningEffort,
    });
    this.threads.set(id, thread);
    this.newThreads.add(id);
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async readThread(_providerId: string, threadId: string) {
    const summary = this.threads.get(threadId);
    if (!summary) throw new Error("Claude Code 会话不存在");
    const file = this.history.get(threadId);
    let parsed: ClaudeHistoryThread | undefined;
    // 打开会话会反复读同一份 JSONL：没变就复用上次的解析结果。
    if (file) parsed = await readClaudeHistoryCached(file);
    const thread = parsed?.thread || {
      id: threadId,
      cwd: summary.cwd,
      model: summary.model,
      turns: [],
    };
    this.stampTurnModels(threadId, thread.turns);
    return {
      ...thread,
      agentId: this.id,
      providerId: summary.providerId,
    };
  }

  /**
   * 回填回合快照。turn.id 即该回合 user 消息的 JSONL uuid——sendTurn 把它
   * 设进 SDKUserMessage.uuid，两者天然对齐。JSONL 自带真实 model 的回合
   * 以 JSONL 为准；快照主要补 JSONL 里没有的 reasoningEffort。
   */
  private stampTurnModels(threadId: string, turns: any[] | undefined) {
    if (!Array.isArray(turns) || !this.options.threadSettings) return;
    for (const turn of turns) {
      if (!turn) continue;
      const stamp = this.options.threadSettings.turnModel(
        this.id,
        threadId,
        String(turn.id || ""),
      );
      if (!stamp) continue;
      if (stamp.model && !turn.model) turn.model = stamp.model;
      if (stamp.reasoningEffort && !turn.reasoningEffort)
        turn.reasoningEffort = stamp.reasoningEffort;
    }
  }

  /**
   * 同一 turn 的多次快照逐字段合并：sendTurn 先记发出时的意图，init /
   * message_start 再拿实际下发的 model/effort 覆盖。patch.reasoningEffort
   * 传 null 表示「SDK 报告无覆盖」，明确清掉；不传则保留先前值。
   */
  private stampTurnModel(
    thread: ThreadSummary,
    turnId: string,
    patch: { model?: string; reasoningEffort?: string | null } = {},
  ) {
    const store = this.options.threadSettings;
    if (!store) return;
    const prev = store.turnModel(this.id, thread.id, turnId);
    const model =
      patch.model || prev?.model || thread.resolvedModel || thread.model;
    const reasoningEffort =
      patch.reasoningEffort === null
        ? undefined
        : patch.reasoningEffort ||
          prev?.reasoningEffort ||
          thread.reasoningEffort;
    if (
      prev &&
      prev.model === model &&
      (prev.reasoningEffort || undefined) === (reasoningEffort || undefined)
    )
      return;
    void store
      .recordTurnModel(this.id, thread.id, turnId, { model, reasoningEffort })
      .catch(() => undefined);
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
    const summary = this.currentSummary(thread);
    summary.name = nextName;
    summary.updatedAt = Date.now();
    this.broadcast("thread.updated", summary);
    return summary;
  }

  async updateThreadSettings(
    _providerId: string,
    threadId: string,
    settings: {
      providerId?: string;
      model?: string;
      reasoningEffort?: string;
      permissionMode?: ClaudePermissionMode;
    },
  ) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Claude Code 会话不存在");
    if (this.isBusy(threadId))
      throw new Error("任务结束后才能修改 Claude 会话设置");
    const connected = this.active.get(threadId);
    if (settings.providerId) {
      const profile = this.resolveProfile(settings.providerId);
      if (connected && profile.id !== thread.providerId)
        throw new Error(
          "此 Claude 会话仍保持连接并可能有后台任务；请先创建分支，再为分支选择其他供应商",
        );
      this.currentSummary(thread).providerId = profile.id;
    }
    if (settings.model) {
      if (connected) await connected.query.setModel(settings.model);
      this.currentSummary(thread).model = settings.model;
      if (connected) connected.model = settings.model;
    }
    if (settings.reasoningEffort !== undefined) {
      const effort = String(settings.reasoningEffort || "").trim();
      if (effort && !CLAUDE_EFFORT_LEVELS.has(effort))
        throw new Error(`不支持的推理强度：${effort}`);
      // effortLevel 走 flag 层即时生效（空值=回模型默认），无需重连；
      // 下个 runTurn 的 options.effort 也会带上，断线重连后不丢。
      if (connected)
        await connected.query.applyFlagSettings({
          effortLevel: (effort || null) as EffortLevel | null,
        });
      this.currentSummary(thread).reasoningEffort = effort || undefined;
    }
    if (settings.permissionMode) {
      if (connected)
        await connected.query.setPermissionMode(settings.permissionMode);
      this.currentSummary(thread).permissionMode = settings.permissionMode;
      if (connected) connected.permissionMode = settings.permissionMode;
    }
    const summary = this.currentSummary(thread);
    await this.options.threadSettings?.update?.(this.id, threadId, {
      providerId: summary.providerId,
      model: summary.model,
      permissionMode: summary.permissionMode,
      reasoningEffort: summary.reasoningEffort || "",
    });
    summary.updatedAt = Date.now();
    this.broadcast("thread.updated", summary);
    return summary;
  }

  /**
   * 分支会话：文件级 fork——把源 JSONL 复制成新会话文件（sessionId 重写），
   * 传 lastTurnId 时截到该 turn 末尾。原文件完全不动，分支通过
   * resume 新会话继续，与 Claude Code 自身的 fork/rewind 产物等价。
   */
  async forkThread(
    _providerId: string,
    threadId: string,
    options: { lastTurnId?: string } = {},
  ) {
    const source = this.threads.get(threadId);
    if (!source) throw new Error("Claude Code 会话不存在");
    if (this.isBusy(threadId))
      throw new Error("Claude Code 会话正在运行，无法分支");
    const file = this.history.get(threadId);
    if (!file) throw new Error("会话还没有写入历史记录，无法分支");
    const content = await readFile(file, "utf8");
    let anchor: string | undefined;
    if (options.lastTurnId) {
      anchor = turnEndUuid(content, options.lastTurnId);
      if (!anchor)
        throw new Error("找不到这条消息，它可能已被回退或不在当前分支上");
    }
    return this.branchThread(source, content, file, anchor);
  }

  /**
   * 从历史 turn 回滚重试（中途编辑）：turnId 即该 turn 首条 user 消息的
   * JSONL uuid。先按其前一条消息为界复制出分支会话（原会话保留），再
   * 在分支上发送新文本——等价于 Claude Code 的 rewind+编辑重发。
   * 目标是首条消息时回滚到会话开头，直接开同配置的新会话。
   */
  async retryFromTurn(
    _providerId: string,
    threadId: string,
    turnId: string,
    text: string,
    images?: TurnImage[],
  ) {
    const source = this.threads.get(threadId);
    if (!source) throw new Error("Claude Code 会话不存在");
    if (this.isBusy(threadId))
      throw new Error("Claude Code 会话正在运行，无法从历史消息重试");
    const value = String(text || "").trim();
    if (!value && !images?.length) throw new Error("请输入重试内容");
    const file = this.history.get(threadId);
    if (!file) throw new Error("会话还没有写入历史记录，无法回退重试");
    const content = await readFile(file, "utf8");
    const anchor = rewindAnchorUuid(content, turnId);
    if (anchor === undefined)
      throw new Error("找不到这条消息，它可能已被回退或不在当前分支上");
    const branch =
      anchor === null
        ? await this.createThread(source.providerId, {
            cwd: source.cwd,
            name: `${source.name || "Claude 会话"} · 分支`,
            model: source.model,
            permissionMode: source.permissionMode,
          })
        : await this.branchThread(source, content, file, anchor);
    if (!branch.forkedFromId) {
      branch.forkedFromId = threadId;
      this.broadcast("thread.updated", branch);
    }
    await this.sendTurn(source.providerId, branch.id, text, images);
    return this.threads.get(branch.id) || branch;
  }

  private async branchThread(
    source: ThreadSummary,
    content: string,
    file: string,
    anchor?: string,
  ) {
    const id = randomUUID();
    const branched = branchClaudeHistory(content, id, anchor);
    if (branched === undefined) throw new Error("无法定位分支点");
    const branchFile = path.join(path.dirname(file), `${id}.jsonl`);
    await writeFile(branchFile, branched);
    const branch: ThreadSummary = {
      ...source,
      id,
      sessionId: id,
      name: `${source.name || "Claude 会话"} · 分支`,
      status: "idle",
      activeTurnId: undefined,
      controlMode: "history",
      claudeConnected: false,
      lastError: undefined,
      forkedFromId: source.id,
      updatedAt: Date.now(),
    };
    this.threads.set(id, branch);
    this.history.set(id, branchFile);
    const home = this.historyHomes.get(source.id);
    if (home) this.historyHomes.set(id, home);
    await this.options.threadSettings?.update?.(this.id, id, {
      providerId: source.providerId,
      model: source.model,
      permissionMode: source.permissionMode,
      reasoningEffort: source.reasoningEffort || "",
    });
    this.broadcast("thread.updated", branch);
    return branch;
  }

  async deleteThread(
    _providerId: string,
    threadId: string,
    options: { closeConnection?: boolean } = {},
  ) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Claude Code 会话不存在");
    if (this.deleting.has(threadId))
      throw new Error("Claude 会话正在删除，请稍后");
    if (this.isBusy(threadId))
      throw new Error(
        "Claude 当前有正在执行的 turn，不能删除；请等待完成或先中断",
      );
    const connected = this.active.get(threadId);
    if (connected && !options.closeConnection)
      throw new Error(
        "Deck 当前与此 Claude 会话保持 SDK 连接，且没有正在执行的 turn。请在删除确认中选择关闭连接并删除",
      );
    this.deleting.add(threadId);
    try {
      if (connected) {
        connected.input.close();
        connected.query.close();
        await this.queryTasks.get(threadId);
        if (this.active.has(threadId))
          throw new Error("Deck 的 Claude 连接尚未关闭，请稍后重试删除");
      }
      const owner = await this.sessionLockOwner(threadId);
      if (owner)
        throw new Error(
          `此 Claude 会话当前由外部进程 PID ${owner.pid}${owner.name ? `（${owner.name}）` : ""}占用。请在原终端或 Agent View 中关闭该会话后重试；也可以在 Deck 中创建分支。`,
        );
      const file = this.history.get(threadId);
      if (file) {
        await unlink(file);
        this.historyIndex.delete(file);
        await this.saveHistoryIndex();
      }
      this.newThreads.delete(threadId);
      this.history.delete(threadId);
      this.historyHomes.delete(threadId);
      this.threads.delete(threadId);
      this.broadcast("thread.deleted", { agentId: this.id, threadId });
      return { ok: true };
    } finally {
      this.deleting.delete(threadId);
    }
  }

  async sendMessage(providerId: string, threadId: string, input: AgentMessageInput): Promise<AgentMessageAcceptance> {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Claude Code 会话不存在");
    assertMessageInput(thread, input, CLAUDE_CAPABILITIES.messages!);
    const result = await this.sendTurn(providerId, threadId, input.text, input.images);
    return { disposition: "started", turnId: result.turn.id };
  }

  messageReady(threadId: string) {
    return !this.isBusy(threadId);
  }

  async sendTurn(
    _providerId: string,
    threadId: string,
    text: string,
    images?: TurnImage[],
  ) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Claude Code 会话不存在");
    if (this.deleting.has(threadId))
      throw new Error("Claude 会话正在删除，不能发送新任务");
    if (this.isBusy(threadId)) throw new Error("Claude Code 会话正在运行");
    if (!text.trim() && !images?.length) throw new Error("请输入指令或图片");
    const turnId = randomUUID();
    const pending = { turnId, abort: new AbortController() };
    this.startingTurns.set(threadId, pending);
    try {
      const current = this.active.get(threadId);
      if (current) {
        if (
          current.providerId !== thread.providerId ||
          current.model !== (thread.model || "default") ||
          current.permissionMode !== (thread.permissionMode || "default")
        )
          throw new Error(
            "此 Claude 会话仍保持连接；更改供应商、模型或权限需新建分支会话",
          );
      } else if (this.history.has(thread.id)) {
        const owner = await this.sessionLockOwner(thread.id);
        if (owner)
          throw new Error(
            `该会话仍由 Claude 进程 pid ${owner.pid} 运行${owner.name ? `（${owner.name}）` : ""}。Deck 会保留它的后台任务；请返回原终端，或在 claude agents 中找到后台会话后 attach，也可在 Deck 中创建分支。原进程退出后可在此续聊。`,
          );
      }
      if (this.startingTurns.get(threadId) !== pending)
        throw new Error("Claude Code adapter 已停止");
    } catch (error) {
      if (this.startingTurns.get(threadId) === pending)
        this.startingTurns.delete(threadId);
      throw error;
    }
    // 上面的 await 之间 refreshAll 可能重建了摘要对象——写 map 当前这份。
    const summary = this.threads.get(threadId) ?? thread;
    summary.status = "running";
    summary.activeTurnId = turnId;
    summary.updatedAt = Date.now();
    summary.lastError = undefined;
    summary.controlMode = "managed";
    this.broadcast("thread.updated", summary);
    this.emitAgentEvent(summary, {
      method: "turn/started",
      params: { threadId, turn: { id: turnId, status: "inProgress" } },
    });
    // 记下回合发出时的模型/effort 快照：uuid 会落到 JSONL user 记录上，
    // readThread 靠它把快照对回历史 turn，切换模型后旧回合不会改标。
    this.stampTurnModel(summary, turnId);
    const current = this.active.get(threadId);
    if (current) {
      current.turnId = turnId;
      current.interrupted = false;
      current.lastCallUsage = undefined;
      current.input.push(inputMessage(thread.id, text, images, turnId));
      this.startingTurns.delete(threadId);
    } else {
      const task = this.runTurn(summary, turnId, text, images, pending);
      this.queryTasks.set(threadId, task);
      void task.then(
        () => {
          if (this.queryTasks.get(threadId) === task)
            this.queryTasks.delete(threadId);
        },
        () => {
          if (this.queryTasks.get(threadId) === task)
            this.queryTasks.delete(threadId);
        },
      );
    }
    return { turn: { id: turnId, status: "inProgress" } };
  }

  async interrupt(_providerId: string, threadId: string, _turnId: string) {
    const current = this.active.get(threadId);
    if (!current?.turnId) {
      const pending = this.startingTurns.get(threadId);
      if (!pending) throw new Error("Claude Code 会话没有正在运行的任务");
      pending.abort.abort();
      return { ok: true };
    }
    current.interrupted = true;
    await current.query.interrupt();
    return { ok: true };
  }

  /**
   * Skill 目录：会话有活跃 SDK 连接时用 `reload_skills` 控制请求取权威
   * 列表（同时刷新磁盘缓存）；未连接时按 Claude Code 发现规则扫
   * `<cwd>/.claude/skills` 与 `<claudeHome>/skills` 的 SKILL.md。
   */
  async listSkills(_providerId: string, threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Claude Code 会话不存在");
    const connected = this.active.get(threadId);
    if (connected && typeof connected.query.reloadSkills === "function") {
      const result = await connected.query.reloadSkills();
      const list = Array.isArray(result?.skills) ? result.skills : [];
      return {
        skills: list
          .map((skill: any) => ({
            name: String(skill?.name || ""),
            description: String(skill?.description || ""),
            scope: String(skill?.argumentHint || "").trim() || undefined,
            enabled: true,
          }))
          .filter((skill: AgentSkill) => skill.name),
      };
    }
    return { skills: await this.scanSkillRoots(thread) };
  }

  /** 无 SDK 连接时的磁盘兜底；WSL 会话的文件在另一侧，扫不到自然为空。 */
  private async scanSkillRoots(thread: ThreadSummary) {
    const roots = [
      ...(thread.cwd
        ? [
            {
              dir: path.join(thread.cwd, ".claude", "skills"),
              scope: "project",
            },
          ]
        : []),
      {
        dir: path.join(this.claudeConfigHome(thread.id), "skills"),
        scope: "user",
      },
    ];
    const skills: AgentSkill[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      for (const file of await findSkillFiles(root.dir)) {
        const meta = await skillFrontmatter(file);
        const name = meta.name || path.basename(path.dirname(file));
        const key = `${root.scope}:${name.toLowerCase()}`;
        if (!name || seen.has(key)) continue;
        seen.add(key);
        skills.push({
          name,
          description: meta.description,
          path: file,
          scope: root.scope,
          enabled: true,
        });
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
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
    const answers =
      approval.kind === "question"
        ? claudeQuestionAnswers(approval.input, payload.answers)
        : undefined;
    if (
      allow &&
      approval.kind === "question" &&
      (!answers ||
        typeof answers !== "object" ||
        !Array.isArray(approval.input.questions) ||
        approval.input.questions.some(
          (question: any) =>
            !question?.question ||
            !String(
              (answers as Record<string, unknown>)[question.question] || "",
            ).trim(),
        ))
    )
      throw new Error("请回答 Claude Code 提出的所有问题");
    if (allow) {
      approval.resolve({
        behavior: "allow",
        updatedInput:
          approval.kind === "question"
            ? { ...approval.input, answers }
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
    if (
      thread &&
      (thread.status === "waiting" || thread.status === "running")
    ) {
      thread.status = [...this.approvals.values()].some(
        (item) => item.threadId === approval.threadId,
      )
        ? "waiting"
        : "running";
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
    pending?: { turnId: string; abort: AbortController },
  ) {
    const materialized = this.history.has(thread.id);
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
    const input = new ClaudeInputQueue();
    const stderrTail: string[] = [];
    try {
      const profile = this.resolveProfile(thread.providerId);
      const runtime = await this.turnRuntime(thread.cwd);
      if (pending?.abort.signal.aborted) {
        this.completeTurn(thread, turnId);
        return;
      }
      const onStderr = (line: string) => {
        const text = this.redact(line.trim());
        if (!text) return;
        this.error = text.slice(-500);
        stderrTail.push(text.slice(-300));
        if (stderrTail.length > 8) stderrTail.shift();
      };
      const effort = claudeEffortLevel(thread.reasoningEffort);
      input.push(inputMessage(thread.id, text, images, turnId));
      query = this.queryFactory({
        prompt: input,
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
          ...(effort ? { effort: effort as EffortLevel } : {}),
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
          env: {
            ...this.runtimeEnv(
              profile,
              this.historyHomes.get(thread.id),
              runtime,
            ),
            // 只读的会话标识：deck-wake 据此确认 watcher 属于哪个会话。
            // 每个 Claude 会话独占一个进程，所以这个值不会串到别的会话。
            CODEX_DECK_SESSION: `${this.id}:${thread.id}`,
          },
          stderr: onStderr,
          ...(runtime === "wsl"
            ? {
                spawnClaudeCodeProcess: (options: SpawnOptions) =>
                  this.trackClaudeProcess(
                    spawnWslClaudeCodeProcess(
                      options,
                      this.options.claudeWslBin || "claude",
                      onStderr,
                    ),
                  ),
              }
            : process.platform === "win32" &&
                /\.(?:cmd|bat)$/i.test(this.options.claudeBin || "")
              ? {
                  spawnClaudeCodeProcess: (options: SpawnOptions) =>
                    this.trackClaudeProcess(
                      spawnClaudeCodeProcess(options, onStderr),
                    ),
                }
              : {}),
        },
      });
      this.active.set(thread.id, {
        query,
        input,
        turnId,
        providerId: thread.providerId,
        model: thread.model || "default",
        permissionMode,
        profileEnv: profile.env,
        streamBlocks: new Map(),
        toolItems: new Map(),
      });
      void Promise.resolve()
        .then(() => query?.initializationResult())
        .then((result) => this.captureModelCatalog(result?.models))
        .catch(() => undefined);
      const summary = this.currentSummary(thread);
      summary.claudeConnected = true;
      this.broadcast("thread.updated", summary);
      if (this.startingTurns.get(thread.id) === pending)
        this.startingTurns.delete(thread.id);
      for await (const message of query) {
        const live = this.active.get(thread.id);
        if (live?.query !== query) break;
        const currentTurnId = live.turnId;
        if (currentTurnId) {
          this.onMessage(thread, currentTurnId, message);
          if (message.type === "result") {
            await this.refreshThreadFromDisk(thread.id).catch(() => undefined);
            // Claude Code's structured /context summary reports the last main
            // API call even when streamed assistant usage was incomplete. The
            // summary mode does not make per-category token-count API calls.
            if (typeof query.getContextUsage === "function") {
              let timeout: ReturnType<typeof setTimeout> | undefined;
              try {
                const context = await Promise.race([
                  query.getContextUsage({ detail: "summary" }),
                  new Promise<undefined>((resolve) => {
                    timeout = setTimeout(() => resolve(undefined), 1_000);
                  }),
                ]);
                const current = this.currentSummary(thread);
                if (
                  !current.activeTurnId &&
                  this.active.get(thread.id)?.query === query &&
                  context?.apiUsage
                ) {
                  const usage = context.apiUsage;
                  const used =
                    (Number(usage.input_tokens) || 0) +
                    (Number(usage.cache_creation_input_tokens) || 0) +
                    (Number(usage.cache_read_input_tokens) || 0);
                  current.tokenUsage = { ...current.tokenUsage, used };
                  this.broadcast("thread.updated", current);
                }
              } catch {
                // Older CLI builds may not support this control request.
              } finally {
                clearTimeout(timeout);
              }
            }
          }
        }
      }
      const live = this.active.get(thread.id);
      if (live?.query === query && live.turnId) {
        if (live.interrupted) this.completeTurn(thread, live.turnId);
        else
          this.failTurn(
            thread,
            live.turnId,
            "Claude Code 连接在任务完成前退出",
          );
      }
    } catch (error: any) {
      const raw = this.redact(error?.message || String(error));
      // claude 进程退出码之外的真实原因只出现在 stderr（如会话锁、
      // resume 目标缺失）；带上尾部几行，不再只显示「exit code 1」。
      const tail = stderrTail
        .filter((line) => !raw.includes(line))
        .slice(-2)
        .join("\n");
      const live = this.active.get(thread.id);
      if (
        (query && live?.query === query) ||
        (!query && !live && this.startingTurns.get(thread.id) === pending)
      )
        this.failTurn(thread, turnId, tail ? `${raw}\n${tail}` : raw);
    } finally {
      input.close();
      const ownsPending =
        pending != null && this.startingTurns.get(thread.id) === pending;
      const ownsConnection =
        query != null && this.active.get(thread.id)?.query === query;
      if (this.startingTurns.get(thread.id) === pending)
        this.startingTurns.delete(thread.id);
      if (ownsConnection) this.active.delete(thread.id);
      // A replaced query may have started after restart. Its state and
      // approvals belong to the replacement, not this closing query.
      if (ownsConnection || ownsPending) {
        const summary = this.currentSummary(thread);
        summary.claudeConnected = false;
        this.broadcast("thread.updated", summary);
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
  }

  /**
   * 摘要对象会被 refreshAll/refreshThreadFromDisk 整体重建替换，回合闭包
   * 里持有的旧引用写完 map 不可见、广播出去还会盖回新对象的字段。凡是
   * 隔过 await 的线程字段写入，先取 map 当前对象再改。
   */
  private currentSummary(thread: ThreadSummary) {
    return this.threads.get(thread.id) ?? thread;
  }

  private historicalTokenUsage(
    summary: ThreadSummary,
    providerId: string,
    selectedModel: string | undefined,
  ) {
    const usage = summary.tokenUsage;
    if (!usage || usage.limit != null) return usage;
    // The JSONL has no window field for a standard gateway session. Apply
    // Claude Code's documented gateway rule only when the saved provider is
    // still available; a model ID by itself cannot establish this limit.
    const profile = this.profiles.find((item) => item.id === providerId);
    if (!profile?.env.ANTHROPIC_BASE_URL) return usage;
    const limit = gatewaySonnetContextWindow(
      summary.resolvedModel,
      selectedModel,
      { ...process.env, ...profile.env },
    );
    return limit ? { ...usage, limit } : usage;
  }

  private recordCallUsage(thread: ThreadSummary, turnId: string, usage: any) {
    const current = this.active.get(thread.id);
    if (!usage || typeof usage !== "object" || current?.turnId !== turnId)
      return;
    const input = Number(usage.input_tokens) || 0;
    const cached = Number(usage.cache_read_input_tokens) || 0;
    const created = Number(usage.cache_creation_input_tokens) || 0;
    const limit = Number(usage.context_window) || 0;
    current.lastCallUsage = {
      input: input + created,
      cachedInput: cached,
      ...(limit > 0 ? { limit } : {}),
    };
    thread.tokenUsage = {
      ...thread.tokenUsage,
      used: input + cached + created,
      ...(limit > 0 ? { limit } : {}),
    };
    this.broadcast("thread.updated", thread);
  }

  private onMessage(
    thread: ThreadSummary,
    turnId: string,
    message: SDKMessage,
  ) {
    thread = this.currentSummary(thread);
    if (message.type === "system" && message.subtype === "init") {
      if (message.model) thread.resolvedModel = message.model;
      // init 帧的 effort 是「实际下发」的水平（已过模型支持度降级），且只在
      // 连接建立时出现一次；有 model 或 effort 字段就校正快照。effort 为
      // null/缺失值表示该模型不接受覆盖，快照清掉，回合标签回模型默认。
      const reportsEffort = "effort" in message;
      if (message.model || reportsEffort)
        this.stampTurnModel(thread, turnId, {
          model: message.model || undefined,
          ...(reportsEffort
            ? {
                reasoningEffort:
                  typeof message.effort === "string" && message.effort
                    ? message.effort
                    : null,
              }
            : {}),
        });
      thread.cwd = message.cwd || thread.cwd;
      return;
    }
    if (message.type === "stream_event") {
      const event: any = message.event;
      if (event.type === "message_start") {
        const current = this.active.get(thread.id);
        if (current?.turnId === turnId) {
          current.streamMessageId = event.message?.id || message.uuid;
          current.streamBlocks.clear();
        }
        // 每回合第一条 API 消息带真实模型 ID——live 连接内换模型后 init
        // 不会再来，靠它把回合快照修到实际模型。
        const apiModel = event.message?.model;
        if (
          !message.parent_tool_use_id &&
          typeof apiModel === "string" &&
          apiModel
        ) {
          thread.resolvedModel = apiModel;
          this.stampTurnModel(thread, turnId, { model: apiModel });
        }
        if (!message.parent_tool_use_id)
          this.recordCallUsage(thread, turnId, event.message?.usage);
        return;
      }
      const current = this.active.get(thread.id);
      if (event.type === "message_delta") return;
      if (event.type === "content_block_start") {
        if (typeof event.index === "number" && current?.turnId === turnId)
          current.streamBlocks.set(event.index, event.content_block?.type);
        return;
      }
      const blockType = current?.streamBlocks.get(event.index);
      const itemId = `${
        current?.turnId === turnId && current.streamMessageId
          ? current.streamMessageId
          : message.uuid
      }:${event.index}`;
      if (event.type === "content_block_delta") {
        // Thinking and tool JSON are distinct Claude blocks. Showing either as
        // answer text creates a duplicate or misleading assistant message.
        const delta =
          blockType === "text" ||
          (blockType === undefined && event.delta?.type === "text_delta")
            ? event.delta?.text || ""
            : "";
        if (delta)
          this.emitAgentEvent(thread, {
            method: "item/agentMessage/delta",
            params: {
              threadId: thread.id,
              turnId,
              itemId,
              delta,
            },
          });
      }
      if (event.type === "content_block_stop" && blockType === "text")
        this.emitAgentEvent(thread, {
          method: "item/completed",
          params: {
            threadId: thread.id,
            turnId,
            item: {
              id: itemId,
              type: "agentMessage",
            },
          },
        });
      if (event.type === "content_block_stop")
        current?.streamBlocks.delete(event.index);
      return;
    }
    // Complete assistant messages carry the full tool input. Start a live
    // item here; the later SDK user/tool_result completes the same item.
    if (message.type === "assistant") {
      const current = this.active.get(thread.id);
      const apiModel = (message.message as any)?.model;
      if (
        !message.parent_tool_use_id &&
        typeof apiModel === "string" &&
        apiModel &&
        apiModel !== "<synthetic>"
      ) {
        thread.resolvedModel = apiModel;
        this.stampTurnModel(thread, turnId, { model: apiModel });
      }
      // 每条 assistant 消息带本次 API 调用自身的 usage（流式分块时同一
      // message.id 逐块更新，最后一条最完整）——这是真实上下文占用；
      // result.usage 是整回合合计，不能当占用。
      const usage = (message.message as any)?.usage;
      if (
        usage &&
        typeof usage === "object" &&
        !message.parent_tool_use_id &&
        current?.turnId === turnId
      ) {
        this.recordCallUsage(thread, turnId, usage);
      }
      const parts = Array.isArray(message.message?.content)
        ? message.message.content
        : [];
      for (const part of parts) {
        if (part?.type !== "tool_use") continue;
        const item = claudeToolItem(part, message);
        if (current?.turnId === turnId) current.toolItems.set(item.id, item);
        this.emitAgentEvent(thread, {
          method: item.type === "extension" ? "item/completed" : "item/started",
          params: {
            threadId: thread.id,
            turnId,
            item:
              item.type === "extension"
                ? { ...item, status: "completed" }
                : item,
          },
        });
      }
      return;
    }
    if (message.type === "user") {
      const parts = Array.isArray(message.message?.content)
        ? message.message.content
        : [];
      const current = this.active.get(thread.id);
      for (const part of parts) {
        if (part?.type !== "tool_result") continue;
        const item = current?.toolItems.get(String(part.tool_use_id));
        if (!item || item.type === "extension") continue;
        const output =
          typeof part.content === "string"
            ? part.content
            : Array.isArray(part.content)
              ? part.content
                  .filter((entry: any) => entry?.type === "text")
                  .map((entry: any) => String(entry.text || ""))
                  .join("\n")
              : "";
        this.emitAgentEvent(thread, {
          method: "item/completed",
          params: {
            threadId: thread.id,
            turnId,
            item: {
              ...item,
              status: part.is_error ? "failed" : "completed",
              ...(item.type === "commandExecution"
                ? { aggregatedOutput: output }
                : {}),
            },
          },
        });
        current?.toolItems.delete(String(part.tool_use_id));
      }
      return;
    }
    if (message.type === "result") {
      // usage 是本回合主循环各次 API 调用的合计（每次往返都重发完整
      // transcript，主要是 cache_read）——是消耗量，不是窗口占用，只能
      // 累计进 total/input/output。占用取最后一次调用自身的 usage。
      const input = Number(message.usage.input_tokens) || 0;
      const cached = Number(message.usage.cache_read_input_tokens) || 0;
      const created = Number(message.usage.cache_creation_input_tokens) || 0;
      const output = Number(message.usage.output_tokens) || 0;
      const last = this.active.get(thread.id)?.lastCallUsage;
      const previous = thread.tokenUsage;
      const models = message.modelUsage || {};
      const resolved = thread.resolvedModel || thread.model;
      const matchingKey = Object.keys(models).find(
        (key) => key === resolved || key.startsWith(`${resolved}[`),
      );
      const preferred = matchingKey
        ? models[matchingKey]
        : Object.keys(models).length === 1
          ? Object.values(models)[0]
          : undefined;
      const limit =
        Number(preferred?.contextWindow) || last?.limit || previous?.limit;
      const used = last
        ? last.input + last.cachedInput
        : (previous?.used ?? (input + cached + created || undefined));
      thread.tokenUsage = {
        total: (previous?.total || 0) + input + cached + created + output,
        ...(used != null ? { used } : {}),
        ...(limit ? { limit } : {}),
        input: (previous?.input || 0) + input + created,
        cachedInput: (previous?.cachedInput || 0) + cached,
        output: (previous?.output || 0) + output,
      };
      if (this.active.get(thread.id)?.interrupted) {
        this.completeTurn(thread, turnId);
      } else if (message.is_error) {
        const detail =
          "errors" in message
            ? message.errors.join("; ")
            : "Claude Code 任务失败";
        this.failTurn(thread, turnId, detail);
      } else this.completeTurn(thread, turnId);
    }
  }

  private completeTurn(thread: ThreadSummary, turnId: string) {
    thread = this.currentSummary(thread);
    if (thread.activeTurnId !== turnId) return;
    const live = this.active.get(thread.id);
    if (live?.turnId === turnId) {
      live.turnId = undefined;
      live.interrupted = false;
      live.toolItems.clear();
    }
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
    thread = this.currentSummary(thread);
    if (thread.activeTurnId !== turnId) return;
    const live = this.active.get(thread.id);
    if (live?.turnId === turnId) {
      live.turnId = undefined;
      live.interrupted = false;
      live.toolItems.clear();
    }
    detail = this.redact(detail);
    if (/not logged in|please run \/login/i.test(detail)) {
      const profile =
        this.profiles.find((item) => item.id === thread.providerId) ||
        (thread.providerId === "claude-current"
          ? this.profiles.find((item) => item.current && item.supported)
          : undefined);
      const home = this.claudeConfigHome(thread.id);
      detail +=
        profile?.env && Object.keys(profile.env).length
          ? `\n配置档「${profile.name}」的认证环境已注入 Claude 子进程（配置目录 ${home}）。请检查该配置档的凭据和 API 地址。`
          : `\n本机 Claude 使用配置目录 ${home}。请在同一目录和运行用户下完成 Claude 登录。`;
    }
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
    if (signal?.aborted)
      return Promise.resolve({
        behavior: "deny" as const,
        message: "Claude Code 任务已取消",
        interrupt: true,
      });
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
          const summary = this.currentSummary(thread);
          summary.status = [...this.approvals.values()].some(
            (item) => item.threadId === thread.id,
          )
            ? "waiting"
            : "running";
          this.broadcast("thread.updated", summary);
          this.broadcast("approval.resolved", {
            agentId: this.id,
            approvalId: id,
          });
        },
        { once: true },
      );
      const summary = this.currentSummary(thread);
      summary.status = "waiting";
      this.broadcast("thread.updated", summary);
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
    if (!profile.supported)
      throw new Error(
        profile.official
          ? "这个 CC Switch Official 配置没有独立凭据；请选本机 Claude 使用已有登录态"
          : "Claude Code 配置缺少有效的地址或认证凭据",
      );
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
    const profileEnv = profile?.env || {};
    // 中转配置档自带凭据时先清掉进程环境里残留的 Anthropic 变量再注入，
    // 避免两套凭据混用；本机配置档（env 为空）则原样透传当前 shell 环境，
    // 让 CLI 用自己的 OAuth/env 登录态。
    if (Object.keys(profileEnv).length) {
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.ANTHROPIC_BASE_URL;
      delete env.ANTHROPIC_CUSTOM_HEADERS;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      delete env.CLAUDE_CODE_USE_BEDROCK;
      delete env.CLAUDE_CODE_USE_VERTEX;
      delete env.CLAUDE_CODE_USE_FOUNDRY;
    }
    Object.assign(env, profileEnv);
    const claudeHome = this.claudeConfigHome(undefined, historyHome);
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

  private claudeConfigHome(threadId?: string, historyHome?: string) {
    return (
      this.options.claudeHome ||
      historyHome ||
      (threadId ? this.historyHomes.get(threadId) : undefined) ||
      process.env.CLAUDE_CONFIG_DIR ||
      process.env.CLAUDE_HOME ||
      defaultClaudeHome()
    );
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
    this.profiles = withLocalProfile(
      new CcSwitchSource(this.options.ccSwitchPath).readClaudeProfiles(),
    );
  }

  /** Reload CC Switch profiles after the shared provider source is refreshed. */
  async reloadProfiles(ccSwitchPath?: string) {
    this.options.ccSwitchPath = ccSwitchPath;
    if (ccSwitchPath) await this.loadProfiles();
    else this.profiles = withLocalProfile([]);
    this.syncAvailability();
    this.broadcast("agent.status", this.descriptor());
    this.broadcast("snapshot", this.snapshot());
  }

  private async loadHistoryIndex() {
    if (this.historyIndexLoaded) return;
    this.historyIndexLoaded = true;
    if (!this.options.historyIndexFile) return;
    try {
      const parsed = JSON.parse(
        await readFile(this.options.historyIndexFile, "utf8"),
      );
      if (parsed?.version !== 6 || !parsed.entries) return;
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
        version: 6,
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

  /**
   * Claude Code 会话锁：~/.claude/sessions/<pid>.json 登记每个活进程
   * 持有的 sessionId。返回占用者的 pid/名字；进程已死的记录是残留锁，
   * 跳过。无占用返回 undefined。
   */
  private async sessionLockOwner(threadId: string) {
    const home =
      this.historyHomes.get(threadId) ||
      this.options.claudeHome ||
      process.env.CLAUDE_CONFIG_DIR ||
      path.join(os.homedir(), ".claude");
    let names: string[] = [];
    try {
      names = await readdir(path.join(home, "sessions"));
    } catch {
      return undefined;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(
          await readFile(path.join(home, "sessions", name), "utf8"),
        );
        if (String(record?.sessionId) !== threadId) continue;
        const pid = Number(record?.pid);
        if (!Number.isInteger(pid) || pid <= 0) continue;
        try {
          process.kill(pid, 0);
        } catch (error: any) {
          if (error?.code !== "EPERM") continue;
        }
        return {
          pid,
          name: typeof record?.name === "string" ? record.name : undefined,
        };
      } catch {}
    }
    return undefined;
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
        this.newThreads.delete(threadId);
        const home = historyHome(file);
        if (home) this.historyHomes.set(threadId, home);
      }
    }
    const file = this.history.get(threadId);
    if (!file) return;
    const parsed = await (this.options.historyReader || readClaudeHistory)(
      file,
    );
    if (!parsed) return;
    const current = this.threads.get(threadId);
    const settings = this.options.threadSettings?.get(this.id, threadId);
    const providerId =
      settings?.providerId || current?.providerId || parsed.summary.providerId;
    const diskUsage = this.historicalTokenUsage(
      parsed.summary,
      providerId,
      settings?.model || current?.model || parsed.summary.model,
    );
    // 读盘 await 期间可能插进来新回合（result 后用户立刻续发），也可能
    // 回合刚结束——以连接/待发回合为准，别把 activeTurnId 丢掉或留尸。
    const busyTurnId =
      this.active.get(threadId)?.turnId ||
      this.startingTurns.get(threadId)?.turnId;
    this.threads.set(threadId, {
      ...parsed.summary,
      providerId,
      model: current?.model || parsed.summary.model,
      status: busyTurnId
        ? current?.status === "waiting"
          ? "waiting"
          : "running"
        : current?.status === "running" || current?.status === "waiting"
          ? "idle"
          : current?.status || parsed.summary.status,
      activeTurnId: busyTurnId,
      lastError: current?.lastError,
      resolvedModel:
        this.active.has(threadId) || busyTurnId
          ? current?.resolvedModel || parsed.summary.resolvedModel
          : parsed.summary.resolvedModel || current?.resolvedModel,
      tokenUsage:
        this.active.has(threadId) || busyTurnId
          ? current?.tokenUsage || diskUsage
          : diskUsage || current?.tokenUsage,
      forkedFromId: current?.forkedFromId,
      permissionMode: current?.permissionMode || "default",
      controlMode: "managed",
      claudeConnected: Boolean(this.active.get(threadId)),
      ...settings,
    });
    this.broadcast("thread.updated", this.threads.get(threadId));
  }

  private redact(value: string) {
    let redacted = value;
    const hide = (secret: string) => {
      if (secret.length >= 8)
        redacted = redacted.split(secret).join("[REDACTED]");
    };
    for (const profileEnv of [
      ...this.profiles.map((profile) => profile.env),
      ...[...this.active.values()].map((current) => current.profileEnv),
    ])
      for (const [key, secret] of Object.entries(profileEnv))
        if (/token|secret|api.?key|password|headers/i.test(key) && secret) {
          hide(secret);
          if (/headers/i.test(key))
            for (const line of secret.split(/[\r\n]+/)) {
              const headerValue = line.slice(line.indexOf(":") + 1).trim();
              if (line.includes(":")) hide(headerValue);
            }
        }
    // 本机配置档透传 shell 环境：ambient Anthropic 凭据同样不能漏进
    // 错误信息、快照或事件。
    for (const key of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_CUSTOM_HEADERS",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]) {
      const secret = process.env[key];
      if (secret) {
        hide(secret);
        if (key === "ANTHROPIC_CUSTOM_HEADERS")
          for (const line of secret.split(/[\r\n]+/)) {
            const headerValue = line.slice(line.indexOf(":") + 1).trim();
            if (line.includes(":")) hide(headerValue);
          }
      }
    }
    return redacted;
  }
}
