import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { killProcessTree, stopChildProcess } from "../process-tree.js";
import { findFreeListenPort } from "../runtime-port.js";
import type {
  ApprovalKind,
  ApprovalQuestion,
  ModelInfo,
  ThreadSummary,
  TokenUsage,
  TurnImage,
} from "../types.js";
import type { ThreadSettingsStore } from "../thread-settings.js";
import type { AgentCapabilities, AgentDescriptor, AgentId } from "./types.js";

const OPENCODE_CAPABILITIES: AgentCapabilities = {
  approvals: true,
  // Deck 侧软归档：OpenCode serve 没有原生归档接口，归档态由 Deck
  // 持久化（thread-settings `archived`），服务端会话原样保留。
  archive: true,
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

type Fetcher = typeof fetch;

interface OpenCodeAdapterOptions {
  bin?: string;
  fetcher?: Fetcher;
  spawnProcess?: (
    command: string,
    args: string[],
    options: {
      env: NodeJS.ProcessEnv;
      stdio: ["ignore", "ignore", "pipe"];
      windowsHide: boolean;
      windowsVerbatimArguments?: boolean;
    },
  ) => ChildProcess;
  port?: number;
  platform?: NodeJS.Platform;
  /**
   * Windows 上真实的 server 是 `cmd.exe` 包裹层身后的孙进程，
   * 默认用 `taskkill /T` 连带结束；测试可注入 mock 断言。
   */
  killProcessTree?: (pid: number) => void;
  initialThreads?: ThreadSummary[];
  initialDirectories?: string[];
  threadSettings?: ThreadSettingsStore;
}

function windowsCommand(command: string, args: string[]) {
  if (/\r|\n|"/.test(command))
    throw new Error("OPENCODE_BIN 包含 Windows cmd 不支持的字符");
  const values = [command, ...args];
  return `call ${values.map((value) => `"${value}"`).join(" ")}`;
}

type OpenCodeSession = {
  id: string;
  directory?: string;
  title?: string;
  /** OpenCode generates this readable name; `title` stays empty until renamed. */
  slug?: string;
  model?: { id?: string; providerID?: string; variant?: string };
  /** Set on child sessions spawned by subagents; they are not Deck threads. */
  parentID?: string;
  time?: { created?: number; updated?: number };
};

type OpenCodeProfile = {
  id: string;
  name: string;
  models?: Record<string, OpenCodeModelMeta>;
};

type OpenCodeModelMeta = {
  name?: string;
  displayName?: string;
  attachment?: boolean;
  modalities?: { input?: string[] };
  /** Current shape: `capabilities.input.image`; older builds used the rest. */
  capabilities?: { attachment?: boolean; input?: { image?: boolean } };
  variants?: Record<string, unknown>;
  limit?: { context?: number; output?: number };
};

function modelSupportsImages(meta?: OpenCodeModelMeta): boolean | undefined {
  if (!meta) return undefined;
  const image = meta.capabilities?.input?.image;
  if (typeof image === "boolean") return image;
  const attachment = meta.capabilities?.attachment;
  if (typeof attachment === "boolean") return attachment;
  const inputs = meta.modalities?.input;
  if (Array.isArray(inputs))
    return inputs.some((item) => /^image/i.test(String(item)));
  if (typeof meta.attachment === "boolean") return meta.attachment;
  return undefined;
}

/** Reasoning effort in OpenCode is a model variant: low / medium / high / max. */
function modelVariants(meta?: OpenCodeModelMeta) {
  const names = Object.keys(meta?.variants || {}).filter(Boolean);
  return names.length
    ? names.map((name) => ({ reasoningEffort: name }))
    : undefined;
}

function normalizeProfiles(value: unknown): OpenCodeProfile[] {
  if (Array.isArray(value)) return value as OpenCodeProfile[];
  if (value && typeof value === "object") {
    const record = value as { all?: unknown; providers?: unknown };
    const list = record.all || record.providers;
    if (Array.isArray(list)) return list as OpenCodeProfile[];
    if (list && typeof list === "object")
      return Object.entries(list).map(([id, profile]) => ({
        ...(profile as object),
        id: (profile as OpenCodeProfile).id || id,
        name: (profile as OpenCodeProfile).name || id,
      }));
  }
  return [];
}

function normalizeSessions(value: unknown): OpenCodeSession[] {
  if (Array.isArray(value)) return value as OpenCodeSession[];
  if (value && typeof value === "object") {
    const sessions = (value as { data?: unknown; sessions?: unknown }).data;
    if (Array.isArray(sessions)) return sessions as OpenCodeSession[];
    const listed = (value as { sessions?: unknown }).sessions;
    if (Array.isArray(listed)) return listed as OpenCodeSession[];
  }
  return [];
}

/**
 * `/provider` answers `{ all, connected, default }`. `connected` holds the
 * providers OpenCode can actually call right now; the rest of the catalog is
 * still browsable but must not be presented as if it were usable.
 */
function connectedProviderIds(value: unknown): Set<string> {
  if (!value || typeof value !== "object") return new Set();
  const record = value as { connected?: unknown };
  const list = Array.isArray(record.connected) ? record.connected : [];
  const ids = new Set<string>();
  for (const item of list) {
    const id =
      typeof item === "string"
        ? item
        : item && typeof item === "object"
          ? String((item as { id?: unknown }).id ?? "")
          : "";
    if (id.trim()) ids.add(id.trim());
  }
  return ids;
}

function configDefaultModel(config: unknown) {
  const providerID = String(
    (config as any)?.model?.providerID ?? "",
  ).trim();
  const modelID = String((config as any)?.model?.modelID ?? "").trim();
  return providerID && modelID ? { providerID, modelID } : undefined;
}

function requestUrl(baseUrl: string, pathname: string, directory?: string) {
  const url = new URL(pathname, baseUrl);
  if (directory) url.searchParams.set("directory", directory);
  return url;
}

function profileId(session: OpenCodeSession) {
  return `opencode:${session.directory || "current"}`;
}

function sessionSummary(
  session: OpenCodeSession,
  status: ThreadSummary["status"] = "idle",
): ThreadSummary {
  const name = session.title || session.slug || "OpenCode 会话";
  const variant = session.model?.variant;
  return {
    agentId: "opencode",
    id: session.id,
    providerId: profileId(session),
    name,
    preview: name,
    cwd: session.directory || "",
    model: "default",
    ...(variant && variant !== "default" ? { reasoningEffort: variant } : {}),
    status,
    updatedAt: Number(
      session.time?.updated || session.time?.created || Date.now(),
    ),
    sessionId: session.id,
    controlMode: "managed",
  };
}

/**
 * 和 Codex 对齐：OpenCode 的 `slug` 只是服务端随机生成的
 * `形容词-名词`（如 witty-comet），`title` 为空直到手动重命名。
 * 有首条用户消息时，用它做 name/preview，而不是展示随机 slug。
 */
const DEFAULT_OPENCODE_NAMES = new Set(["OpenCode 会话", "新 OpenCode 会话"]);

function cleanOpenCodePreview(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstOpenCodeUserPreview(records: any[]) {
  for (const record of records || []) {
    const message = record?.info || record?.message || record;
    if (message?.role !== "user") continue;
    const parts = Array.isArray(record?.parts) ? record.parts : [];
    const text = parts
      .filter((part: any) => part?.type === "text" && part?.text)
      .map((part: any) => String(part.text))
      .join(" ");
    const cleaned =
      cleanOpenCodePreview(text) ||
      cleanOpenCodePreview((message as any)?.content);
    if (cleaned) return cleaned;
  }
  return "";
}

/** 随机 slug 长这样：curious-comet / neon-lagoon，全小写字母加连字符。 */
function isOpenCodeSlug(value?: string) {
  return /^[a-z]{3,}-[a-z]{3,}(?:-[a-z]{3,})?$/.test(String(value || "").trim());
}

function isOpenCodeDefaultName(name?: string) {
  const value = String(name || "").trim();
  if (!value) return true;
  if (DEFAULT_OPENCODE_NAMES.has(value)) return true;
  return isOpenCodeSlug(value);
}

function textPart(text: string) {
  return { type: "text", text };
}

function imagePart(image: TurnImage) {
  return {
    type: "file",
    url: image.url,
    mime: image.url.match(/^data:(image\/[^;,]+)/i)?.[1] || "image/png",
    filename: image.name,
  };
}

function normalizeMessages(
  session: OpenCodeSession,
  records: any[],
  activeTurnId?: string,
) {
  const turns: any[] = [];
  let turn: any;
  for (const record of records || []) {
    const message = record?.info || record?.message || record;
    const parts = Array.isArray(record?.parts) ? record.parts : [];
    if (message?.role === "user") {
      turn = {
        id: String(message.id || randomUUID()),
        status: "completed",
        startedAt: Number(message.time?.created || Date.now()),
        items: [
          {
            id: String(message.id || randomUUID()),
            type: "userMessage",
            content: parts
              .filter(
                (part: any) => part.type === "text" || part.type === "file",
              )
              .map((part: any) =>
                part.type === "file"
                  ? { type: "image", url: part.url, name: part.filename }
                  : textPart(String(part.text || "")),
              ),
          },
        ],
      };
      turns.push(turn);
      continue;
    }
    if (message?.role !== "assistant" || !turn) continue;
    for (const part of parts) {
      const mapped = openCodePartToItem(part);
      if (mapped) turn.items.push(mapped);
    }
  }
  if (activeTurnId && turns.length > 0) {
    const activeTurn = turns[turns.length - 1];
    activeTurn.id = activeTurnId;
    activeTurn.status = "inProgress";
  }
  return {
    id: session.id,
    cwd: session.directory || "",
    model: "default",
    turns,
  };
}

/** Newest assistant message of a session, or undefined before the first reply. */
function lastAssistantInfo(records: any[]) {
  for (let index = (records || []).length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const info = record?.info || record?.message || record;
    if (info?.role === "assistant") return info;
  }
  return undefined;
}

/**
 * Newest assistant message that actually carries token counts. Aborted or
 * failed turns still leave an assistant message behind, but with all-zero
 * tokens; using it would display a bogus "0/xxx" context chip.
 */
function lastAssistantWithUsage(records: any[]) {
  for (let index = (records || []).length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const info = record?.info || record?.message || record;
    if (info?.role !== "assistant") continue;
    const tokens = info.tokens || {};
    const cache = tokens.cache || {};
    if (
      tokenNumber(tokens.input) +
        tokenNumber(tokens.output) +
        tokenNumber(tokens.reasoning) +
        tokenNumber(cache.read) +
        tokenNumber(cache.write) >
      0
    )
      return info;
  }
  return undefined;
}

function tokenNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Maps a native OpenCode part to the shared Codex-shaped turn item. Tool
 * parts keep their structured input/metadata and unknown part types become
 * `extension` items with the raw payload attached so per-agent frontend
 * adapters can render what OpenCode natively produced (todos, questions...).
 */
export function openCodePartToItem(part: any): any | undefined {
  if (!part?.type && !part?.tool) return undefined;
  if (
    ["step-start", "step-finish", "snapshot", "patch"].includes(
      String(part.type),
    )
  )
    return undefined;
  if (part.type === "text")
    return { id: String(part.id), type: "agentMessage", text: part.text || "" };
  if (part.type === "reasoning")
    return { id: String(part.id), type: "reasoning", summary: part.text || "" };
  if (part.type === "tool") {
    const state = part.state || {};
    if (part.tool === "task") {
      const input =
        state.input && typeof state.input === "object" ? state.input : {};
      const childSessionId = String(state.metadata?.sessionId || "").trim();
      return {
        id: String(part.id),
        type: "subagent",
        title: String(input.description || state.title || part.tool).trim(),
        agent: String(
          input.subagent_type || input.agent || input.agentType || "",
        ).trim(),
        status:
          state.status === "error"
            ? "failed"
            : state.status === "completed"
              ? "completed"
              : "inProgress",
        activity: String(state.metadata?.deckActivity || ""),
        aggregatedOutput: state.output || state.error || "",
        ...(childSessionId ? { childSessionId } : {}),
      };
    }
    const item: any = {
      id: String(part.id),
      type: "commandExecution",
      command: state.title || part.tool || "OpenCode 工具",
      status:
        state.status === "error"
          ? "failed"
          : state.status === "completed"
            ? "completed"
            : "inProgress",
      aggregatedOutput: state.output || state.error || "",
      ...(part.tool ? { tool: part.tool } : {}),
      ...(state.input != null ? { input: state.input } : {}),
      ...(state.metadata != null ? { metadata: state.metadata } : {}),
    };
    const todos = opencodeTodos(item);
    if (todos.length) item.todos = todos;
    return item;
  }
  if (part.type === "file") return undefined;
  return {
    id: String(part.id),
    type: "extension",
    kind: String(part.type || "unknown"),
    agentId: "opencode",
    payload: part,
  };
}

/** Todos emitted by OpenCode's todo tools live in state.input or state.metadata. */
export function opencodeTodos(item: any): any[] {
  for (const source of [item?.metadata?.todos, item?.input?.todos, item?.input?.items]) {
    if (Array.isArray(source) && source.length)
      return source.filter(Boolean).map((todo: any) =>
        typeof todo === "string"
          ? { content: todo }
          : { ...todo, content: String(todo.content ?? todo.text ?? todo.title ?? "") },
      );
  }
  return [];
}

/** Readable one-line progress from a subagent session part, if any. */
export function childActivityText(part: any): string | undefined {
  if (part?.type === "tool") {
    const title = String(part.state?.title || "").trim();
    return title || undefined;
  }
  if (part?.type === "text") {
    const text = String(part.text || "").replace(/\s+/g, " ").trim();
    if (!text) return undefined;
    return text.length > 160 ? `…${text.slice(-160)}` : text;
  }
  return undefined;
}

/** Replays a parent task part snapshot with the latest child activity attached. */
export function withChildActivity(part: any, activity: string) {
  const state = part?.state || {};
  return {
    ...part,
    state: {
      ...state,
      metadata: { ...(state.metadata || {}), deckActivity: activity },
    },
  };
}

function permissionQuestions(permission: any): ApprovalQuestion[] | undefined {
  if (!/question|ask/i.test(String(permission?.type || ""))) return undefined;
  const meta = permission.metadata && typeof permission.metadata === "object" ? permission.metadata : {};
  const rawOptions = meta.options ?? meta.choices ?? meta.answers;
  const options = Array.isArray(rawOptions)
    ? rawOptions.map((option: any) =>
        typeof option === "string"
          ? { label: option, value: option }
          : {
              label: String(option.label ?? option.value ?? ""),
              value: String(option.value ?? option.label ?? option.id ?? ""),
            },
      )
    : [];
  return [
    {
      id: String(permission.id || ""),
      prompt:
        meta.question ?? meta.message ?? permission.title ?? undefined,
      header: typeof meta.header === "string" ? meta.header : undefined,
      options,
    },
  ];
}

export class OpenCodeAdapter extends EventEmitter {
  readonly id: AgentId = "opencode";
  private threads = new Map<string, ThreadSummary>();
  private profiles: OpenCodeProfile[] = [];
  private connected = new Set<string>();
  private configDefault?: { providerID: string; modelID: string };
  private approvals = new Map<string, any>();
  /** Role of the last seen OpenCode message, used to skip replayed user parts. */
  private messageRoles = new Map<string, string>();
  /**
   * OpenCode 服务端的 `title`（手动重命名才有）。有它时首条消息
   * 不得覆盖用户起的名字；没它时才用首条消息对齐 Codex。
   */
  private sessionTitles = new Map<string, string>();
  /** 子会话 → 父会话 ID：subagent 会话不是 Deck thread，但活动要挂回父会话。 */
  private childParents = new Map<string, string>();
  /** 子会话 ID → 父会话里派发它的 task 工具 part ID。 */
  private childTaskParts = new Map<string, string>();
  /** task part ID → 最近一次父会话 task part 快照，转发子代理活动时用它补全。 */
  private taskPartSnapshots = new Map<string, any>();
  /** 子代理活动先于 task part 的 sessionId 元数据到达时先缓冲。 */
  private pendingChildActivity = new Map<string, string>();
  private online = false;
  private starting = false;
  private startingTask?: Promise<void>;
  private error?: string;
  private baseUrl?: string;
  private process?: ChildProcess;
  private eventAbort?: AbortController;
  private fetcher: Fetcher;
  private processStderr = "";

  constructor(private options: OpenCodeAdapterOptions = {}) {
    super();
    this.fetcher = options.fetcher || fetch;
    for (const thread of options.initialThreads || []) {
      if (thread.agentId !== this.id) continue;
      this.threads.set(thread.id, {
        ...thread,
        ...options.threadSettings?.get(this.id, thread.id),
        agentId: this.id,
      });
    }
  }

  descriptor(): AgentDescriptor {
    return {
      id: this.id,
      name: "OpenCode",
      available: Boolean(
        this.options.bin || process.env.OPENCODE_BIN || "opencode",
      ),
      online: this.online,
      starting: this.starting,
      error: this.error,
      historyStatus: this.online
        ? "ready"
        : this.starting
          ? "loading"
          : "cached",
      capabilities: OPENCODE_CAPABILITIES,
    };
  }

  snapshot() {
    const threads = this.listThreads();
    return {
      threads,
      archivedThreads: [...this.threads.values()]
        .filter((thread) => thread.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
      approvals: [...this.approvals.values()],
    };
  }

  /**
   * Providers OpenCode can actually use first: the configured default, then
   * every connected provider, then the rest of the (still browsable) catalog.
   */
  private rankedProfiles() {
    const rank = (id: string) =>
      this.configDefault?.providerID === id
        ? 0
        : this.connected.has(id)
          ? 1
          : 2;
    return this.profiles
      .map((profile, index) => ({ profile, index, rank: rank(profile.id) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.profile);
  }

  publicProfiles() {
    return this.rankedProfiles().map((profile) => ({
      id: profile.id,
      agentId: this.id,
      name: profile.name,
      enabled: true,
      online: this.online,
      ...(this.configDefault?.providerID === profile.id
        ? { current: true }
        : {}),
      ...(this.connected.has(profile.id) ? { connected: true } : {}),
    }));
  }

  listModels(providerId?: string): ModelInfo[] {
    const matched = providerId
      ? this.profiles.filter((item) => item.id === providerId)
      : this.rankedProfiles();
    const scope = matched.length ? matched : this.rankedProfiles();
    const entries: ModelInfo[] = [];
    for (const profile of scope) {
      const groupName = profile.name || profile.id;
      const connected = this.connected.has(profile.id);
      for (const [id, model] of Object.entries(profile.models || {})) {
        entries.push({
          id: `${profile.id}/${id}`,
          model: `${profile.id}/${id}`,
          displayName: model.name || model.displayName || id,
          groupName,
          isDefault:
            this.configDefault?.providerID === profile.id &&
            this.configDefault.modelID === id
              ? true
              : undefined,
          ...(connected ? { connected: true } : {}),
          supportedReasoningEfforts: modelVariants(model),
          supportsImages: modelSupportsImages(model),
        });
      }
    }
    return [
      {
        id: "default",
        model: "default",
        displayName: "跟随 OpenCode 默认",
        isDefault: !this.configDefault ? true : undefined,
      },
      ...entries,
    ];
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
      // 已有健康 server 时直接复用，避免每次 startAll 都另起一个端口泄漏。
      if (await this.reuseHealthyServer()) return;
      const port = this.options.port || (await findFreeListenPort());
      this.baseUrl = `http://127.0.0.1:${port}`;
      const platform = this.options.platform || process.platform;
      const configuredCommand = this.options.bin || process.env.OPENCODE_BIN;
      let command =
        configuredCommand ||
        (platform === "win32" ? "opencode.cmd" : "opencode");
      if (platform === "win32" && command.toLowerCase() === "opencode")
        command = "opencode.cmd";
      const serveArgs = [
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ];
      const commandIsBatch =
        platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
      const spawnCommand = commandIsBatch
        ? process.env.ComSpec || "cmd.exe"
        : command;
      const spawnArgs = commandIsBatch
        ? ["/d", "/s", "/c", windowsCommand(command, serveArgs)]
        : serveArgs;
      const spawnProcess =
        this.options.spawnProcess ||
        ((bin, args, opts) => spawn(bin, args, opts));
      const child = spawnProcess(spawnCommand, spawnArgs, {
        env: process.env,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: commandIsBatch || undefined,
      });
      this.process = child;
      this.processStderr = "";
      child.stderr?.on("data", (chunk) => {
        this.processStderr = `${this.processStderr}${String(chunk)}`.slice(
          -4_000,
        );
      });
      let ready = false;
      let rejectProcessFailure: (error: Error) => void = () => undefined;
      const processFailure = new Promise<never>((_resolve, reject) => {
        rejectProcessFailure = reject;
      });
      const failed = (error: Error) => {
        if (this.process !== child) return;
        const detail = this.processError(error);
        if (ready) {
          // The process has already exited; do not run taskkill against its
          // PID because Windows may have reused it for another OpenCode.
          this.process = undefined;
          this.eventAbort?.abort();
          this.eventAbort = undefined;
          this.offline(detail);
        } else rejectProcessFailure(detail);
      };
      child.once("error", (error) => failed(error));
      child.once("exit", (code, signal) =>
        failed(
          new Error(
            `OpenCode server 已退出${code == null ? "" : `（代码 ${code}）`}${signal ? `（信号 ${signal}）` : ""}`,
          ),
        ),
      );
      await Promise.race([this.waitForHealth(), processFailure]);
      ready = true;
      this.online = true;
      this.error = undefined;
      await this.refreshAll();
      void this.consumeEvents();
    } catch (error: any) {
      const detail = this.processError(error);
      const child = this.process;
      this.process = undefined;
      this.killChild(child);
      this.offline(detail);
      throw detail;
    } finally {
      this.starting = false;
      this.broadcast("agent.status", this.descriptor());
    }
  }

  /**
   * Merges a native session into the Deck thread. OpenCode owns the title,
   * directory and timestamps; Deck keeps the settings it was given at
   * creation time (model, provider, live status) so a `session.created` or
   * `session.updated` event cannot downgrade a thread back to `default`.
   */
  private mergeThread(session: OpenCodeSession, existing?: ThreadSummary) {
    const busy =
      existing?.status === "running" || existing?.status === "waiting";
    const summary = sessionSummary(session, busy ? existing!.status : "idle");
    const settings = this.options.threadSettings?.get(this.id, session.id);
    const title = String(session.title || "").trim();
    this.sessionTitles.set(session.id, title);
    const merged: ThreadSummary = {
      ...summary,
      ...existing,
      ...settings,
      agentId: this.id,
      name: session.title || existing?.name || session.slug || summary.name,
      preview:
        session.title || existing?.preview || session.slug || summary.preview,
      cwd: session.directory || existing?.cwd || summary.cwd,
      updatedAt: Math.max(summary.updatedAt, existing?.updatedAt || 0),
    };
    // 旧版本会把“仅有上下文上限、没有 token 记录”的用量也存进缓存，
    // 刷新时清掉这种 used=0 残留，避免侧栏一直显示 0/xxx。
    if (!merged.tokenUsage?.used) delete merged.tokenUsage;
    return merged;
  }

  /**
   * 和 Codex 一致：没有服务端 title 时，用首条用户消息做标题。
   * 有 title（新建时填了名 / 手动重命名）时绝不覆盖。
   */
  private applyFirstMessageNaming(thread: ThreadSummary, records: any[]) {
    if (String(this.sessionTitles.get(thread.id) || "").trim()) return thread;
    const preview = firstOpenCodeUserPreview(records);
    if (!preview) return thread;
    // 重启后标题表是空的，这时只覆盖随机 slug / 默认名，
    // 自定义名字（和 preview 不一致、也不是 slug）一律保留。
    if (
      this.sessionTitles.has(thread.id) ||
      isOpenCodeDefaultName(thread.name) ||
      isOpenCodeDefaultName(thread.preview)
    ) {
      const next: ThreadSummary = {
        ...thread,
        name: preview.slice(0, 42),
        preview,
      };
      this.threads.set(next.id, next);
      this.broadcast("thread.updated", next);
      return next;
    }
    return thread;
  }

  async refreshAll() {
    const directories = new Set(
      [
        ...(this.options.initialDirectories || []),
        ...[...this.threads.values()].map((thread) => thread.cwd),
      ].filter(Boolean),
    );
    const sessionResponses = await Promise.all([
      this.request<unknown>("/session"),
      ...[...directories].map((directory) =>
        this.request<unknown>("/session", { directory }).catch(() => []),
      ),
    ]);
    const sessions = sessionResponses.flatMap(normalizeSessions);
    const [providers, config] = await Promise.all([
      this.request<unknown>("/provider").catch(() => []),
      this.request<unknown>("/config").catch(() => undefined),
    ]);
    this.profiles = normalizeProfiles(providers);
    this.connected = connectedProviderIds(providers);
    this.configDefault = configDefaultModel(config);
    const seen = new Set<string>();
    for (const session of sessions) {
      // Subagent sessions are children of the thread that spawned them and
      // must not surface as separate Deck sessions. Still remember the
      // parent link so their streamed activity can be attached to the
      // parent's task card.
      if (session.parentID) {
        this.boundedPut(this.childParents, session.id, session.parentID);
        continue;
      }
      seen.add(session.id);
      this.threads.set(
        session.id,
        this.mergeThread(session, this.threads.get(session.id)),
      );
    }
    for (const [child, parent] of this.childParents)
      if (!this.threads.has(parent)) {
        this.childParents.delete(child);
        const partId = this.childTaskParts.get(child);
        if (partId) this.taskPartSnapshots.delete(partId);
        this.childTaskParts.delete(child);
        this.pendingChildActivity.delete(child);
      }
    this.broadcast("agent.status", this.descriptor());
    this.broadcast("snapshot", this.snapshot());
  }

  busyThreads() {
    return this.listThreads().filter(
      (thread) => thread.status === "running" || thread.status === "waiting",
    );
  }

  /**
   * 已有 server 且健康检查通过时复用它；事件流沿用旧的，不重复订阅。
   * 不健康则终止当前直接子进程，返回 false 让调用方重新拉起。
   */
  private async reuseHealthyServer(): Promise<boolean> {
    const child = this.process;
    if (!this.online || !child || !this.baseUrl) return false;
    if (child.killed || child.exitCode != null) return false;
    try {
      const healthy = await Promise.race([
        this.request("/global/health").then(
          () => true,
          () => false,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
      if (healthy) {
        await this.refreshAll();
        return true;
      }
    } catch {
      // 走到下面按不健康处理。
    }
    // A failed health probe can race the child's `exit` notification.  Avoid
    // taskkill /T here: a stale PID could already belong to another OpenCode.
    this.killDirectChild(child);
    if (this.process === child) this.process = undefined;
    // 旧 server 已死，它上面的 SSE 流也要停掉，否则旧循环会把 error
    // 写回 descriptor，覆盖新 server 的健康状态。
    this.eventAbort?.abort();
    this.eventAbort = undefined;
    this.online = false;
    return false;
  }

  private killChild(child: ChildProcess | undefined) {
    if (!child) return;
    // Never taskkill a process that has already exited: on Windows the PID
    // may have been reused by an unrelated OpenCode instance.
    if (child.killed || child.exitCode != null || child.signalCode != null) {
      try {
        child.kill();
      } catch {
        // Ignore: the process may already be gone.
      }
      return;
    }
    stopChildProcess(
      child,
      this.options.killProcessTree || killProcessTree,
    );
  }

  private killDirectChild(child: ChildProcess | undefined) {
    if (!child) return;
    try {
      child.kill();
    } catch {
      // Ignore: the process may already be gone.
    }
  }

  restart() {
    this.eventAbort?.abort();
    this.eventAbort = undefined;
    const child = this.process;
    this.process = undefined;
    this.killChild(child);
    this.online = false;
    for (const thread of this.busyThreads()) {
      thread.status = "offline";
      thread.activeTurnId = undefined;
    }
  }

  /** 现有库：归档会话不在这里，在 `snapshot().archivedThreads` 里。 */
  listThreads() {
    return [...this.threads.values()]
      .filter((thread) => !thread.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createThread(
    providerId: string,
    input: {
      cwd: string;
      name?: string;
      model?: string;
      reasoningEffort?: string;
    },
  ) {
    const session = await this.request<OpenCodeSession>("/session", {
      method: "POST",
      directory: input.cwd,
      body: { title: input.name },
    });
    const displayName = input.name || session.title || "新 OpenCode 会话";
    this.sessionTitles.set(session.id, String(input.name || session.title || "").trim());
    const effort = input.reasoningEffort?.trim() || undefined;
    const thread = {
      ...sessionSummary(session),
      providerId: providerId || profileId(session),
      cwd: input.cwd,
      model: input.model || "default",
      ...(effort ? { reasoningEffort: effort } : {}),
      // 新会话没有首条消息前不展示随机 slug，和 Codex 的“新会话”一致。
      name: displayName,
      preview: displayName,
    };
    // Persist the picked model/effort so the next refresh (or a Deck restart)
    // keeps them instead of falling back to OpenCode's own default.
    if (input.model || effort) {
      const patch: { model?: string; reasoningEffort?: string } = {};
      if (input.model) patch.model = input.model;
      if (effort) patch.reasoningEffort = effort;
      await this.options.threadSettings?.update(this.id, thread.id, patch);
    }
    this.threads.set(thread.id, thread);
    this.broadcast("thread.updated", thread);
    return thread;
  }

  /**
   * OpenCode stores per-message token counts instead of a running context
   * total, so the newest assistant message is what Deck can show as "context
   * used", next to the context window the model itself advertises.
   */
  private applyThreadUsage(thread: ThreadSummary, records: any[]) {
    const info = lastAssistantInfo(records);
    const usageInfo = lastAssistantWithUsage(records);
    const infoProvider = String(info?.providerID || "").trim();
    const infoModel = String(info?.modelID || "").trim();
    const resolved =
      infoProvider && infoModel
        ? `${infoProvider}/${infoModel}`
        : thread.model && thread.model !== "default"
          ? thread.model
          : this.configDefault
            ? `${this.configDefault.providerID}/${this.configDefault.modelID}`
            : undefined;
    const providerID = String(usageInfo?.providerID || "").trim();
    const modelID = String(usageInfo?.modelID || "").trim();
    const tokens = usageInfo?.tokens || {};
    const cache = tokens.cache || {};
    const input = tokenNumber(tokens.input);
    const output = tokenNumber(tokens.output);
    const reasoning = tokenNumber(tokens.reasoning);
    const cachedInput = tokenNumber(cache.read) + tokenNumber(cache.write);
    const used = input + output + reasoning + cachedInput;
    const limit =
      providerID && modelID
        ? this.modelContextLimit(providerID, modelID)
        : undefined;
    // 只有拿到真实 token 记录才生成用量；仅有上限没有用量时会显示成
    // 误导性的 “0/xxx”，不如不显示。
    const tokenUsage: TokenUsage | undefined =
      used > 0 ? { input, cachedInput, output, reasoningOutput: reasoning, used, limit } : undefined;
    const sameUsage =
      thread.tokenUsage?.used === tokenUsage?.used &&
      thread.tokenUsage?.limit === tokenUsage?.limit;
    if (resolved === thread.resolvedModel && sameUsage) return thread;
    const next: ThreadSummary = {
      ...thread,
      ...(resolved ? { resolvedModel: resolved } : {}),
    };
    if (tokenUsage) next.tokenUsage = tokenUsage;
    else delete next.tokenUsage;
    this.threads.set(next.id, next);
    this.broadcast("thread.updated", next);
    return next;
  }

  /** Effort chosen in Deck, kept only when the model in use advertises it. */
  private threadVariant(thread: ThreadSummary) {
    const effort = thread.reasoningEffort?.trim();
    if (!effort) return undefined;
    const parsed = this.modelInput(thread.model || thread.resolvedModel || "");
    if (!parsed) return undefined;
    const model = this.profiles.find((item) => item.id === parsed.providerID)
      ?.models?.[parsed.modelID];
    const supported = modelVariants(model);
    if (!supported?.some((item) => item.reasoningEffort === effort))
      return undefined;
    return effort;
  }

  private modelContextLimit(providerID: string, modelID: string) {
    const profile = this.profiles.find((item) => item.id === providerID);
    const limit = profile?.models?.[modelID]?.limit?.context;
    return typeof limit === "number" && limit > 0 ? limit : undefined;
  }

  async readThread(_providerId: string, threadId: string) {
    const thread = this.requireThread(threadId);
    const records = await this.request<any[]>(
      `/session/${encodeURIComponent(threadId)}/message`,
      { directory: thread.cwd },
    );
    const renamed = this.applyFirstMessageNaming(thread, records);
    const current = this.applyThreadUsage(renamed, records);
    return {
      ...normalizeMessages(
        { id: current.id, directory: current.cwd },
        records,
        current.status === "running" || current.status === "waiting"
          ? current.activeTurnId
          : undefined,
      ),
      agentId: this.id,
      providerId: current.providerId,
      model: current.model,
      ...(current.resolvedModel
        ? { resolvedModel: current.resolvedModel }
        : {}),
      ...(current.tokenUsage ? { tokenUsage: current.tokenUsage } : {}),
    };
  }

  async renameThread(_providerId: string, threadId: string, name: string) {
    const thread = this.requireThread(threadId);
    const next = name.trim();
    if (!next) throw new Error("会话名称不能为空");
    await this.request(`/session/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      directory: thread.cwd,
      body: { title: next },
    });
    this.sessionTitles.set(threadId, next);
    thread.name = next;
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    return thread;
  }

  /**
   * Deck 侧软归档：OpenCode serve 没有归档接口，服务端会话原样保留，
   * 只是不再出现在现有库；归档态写进 thread-settings，重启不丢失。
   */
  async archiveThread(_providerId: string, threadId: string) {
    const thread = this.requireThread(threadId);
    if (thread.archived) return thread;
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("运行中的 OpenCode 会话不能归档");
    thread.archived = true;
    thread.updatedAt = Date.now();
    await this.options.threadSettings?.update(this.id, threadId, {
      archived: true,
    });
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async unarchiveThread(_providerId: string, threadId: string) {
    const thread = this.requireThread(threadId);
    if (!thread.archived) return thread;
    thread.archived = false;
    thread.updatedAt = Date.now();
    await this.options.threadSettings?.update(this.id, threadId, {
      archived: null,
    });
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async updateThreadSettings(
    _providerId: string,
    threadId: string,
    settings: { model?: string; reasoningEffort?: string },
  ) {
    const thread = this.requireThread(threadId);
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("任务结束后才能修改 OpenCode 会话设置");
    if (settings.model) thread.model = settings.model;
    if (settings.reasoningEffort !== undefined)
      thread.reasoningEffort = settings.reasoningEffort || undefined;
    // Same persistence as createThread: a refresh or restart must not drop the
    // model/effort picked in Deck.
    await this.options.threadSettings?.update(this.id, threadId, {
      model: thread.model,
      reasoningEffort: settings.reasoningEffort,
    });
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async deleteThread(_providerId: string, threadId: string) {
    const thread = this.requireThread(threadId);
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("运行中的 OpenCode 会话不能删除");
    await this.request(`/session/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
      directory: thread.cwd,
    });
    this.threads.delete(threadId);
    this.sessionTitles.delete(threadId);
    this.broadcast("thread.deleted", { agentId: this.id, threadId });
    return { ok: true };
  }

  async sendTurn(
    _providerId: string,
    threadId: string,
    text: string,
    images?: TurnImage[],
  ) {
    const thread = this.requireThread(threadId);
    if (!text.trim() && !images?.length) throw new Error("请输入指令或图片");
    if (thread.archived) throw new Error("会话已归档，请先恢复再发送");
    const parsed =
      thread.model && thread.model !== "default"
        ? this.modelInput(thread.model)
        : undefined;
    if (images?.length && parsed) {
      const meta = this.profiles.find(
        (item) => item.id === parsed.providerID,
      )?.models?.[parsed.modelID];
      if (modelSupportsImages(meta) === false)
        throw new Error(
          `当前模型 ${thread.model} 不支持图片输入，请移除图片或改用支持视觉的模型后再发送`,
        );
    }
    const turnId = randomUUID();
    thread.status = "running";
    thread.activeTurnId = turnId;
    thread.lastError = undefined;
    thread.updatedAt = Date.now();
    // 首条消息先在本地落标题，和 Codex 一样不用等服务端回包。
    const optimistic = cleanOpenCodePreview(text);
    if (
      optimistic &&
      !String(this.sessionTitles.get(threadId) || "").trim() &&
      (isOpenCodeDefaultName(thread.name) ||
        isOpenCodeDefaultName(thread.preview) ||
        !this.sessionTitles.has(threadId))
    ) {
      // 重启后标题表未知时同样只覆盖 slug/默认名，自定义名不动。
      if (
        this.sessionTitles.has(threadId) ||
        isOpenCodeDefaultName(thread.name)
      ) {
        thread.name = optimistic.slice(0, 42);
        thread.preview = optimistic;
      }
    }
    this.broadcast("thread.updated", thread);
    this.emitAgentEvent(thread, "turn/started", {
      threadId,
      turn: { id: turnId, status: "inProgress" },
    });
    const model = parsed;
    // The reasoning effort is a per-message variant; only send one the model
    // actually advertises, otherwise OpenCode rejects the request.
    const variant = this.threadVariant(thread);
    await this.request(`/session/${encodeURIComponent(threadId)}/message`, {
      method: "POST",
      directory: thread.cwd,
      body: {
        parts: [
          ...(text ? [textPart(text)] : []),
          ...(images || []).map(imagePart),
        ],
        ...(model ? { model } : {}),
        ...(variant ? { variant } : {}),
      },
    });
    return { turn: { id: turnId, status: "inProgress" } };
  }

  async interrupt(_providerId: string, threadId: string, _turnId: string) {
    const thread = this.requireThread(threadId);
    if (thread.archived) throw new Error("会话已归档，请先恢复再操作");
    await this.request(`/session/${encodeURIComponent(threadId)}/abort`, {
      method: "POST",
      directory: thread.cwd,
    });
    return { ok: true };
  }

  async resolveApproval(
    approvalId: string,
    body: string | { decision?: string; answers?: unknown },
  ) {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error("审批已处理或不存在");
    const decision = typeof body === "string" ? body : body.decision;
    if (approval.request?.method === "opencode/question")
      return this.resolveQuestion(approval, decision, (body as any)?.answers);
    // Question approvals carry the picked option back to OpenCode as the
    // permission response; a missing/unusable value falls back to allow-once.
    const answered =
      !decision && Array.isArray((body as any)?.answers)
        ? (body as any).answers
            .map((answer: any) => String(answer?.value || answer?.label || answer?.other || "").trim())
            .filter(Boolean)
            .join(", ")
        : undefined;
    const respond = async (response: string) =>
      this.request(
        `/session/${encodeURIComponent(approval.sessionID)}/permissions/${encodeURIComponent(
          approval.permissionId || approval.id,
        )}`,
        { method: "POST", directory: approval.cwd, body: { response } },
      );
    if (answered) {
      try {
        await respond(answered);
      } catch {
        await respond("once");
      }
    } else {
      const response =
        decision === "acceptForSession"
          ? "always"
          : decision === "accept"
            ? "once"
            : "reject";
      await respond(response);
    }
    this.approvals.delete(approvalId);
    this.broadcast("approval.resolved", { agentId: this.id, approvalId });
    return { ok: true };
  }

  /**
   * Answers or dismisses a native OpenCode question request
   * (question.asked). Each answer is sent as an array of picked labels, one
   * entry per question in order; free-text answers are wrapped the same way.
   */
  private async resolveQuestion(
    approval: any,
    decision?: string,
    answers?: unknown,
  ) {
    const decline = () =>
      this.request(
        `/question/${encodeURIComponent(approval.requestId)}/reject`,
        { method: "POST", directory: approval.cwd },
      );
    if (decision === "decline" || decision === "cancel") {
      await decline();
    } else {
      const items = Array.isArray(answers) ? answers : [];
      if (!items.length) await decline();
      else {
        const payload = {
          answers: items.map((item: any) => {
            // Multi-select questions carry a values array; single-select
            // answers fall back to the joined value / label / free text.
            const explicit = Array.isArray(item?.values)
              ? item.values.map((value: any) => String(value).trim()).filter(Boolean)
              : [];
            const single = String(
              item?.value || item?.label || item?.other || "",
            ).trim();
            return explicit.length ? explicit : [single];
          }),
        };
        try {
          await this.request(
            `/question/${encodeURIComponent(approval.requestId)}/reply`,
            { method: "POST", directory: approval.cwd, body: payload },
          );
        } catch {
          // Question may have been answered or retracted elsewhere; drop it.
          this.approvals.delete(approval.id);
          this.broadcast("approval.resolved", {
            agentId: this.id,
            approvalId: approval.id,
          });
          throw new Error("OpenCode 问题已失效，请重新发送");
        }
      }
    }
    this.approvals.delete(approval.id);
    this.broadcast("approval.resolved", { agentId: this.id, approvalId: approval.id });
    return { ok: true };
  }

  private async waitForHealth() {
    let lastError: unknown;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try {
        await this.request("/global/health");
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw lastError || new Error("OpenCode server 未在限定时间内启动");
  }

  private async consumeEvents() {
    // 先停掉上一条流：restart 漏调或并发 startAll 时不能有两条 SSE 循环。
    this.eventAbort?.abort();
    const abort = new AbortController();
    this.eventAbort = abort;
    try {
      const response = await this.fetcher(
        requestUrl(this.baseUrl!, "/global/event"),
        { signal: abort.signal },
      );
      if (!response.ok || !response.body)
        throw new Error(`OpenCode 事件流不可用：${response.status}`);
      const reader = response.body.getReader();
      try {
        const decoder = new TextDecoder();
        let buffered = "";
        while (!abort.signal.aborted) {
          const next = await reader.read();
          if (next.done) break;
          buffered += decoder.decode(next.value, { stream: true });
          const chunks = buffered.split(/\n\n/);
          buffered = chunks.pop() || "";
          for (const chunk of chunks) {
            const line = chunk
              .split(/\r?\n/)
              .find((item) => item.startsWith("data:"));
            if (!line) continue;
            try {
              this.onEvent(JSON.parse(line.slice(5)));
            } catch {}
          }
        }
      } finally {
        // reader 不 cancel/release 会一直挂着 socket 和 read() promise。
        try {
          await reader.cancel();
        } catch {}
        try {
          reader.releaseLock();
        } catch {}
      }
    } catch (error: any) {
      if (!abort.signal.aborted) this.error = error?.message || String(error);
    }
  }

  private onEvent(event: any) {
    const payload = event?.payload || event;
    const body = payload?.properties || {};
    const sessionId =
      body.sessionID ||
      body.info?.id ||
      body.part?.sessionID ||
      body.session?.id;
    const thread = sessionId ? this.threads.get(sessionId) : undefined;
    if (
      payload?.type === "session.created" ||
      payload?.type === "session.updated"
    ) {
      const session = body.info as OpenCodeSession | undefined;
      if (!session?.id) return;
      if (session.parentID) {
        this.boundedPut(this.childParents, session.id, session.parentID);
        return;
      }
      const next = this.mergeThread(session, this.threads.get(session.id));
      this.threads.set(next.id, next);
      this.broadcast("thread.updated", next);
      return;
    }
    if (payload?.type === "session.deleted" && sessionId) {
      this.threads.delete(sessionId);
      this.sessionTitles.delete(sessionId);
      for (const [child, parent] of this.childParents) {
        if (parent !== sessionId) continue;
        this.childParents.delete(child);
        const partId = this.childTaskParts.get(child);
        if (partId) this.taskPartSnapshots.delete(partId);
        this.childTaskParts.delete(child);
        this.pendingChildActivity.delete(child);
      }
      this.broadcast("thread.deleted", {
        agentId: this.id,
        threadId: sessionId,
      });
      return;
    }
    if (payload?.type === "session.status" && thread) {
      thread.status = body.status?.type === "busy" ? "running" : "idle";
      if (thread.status === "running" && !thread.activeTurnId) {
        thread.activeTurnId = randomUUID();
        this.emitAgentEvent(thread, "turn/started", {
          threadId: thread.id,
          turn: { id: thread.activeTurnId, status: "inProgress" },
        });
      }
      const completedTurnId = thread.activeTurnId || "opencode";
      if (thread.status === "idle") thread.activeTurnId = undefined;
      thread.updatedAt = Date.now();
      this.broadcast("thread.updated", thread);
      if (thread.status === "idle")
        this.emitAgentEvent(thread, "turn/completed", {
          threadId: thread.id,
          turn: { id: completedTurnId, status: "completed" },
        });
      return;
    }
    if (payload?.type === "session.error" && thread) {
      thread.status = "error";
      thread.activeTurnId = undefined;
      thread.lastError = String(
        body.error?.data?.message || body.error?.message || "OpenCode 任务失败",
      );
      this.broadcast("thread.updated", thread);
      return;
    }
    if (payload?.type === "question.asked") {
      // Newer OpenCode versions ask questions through the dedicated question
      // system (question.asked SSE + /question/:id/reply) instead of
      // permission.updated; both share the question approval card here.
      const request = body;
      const id = `${request.sessionID}:${request.id}`;
      const questions: ApprovalQuestion[] = (Array.isArray(request.questions)
        ? request.questions
        : []
      ).map((item: any, index: number) => ({
        id: String(request.id || index),
        header: typeof item.header === "string" ? item.header : undefined,
        prompt: item.question,
        options: (Array.isArray(item.options) ? item.options : []).map(
          (option: any) => ({
            label: String(option.label ?? option.value ?? ""),
            value: String(option.label ?? option.value ?? ""),
          }),
        ),
        ...(item.multiple ? { multiple: true } : {}),
        ...(item.custom ? { custom: true } : {}),
      }));
      const multiple = questions.some((item: any) => item.multiple);
      const pending = {
        id,
        agentId: this.id,
        providerId: thread?.providerId,
        cwd: thread?.cwd,
        sessionID: request.sessionID,
        requestId: request.id,
        kind: "question" as ApprovalKind,
        command:
          questions[0]?.header || questions[0]?.prompt || "OpenCode 提问",
        reason: `OpenCode 请求回答 ${questions.length} 个问题`,
        questions,
        ...(multiple ? { multiple: true } : {}),
        request: {
          method: "opencode/question",
          params: { threadId: request.sessionID, requestId: request.id },
        },
      };
      this.approvals.set(id, pending);
      if (thread) {
        thread.status = "waiting";
        this.broadcast("thread.updated", thread);
      }
      this.broadcast("approval.requested", pending);
      return;
    }
    if (
      (payload?.type === "question.replied" ||
        payload?.type === "question.rejected") &&
      body.requestID
    ) {
      const id = `${body.sessionID}:${body.requestID}`;
      if (this.approvals.delete(id))
        this.broadcast("approval.resolved", { agentId: this.id, approvalId: id });
      return;
    }
    if (payload?.type === "permission.updated") {
      const permission = body;
      const id = `${permission.sessionID}:${permission.id}`;
      const questions = permissionQuestions(permission);
      const pending = {
        id,
        agentId: this.id,
        providerId: thread?.providerId,
        cwd: thread?.cwd,
        sessionID: permission.sessionID,
        permissionId: permission.id,
        kind: questions ? ("question" as ApprovalKind) : this.permissionKind(permission.type),
        command: permission.title,
        reason: permission.title,
        ...(questions ? { questions } : { availableDecisions: ["decline", "accept", "acceptForSession"] }),
        request: {
          method: "opencode/permission",
          params: { threadId: permission.sessionID, permission },
        },
      };
      this.approvals.set(id, pending);
      if (thread) {
        thread.status = "waiting";
        this.broadcast("thread.updated", thread);
      }
      this.broadcast("approval.requested", pending);
      return;
    }
    if (payload?.type === "message.updated") {
      const info = body.info;
      if (info?.id && info?.role) this.rememberRole(info.id, info.role);
      return;
    }
    if (payload?.type === "message.part.updated") {
      const childParent = sessionId
        ? this.childParents.get(sessionId)
        : undefined;
      if (childParent) {
        const parentThread = this.threads.get(childParent);
        if (parentThread) this.forwardChildPart(parentThread, sessionId, body.part);
        return;
      }
      if (!thread) return;
      let part = body.part;
      // OpenCode replays the parts of the message the user just sent. The
      // turn history already renders that message, so forwarding it here
      // would show it a second time as if the assistant repeated it.
      if (this.isUserPart(part)) return;
      // A task tool part is the parent-side anchor of a subagent run; its
      // metadata.sessionId links the child session so later child events
      // can be replayed onto this same item as live activity.
      if (part?.type === "tool" && part?.tool === "task" && part?.id) {
        const childId = String(part?.state?.metadata?.sessionId || "").trim();
        if (childId) {
          this.boundedPut(this.childTaskParts, childId, String(part.id));
          const pending = this.pendingChildActivity.get(childId);
          if (pending !== undefined) {
            this.pendingChildActivity.delete(childId);
            part = withChildActivity(part, pending);
          }
        }
        this.boundedPut(this.taskPartSnapshots, String(part.id), part);
      }
      if (part?.type === "text" && body.delta)
        this.emitAgentEvent(thread, "item/agentMessage/delta", {
          threadId: thread.id,
          turnId: thread.activeTurnId,
          itemId: part.id || part.messageID,
          delta: body.delta,
        });
      else
        this.emitAgentEvent(thread, "item/updated", {
          threadId: thread.id,
          turnId: thread.activeTurnId,
          item: part,
        });
    }
  }

  private rememberRole(messageId: unknown, role: unknown) {
    const id = String(messageId || "").trim();
    if (!id) return;
    this.messageRoles.set(id, String(role || ""));
    if (this.messageRoles.size > 400)
      this.messageRoles = new Map(
        [...this.messageRoles].slice(-200),
      );
  }

  /**
   * 子会话的 part 不在 Deck threads 里；把可读的进展（工具调用标题、
   * 文本尾部）作为实时活动挂回父会话的 task 卡片上。
   */
  private forwardChildPart(
    thread: ThreadSummary,
    childId: string,
    part: any,
  ) {
    const activity = childActivityText(part);
    if (!activity) return;
    this.boundedPut(this.pendingChildActivity, childId, activity);
    const partId = this.childTaskParts.get(childId);
    const snapshot = partId ? this.taskPartSnapshots.get(partId) : undefined;
    if (!snapshot) return;
    this.pendingChildActivity.delete(childId);
    this.emitAgentEvent(thread, "item/updated", {
      threadId: thread.id,
      turnId: thread.activeTurnId,
      item: withChildActivity(snapshot, activity),
    });
  }

  private boundedPut<T>(map: Map<string, T>, key: string, value: T) {
    map.set(key, value);
    if (map.size <= 400) return;
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }

  private isUserPart(part: any) {
    const messageId = String(part?.messageID || "").trim();
    if (!messageId) return false;
    return this.messageRoles.get(messageId) === "user";
  }

  private permissionKind(type: string): ApprovalKind {
    return /edit|write|patch/i.test(type)
      ? "file"
      : /question/i.test(type)
        ? "question"
        : "command";
  }

  private modelInput(value: string) {
    const separator = value.indexOf("/");
    return separator > 0
      ? {
          providerID: value.slice(0, separator),
          modelID: value.slice(separator + 1),
        }
      : undefined;
  }

  private requireThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("OpenCode 会话不存在");
    return thread;
  }

  private async request<T = any>(
    pathname: string,
    options: { method?: string; directory?: string; body?: unknown } = {},
  ): Promise<T> {
    if (!this.baseUrl) throw new Error("OpenCode server 尚未启动");
    const response = await this.fetcher(
      requestUrl(this.baseUrl, pathname, options.directory),
      {
        method: options.method,
        headers: options.body
          ? { "content-type": "application/json" }
          : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
      },
    );
    if (!response.ok)
      throw new Error(
        `OpenCode API ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  private offline(error: unknown) {
    this.online = false;
    this.error = error instanceof Error ? error.message : String(error);
    for (const thread of this.busyThreads()) {
      thread.status = "offline";
      thread.activeTurnId = undefined;
    }
    this.broadcast("agent.status", this.descriptor());
    this.broadcast("snapshot", this.snapshot());
  }

  private processError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stderr = this.processStderr.trim();
    return new Error(
      stderr && !message.includes(stderr) ? `${message}: ${stderr}` : message,
    );
  }

  private emitAgentEvent(thread: ThreadSummary, method: string, params: any) {
    this.broadcast("agent.event", {
      agentId: this.id,
      providerId: thread.providerId,
      method,
      params,
    });
  }

  private broadcast(type: string, data: unknown) {
    this.emit("event", { type, data });
  }
}
