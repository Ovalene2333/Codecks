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
import type {
  AgentCapabilities,
  AgentDescriptor,
  AgentId,
  AgentSkill,
} from "./types.js";

const OPENCODE_CAPABILITIES: AgentCapabilities = {
  approvals: true,
  // Deck 侧软归档：OpenCode serve 没有原生归档接口，归档态由 Deck
  // 持久化（thread-settings `archived`），服务端会话原样保留。
  archive: true,
  delete: true,
  // 原生 `POST /session/:id/fork { messageID? }`：非破坏性分支，
  // 与 Codex `thread/fork` 对齐；destructive 的 revert 仍保留为 undo。
  fork: true,
  images: true,
  interrupt: true,
  mcp: false,
  models: true,
  review: false,
  sessionSettings: true,
  shell: false,
  // `GET /skill` 枚举 SKILL.md 目录；skill 同时被 `Command.list()` 并入
  // 可调命令（`skill:true`），`/name` 透传即可调用。
  skills: true,
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
  /**
   * `session.status` 的 idle 防抖时长（毫秒）。OpenCode 在一轮执行中会
   * 短暂吐出 idle（步骤间隙/流间隙），直接翻转会导致侧栏在
   * “运行中 / 有新回复 / 无状态”之间来回跳。idle 只做延迟落盘，
   * 期间再有 busy 或消息活动就取消。测试可传 0 恢复成立即行为。
   */
  idleGraceMs?: number;
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
  /**
   * Present on sessions created by `POST /session/:id/fork`. Subagent
   * children carry only `parentID`; fork children must stay visible as
   * Deck threads instead of being hidden as subagent activity.
   */
  fork?: { sessionID?: string; boundary?: unknown } | unknown;
  time?: { created?: number; updated?: number };
};

type OpenCodeProfile = {
  id: string;
  name: string;
  models?: Record<string, OpenCodeModelMeta>;
};

type OpenCodeCatalog = {
  profiles: OpenCodeProfile[];
  connected: Set<string>;
  defaultModel?: { providerID: string; modelID: string };
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
  const configured = (config as any)?.model;
  if (typeof configured === "string") {
    const model = configured.trim();
    const separator = model.indexOf("/");
    if (separator > 0 && separator < model.length - 1)
      return {
        providerID: model.slice(0, separator),
        modelID: model.slice(separator + 1),
      };
  }
  const providerID = String(
    configured?.providerID ?? "",
  ).trim();
  const modelID = String(configured?.modelID ?? "").trim();
  return providerID && modelID ? { providerID, modelID } : undefined;
}

type OpenCodeCommandInfo = { name: string; description?: string };

/**
 * `GET /skill` 返回 Skill.Info[]（name/description/location）。location
 * 是 SKILL.md 的路径；按是否在会话目录内标注 project/global。
 */
function normalizeSkills(value: unknown, cwd?: string): AgentSkill[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? ((value as { skills?: unknown; data?: unknown }).skills ??
        (value as { data?: unknown }).data)
      : undefined;
  if (!Array.isArray(list)) return [];
  const root = String(cwd || "")
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
  const seen = new Set<string>();
  const skills: AgentSkill[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const name = String(
      (item as any)?.name ?? (item as any)?.id ?? "",
    ).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const location = String(
      (item as any)?.location ??
        (item as any)?.path ??
        (item as any)?.directory ??
        "",
    ).trim();
    const normalized = location.replaceAll("\\", "/");
    skills.push({
      name,
      description:
        String((item as any)?.description ?? "").trim() || undefined,
      path: location || undefined,
      scope: root && normalized.startsWith(`${root}/`) ? "project" : "global",
      enabled: (item as any)?.enabled !== false,
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeCommands(value: unknown): OpenCodeCommandInfo[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? ((value as { commands?: unknown; data?: unknown }).commands ??
        (value as { data?: unknown }).data)
      : undefined;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const entries: OpenCodeCommandInfo[] = [];
  for (const item of list) {
    const raw =
      typeof item === "string"
        ? item
        : String(
            (item as any)?.name ??
              (item as any)?.command ??
              (item as any)?.id ??
              "",
          ).trim();
    if (!raw) continue;
    const name = raw.startsWith("/") ? raw.slice(1) : raw;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const description =
      item && typeof item === "object"
        ? String((item as any)?.description ?? "").trim() || undefined
        : undefined;
    entries.push({ name, ...(description ? { description } : {}) });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function requestUrl(baseUrl: string, pathname: string, directory?: string) {
  const url = new URL(pathname, baseUrl);
  if (directory) url.searchParams.set("directory", directory);
  return url;
}

/** GET 类幂等请求的超时与重试配置：回环偶发闪断时自愈，不用用户手动刷新。 */
const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_POST_TIMEOUT_MS = 60_000;
/** 重试次数（不含首次）：GET 最多 3 次，非幂等写操作只发 1 次，绝不重发。 */
const REQUEST_RETRIES = 2;
const REQUEST_RETRY_DELAYS_MS = [300, 800];

/**
 * 瞬时网络失败：回环 ECONNRESET/keep-alive 竞态、OpenCode 繁忙瞬间、
 * 自身超时 abort 都算，可重试。HTTP 状态错误不算，由调用方按状态处理。
 */
function isTransientRequestError(error: unknown) {
  const code = String(
    (error as any)?.cause?.code || (error as any)?.code || "",
  ).toUpperCase();
  if (
    /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ECONNABORTED|UND_ERR_SOCKET)$/.test(
      code,
    )
  )
    return true;
  const name = String((error as any)?.name || "");
  if (name === "AbortError" || name === "TimeoutError") return true;
  return /fetch failed|socket hang up|terminated|aborted|timeout|temporarily|try again/i.test(
    String((error as any)?.message || error || ""),
  );
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
      const compaction = parts.find((part: any) => part?.type === "compaction");
      turn = {
        id: String(message.id || randomUUID()),
        status: "completed",
        startedAt: Number(message.time?.created || Date.now()),
        items: compaction
          ? [
              {
                id: String(compaction.id || message.id || randomUUID()),
                type: "contextCompaction",
                text: "",
              },
            ]
          : [
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
    // 每条 assistant 消息记录真实运行的 provider/model（以及 effort
    // variant）；同一 turn 有多条时后者覆盖，时间线按回合显示当时模型。
    const providerID = String(message.providerID || "").trim();
    const modelID = String(message.modelID || "").trim();
    if (providerID && modelID) turn.model = `${providerID}/${modelID}`;
    if (typeof message.variant === "string" && message.variant.trim())
      turn.reasoningEffort = message.variant.trim();
    if (message.summary === true && turn.items[0]?.type === "contextCompaction") {
      turn.items[0].text = parts
        .filter((part: any) => part?.type === "text")
        .map((part: any) => String(part.text || ""))
        .join("\n\n");
      continue;
    }
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
    // The summary reply measures the compression request's input, not the
    // context available after compression. Wait for the next normal reply.
    if (
      info?.role === "user" &&
      record?.parts?.some((part: any) => part?.type === "compaction")
    ) return undefined;
    if (info?.summary === true) continue;
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

/** Bash/shell 类工具的真实命令在 state.input.command 里，state.title 经常只是
 * 泛称（甚至缺失），直接用它做 command 会展示成“正在执行 bash”且点开展示空。
 * 这里优先取 input 里的实际命令，标题里带不下、详情里必须有。 */
function openCodeShellCommand(input: unknown): string {
  if (typeof input === "string") return input.trim();
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const row = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script", "text", "commands"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const joined = value
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
        .join("\n")
        .trim();
      if (joined) return joined;
    }
  }
  return "";
}

const OPENCODE_SHELL_TOOLS = new Set([
  "bash",
  "shell",
  "exec",
  "execute",
  "command",
  "run",
  "sh",
  "terminal",
  "process",
]);

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
    const toolName = String(part.tool || "").toLowerCase();
    const shellCommand = openCodeShellCommand(state.input);
    const command =
      (OPENCODE_SHELL_TOOLS.has(toolName) && shellCommand) ||
      shellCommand ||
      state.title ||
      part.tool ||
      "OpenCode 工具";
    const description = String(
      (state.input as any)?.description || "",
    ).trim();
    const item: any = {
      id: String(part.id),
      type: "commandExecution",
      command,
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
      ...(description && description !== String(command || "").trim()
        ? { description }
        : {}),
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
  private projectCatalogs = new Map<string, OpenCodeCatalog>();
  private approvals = new Map<string, any>();
  /** Role of the last seen OpenCode message, used to skip replayed user parts. */
  private messageRoles = new Map<string, string>();
  private partTypes = new Map<string, string>();
  /**
   * OpenCode 服务端的 `title`（手动重命名才有）。有它时首条消息
   * 不得覆盖用户起的名字；没它时才用首条消息对齐 Codex。
   */
  private sessionTitles = new Map<string, string>();
  /** 子会话 → 父会话 ID：subagent 会话不是 Deck thread，但活动要挂回父会话。 */
  private childParents = new Map<string, string>();
  /**
   * Deck 发起的 fork 子会话 ID：服务端同样用 `parentID` 标记它们，
   * 但它们是可见分支，必须保留在 threads 里，不能按 subagent 隐藏。
   */
  private forkChildren = new Set<string>();
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
  /** sessionId → 待落盘的 idle 定时器：防抖窗口内仍算运行中。 */
  private idleTimers = new Map<string, NodeJS.Timeout>();

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
      protocol: "native",
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

  private idleGraceMs() {
    const value = this.options.idleGraceMs;
    if (value == null) return 2_500;
    if (!Number.isFinite(value) || value < 0) return 0;
    return value;
  }

  private clearIdleTimer(sessionId: string) {
    const timer = this.idleTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(sessionId);
    }
  }

  private clearAllIdleTimers() {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
  }

  /** 测试用：不等防抖窗口，直接落盘所有待定的 idle。 */
  flushIdleTimers() {
    const pending = [...this.idleTimers.keys()];
    for (const sessionId of pending) {
      this.clearIdleTimer(sessionId);
      const thread = this.threads.get(sessionId);
      if (thread) this.applyIdle(thread);
    }
  }

  private markBusy(thread: ThreadSummary) {
    this.clearIdleTimer(thread.id);
    thread.status = "running";
    if (!thread.activeTurnId) {
      thread.activeTurnId = randomUUID();
      this.emitAgentEvent(thread, "turn/started", {
        threadId: thread.id,
        turn: { id: thread.activeTurnId, status: "inProgress" },
      });
    }
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
  }

  private scheduleIdle(thread: ThreadSummary) {
    // 审批等待态由 permission/question 事件驱动，idle 不得覆盖 waiting，
    // 否则侧栏会在“待确认 / 运行中 / 有新回复”之间跳。
    if (thread.status === "waiting") return;
    if (thread.status === "error") return;
    // 已是 idle 且没有残留 activeTurn 时无需再落盘；但残留 turn
    // 说明前后端状态不一致（如重启后恢复），仍要补一次完成事件。
    if (thread.status === "idle" && !thread.activeTurnId) return;
    if (this.idleTimers.has(thread.id)) return;
    const grace = this.idleGraceMs();
    if (grace <= 0) {
      this.applyIdle(thread);
      return;
    }
    const timer = setTimeout(() => {
      this.idleTimers.delete(thread.id);
      const current = this.threads.get(thread.id);
      // 期间已有 busy/审批把状态搬走就不再覆盖；残留 activeTurn 除外。
      if (!current || (current.status !== "running" && !current.activeTurnId))
        return;
      if (current.status === "waiting" || current.status === "error") return;
      this.applyIdle(current);
    }, grace);
    // 定时器不应拖住进程退出。
    (timer as unknown as { unref?: () => void }).unref?.();
    this.idleTimers.set(thread.id, timer);
  }

  private applyIdle(thread: ThreadSummary) {
    const completedTurnId = thread.activeTurnId || "opencode";
    thread.status = "idle";
    thread.activeTurnId = undefined;
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    this.emitAgentEvent(thread, "turn/completed", {
      threadId: thread.id,
      turn: { id: completedTurnId, status: "completed" },
    });
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

  listModels(providerId?: string, directory?: string): ModelInfo[] | Promise<ModelInfo[]> {
    if (directory)
      return this.loadProjectCatalog(directory, true).then((catalog) =>
        this.modelList(
          providerId,
          catalog.profiles,
          catalog.connected,
          catalog.defaultModel,
        ),
      );
    return this.modelList(providerId, this.profiles, this.connected, this.configDefault);
  }

  private async loadProjectCatalog(directory: string, refresh = false) {
    const cached = this.projectCatalogs.get(directory);
    if (cached && !refresh) return cached;
    const [providers, config] = await Promise.all([
      this.request<unknown>("/provider", {
        directory, retry: false, timeoutMs: 5_000,
      }),
      this.request<unknown>("/config", {
        directory, retry: false, timeoutMs: 5_000,
      }),
    ]);
    const catalog: OpenCodeCatalog = {
      profiles: normalizeProfiles(providers),
      connected: connectedProviderIds(providers),
      defaultModel: configDefaultModel(config),
    };
    this.projectCatalogs.set(directory, catalog);
    return catalog;
  }

  private modelList(
    providerId: string | undefined,
    profiles: OpenCodeProfile[],
    connected: Set<string>,
    defaultModel: { providerID: string; modelID: string } | undefined,
  ): ModelInfo[] {
    const ranked = profiles
      .map((profile, index) => ({
        profile,
        index,
        rank: defaultModel?.providerID === profile.id
          ? 0
          : connected.has(profile.id)
            ? 1
            : 2,
      }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.profile);
    const matched = providerId
      ? profiles.filter((item) => item.id === providerId)
      : ranked;
    const scope = matched.length ? matched : ranked;
    const entries: ModelInfo[] = [];
    for (const profile of scope) {
      const groupName = profile.name || profile.id;
      const isConnected = connected.has(profile.id);
      for (const [id, model] of Object.entries(profile.models || {})) {
        entries.push({
          id: `${profile.id}/${id}`,
          model: `${profile.id}/${id}`,
          displayName: model.name || model.displayName || id,
          groupName,
          isDefault:
            defaultModel?.providerID === profile.id &&
            defaultModel.modelID === id
              ? true
              : undefined,
          ...(isConnected ? { connected: true } : {}),
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
        isDefault: !defaultModel ? true : undefined,
      },
      ...entries,
    ];
  }

  isOnline() {
    return this.online;
  }

  /**
   * `GET /agent`：当前目录下可见的全部 agent（primary + subagent），
   * 含 name/mode/description。server 未启动时返回空数组，调用方按
   * “离线”处理而不是报错。
   */
  async agentCatalog(directory?: string): Promise<any[]> {
    const value = await this.request<unknown>("/agent", { directory }).catch(
      () => [],
    );
    const list = Array.isArray(value)
      ? value
      : ((value as { agents?: unknown; data?: unknown })?.agents ??
        (value as { data?: unknown })?.data);
    return Array.isArray(list) ? list : [];
  }

  /**
   * `PATCH /config`：把配置写进运行中的 server。OpenCode 会把它持久化到
   * 工作区配置文件；调用方负责先写目标文件，这里只是让在线实例立即生效。
   */
  async patchRuntimeConfig(
    config: Record<string, unknown>,
    directory?: string,
  ) {
    const result = await this.request("/config", {
      method: "PATCH",
      directory,
      body: config,
    });
    if (directory) this.projectCatalogs.delete(directory);
    else this.projectCatalogs.clear();
    return result;
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
   * fork 证据：服务端 `fork` 字段、Deck 发起的 fork 记录、或已可见分支。
   * 三者任一成立即按分支保留，不按 subagent 隐藏。
   */
  private isForkChild(session: OpenCodeSession) {
    if (!session.parentID) return false;
    if (session.fork != null) return true;
    if (this.forkChildren.has(session.id)) return true;
    const known = this.threads.get(session.id);
    if (known?.forkedFromId) return true;
    return false;
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
    this.projectCatalogs.clear();
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
      // parent's task card. Fork children also carry `parentID` but are
      // real branches: keep them visible (fork field, Deck fork record, or
      // an already-visible thread all count as fork evidence).
      if (session.parentID && !this.isForkChild(session)) {
        this.boundedPut(this.childParents, session.id, session.parentID);
        continue;
      }
      if (session.parentID) this.forkChildren.add(session.id);
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
   * 已有 server 且健康检查通过时复用它；事件流必须重建——旧 SSE 可能已静默
   * 断开（服务端关流/网络闪断），不断即永久收不到审批与状态事件。
   * consumeEvents 入口会先 abort 上一条流，不会重复订阅。
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
        this.error = undefined;
        void this.consumeEvents();
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
    this.clearAllIdleTimers();
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
    const catalog = this.projectCatalogs.get(thread.cwd);
    const defaultModel = catalog?.defaultModel || this.configDefault;
    const info = lastAssistantInfo(records);
    const usageInfo = lastAssistantWithUsage(records);
    const infoProvider = String(info?.providerID || "").trim();
    const infoModel = String(info?.modelID || "").trim();
    const resolved =
      infoProvider && infoModel
        ? `${infoProvider}/${infoModel}`
        : thread.model && thread.model !== "default"
          ? thread.model
          : defaultModel
            ? `${defaultModel.providerID}/${defaultModel.modelID}`
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
        ? this.modelContextLimit(providerID, modelID, thread.cwd)
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

  /**
   * Effort chosen in Deck. Models that advertise a variant list keep the
   * allowlist (unknown effort is dropped, otherwise OpenCode rejects it);
   * only custom `opencode.json` models known to the catalog but without any
   * variant metadata pass through, so
   * e.g. `dstest/deepseek-v4.1-flash-expires-on-0910 · medium` works.
   * Unknown profiles/models still drop, avoiding variant sends before the
   * provider catalog has loaded.
   */
  private threadVariant(thread: ThreadSummary) {
    const effort = thread.reasoningEffort?.trim();
    if (!effort) return undefined;
    const parsed = this.modelInput(thread.model || thread.resolvedModel || "");
    if (!parsed) return undefined;
    const profiles = this.projectCatalogs.get(thread.cwd)?.profiles || this.profiles;
    const profile = profiles.find((item) => item.id === parsed.providerID);
    if (!profile) return undefined;
    const model = profile.models?.[parsed.modelID];
    if (!model) return undefined;
    const supported = modelVariants(model);
    if (!supported) return effort;
    if (!supported.some((item) => item.reasoningEffort === effort))
      return undefined;
    return effort;
  }

  private modelContextLimit(providerID: string, modelID: string, directory?: string) {
    const profiles = this.projectCatalogs.get(directory || "")?.profiles || this.profiles;
    const profile = profiles.find((item) => item.id === providerID);
    const limit = profile?.models?.[modelID]?.limit?.context;
    return typeof limit === "number" && limit > 0 ? limit : undefined;
  }

  async readThread(_providerId: string, threadId: string) {
    const thread = this.requireThread(threadId);
    const [allRecords, session] = await Promise.all([
      this.request<any[]>(`/session/${encodeURIComponent(threadId)}/message`, {
        directory: thread.cwd,
      }),
      this.request<OpenCodeSession & { revert?: { messageID?: string } }>(
        `/session/${encodeURIComponent(threadId)}`,
        { directory: thread.cwd },
      ),
      thread.cwd && !this.projectCatalogs.has(thread.cwd)
        ? this.loadProjectCatalog(thread.cwd).catch(() => undefined)
        : Promise.resolve(undefined),
    ]);
    // OpenCode stages /revert and keeps the old messages in storage for /redo.
    // Its message list still contains them, so hide the boundary and everything
    // after it until /unrevert clears the marker.
    const revertId = String(session?.revert?.messageID || "");
    const revertedAt = revertId
      ? allRecords.findIndex((record) =>
          String((record?.info || record?.message || record)?.id) === revertId,
        )
      : -1;
    const records = revertedAt >= 0 ? allRecords.slice(0, revertedAt) : allRecords;
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
    this.forkChildren.delete(threadId);
    this.broadcast("thread.deleted", { agentId: this.id, threadId });
    return { ok: true };
  }

  /**
   * 非破坏性分支：`POST /session/:id/fork { messageID? }`。
   * OpenCode 的 messageID 是排除该消息的边界。公开接口的 lastTurnId
   * 表示保留所选轮次，因此要找到下一条 user 消息作为原生边界。
   * 直接传 messageID 时保留原生的排除语义，供历史消息重试使用。
   * 这是 tree/分支的主入口；destructive 的 revert 仍保留为 undo。
   */
  async forkThread(
    _providerId: string,
    threadId: string,
    options: { messageID?: string; lastTurnId?: string } = {},
  ) {
    const source = this.requireThread(threadId);
    if (source.archived) throw new Error("会话已归档，请先恢复再分支");
    if (source.status === "running" || source.status === "waiting")
      throw new Error("会话正在运行或等待确认，无法分支");
    let boundary = String(options.messageID || "").trim();
    if (options.lastTurnId) {
      const selected = String(options.lastTurnId).trim();
      const records = await this.request<any[]>(
        `/session/${encodeURIComponent(threadId)}/message`,
        { directory: source.cwd },
      );
      const userIds = records
        .map((record) => record?.info || record?.message || record)
        .filter((info) => info?.role === "user" && info?.id)
        .map((info) => String(info.id));
      const index = userIds.indexOf(selected);
      if (index < 0) throw new Error("找不到分支所选的消息");
      boundary = userIds[index + 1] || "";
    }
    let forked: OpenCodeSession;
    try {
      forked = await this.request<OpenCodeSession>(
        `/session/${encodeURIComponent(threadId)}/fork`,
        {
          method: "POST",
          directory: source.cwd,
          ...(boundary ? { body: { messageID: boundary } } : {}),
        },
      );
    } catch (error: any) {
      const detail = String(error?.message || error || "OpenCode 分支失败");
      if (/404/.test(detail))
        throw new Error(
          "当前 OpenCode server 不支持分支接口（POST /session/:id/fork 返回 404），请升级 OpenCode 后重试",
        );
      throw error instanceof Error ? error : new Error(detail);
    }
    if (!forked?.id) throw new Error("OpenCode 分支失败：服务端未返回新会话");
    this.forkChildren.add(forked.id);
    this.sessionTitles.set(forked.id, "");
    const branchName = `${source.name || forked.title || forked.slug || "会话"} · 分支`;
    try {
      await this.request(`/session/${encodeURIComponent(forked.id)}`, {
        method: "PATCH",
        directory: forked.directory || source.cwd,
        body: { title: branchName },
      });
      this.sessionTitles.set(forked.id, branchName);
    } catch {
      // 命名失败不影响分支本身，首条消息命名会再兜底。
    }
    const merged = this.mergeThread(
      { ...forked, title: branchName, directory: forked.directory || source.cwd },
      undefined,
    );
    const branch: ThreadSummary = {
      ...merged,
      agentId: this.id,
      providerId: source.providerId,
      cwd: forked.directory || source.cwd,
      model: source.model || "default",
      ...(source.reasoningEffort
        ? { reasoningEffort: source.reasoningEffort }
        : {}),
      name: branchName,
      preview: branchName,
      status: "idle",
      activeTurnId: undefined,
      lastError: undefined,
      forkedFromId: threadId,
      updatedAt: Date.now(),
    };
    if (source.model || source.reasoningEffort) {
      await this.options.threadSettings?.update(this.id, branch.id, {
        model: branch.model,
        reasoningEffort: source.reasoningEffort,
      });
    }
    this.threads.set(branch.id, branch);
    this.broadcast("thread.updated", branch);
    return branch;
  }

  /**
   * 从指定 user 消息分支并用新文本重试：与 Codex retryFromTurn 一致，
   * 以目标 turn 自身作为 OpenCode fork 的排除边界（首轮则空分支），
   * 再在新分支上 sendTurn。原分支完整保留，可随时回看。
   */
  async retryFromTurn(
    _providerId: string,
    threadId: string,
    turnId: string,
    text: string,
    images?: TurnImage[],
  ) {
    const source = this.requireThread(threadId);
    if (source.archived) throw new Error("会话已归档，请先恢复再重试");
    if (source.status === "running" || source.status === "waiting")
      throw new Error("会话正在运行或等待确认，无法从历史消息重试");
    const value = String(text || "").trim();
    if (!value && !images?.length) throw new Error("请输入重试内容");
    const records = await this.request<any[]>(
      `/session/${encodeURIComponent(threadId)}/message`,
      { directory: source.cwd },
    );
    const userIds: string[] = [];
    for (const record of records || []) {
      const info = record?.info || record?.message || record;
      if (info?.role === "user" && info?.id) userIds.push(String(info.id));
    }
    const target = String(turnId || "").trim();
    const targetIndex = target ? userIds.indexOf(target) : -1;
    if (target && targetIndex < 0) throw new Error("找不到这条消息所属的回合");
    const boundary = targetIndex > 0 ? userIds[targetIndex] : "";
    // 有边界用官方 fork 复制历史；首轮则新建空会话再发，不碰原会话的
    // 任何历史与文件快照（不对新分支做 revert，避免副作用工作区文件）。
    const branch = boundary
      ? await this.forkThread(source.providerId, threadId, {
          messageID: boundary,
        })
      : await this.createEmptyBranch(source);
    await this.sendTurn(source.providerId, branch.id, value, images);
    return this.threads.get(branch.id) || branch;
  }

  /**
   * 空分支：只调官方 `POST /session` 新建会话，不复制历史、不改文件。
   * 与 Codex `createEmptyFork` 对应，用于首轮重试。
   */
  private async createEmptyBranch(source: ThreadSummary) {
    const session = await this.request<OpenCodeSession>("/session", {
      method: "POST",
      directory: source.cwd,
      body: { title: `${source.name || "会话"} · 分支` },
    });
    if (!session?.id) throw new Error("OpenCode 分支失败：服务端未返回新会话");
    this.forkChildren.add(session.id);
    const merged = this.mergeThread(
      {
        ...session,
        title: `${source.name || "会话"} · 分支`,
        directory: session.directory || source.cwd,
      },
      undefined,
    );
    const branch: ThreadSummary = {
      ...merged,
      agentId: this.id,
      providerId: source.providerId,
      cwd: session.directory || source.cwd,
      model: source.model || "default",
      ...(source.reasoningEffort
        ? { reasoningEffort: source.reasoningEffort }
        : {}),
      name: `${source.name || "会话"} · 分支`,
      preview: `${source.name || "会话"} · 分支`,
      status: "idle",
      activeTurnId: undefined,
      lastError: undefined,
      forkedFromId: source.id,
      updatedAt: Date.now(),
    };
    if (source.model || source.reasoningEffort) {
      await this.options.threadSettings?.update(this.id, branch.id, {
        model: branch.model,
        reasoningEffort: source.reasoningEffort,
      });
    }
    this.threads.set(branch.id, branch);
    this.broadcast("thread.updated", branch);
    return branch;
  }

  /**
   * P0 命令目录：`GET /command` 返回内置 + `.opencode/commands/*.md`
   * 自定义命令，归一化为不带 `/` 的名字供 Deck 补全使用。
   */
  async listSessionCommands(_providerId: string, _threadId: string) {
    const thread = this.requireThread(_threadId);
    const raw = await this.request<unknown>("/command", {
      directory: thread.cwd,
    });
    return normalizeCommands(raw);
  }

  /**
   * Skill 目录：`GET /skill` 枚举 `.opencode/skills`、`.claude/skills`、
   * `.agents/skills` 等来源的 SKILL.md。按会话目录带上 `directory` 参数。
   */
  async listSkills(_providerId: string, threadId: string) {
    const thread = this.requireThread(threadId);
    let raw: unknown;
    try {
      raw = await this.request<unknown>("/skill", { directory: thread.cwd });
    } catch (error: any) {
      throw new Error(
        `当前 OpenCode 不支持 Skill 列表：${error?.message || error}`,
      );
    }
    return { skills: normalizeSkills(raw, thread.cwd) };
  }

  /**
   * P0 通用命令透传：`POST /session/:id/command { command, arguments }`。
   * `command` 不带前导 `/`；`model/variant` 沿用会话当前选择，
   * 与 `sendTurn` 一致，避免用默认模型执行命令。
   */
  async runSessionCommand(
    _providerId: string,
    threadId: string,
    command: string,
    args?: string,
  ) {
    const thread = this.requireThread(threadId);
    if (thread.archived) throw new Error("会话已归档，请先恢复再操作");
    const name = String(command || "").trim().replace(/^\/+/, "");
    if (!name) throw new Error("命令名称不能为空");
    const parsed =
      thread.model && thread.model !== "default"
        ? this.modelInput(thread.model)
        : undefined;
    const variant = this.threadVariant(thread);
    const turnId = randomUUID();
    this.clearIdleTimer(thread.id);
    thread.status = "running";
    thread.activeTurnId = turnId;
    thread.lastError = undefined;
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    this.emitAgentEvent(thread, "turn/started", {
      threadId,
      turn: { id: turnId, status: "inProgress" },
    });
    // Unlike prompt_async, this endpoint returns only after the command's
    // entire agent run. Keep the HTTP request alive without blocking Deck's
    // command response or timing out an active task after 60 seconds.
    void this.request(`/session/${encodeURIComponent(threadId)}/command`, {
      method: "POST",
      directory: thread.cwd,
      timeoutMs: 0,
      body: {
        command: name,
        arguments: String(args ?? ""),
        ...(parsed ? { model: parsed } : {}),
        ...(variant ? { variant } : {}),
      },
    }).catch((error: any) => {
      if (thread.activeTurnId !== turnId) return;
      const detail = String(error?.message || error || "OpenCode 命令执行失败");
      this.clearIdleTimer(thread.id);
      thread.status = "error";
      thread.activeTurnId = undefined;
      thread.lastError = detail;
      thread.updatedAt = Date.now();
      this.broadcast("thread.updated", thread);
      this.emitAgentEvent(thread, "turn/completed", {
        threadId,
        turn: { id: turnId, status: "failed", error: { message: detail } },
      });
    });
    return { turn: { id: turnId, status: "inProgress" } };
  }

  /**
   * P0 `/compact`：`POST /session/:id/summarize { providerID, modelID }`。
   * 模型解析与用量显示一致：会话模型 → 已解析模型 → OpenCode 默认模型。
   */
  async compactSession(_providerId: string, threadId: string) {
    const thread = this.requireThread(threadId);
    if (thread.archived) throw new Error("会话已归档，请先恢复再操作");
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("任务结束后才能压缩 OpenCode 会话上下文");
    const explicit =
      thread.model && thread.model !== "default"
        ? this.modelInput(thread.model)
        : undefined;
    const resolved = explicit || this.modelInput(thread.resolvedModel || "");
    const target =
      resolved || this.projectCatalogs.get(thread.cwd)?.defaultModel || this.configDefault;
    if (!target)
      throw new Error("当前没有可用模型用于压缩，请先在会话设置里选择模型");
    thread.compacting = true;
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    try {
      await this.request(`/session/${encodeURIComponent(threadId)}/summarize`, {
        method: "POST",
        directory: thread.cwd,
        body: { providerID: target.providerID, modelID: target.modelID },
      });
      // The summary request reports its old input context. A new ordinary
      // reply is needed before there is a trustworthy post-compaction value.
      delete thread.tokenUsage;
    } finally {
      thread.compacting = undefined;
      thread.updatedAt = Date.now();
      this.broadcast("thread.updated", thread);
    }
    return { ok: true };
  }

  /**
   * `/undo`：`POST /session/:id/revert { messageID }`。
   * 不带 messageID 时以后端消息列表里最后一条 user 消息为边界，
   * 与原生 TUI `/undo`（撤回最近一轮）一致；按条撤回时由调用方传入
   * Deck turn.id（即 user message id）。
   * revert 只是 staging：执行后回读 session 的 revert.summary 做核验，
   * 上游曾出现返回成功但文件未恢复的情况，调用方应展示该摘要而非假设成功。
   */
  async revertSession(_providerId: string, threadId: string, messageID?: string) {
    const thread = this.requireThread(threadId);
    if (thread.archived) throw new Error("会话已归档，请先恢复再操作");
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("任务运行中不能撤回，请先停止任务");
    let target = String(messageID || "").trim();
    if (!target) {
      const records = await this.request<any[]>(
        `/session/${encodeURIComponent(threadId)}/message`,
        { directory: thread.cwd },
      );
      for (let index = (records || []).length - 1; index >= 0; index -= 1) {
        const info =
          records[index]?.info || records[index]?.message || records[index];
        if (info?.role === "user" && info?.id) {
          target = String(info.id);
          break;
        }
      }
      if (!target) throw new Error("没有可撤回的用户消息");
    }
    await this.request(`/session/${encodeURIComponent(threadId)}/revert`, {
      method: "POST",
      directory: thread.cwd,
      body: { messageID: target },
    });
    const session = await this.request<any>(
      `/session/${encodeURIComponent(threadId)}`,
      { directory: thread.cwd },
    ).catch(() => undefined);
    const summary = session?.summary || {};
    const number = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) && value > 0
        ? value
        : 0;
    return {
      messageID: String(session?.revert?.messageID || target),
      files: number(summary.files),
      additions: number(summary.additions),
      deletions: number(summary.deletions),
    };
  }

  /** `/redo`：`POST /session/:id/unrevert`，恢复撤回前的内容与文件。 */
  async unrevertSession(_providerId: string, threadId: string) {
    const thread = this.requireThread(threadId);
    if (thread.archived) throw new Error("会话已归档，请先恢复再操作");
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("任务运行中不能恢复撤回，请先停止任务");
    await this.request(`/session/${encodeURIComponent(threadId)}/unrevert`, {
      method: "POST",
      directory: thread.cwd,
    });
    return { ok: true as const };
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
      const profiles = this.projectCatalogs.get(thread.cwd)?.profiles || this.profiles;
      const meta = profiles.find(
        (item) => item.id === parsed.providerID,
      )?.models?.[parsed.modelID];
      if (modelSupportsImages(meta) === false)
        throw new Error(
          `当前模型 ${thread.model} 不支持图片输入，请移除图片或改用支持视觉的模型后再发送`,
        );
    }
    const turnId = randomUUID();
    this.clearIdleTimer(thread.id);
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
    try {
      // /message waits for the entire agent run. A proxy or caller can time out
      // after OpenCode accepted it, then resend the same prompt. The async
      // endpoint acknowledges acceptance immediately (204).
      await this.request(`/session/${encodeURIComponent(threadId)}/prompt_async`, {
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
    } catch (error: any) {
      // POST 失败（模型被拒、server 重启中）时必须回滚上面的 running 标记，
      // 否则没有任何 session.status 事件能纠正，线程永久卡 running。
      // 若服务端实际已收下请求，后续 busy 事件会把它置回 running，自愈。
      const detail = String(error?.message || error || "OpenCode 任务发送失败");
      this.clearIdleTimer(thread.id);
      thread.status = "error";
      thread.activeTurnId = undefined;
      thread.lastError = detail;
      thread.updatedAt = Date.now();
      this.broadcast("thread.updated", thread);
      this.emitAgentEvent(thread, "turn/completed", {
        threadId,
        turn: { id: turnId, status: "failed", error: { message: detail } },
      });
      throw error;
    }
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
    if (approval.request?.method === "opencode/permission.v2") {
      const reply =
        decision === "acceptForSession"
          ? "always"
          : decision === "accept"
            ? "once"
            : "reject";
      await this.request(`/permission/${encodeURIComponent(approval.permissionId)}/reply`, {
        method: "POST",
        directory: approval.cwd,
        body: { reply },
      });
      this.clearApproval(approvalId);
      return { ok: true };
    }
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
    this.clearApproval(approvalId);
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
        await this.request(
          `/question/${encodeURIComponent(approval.requestId)}/reply`,
          { method: "POST", directory: approval.cwd, body: payload },
        );
      }
    }
    this.clearApproval(approval.id);
    return { ok: true };
  }

  private async waitForHealth() {
    let lastError: unknown;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try {
        // 本轮询自带重试，关闭 request 内层退避（否则启动探测被拖慢一个数量级）。
        await this.request("/global/health", { retry: false, timeoutMs: 5_000 });
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw lastError || new Error("OpenCode server 未在限定时间内启动");
  }

  private clearApproval(approvalId: string) {
    const approval = this.approvals.get(approvalId);
    if (!approval || !this.approvals.delete(approvalId)) return;
    this.broadcast("approval.resolved", { agentId: this.id, approvalId });
    const thread =
      this.threads.get(approval.sessionID) ||
      this.threads.get(this.childParents.get(approval.sessionID) || "");
    if (!thread || thread.status !== "waiting") return;
    const hasAnother = [...this.approvals.values()].some(
      (item) =>
        item.sessionID === thread.id ||
        this.childParents.get(item.sessionID) === thread.id,
    );
    if (hasAnother) return;
    thread.status = "running";
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    // An idle event may have arrived while the thread was waiting. Recheck
    // the current server state so a resolved prompt cannot leave it running.
    void this.request<Record<string, { type?: string }>>("/session/status", {
      directory: thread.cwd,
      retry: false,
    }).then((statuses) => {
      if (thread.status !== "running") return;
      const status = statuses?.[thread.id]?.type;
      if (!status || status === "idle") this.applyIdle(thread);
    }).catch(() => undefined);
  }

  private rememberPermissionRequest(permission: any) {
    const sessionID = String(permission?.sessionID || "");
    const permissionId = String(permission?.id || "");
    if (!sessionID || !permissionId) return;
    const thread =
      this.threads.get(sessionID) ||
      this.threads.get(this.childParents.get(sessionID) || "");
    const metadata = permission.metadata || {};
    const patterns = Array.isArray(permission.patterns)
      ? permission.patterns.map(String).filter(Boolean)
      : [];
    const kind = String(permission.permission || "permission");
    const command =
      (typeof metadata.command === "string" && metadata.command) ||
      patterns.join(", ") ||
      kind;
    const id = `${sessionID}:${permissionId}`;
    const pending = {
      id,
      agentId: this.id,
      providerId: thread?.providerId,
      cwd: thread?.cwd,
      sessionID,
      permissionId,
      kind: this.permissionKind(kind),
      command,
      reason: `${kind}${patterns.length ? ` · ${patterns.join(", ")}` : ""}`,
      availableDecisions: ["decline", "accept", "acceptForSession"],
      request: {
        method: "opencode/permission.v2",
        params: { threadId: sessionID, permission },
      },
    };
    this.approvals.set(id, pending);
    if (thread) {
      this.clearIdleTimer(thread.id);
      thread.status = "waiting";
      this.broadcast("thread.updated", thread);
    }
    this.broadcast("approval.requested", pending);
  }

  private rememberQuestionRequest(request: any) {
    const sessionID = String(request?.sessionID || "");
    const requestId = String(request?.id || "");
    if (!sessionID || !requestId) return;
    const thread =
      this.threads.get(sessionID) ||
      this.threads.get(this.childParents.get(sessionID) || "");
    const questions: ApprovalQuestion[] = (Array.isArray(request.questions)
      ? request.questions
      : []
    ).map((item: any, index: number) => ({
      id: String(requestId || index),
      header: typeof item.header === "string" ? item.header : undefined,
      prompt: item.question,
      options: (Array.isArray(item.options) ? item.options : []).map(
        (option: any) => ({
          label: String(option.label ?? option.value ?? ""),
          value: String(option.label ?? option.value ?? ""),
          ...(option.description
            ? { description: String(option.description) }
            : {}),
        }),
      ),
      ...(item.multiple ? { multiple: true } : {}),
      ...(item.custom ? { custom: true } : {}),
    }));
    const id = `${sessionID}:${requestId}`;
    const pending = {
      id,
      agentId: this.id,
      providerId: thread?.providerId,
      cwd: thread?.cwd,
      sessionID,
      requestId,
      kind: "question" as ApprovalKind,
      command: questions[0]?.header || questions[0]?.prompt || "OpenCode 提问",
      reason: `OpenCode 请求回答 ${questions.length} 个问题`,
      questions,
      ...(questions.some((item) => item.multiple) ? { multiple: true } : {}),
      request: {
        method: "opencode/question",
        params: { threadId: sessionID, requestId },
      },
    };
    this.approvals.set(id, pending);
    if (thread) {
      this.clearIdleTimer(thread.id);
      thread.status = "waiting";
      this.broadcast("thread.updated", thread);
    }
    this.broadcast("approval.requested", pending);
  }

  private async syncPendingPermissions() {
    const directories = new Set([
      undefined,
      ...[...this.threads.values()].map((thread) => thread.cwd).filter(Boolean),
    ]);
    const results = await Promise.all(
      [...directories].map((directory) =>
        this.request<unknown>("/permission", { directory, retry: false })
          .then((value) => Array.isArray(value) ? value : undefined)
          .catch(() => undefined),
      ),
    );
    const seen = new Set<string>();
    for (const requests of results) {
      if (!requests) continue;
      for (const permission of requests) {
        if (!permission?.sessionID || !permission?.id) continue;
        seen.add(`${permission.sessionID}:${permission.id}`);
        this.rememberPermissionRequest(permission);
      }
    }
    // A successful full scan also clears requests resolved while SSE was away.
    if (results.every((requests) => requests !== undefined))
      for (const [id, approval] of this.approvals)
        if (approval.request?.method === "opencode/permission.v2" && !seen.has(id))
          this.clearApproval(id);
    // Native questions have a separate queue. Older servers may not expose
    // GET /question; in that case keep existing cards until an SSE resolution.
    const questions = await Promise.all(
      [...directories].map((directory) =>
        this.request<unknown>("/question", {
          directory, retry: false, timeoutMs: 5_000,
        }).then((value) => Array.isArray(value) ? value : undefined)
          .catch(() => undefined),
      ),
    );
    const activeQuestions = new Set<string>();
    for (const requests of questions) {
      if (!requests) continue;
      for (const request of requests) {
        if (!request?.sessionID || !request?.id) continue;
        const id = `${request.sessionID}:${request.id}`;
        activeQuestions.add(id);
        if (!this.approvals.has(id)) this.rememberQuestionRequest(request);
      }
    }
    if (questions.every((requests) => requests !== undefined))
      for (const [id, approval] of this.approvals)
        if (approval.request?.method === "opencode/question" && !activeQuestions.has(id))
          this.clearApproval(id);
  }

  private async consumeEvents() {
    // 先停掉上一条流：restart 漏调或并发 startAll 时不能有两条 SSE 循环。
    this.eventAbort?.abort();
    const abort = new AbortController();
    this.eventAbort = abort;
    while (!abort.signal.aborted && this.eventAbort === abort) {
      try {
        const response = await this.fetcher(
          requestUrl(this.baseUrl!, "/global/event"),
          { signal: abort.signal },
        );
        if (!response.ok || !response.body)
          throw new Error(`OpenCode 事件流不可用：${response.status}`);
        this.error = undefined;
        this.broadcast("agent.status", this.descriptor());
        // Subscribe first, then recover requests created while SSE was away.
        // Events arriving during the scan stay buffered in the response body.
        await this.syncPendingPermissions();
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
        if (abort.signal.aborted) break;
        this.error = error?.message || String(error);
        this.broadcast("agent.status", this.descriptor());
      }
      if (!abort.signal.aborted && this.eventAbort === abort)
        await new Promise((resolve) => setTimeout(resolve, 1_500));
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
      if (session.parentID && !this.isForkChild(session)) {
        this.boundedPut(this.childParents, session.id, session.parentID);
        return;
      }
      if (session.parentID) this.forkChildren.add(session.id);
      const next = this.mergeThread(session, this.threads.get(session.id));
      // 事件里的 fork 会话不带 forkedFromId 时，用 parentID 补上，
      // 保证分支 chip / fork 计数 / origin 跳转可用。
      if (session.parentID && !next.forkedFromId)
        next.forkedFromId = session.fork &&
        typeof session.fork === "object" &&
        (session.fork as { sessionID?: string }).sessionID
          ? String((session.fork as { sessionID?: string }).sessionID)
          : session.parentID;
      this.threads.set(next.id, next);
      this.broadcast("thread.updated", next);
      return;
    }
    if (payload?.type === "session.deleted" && sessionId) {
      this.clearIdleTimer(sessionId);
      this.threads.delete(sessionId);
      this.sessionTitles.delete(sessionId);
      this.forkChildren.delete(sessionId);
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
      if (body.status?.type === "busy" || body.status?.type === "retry") {
        this.markBusy(thread);
      } else {
        this.scheduleIdle(thread);
      }
      return;
    }
    if (payload?.type === "session.idle" && thread) {
      this.scheduleIdle(thread);
      return;
    }
    if (payload?.type === "session.error" && thread) {
      this.clearIdleTimer(thread.id);
      const turnId = thread.activeTurnId || "opencode";
      thread.status = "error";
      thread.activeTurnId = undefined;
      thread.lastError = String(
        body.error?.data?.message || body.error?.message || "OpenCode 任务失败",
      );
      this.broadcast("thread.updated", thread);
      for (const [id, approval] of this.approvals)
        if (approval.sessionID === thread.id) this.clearApproval(id);
      this.emitAgentEvent(thread, "turn/completed", {
        threadId: thread.id,
        turn: {
          id: turnId,
          status: "failed",
          error: { message: thread.lastError },
        },
      });
      return;
    }
    if (payload?.type === "question.asked") {
      this.rememberQuestionRequest(body);
      return;
    }
    if (
      (payload?.type === "question.replied" ||
        payload?.type === "question.rejected") &&
      body.requestID
    ) {
      this.clearApproval(`${body.sessionID}:${body.requestID}`);
      return;
    }
    if (payload?.type === "permission.asked") {
      this.rememberPermissionRequest(body);
      return;
    }
    if (payload?.type === "permission.replied" && body.requestID) {
      this.clearApproval(`${body.sessionID}:${body.requestID}`);
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
        this.clearIdleTimer(thread.id);
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
    if (payload?.type === "message.part.delta") {
      if (
        !thread ||
        body.field !== "text" ||
        !body.partID ||
        this.messageRoles.get(String(body.messageID)) === "user" ||
        (this.partTypes.has(String(body.partID)) &&
          this.partTypes.get(String(body.partID)) !== "text")
      ) return;
      this.clearIdleTimer(thread.id);
      this.emitAgentEvent(thread, "item/agentMessage/delta", {
        threadId: thread.id,
        turnId: thread.activeTurnId,
        itemId: body.partID,
        delta: body.delta,
      });
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
      if (part?.id && part?.type)
        this.boundedPut(this.partTypes, String(part.id), String(part.type));
      // OpenCode replays the parts of the message the user just sent. The
      // turn history already renders that message, so forwarding it here
      // would show it a second time as if the assistant repeated it.
      if (this.isUserPart(part)) return;
      // 还有助手/工具活动就说明本轮没结束：取消待定的 idle，
      // 避免步骤间隙的 idle 把侧栏先打成“有新回复/无状态”再跳回运行中。
      if (sessionId) this.clearIdleTimer(sessionId);
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
    options: {
      method?: string;
      directory?: string;
      body?: unknown;
      /**
       * 传 false 关闭 GET 重试：waitForHealth 自带 150 次轮询，
       * 内层再退避重试会把启动探测拖慢一个数量级。
       */
      retry?: boolean;
      /** 0 disables the deadline for endpoints that run an entire agent turn. */
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    if (!this.baseUrl) throw new Error("OpenCode server 尚未启动");
    const idempotent = !options.method || options.method === "GET";
    const maxAttempts =
      options.retry === false || !idempotent ? 1 : 1 + REQUEST_RETRIES;
    const timeoutMs =
      options.timeoutMs ??
      (idempotent ? REQUEST_TIMEOUT_MS : REQUEST_POST_TIMEOUT_MS);
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0)
        await new Promise<void>((resolve) =>
          setTimeout(
            resolve,
            REQUEST_RETRY_DELAYS_MS[
              Math.min(attempt - 1, REQUEST_RETRY_DELAYS_MS.length - 1)
            ],
          ),
        );
      // AbortSignal.timeout 的定时器是 unref 的：进程空闲时它不会触发，
      // 「挂起连接超时」的 deadline 保证就失效了（事件循环先排空，请求
      // 永不结算）。ref 定时器 + AbortController 才能确保超时一定到达。
      const abort = new AbortController();
      const timer = timeoutMs > 0
        ? setTimeout(() => abort.abort(), timeoutMs)
        : undefined;
      try {
        const response = await this.fetcher(
          requestUrl(this.baseUrl, pathname, options.directory),
          {
            method: options.method,
            headers: options.body
              ? { "content-type": "application/json" }
              : undefined,
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: abort.signal,
          },
        );
        if (!response.ok) {
          if (
            idempotent &&
            attempt + 1 < maxAttempts &&
            (response.status === 502 ||
              response.status === 503 ||
              response.status === 504)
          )
            continue;
          throw new Error(
            `OpenCode API ${response.status}: ${(await response.text()).slice(0, 500)}`,
          );
        }
        if (response.status === 204) return undefined as T;
        return response.json() as Promise<T>;
      } catch (error: any) {
        // HTTP 状态错误直接抛（fork 的 404 兜底依赖原文案），不重试。
        if (String(error?.message || "").startsWith("OpenCode API "))
          throw error;
        lastError = error;
        if (attempt + 1 >= maxAttempts || !isTransientRequestError(error))
          throw this.requestError(error);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw this.requestError(lastError);
  }

  /**
   * Node fetch 网络失败原文就是 "fetch failed"，直接透到前端用户看不懂。
   * 包一层中文说明并保留原文/原因码，方便排查。
   */
  private requestError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = (error as any)?.cause as
      | { code?: unknown; message?: unknown }
      | undefined;
    const causeText =
      cause &&
      String(cause.message || "").trim() &&
      String(cause.message) !== message
        ? `（${String(cause.code || cause.message)}）`
        : "";
    return new Error(`OpenCode 连接闪断（${message}）${causeText}，重试即可恢复`);
  }

  private offline(error: unknown) {
    this.online = false;
    this.error = error instanceof Error ? error.message : String(error);
    this.clearAllIdleTimers();
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
