import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { assertMessageInput, messageBusy, type AgentMessageInput, type AgentMessageAcceptance } from "./messages.js";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import type {
  AgentId,
  ApprovalKind,
  ModelInfo,
  RpcMessage,
  ThreadSummary,
  TurnImage,
} from "../types.js";
import type { ThreadSettingsStore } from "../thread-settings.js";
import { timestampFromId } from "../protocol.js";
import { AcpClient } from "./acp-client.js";
import type {
  AcpAgentCapabilities,
  AcpAvailableCommand,
  AcpContentBlock,
  AcpNewSessionResult,
  AcpPermissionOption,
  AcpSessionConfigOption,
  AcpSessionInfo,
  AcpSessionModeState,
  AcpSessionModelState,
  AcpSessionUpdate,
  AcpToolCall,
} from "./acp-types.js";
import type {
  AgentCapabilities,
  AgentCreateThreadInput,
  AgentDescriptor,
} from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * 一个 ACP agent 的接入描述。内置表见 acp-agents.ts；用户可用数据目录下的
 * acp-agents.json 覆盖参数或注册自定义 agent。
 */
export interface AcpAgentSpec {
  id: AgentId;
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  /**
   * 声明本 agent 是某个主 agent 的备选（例如 claude-code-acp 之于原生
   * `claude`：二者读写同一份 `~/.claude` 会话）。主 agent 健康时隐藏本
   * agent 未接管的历史会话，避免同一批会话重复出现；见 AgentRegistry。
   */
  fallbackFor?: AgentId;
  /**
   * ACP 没有强制的历史列举接口。`sessionCapabilities.list` 优先走
   * `session/list`；不支持时回落到这个本地命令（如 `devin list --format
   * json`）。命令应输出 JSON 数组或 {sessions:[...]}，字段名宽松匹配。
   */
  listSessions?: {
    command?: string;
    args: string[];
    /** true → 在每个已知项目目录下各执行一次（devin list 按目录列会话）。 */
    perDirectory?: boolean;
    /**
     * 非标准输出字段映射：规范字段 → 该 CLI 输出里的键名。声明后优先于
     * 内置别名表，适配新 CLI 只需改 spec 而不动 adapter。
     */
    fields?: Partial<
      Record<"sessionId" | "cwd" | "title" | "updatedAt" | "locked", string>
    >;
  };
  /** agent 不支持 configOptions 模型目录时的静态模型列表。 */
  models?: { id: string; name?: string; description?: string }[];
  /** 认证类错误后附加的提示文案；缺省时用通用「请先完成登录认证」。 */
  authHint?: string;
}

/** 规范字段 → listSessions 命令输出的常见别名。spec.fields 可覆盖/补充。 */
const SESSION_FIELD_ALIASES = {
  sessionId: ["sessionId", "session_id", "id", "sessionID"],
  cwd: [
    "cwd",
    "directory",
    "workingDirectory",
    "working_directory",
    "path",
    "workspace",
  ],
  title: ["title", "name", "summary", "description"],
  updatedAt: [
    "updatedAt",
    "updated_at",
    "lastActivityAt",
    "last_active_at",
    "createdAt",
    "created_at",
    "timestamp",
  ],
} as const;

interface PendingPermission {
  id: string;
  threadId: string;
  requestId: number | string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
  kind: ApprovalKind;
}

interface AcpSessionState {
  id: string;
  /** 进程内已 new/load 的会话才能 prompt。 */
  live: boolean;
  /** 正在进行的 turnId（用于把 session/update 路由到正确 turn）。 */
  turnId?: string;
  /**
   * toolCallId → 原始 ACP toolCall，tool_call_update 增量合并与
   * request_permission 补 kind/title/rawInput 都以此为底。终态后只留
   * 骨架字段（slimToolCall）——rawInput/content 里是整份文件内容。
   * 原始载荷不再挂到 item.__raw：那会随 agent.event 广播和 readThread
   * 响应被全量序列化给客户端，常驻内存和带宽两头浪费。
   */
  rawTools: Map<string, AcpToolCall>;
  commands: AcpAvailableCommand[];
  modes?: AcpSessionModeState;
  /** session/new|resume|load 响应里的模型目录（claude-code-acp 走这个字段）。 */
  models?: AcpSessionModelState;
  configOptions: AcpSessionConfigOption[];
  /** 本地收集的 turn 历史（live 累积或 load 回放结果）。 */
  turns: any[];
  /**
   * 本进程内已回放过该会话的历史（session/load 成功，或 session/new 的
   * 全新会话天然无历史可回放）。live 会话靠 session/update 流保持新鲜，
   * 不需要每次读取都整段重放——agent 端每次 load 都会新建一整套会话
   * 状态（devin 的 create_acp_agent），重复回放是纯开销。
   */
  historyLoaded?: boolean;
  /** session/load 回放在此累积，与实时 turn 分流。 */
  replay?: { turns: any[]; current?: any };
  /** 每个 messageId 的流式文本累积。 */
  messageText: Map<string, string>;
  thoughtText: string;
  thoughtItemId?: string;
  /** 区分同 turn 内被工具/思考隔开的多段回复/思考（无 messageId 时）。 */
  runSeq: number;
  /** 进行中的 session/load。 */
  loading?: Promise<any[]>;
  /** running 期间收到的待发消息；turn 结束后按序 drain。 */
  pendingSends: { turnId: string; text: string; images?: TurnImage[] }[];
  queueHolds?: number;
}

/**
 * 活动时间优先级：agent 报告的时间戳 > 本地缓存 > sessionId 内嵌的
 * UUIDv7 时间 > 当前时间。list 刷新/回放不得把「没有数据」刷成「刚刚」。
 */
function resolveUpdatedAt(
  info: AcpSessionInfo,
  existing: ThreadSummary | undefined,
  sessionId: string,
) {
  return (
    Date.parse(info.updatedAt || "") ||
    existing?.updatedAt ||
    timestampFromId(sessionId) ||
    Date.now()
  );
}

function pick(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return "";
}

function textOfContent(block: AcpContentBlock | undefined): string {
  if (!block) return "";
  if (block.type === "text") return String(block.text || "");
  if (block.type === "resource_link")
    return `[${block.name || block.uri || "resource"}]`;
  if (block.type === "resource") {
    const text = block.resource?.text;
    return typeof text === "string" && text
      ? text
      : `[${block.resource?.uri || "resource"}]`;
  }
  if (block.type === "image") return "[image]";
  if (block.type === "audio") return "[audio]";
  return `[${block.type || "content"}]`;
}

/** 用户图片保留为图片部分，不能在回放时拼成正文里的 "[image]"。 */
function userContentPart(block: AcpContentBlock | undefined): Record<string, any> | undefined {
  if (block?.type === "image") {
    const url = block.data && block.mimeType?.startsWith("image/")
      ? `data:${block.mimeType};base64,${block.data}` : block.uri;
    return url ? { type: "image", url, name: block.name } : undefined;
  }
  const text = textOfContent(block);
  return text ? { type: "text", text } : undefined;
}

function toolOutputText(call: AcpToolCall): string {
  const parts: string[] = [];
  for (const entry of call.content || []) {
    if (entry?.type === "content") {
      const text = textOfContent(entry.content);
      if (text) parts.push(text);
    }
  }
  if (typeof call.rawOutput === "string" && call.rawOutput.trim())
    parts.push(call.rawOutput);
  else if (call.rawOutput != null) {
    try {
      parts.push(JSON.stringify(call.rawOutput, null, 2));
    } catch {
      /* ignore */
    }
  }
  return tailLimited(parts.join("\n\n").trim(), TOOL_OUTPUT_TAIL_LIMIT);
}

function shellCommandOf(call: AcpToolCall): string {
  const editable = editableCommandOf(call);
  if (editable) return editable;
  const input = call.rawInput;
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const row = input as Record<string, unknown>;
    for (const key of ["command", "cmd", "script", "code"]) {
      const value = row[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return String(call.title || "").trim();
}

/**
 * devin 的 request_permission 只带 {toolCallId, _meta} 快照，命令文本在
 * `_meta["cognition.ai/editableCommand"]`；session/update 的完整 toolCall
 * 里才有 title/rawInput。
 */
function editableCommandOf(call: AcpToolCall): string {
  const meta = call._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return "";
  for (const [key, value] of Object.entries(meta)) {
    if (
      typeof value === "string" &&
      value.trim() &&
      /(?:^|[./])editableCommand$/i.test(key)
    )
      return value.trim();
  }
  return "";
}

/** oldText/newText 合成一个带 +/- 前缀的简易 diff，供 FileDiff 按行着色。 */
function pseudoDiff(oldText: string | null | undefined, newText?: string) {
  const minus = (oldText || "")
    .split("\n")
    .map((line) => `-${line}`)
    .join("\n");
  const plus = String(newText ?? "")
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n");
  return [minus, plus].filter(Boolean).join("\n");
}

function itemStatus(status: string | undefined) {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "inProgress";
}

/**
 * turn item 常驻内存的体积控制。回放的历史会话与累积的 live 会话都不
 * 淘汰（session.turns 随进程生命周期保留），单个 item 必须把大块载荷
 * 截在内存外，否则长跑进程会按会话活动量单调上涨。
 */
const TOOL_OUTPUT_TAIL_LIMIT = 512 * 1024;
const RAW_ARG_STRING_LIMIT = 32 * 1024;

function tailLimited(text: string, limit: number) {
  if (text.length <= limit) return text;
  return `…(省略前 ${text.length - limit} 字符)\n${text.slice(-limit)}`;
}

/**
 * 终态 toolCall 只留增量合并要用的骨架字段：content（old/newText）、
 * rawInput（整份文件参数）、locations 这些大载荷在终态后不再被读取。
 * 进行中的调用要留全量——权限请求和后续 update 都靠它补齐字段。
 */
function slimToolCall(call: AcpToolCall): AcpToolCall {
  return {
    toolCallId: call.toolCallId,
    kind: call.kind,
    title: call.title,
    status: call.status,
  } as AcpToolCall;
}

/**
 * rawInput 直接挂到 item 上前逐字段截断长字符串（write/edit 类工具的
 * 参数是整份文件内容）。只有真有字段被截断才拷贝，小对象原样透传。
 */
function capDeepStrings(value: any): any {
  if (typeof value === "string")
    return tailLimited(value, RAW_ARG_STRING_LIMIT);
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const capped = capDeepStrings(entry);
      changed ||= capped !== entry;
      return capped;
    });
    return changed ? next : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const capped = capDeepStrings(entry);
      changed ||= capped !== entry;
      next[key] = capped;
    }
    return changed ? next : value;
  }
  return value;
}

/**
 * session/list 项的锁定标记。devin 放在 `_meta["cognition.ai/isLocked"]`；
 * 直接给 locked/isLocked/is_locked 字段的 agent（或 listSessions 命令的
 * JSON 行）一并识别。误配 `unlocked` 之类的键不会命中。
 */
function sessionLockedOf(info: Record<string, unknown>): boolean {
  for (const key of ["locked", "isLocked", "is_locked"])
    if (info[key] === true) return true;
  const meta = info._meta;
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    for (const [key, value] of Object.entries(meta))
      if (value === true && /(?:^|\/)(?:is)?locked$/i.test(key)) return true;
  }
  return false;
}

export class AcpAdapter extends EventEmitter {
  readonly id: AgentId;
  private client: AcpClient;
  private threads = new Map<string, ThreadSummary>();
  private sessions = new Map<string, AcpSessionState>();
  private approvals = new Map<string, PendingPermission>();
  private liveLoading = new Map<string, Promise<void>>();
  private online = false;
  private starting = false;
  private error?: string;
  private historyStatus: AgentDescriptor["historyStatus"] = "loading";
  private historyError?: string;
  private startTask?: Promise<void>;
  /** restart() 触发的进程停止；下一次启动要先等它结束。 */
  private stopTask?: Promise<void>;

  constructor(
    private spec: AcpAgentSpec,
    private options: {
      threadSettings?: ThreadSettingsStore;
      initialThreads?: ThreadSummary[];
      /** perDirectory 历史列举命令使用的候选目录。 */
      directories?: string[];
      spawnProcess?: typeof spawn;
      killProcessTree?: (pid: number) => void;
      requestTimeoutMs?: number;
      /** 测试注入：替代 execFile 跑 listSessions 命令。 */
      execListCommand?: (
        command: string,
        args: string[],
        cwd?: string,
      ) => Promise<string>;
    } = {},
  ) {
    super();
    this.id = spec.id;
    this.client = new AcpClient({
      command: spec.command,
      args: spec.args,
      env: spec.env,
      requestTimeoutMs: options.requestTimeoutMs,
      spawnProcess: options.spawnProcess,
      killProcessTree: options.killProcessTree,
    });
    this.client.on("notification", (message: RpcMessage) =>
      this.onNotification(message),
    );
    this.client.on("request", (message: RpcMessage) =>
      this.onClientRequest(message),
    );
    this.client.on("offline", (message: string) => this.onOffline(message));
    for (const thread of options.initialThreads || []) {
      if (thread.agentId !== this.id) continue;
      this.threads.set(thread.id, {
        ...thread,
        ...options.threadSettings?.get(this.id, thread.id),
        agentId: this.id,
        // 缓存的 live 状态对新进程没有意义：进程重启后会话不再 live。
        status: "idle",
        activeTurnId: undefined,
        controlMode: "history",
      });
    }
    this.historyStatus = this.threads.size ? "cached" : "loading";
  }

  private get capabilities(): AgentCapabilities {
    const caps = this.client.agentCapabilities;
    return {
      messages: { busyBehavior: "queue", interruptScope: "session", queueDurability: "memory" },
      approvals: true,
      archive: true,
      delete: Boolean(caps.sessionCapabilities?.delete),
      fork: Boolean(caps.sessionCapabilities?.fork),
      images: Boolean(caps.promptCapabilities?.image),
      interrupt: true,
      mcp: false,
      models: this.hasModelCatalog(),
      review: false,
      sessionSettings: true,
      shell: false,
      skills: false,
    };
  }

  descriptor(): AgentDescriptor {
    return {
      id: this.id,
      name: this.spec.name,
      protocol: "acp",
      fallbackFor: this.spec.fallbackFor,
      available: true,
      online: this.online && this.client.online,
      starting: this.starting,
      error: this.error,
      historyStatus: this.historyStatus,
      historyError: this.historyError,
      capabilities: this.capabilities,
    };
  }

  snapshot() {
    const all = [...this.threads.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    return {
      threads: all.filter((thread) => !thread.archived),
      archivedThreads: all.filter((thread) => thread.archived),
      approvals: [...this.approvals.values()].map((approval) =>
        this.approvalView(approval),
      ),
    };
  }

  publicProfiles() {
    return [
      {
        id: `${this.id}-current`,
        agentId: this.id,
        name: this.spec.name,
        current: true,
        enabled: true,
        online: this.online,
      },
    ];
  }

  startAll() {
    if (this.startTask) return this.startTask;
    const task = this.startOnce();
    this.startTask = task;
    return task.finally(() => {
      if (this.startTask === task) this.startTask = undefined;
    });
  }

  private async startOnce() {
    this.starting = true;
    this.broadcast("agent.status", this.descriptor());
    try {
      // 重载 = restart() 后立刻 startAll()：必须等旧进程真正退出再拉新的，
      // 否则旧进程迟到的 exit 会被算到新进程头上，把刚起来的连接判死。
      if (this.stopTask) await this.stopTask;
      await this.client.start();
      this.online = true;
      this.error = undefined;
      await this.loadHistory();
    } catch (error: any) {
      this.online = false;
      this.error = this.withAuthHint(error?.message || String(error));
      this.historyStatus = "error";
      this.historyError = this.error;
      throw error;
    } finally {
      this.starting = false;
      this.broadcast("agent.status", this.descriptor());
      this.broadcast("snapshot", this.snapshot());
    }
  }

  async refreshAll() {
    if (!this.client.online) return this.startAll();
    await this.loadHistory();
  }

  busyThreads() {
    return [...this.threads.values()].filter(
      (thread) =>
        !thread.archived &&
        (thread.status === "running" || thread.status === "waiting"),
    );
  }

  runtimePids() {
    const pid = this.client.pid;
    return typeof pid === "number" ? [pid] : [];
  }

  restart() {
    // 先把挂起的 permission 请求应答 cancelled，再停进程。
    for (const approval of this.approvals.values()) {
      this.client.respond(approval.requestId, {
        outcome: { outcome: "cancelled" },
      });
    }
    this.approvals.clear();
    const stopping = this.client.stop();
    this.stopTask = stopping;
    void stopping.finally(() => {
      if (this.stopTask === stopping) this.stopTask = undefined;
    });
    for (const session of this.sessions.values()) {
      session.live = false;
      session.historyLoaded = false;
    }
    for (const thread of this.threads.values())
      if (thread.status === "running" || thread.status === "waiting") {
        thread.status = "offline";
        thread.activeTurnId = undefined;
      }
    this.online = false;
  }

  private onOffline(message: string) {
    this.online = false;
    this.error = message;
    for (const session of this.sessions.values()) {
      session.live = false;
      session.historyLoaded = false;
    }
    for (const approval of this.approvals.values()) {
      this.broadcast("approval.resolved", {
        agentId: this.id,
        approvalId: approval.id,
      });
    }
    this.approvals.clear();
    for (const thread of this.threads.values())
      if (thread.status === "running" || thread.status === "waiting") {
        thread.status = "error";
        thread.lastError = message;
        thread.activeTurnId = undefined;
        this.broadcast("thread.updated", thread);
      }
    this.broadcast("agent.status", this.descriptor());
  }

  // ---------------------------------------------------------------- sessions

  private sessionFor(threadId: string) {
    let session = this.sessions.get(threadId);
    if (!session) {
      session = {
        id: threadId,
        live: false,
        rawTools: new Map(),
        commands: [],
        configOptions: [],
        turns: [],
        messageText: new Map(),
        thoughtText: "",
        runSeq: 0,
        pendingSends: [],
      };
      this.sessions.set(threadId, session);
    }
    return session;
  }

  private async ensureClient() {
    if (!this.client.online) {
      try {
        await this.client.start();
      } catch (error: any) {
        throw new Error(this.withAuthHint(error?.message || String(error)));
      }
      this.online = true;
      this.error = undefined;
      this.broadcast("agent.status", this.descriptor());
    }
  }

  /** 让历史会话在当前进程内可用（resume 优先，load 兜底并顺带取回历史）。 */
  private async ensureLive(thread: ThreadSummary) {
    const session = this.sessionFor(thread.id);
    if (session.live) return;
    const running = this.liveLoading.get(thread.id);
    if (running) return running;
    const task = (async () => {
      if (session.live) return;
      const caps = this.client.agentCapabilities;
      const canResume = Boolean(caps.sessionCapabilities?.resume);
      try {
        if (canResume) {
          const result = (await this.client.request("session/resume", {
            sessionId: thread.id,
            cwd: thread.cwd,
            mcpServers: [],
          })) as AcpNewSessionResult;
          this.applySessionInfo(thread, session, result);
          session.live = true;
          if (thread.locked) {
            thread.locked = undefined;
            this.broadcast("thread.updated", thread);
          }
          return;
        }
        if (caps.loadSession) {
          await this.loadSession(thread, session);
          return;
        }
        throw new Error(
          `${this.spec.name} 不支持恢复历史会话（缺少 loadSession/resume 能力）`,
        );
      } catch (error) {
        throw this.translateSessionError(thread, error);
      }
    })().finally(() => {
      this.liveLoading.delete(thread.id);
    });
    this.liveLoading.set(thread.id, task);
    return task;
  }

  /** session/load：回放过程中 agent 会推送全量 session/update。 */
  private async loadSession(
    thread: ThreadSummary,
    session: AcpSessionState,
  ): Promise<any[]> {
    if (session.loading) return session.loading;
    const task = (async () => {
      const replay = { turns: [] as any[], current: undefined as any };
      session.replay = replay;
      try {
        const result = (await this.client.request(
          "session/load",
          { sessionId: thread.id, cwd: thread.cwd, mcpServers: [] },
          Math.max(this.options.requestTimeoutMs ?? 30_000, 60_000),
        )) as AcpNewSessionResult;
        if (replay.current) replay.turns.push(replay.current);
        session.turns = replay.turns;
        this.applySessionInfo(thread, session, result);
        session.live = true;
        session.historyLoaded = true;
        if (thread.locked) {
          thread.locked = undefined;
          this.broadcast("thread.updated", thread);
        }
        return session.turns;
      } finally {
        session.replay = undefined;
        session.loading = undefined;
      }
    })();
    session.loading = task;
    return task;
  }

  private applySessionInfo(
    thread: ThreadSummary,
    session: AcpSessionState,
    result: AcpNewSessionResult,
  ) {
    if (result?.modes?.availableModes?.length) {
      session.modes = result.modes;
      thread.sessionModes = result.modes.availableModes.map((mode) => ({
        id: mode.id,
        name: mode.name,
        description: mode.description,
      }));
    }
    if (result?.modes?.currentModeId)
      thread.sessionMode = result.modes.currentModeId;
    if (result?.models) session.models = result.models;
    if (Array.isArray(result?.configOptions))
      session.configOptions = result.configOptions;
    // ACP 规范不在 new/resume/load 响应里带命令，但部分 agent 会顺带返回；
    // 宽松接收 `commands.availableCommands` 或顶层 `availableCommands`。
    const seeded =
      (result as any)?.commands?.availableCommands ??
      (result as any)?.availableCommands;
    if (Array.isArray(seeded))
      session.commands = seeded.filter(
        (item: any) => typeof item?.name === "string",
      );
    const model = this.currentModelOf(session);
    if (model) thread.resolvedModel = model;
  }

  private currentModelOf(session: AcpSessionState) {
    const option = (session.configOptions || []).find(
      (item) => item?.category === "model" && item?.type === "select",
    );
    if (typeof option?.currentValue === "string") return option.currentValue;
    return session.models?.currentModelId || "";
  }

  /* ACP 没有标准 effort 字段；agent 若暴露了 effort 类 select
     configOption（如 devin 的 thinking level），就当作推理强度来用。 */
  private effortOptionOf(session: AcpSessionState) {
    return (session.configOptions || []).find(
      (item) =>
        item?.type === "select" &&
        item?.category !== "model" &&
        /effort|reason|thought|think/i.test(
          `${item?.category || ""} ${item?.id || ""} ${item?.name || ""}`,
        ),
    );
  }

  private currentEffortOf(session: AcpSessionState) {
    const value = this.effortOptionOf(session)?.currentValue;
    return typeof value === "string" ? value : "";
  }

  // ------------------------------------------------------------------ CRUD

  async createThread(providerId: string, input: AgentCreateThreadInput) {
    await this.ensureClient();
    let result: AcpNewSessionResult;
    try {
      result = (await this.client.request("session/new", {
        cwd: input.cwd,
        mcpServers: [],
      })) as AcpNewSessionResult;
    } catch (error: any) {
      throw new Error(this.withAuthHint(error?.message || String(error)));
    }
    const sessionId = String(result?.sessionId || "");
    if (!sessionId) throw new Error(`${this.spec.name} 没有返回 sessionId`);
    const session = this.sessionFor(sessionId);
    session.live = true;
    session.historyLoaded = true;
    const thread: ThreadSummary = {
      agentId: this.id,
      id: sessionId,
      providerId: providerId || `${this.id}-current`,
      name: input.name || `新 ${this.spec.name} 会话`,
      preview: input.name || `新 ${this.spec.name} 会话`,
      cwd: input.cwd,
      model:
        input.model && input.model !== "default"
          ? input.model
          : this.currentModelOf(session) || "default",
      status: "idle",
      updatedAt: Date.now(),
      sessionId,
      controlMode: "managed",
      ...this.options.threadSettings?.get(this.id, sessionId),
    };
    this.applySessionInfo(thread, session, result);
    this.threads.set(sessionId, thread);
    const effort = this.currentEffortOf(session);
    if (effort) thread.reasoningEffort = effort;
    if (input.model && input.model !== "default")
      await this.applyModel(thread, session, input.model).catch(() => {
        /* 模型应用失败不阻塞建会话 */
      });
    if (input.reasoningEffort)
      await this.applyEffort(thread, session, input.reasoningEffort).catch(
        () => {
          /* 同上 */
        },
      );
    if (input.sessionMode)
      await this.applyMode(thread, session, input.sessionMode).catch(() => {
        /* 同上 */
      });
    this.broadcast("thread.updated", thread);
    return thread;
  }

  /** session/fork：agent 侧复制会话历史并返回新 sessionId（ACP unstable）。 */
  async forkThread(providerId: string, threadId: string) {
    const source = this.mustThread(threadId);
    if (source.status === "running" || source.status === "waiting")
      throw new Error("会话正在运行，无法分支");
    await this.ensureClient();
    const result = (await this.client.request("session/fork", {
      sessionId: threadId,
      cwd: source.cwd,
      mcpServers: [],
    })) as AcpNewSessionResult;
    const sessionId = String(result?.sessionId || "");
    if (!sessionId) throw new Error(`${this.spec.name} 没有返回 sessionId`);
    const session = this.sessionFor(sessionId);
    session.live = true;
    const thread: ThreadSummary = {
      agentId: this.id,
      id: sessionId,
      providerId: source.providerId || providerId || `${this.id}-current`,
      name: `${source.name || source.preview || "会话"} · 分支`,
      preview: source.preview,
      cwd: source.cwd,
      model: source.model,
      status: "idle",
      updatedAt: Date.now(),
      sessionId,
      forkedFromId: threadId,
      controlMode: "managed",
    };
    this.applySessionInfo(thread, session, result);
    this.threads.set(sessionId, thread);
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async readThread(_providerId: string, threadId: string) {
    const thread = this.mustThread(threadId);
    const session = this.sessionFor(threadId);
    const busy = thread.status === "running" || thread.status === "waiting";
    // live 会话由 session/update 流持续喂新，无需每次读取都整段重放；
    // agent 端每次 session/load 都会新建一份会话状态，重复调用是内存放大器。
    const needsReplay =
      !session.live || (!session.turns.length && !session.historyLoaded);
    if (
      !busy &&
      needsReplay &&
      this.client.online &&
      this.client.agentCapabilities.loadSession
    ) {
      try {
        await this.loadSession(thread, session);
      } catch (error) {
        // 回放失败退回本地累积的 turn（进程内新建的会话在磁盘上可能还没
        // 历史）；锁冲突顺带把标记打上，让 UI 显示「占用中」。
        if (this.isSessionLockedError(error) && !thread.locked) {
          thread.locked = true;
          this.broadcast("thread.updated", thread);
        }
      }
    }
    this.stampTurnModels(thread, session.turns);
    return {
      id: threadId,
      agentId: this.id,
      providerId: thread.providerId,
      cwd: thread.cwd,
      model: thread.resolvedModel || thread.model,
      reasoningEffort: thread.reasoningEffort,
      sessionMode: thread.sessionMode,
      sessionModes: thread.sessionModes,
      turns: session.turns,
      tokenUsage: thread.tokenUsage,
    };
  }

  /**
   * 回填 turn 的模型快照：live turn 的 id 与记录一致直接命中；session/load
   * 回放生成的 `acp-replay-N` 合成 id 对不上，仅当「快照数与 turn 数一致
   * 且没有任何 id 命中」时按位置回填，错位历史宁可留空让前端回落。
   */
  private stampTurnModels(thread: ThreadSummary, turns: any[]) {
    const stamps =
      this.options.threadSettings?.turnModelList(this.id, thread.id) || [];
    if (!stamps.length || !Array.isArray(turns)) return;
    const byId = new Map(stamps.map((stamp) => [stamp.turnId, stamp]));
    const aligned =
      turns.length === stamps.length &&
      turns.every((turn) => !turn?.model && !byId.has(String(turn?.id || "")));
    turns.forEach((turn, index) => {
      if (!turn || turn.model) return;
      const stamp =
        byId.get(String(turn.id || "")) ||
        (aligned ? stamps[index] : undefined);
      if (stamp?.model) turn.model = stamp.model;
      if (stamp?.reasoningEffort && !turn.reasoningEffort)
        turn.reasoningEffort = stamp.reasoningEffort;
    });
  }

  async renameThread(_providerId: string, threadId: string, name: string) {
    const thread = this.mustThread(threadId);
    const next = name.trim();
    if (!next) throw new Error("会话名称不能为空");
    thread.name = next;
    this.touch(thread);
    await this.options.threadSettings?.update(this.id, threadId, {
      name: next,
    });
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async archiveThread(_providerId: string, threadId: string) {
    const thread = this.mustThread(threadId);
    if (thread.archived) return thread;
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("运行中的会话不能归档");
    thread.archived = true;
    await this.options.threadSettings?.update(this.id, threadId, {
      archived: true,
    });
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async unarchiveThread(_providerId: string, threadId: string) {
    const thread = this.mustThread(threadId);
    if (!thread.archived) return thread;
    thread.archived = false;
    await this.options.threadSettings?.update(this.id, threadId, {
      archived: null,
    });
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async deleteThread(_providerId: string, threadId: string) {
    const thread = this.mustThread(threadId);
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("运行中的会话不能删除");
    if (
      this.client.online &&
      this.client.agentCapabilities.sessionCapabilities?.delete
    )
      try {
        await this.client.request("session/delete", { sessionId: threadId });
      } catch (error) {
        throw this.translateSessionError(thread, error);
      }
    this.sessions.delete(threadId);
    this.threads.delete(threadId);
    await this.options.threadSettings?.remove(this.id, threadId);
    this.broadcast("thread.deleted", { agentId: this.id, threadId });
    return { ok: true };
  }

  async updateThreadSettings(
    _providerId: string,
    threadId: string,
    settings: Partial<AgentCreateThreadInput>,
  ) {
    const thread = this.mustThread(threadId);
    const session = this.sessionFor(threadId);
    if (settings.sessionMode) {
      await this.applyMode(thread, session, settings.sessionMode);
      await this.options.threadSettings?.update(this.id, threadId, {
        sessionMode: settings.sessionMode,
      });
    }
    if (settings.model) {
      await this.applyModel(thread, session, settings.model);
      thread.model = settings.model;
      await this.options.threadSettings?.update(this.id, threadId, {
        model: settings.model,
      });
    }
    if (settings.reasoningEffort !== undefined) {
      await this.applyEffort(thread, session, settings.reasoningEffort);
      await this.options.threadSettings?.update(this.id, threadId, {
        reasoningEffort: settings.reasoningEffort,
      });
    }
    this.touch(thread);
    this.broadcast("thread.updated", thread);
    return thread;
  }

  private async applyMode(
    thread: ThreadSummary,
    session: AcpSessionState,
    modeId: string,
  ) {
    if (!session.live)
      throw new Error("会话尚未加载，发送一条消息后才能切换模式");
    await this.client.request("session/set_mode", {
      sessionId: thread.id,
      modeId,
    });
    thread.sessionMode = modeId;
  }

  private async applyModel(
    thread: ThreadSummary,
    session: AcpSessionState,
    model: string,
  ) {
    if (!session.live) return;
    const option = (session.configOptions || []).find(
      (item) => item?.category === "model" && item?.type === "select",
    );
    if (option) {
      await this.client.request("session/set_config_option", {
        sessionId: thread.id,
        configId: option.id,
        value: model,
      });
      thread.resolvedModel = model;
      return;
    }
    // ACP unstable `session/set_model`（claude-code-acp 等走 models 字段的 agent）。
    if (session.models?.availableModels?.length) {
      await this.client.request("session/set_model", {
        sessionId: thread.id,
        modelId: model,
      });
      session.models.currentModelId = model;
      thread.resolvedModel = model;
    }
  }

  private async applyEffort(
    thread: ThreadSummary,
    session: AcpSessionState,
    effort: string,
  ) {
    const option = this.effortOptionOf(session);
    if (!option || !session.live) return;
    await this.client.request("session/set_config_option", {
      sessionId: thread.id,
      configId: option.id,
      value: effort,
    });
    thread.reasoningEffort = effort;
  }

  // ------------------------------------------------------------------- turn

  async sendMessage(providerId: string, threadId: string, input: AgentMessageInput): Promise<AgentMessageAcceptance> {
    assertMessageInput(this.mustThread(threadId), input, this.capabilities.messages!);
    const result = await this.sendTurn(providerId, threadId, input.text, input.images, input);
    return result.turn.status === "queued"
      ? { disposition: "queued", turnId: result.turn.id, queueDurability: "memory" }
      : { disposition: "started", turnId: result.turn.id };
  }

  async sendTurn(
    _providerId: string,
    threadId: string,
    text: string,
    images?: TurnImage[],
    message?: AgentMessageInput,
  ) {
    const thread = this.mustThread(threadId);
    if (thread.archived) throw new Error("会话已归档，请先恢复再发送");
    if (!text.trim() && !images?.length) throw new Error("请输入指令或图片");
    const session = this.sessionFor(threadId);
    // ACP 没有 steer/queue 协议方法：turn 进行中先把消息排队，
    // runPrompt 收尾时按序 drain——行为对齐 Claude CLI 的 queued message。
    if (thread.status === "running" || thread.status === "waiting") {
      const turnId = randomUUID();
      session.pendingSends.push({ turnId, text, images });
      return { turn: { id: turnId, status: "queued" } };
    }
    await this.ensureClient();
    await this.ensureLive(thread);
    if (message) {
      assertMessageInput(thread, message, this.capabilities.messages!);
      if (messageBusy(thread)) {
        const turnId = randomUUID();
        session.pendingSends.push({ turnId, text, images });
        return { turn: { id: turnId, status: "queued" } };
      }
    }
    const turnId = randomUUID();
    return this.beginTurn(thread, turnId, text, images);
  }

  private beginTurn(
    thread: ThreadSummary,
    turnId: string,
    text: string,
    images?: TurnImage[],
  ) {
    const session = this.sessionFor(thread.id);
    session.turnId = turnId;
    session.rawTools.clear();
    session.messageText.clear();
    session.thoughtText = "";
    session.thoughtItemId = undefined;
    session.runSeq = 0;
    thread.status = "running";
    thread.activeTurnId = turnId;
    this.touch(thread);
    thread.lastError = undefined;
    thread.controlMode = "managed";
    const turn = {
      id: turnId,
      status: "inProgress",
      startedAt: new Date().toISOString(),
      items: [
        {
          id: `acp-user-${turnId}`,
          type: "userMessage",
          content: [{ type: "text", text }, ...(images || []).map((image) => ({
            type: "image", url: image.url, name: image.name,
          }))],
        },
      ],
    };
    session.turns.push(turn);
    // ACP 回放拿不到逐回合模型；记下发送时的快照，readThread 时按
    // turnId（回放则是按位置）回填，切换模型后旧回合不会被标成新模型。
    void this.options.threadSettings
      ?.recordTurnModel(this.id, thread.id, turnId, {
        model: thread.resolvedModel || thread.model,
        reasoningEffort:
          thread.reasoningEffort || this.currentEffortOf(session),
      })
      ?.catch(() => undefined);
    this.broadcast("thread.updated", thread);
    this.emitAgentEvent(thread, {
      method: "turn/started",
      params: {
        threadId: thread.id,
        turn: { id: turnId, status: "inProgress" },
      },
    });
    void this.runPrompt(thread, session, turn, turnId, text, images);
    return { turn: { id: turnId, status: "inProgress" } };
  }

  private promptBlocks(text: string, images?: TurnImage[]) {
    const blocks: AcpContentBlock[] = [];
    if (text.trim()) blocks.push({ type: "text", text });
    const canImage = Boolean(
      this.client.agentCapabilities.promptCapabilities?.image,
    );
    for (const image of images || []) {
      const match = image.url.match(
        /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/s,
      );
      if (canImage && match)
        blocks.push({ type: "image", mimeType: match[1], data: match[2] });
      else
        blocks.push({
          type: "text",
          text: `[图片：${image.name || image.url}]`,
        });
    }
    return blocks;
  }

  private async runPrompt(
    thread: ThreadSummary,
    session: AcpSessionState,
    turn: any,
    turnId: string,
    text: string,
    images?: TurnImage[],
  ) {
    try {
      const result = await this.client.request(
        "session/prompt",
        {
          sessionId: thread.id,
          prompt: this.promptBlocks(text, images),
        },
        // prompt 是整个 turn 的生命周期，不能走默认请求超时。
        24 * 60 * 60 * 1000,
      );
      const reason = String(result?.stopReason || "end_turn");
      if (reason === "cancelled")
        this.completeTurn(thread, turnId, "cancelled");
      else if (reason === "refusal")
        this.failTurn(thread, turnId, `${this.spec.name} 拒绝了该请求`);
      else this.completeTurn(thread, turnId, "completed");
    } catch (error: any) {
      this.failTurn(
        thread,
        turnId,
        this.translateSessionError(thread, error).message,
      );
    } finally {
      session.turnId = undefined;
      for (const [id, approval] of this.approvals)
        if (approval.threadId === thread.id) {
          this.client.respond(approval.requestId, {
            outcome: { outcome: "cancelled" },
          });
          this.approvals.delete(id);
          this.broadcast("approval.resolved", {
            agentId: this.id,
            approvalId: id,
          });
        }
      // 长任务结束后把 streamCompleted 标记打到消息上，光标停止闪烁。
      for (const itemId of session.messageText.keys())
        this.emitAgentEvent(thread, {
          method: "item/completed",
          params: {
            threadId: thread.id,
            turnId,
            item: { id: itemId, type: "agentMessage" },
          },
        });
      if (session.thoughtItemId)
        this.emitAgentEvent(thread, {
          method: "item/completed",
          params: {
            threadId: thread.id,
            turnId,
            item: { id: session.thoughtItemId, type: "reasoning" },
          },
        });
      this.drainPendingSends(thread, session);
    }
  }

  /** turn 结束（完成/失败/取消）后发队列里的下一条，按 FIFO 逐条 drain。 */
  private drainPendingSends(thread: ThreadSummary, session: AcpSessionState) {
    if (!this.online || !session.live || session.queueHolds || session.turnId || messageBusy(thread)) return;
    if (!this.threads.has(thread.id)) {
      session.pendingSends.length = 0;
      return;
    }
    const next = session.pendingSends.shift();
    if (!next) return;
    // 微任务延迟：让 turn/completed 与 thread.updated 先到达前端。
    void Promise.resolve().then(() =>
      !this.online || !session.live || session.queueHolds || session.turnId || messageBusy(thread)
        ? session.pendingSends.unshift(next)
        : this.beginTurn(thread, next.turnId, next.text, next.images),
    );
  }

  messageReady(threadId: string) {
    return !this.sessions.get(threadId)?.turnId;
  }

  holdMessageQueue(threadId: string) {
    const session = this.sessionFor(threadId);
    session.queueHolds = (session.queueHolds ?? 0) + 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      session.queueHolds = Math.max(0, (session.queueHolds ?? 1) - 1);
      const thread = this.threads.get(threadId);
      if (thread) this.drainPendingSends(thread, session);
    };
  }

  private completeTurn(thread: ThreadSummary, turnId: string, status: string) {
    thread.status = "idle";
    thread.activeTurnId = undefined;
    this.touch(thread);
    const session = this.sessions.get(thread.id);
    const turn = session?.turns.find((item) => item.id === turnId);
    if (turn) turn.status = status;
    this.broadcast("thread.updated", thread);
    this.emitAgentEvent(thread, {
      method: "turn/completed",
      params: { threadId: thread.id, turn: { id: turnId, status } },
    });
  }

  private failTurn(thread: ThreadSummary, turnId: string, detail: string) {
    thread.status = "error";
    thread.activeTurnId = undefined;
    thread.lastError = detail || `${this.spec.name} 任务失败`;
    this.touch(thread);
    this.error = thread.lastError;
    const session = this.sessions.get(thread.id);
    const turn = session?.turns.find((item) => item.id === turnId);
    if (turn) turn.status = "failed";
    this.broadcast("thread.updated", thread);
    this.emitAgentEvent(thread, {
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turn: { id: turnId, status: "failed", error: { message: detail } },
      },
    });
  }

  async interrupt(_providerId: string, threadId: string, turnId: string) {
    const thread = this.mustThread(threadId);
    const session = this.sessionFor(threadId);
    if (session.turnId !== turnId)
      throw new Error(`${this.spec.name} 会话没有正在运行的任务`);
    this.client.notify("session/cancel", { sessionId: threadId });
    return { ok: true };
  }

  // ------------------------------------------------------------- approvals

  private onClientRequest(message: RpcMessage) {
    if (message.method === "session/request_permission") {
      void this.requestPermission(message).catch((error) => {
        this.client.respondError(
          message.id as number | string,
          -32603,
          error?.message || String(error),
        );
      });
      return;
    }
    // fs/*、terminal/* 等能力没有声明，agent 不应调用；兜底按未实现回包。
    this.client.respondError(
      message.id as number | string,
      -32601,
      `Codecks 未实现 ${message.method}`,
    );
  }

  private async requestPermission(message: RpcMessage) {
    const params = message.params || {};
    const sessionId = String(params.sessionId || "");
    const thread = this.threads.get(sessionId);
    if (!thread)
      return this.client.respondError(
        message.id as number | string,
        -32602,
        "未知会话",
      );
    const raw = (params.toolCall || {}) as AcpToolCall;
    // devin 的权限请求只回 {toolCallId,_meta} 快照，kind/title/rawInput 要
    // 从先前 session/update 里同一 toolCallId 的记录补齐，否则审批卡拿不到
    // 命令文本、kind 也分不出来。
    const known = this.sessions
      .get(sessionId)
      ?.rawTools.get(String(raw.toolCallId || ""));
    const toolCall = { ...(known || {}), ...raw } as AcpToolCall;
    const options = Array.isArray(params.options) ? params.options : [];
    const id = `${sessionId}:${randomUUID()}`;
    const approval: PendingPermission = {
      id,
      threadId: sessionId,
      requestId: message.id as number | string,
      toolCall,
      options,
      kind: permissionKind(toolCall),
    };
    this.approvals.set(id, approval);
    thread.status = "waiting";
    this.broadcast("thread.updated", thread);
    this.broadcast("approval.requested", this.approvalView(approval));
  }

  async resolveApproval(
    approvalId: string,
    body: string | { decision?: string; optionId?: string },
  ) {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error("审批已处理或不存在");
    const input = typeof body === "string" ? { decision: body } : body || {};
    const outcome = this.permissionOutcome(approval.options, input);
    this.client.respond(approval.requestId, { outcome });
    this.approvals.delete(approvalId);
    const thread = this.threads.get(approval.threadId);
    if (thread) {
      thread.status = "running";
      this.broadcast("thread.updated", thread);
    }
    this.broadcast("approval.resolved", { agentId: this.id, approvalId });
    return { ok: true };
  }

  private permissionOutcome(
    options: AcpPermissionOption[],
    input: { decision?: string; optionId?: string },
  ) {
    // 前端会把 agent 的完整 options 渲染出来并回传 optionId（devin 一次给
    // 多档）；id 不在列表里说明请求已过期，抛错保留待审批比错判拒绝安全。
    if (input.optionId != null) {
      const chosen = options.find(
        (option) => String(option.optionId) === String(input.optionId),
      );
      if (!chosen) throw new Error("该选项已失效，请刷新后重试");
      return { outcome: "selected" as const, optionId: chosen.optionId };
    }
    const decision = input.decision || "decline";
    const find = (kind: string, match?: RegExp) =>
      options.find(
        (option) =>
          option.kind === kind &&
          (!match || match.test(`${option.optionId} ${option.name || ""}`)),
      );
    const option =
      decision === "accept"
        ? find("allow_once") || find("allow_always") || options[0]
        : decision === "acceptForSession"
          ? // devin 把 allow_session/allow_always(_global)/switch_bypass 全标
            // allow_always；「本会话」必须挑 session 档，不能按数组顺序撞。
            find("allow_always", /session/i) ||
            find("allow_always") ||
            find("allow_once") ||
            options[0]
          : decision === "decline"
            ? find("reject_once") || find("reject_always")
            : undefined;
    if (option)
      return { outcome: "selected" as const, optionId: option.optionId };
    return { outcome: "cancelled" as const };
  }

  private approvalView(approval: PendingPermission) {
    const thread = this.threads.get(approval.threadId);
    const call = approval.toolCall;
    const command = shellCommandOf(call) || String(call.title || "");
    const kinds = new Set(approval.options.map((option) => option.kind));
    const availableDecisions = [
      ...(kinds.has("reject_once") || kinds.has("reject_always")
        ? ["decline"]
        : []),
      ...(kinds.has("allow_once") || kinds.has("allow_always")
        ? ["accept"]
        : []),
      ...(kinds.has("allow_always") ? ["acceptForSession"] : []),
      "cancel",
    ];
    const changes = (call.content || [])
      .filter((entry) => entry?.type === "diff" && entry.path)
      .map((entry) => ({
        path: String(entry.path),
        kind: "update",
        diff: pseudoDiff(entry.oldText, entry.newText),
      }));
    return {
      id: approval.id,
      agentId: this.id,
      providerId: thread?.providerId,
      kind: approval.kind,
      cwd: thread?.cwd,
      command,
      reason: `${this.spec.name} 请求许可：${call.title || call.kind || "工具调用"}`,
      availableDecisions,
      ...(approval.kind === "file" && changes.length ? { changes } : {}),
      request: {
        method: "session/request_permission",
        params: {
          threadId: approval.threadId,
          toolCall: call,
          options: approval.options,
          command,
        },
      },
    };
  }

  // ------------------------------------------------------------- commands

  async listSessionCommands(_providerId: string, threadId: string) {
    const session = this.sessions.get(threadId);
    return (session?.commands || []).map((command) => ({
      name: command.name,
      description: command.description,
    }));
  }

  async runSessionCommand(
    _providerId: string,
    threadId: string,
    command: string,
    args?: string,
  ) {
    const thread = this.mustThread(threadId);
    if (thread.archived) throw new Error("会话已归档，请先恢复再操作");
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error(`${this.spec.name} 会话正在运行`);
    const name = command.replace(/^\//, "").trim();
    if (!name) throw new Error("命令不能为空");
    await this.ensureClient();
    await this.ensureLive(thread);
    // ACP 里斜杠命令就是普通 prompt 文本，/cmd args 由 agent 自己解析。
    const text = `/${name}${args?.trim() ? ` ${args.trim()}` : ""}`;
    return this.beginTurn(thread, randomUUID(), text);
  }

  // -------------------------------------------------------------- models

  async listModels(): Promise<ModelInfo[]> {
    /* effort 是 agent 级的 configOption，不随模型变化；目录里有值时把同一组
       选项挂到每个模型上，前端选择器就能渲染推理强度下拉。 */
    const effortOption = [...this.sessions.values()]
      .map((session) => this.effortOptionOf(session))
      .find(Boolean);
    const efforts = effortOption
      ? flattenConfigOptions(effortOption.options).map((value) => ({
          reasoningEffort: value.id,
          description: value.name,
        }))
      : [];
    const defaultEffort =
      typeof effortOption?.currentValue === "string"
        ? effortOption.currentValue
        : undefined;
    const effortMeta = efforts.length
      ? {
          supportedReasoningEfforts: efforts,
          defaultReasoningEffort: defaultEffort,
        }
      : {};
    const catalog = new Map<string, ModelInfo>();
    for (const model of this.spec.models || [])
      catalog.set(model.id, {
        id: model.id,
        model: model.id,
        displayName: model.name || model.id,
        ...effortMeta,
      });
    for (const session of this.sessions.values()) {
      for (const option of session.configOptions || []) {
        if (option?.category !== "model" || option?.type !== "select") continue;
        for (const value of flattenConfigOptions(option.options)) {
          if (!catalog.has(value.id))
            catalog.set(value.id, {
              id: value.id,
              model: value.id,
              displayName: value.name || value.id,
              groupName: value.group,
              isDefault: option.currentValue === value.id,
              ...effortMeta,
            });
        }
      }
      // ACP 原生 models 字段（claude-code-acp 等不走 configOptions 的 agent）。
      for (const model of session.models?.availableModels || []) {
        if (!catalog.has(model.modelId))
          catalog.set(model.modelId, {
            id: model.modelId,
            model: model.modelId,
            displayName: model.name || model.modelId,
            isDefault: session.models?.currentModelId === model.modelId,
            ...effortMeta,
          });
      }
    }
    return [...catalog.values()];
  }

  private hasModelCatalog() {
    if (this.spec.models?.length) return true;
    for (const session of this.sessions.values())
      if (
        session.models?.availableModels?.length ||
        (session.configOptions || []).some(
          (item) => item?.category === "model" && item?.type === "select",
        )
      )
        return true;
    return false;
  }

  // ------------------------------------------------------------- updates

  private onNotification(message: RpcMessage) {
    if (message.method !== "session/update") return;
    const params = message.params || {};
    const sessionId = String(params.sessionId || "");
    const update = params.update as AcpSessionUpdate | undefined;
    if (!sessionId || !update?.sessionUpdate) return;
    const thread = this.threads.get(sessionId);
    const session = this.sessionFor(sessionId);
    // 会话级状态（命令/模式/配置/标题/用量）不属于任何 turn，在 load
    // 回放期间也会推送，先单独处理再分流到回放或实时 turn。
    if (this.applySessionMetaUpdate(thread, session, update)) return;
    if (session.replay) {
      this.applyReplayUpdate(session, session.replay, update);
      return;
    }
    if (thread) this.applyLiveUpdate(thread, session, update);
  }

  /** 不属于 turn 的 session/update：回放与实时阶段都要生效。 */
  private applySessionMetaUpdate(
    thread: ThreadSummary | undefined,
    session: AcpSessionState,
    update: AcpSessionUpdate,
  ) {
    switch (update.sessionUpdate) {
      case "available_commands_update":
        session.commands = Array.isArray(update.availableCommands)
          ? update.availableCommands.filter(
              (item: any) => typeof item?.name === "string",
            )
          : [];
        // 推给前端刷新 `/` 补全：GET /commands 只在会话挂载时拉一次。
        if (thread)
          this.emitAgentEvent(thread, {
            method: "session/commands",
            params: { threadId: thread.id, commands: session.commands },
          });
        return true;
      case "current_mode_update":
        if (thread && update.currentModeId) {
          thread.sessionMode = String(update.currentModeId);
          this.broadcast("thread.updated", thread);
        }
        return true;
      case "config_option_update":
        if (Array.isArray(update.configOptions)) {
          session.configOptions = update.configOptions;
          const model = this.currentModelOf(session);
          if (thread && model) thread.resolvedModel = model;
          const effort = this.currentEffortOf(session);
          if (thread && effort) thread.reasoningEffort = effort;
          if (thread) this.broadcast("thread.updated", thread);
        }
        return true;
      case "session_info_update":
        if (thread && typeof update.title === "string" && update.title.trim()) {
          thread.name = update.title.trim();
          this.broadcast("thread.updated", thread);
        }
        return true;
      case "usage_update":
        if (thread) {
          const used = Number(update.used) || 0;
          const size = Number(update.size) || 0;
          thread.tokenUsage = {
            total: used,
            used,
            ...(size ? { limit: size } : {}),
          };
          this.broadcast("thread.updated", thread);
        }
        return true;
      default:
        return false;
    }
  }

  /** 实时 turn 的 session/update：归一化后既进本地 turn 历史也发流式事件。 */
  private applyLiveUpdate(
    thread: ThreadSummary,
    session: AcpSessionState,
    update: AcpSessionUpdate,
  ) {
    const turnId = session.turnId;
    const turn = session.turns.find((item) => item.id === turnId);
    const emitItem = (method: string, item: any) =>
      this.emitAgentEvent(thread, {
        method,
        params: { threadId: thread.id, turnId, item },
      });
    const upsertItem = (item: any) => {
      if (!turn) return;
      const index = turn.items.findIndex(
        (entry: any) => String(entry?.id) === String(item.id),
      );
      if (index >= 0) turn.items[index] = { ...turn.items[index], ...item };
      else turn.items.push(item);
    };

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textOfContent(update.content);
        if (!text) return;
        const itemId = this.chunkItemId(
          session,
          turn,
          turnId,
          "acp-msg",
          "agentMessage",
          update.messageId,
        );
        session.messageText.set(
          itemId,
          (session.messageText.get(itemId) || "") + text,
        );
        upsertItem({
          id: itemId,
          type: "agentMessage",
          text: session.messageText.get(itemId),
        });
        this.emitAgentEvent(thread, {
          method: "item/agentMessage/delta",
          params: { threadId: thread.id, turnId, itemId, delta: text },
        });
        return;
      }
      case "agent_thought_chunk": {
        const text = textOfContent(update.content);
        if (!text) return;
        const itemId = this.chunkItemId(
          session,
          turn,
          turnId,
          "acp-think",
          "reasoning",
          update.messageId,
        );
        // 每段思考独立累积：被其它内容隔开后再来的 chunk 属于新的一段。
        session.thoughtText =
          session.thoughtItemId === itemId ? session.thoughtText + text : text;
        session.thoughtItemId = itemId;
        const item = {
          id: itemId,
          type: "reasoning",
          summary: session.thoughtText,
        };
        upsertItem(item);
        emitItem("item/started", item);
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const call = update as unknown as AcpToolCall;
        const toolCallId = String(call.toolCallId || "");
        if (!toolCallId) return;
        const merged = {
          ...(session.rawTools.get(toolCallId) || {}),
          ...call,
          toolCallId,
        };
        const item = this.normalizeToolCall(merged);
        const terminal =
          item.status === "completed" || item.status === "failed";
        session.rawTools.set(
          toolCallId,
          terminal ? slimToolCall(merged) : merged,
        );
        upsertItem(item);
        emitItem(terminal ? "item/completed" : "item/started", item);
        return;
      }
      case "plan": {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        const todos = entries.map((entry: any) => ({
          content: String(entry?.content || ""),
          status:
            entry?.status === "completed"
              ? "completed"
              : entry?.status === "in_progress"
                ? "inProgress"
                : "pending",
          priority: entry?.priority,
        }));
        const item = {
          id: `acp-plan-${session.id}`,
          type: "extension",
          kind: "todo",
          agentId: this.id,
          status: "inProgress",
          payload: { todos },
        };
        upsertItem(item);
        emitItem("item/started", item);
        return;
      }
      default:
        return;
    }
  }

  /**
   * chunk 一般不带 messageId：连续的同类 chunk 续写尾部 item；被工具、
   * 计划等其它内容隔开后再来的 chunk 属于新的一段，分配新 itemId——
   * 与 load 回放按位置拆段的语义一致，运行中的时间线才不会整轮黏成一块。
   */
  private chunkItemId(
    session: AcpSessionState,
    turn: any,
    turnId: string | undefined,
    prefix: string,
    type: string,
    messageId?: string,
  ) {
    if (messageId) return `${prefix}-${messageId}`;
    const tail = turn?.items?.at?.(-1);
    if (tail?.type === type && String(tail?.id || "").startsWith(`${prefix}-`))
      return String(tail.id);
    return `${prefix}-${turnId || session.id}-r${session.runSeq++}`;
  }

  /** session/load 回放：同样的归一化，但只建 turns、不发流式事件。 */
  private applyReplayUpdate(
    session: AcpSessionState,
    replay: NonNullable<AcpSessionState["replay"]>,
    update: AcpSessionUpdate,
  ) {
    const ensureTurn = () => {
      if (!replay.current) {
        replay.current = {
          id: `acp-replay-${replay.turns.length + 1}`,
          status: "completed",
          items: [],
        };
      }
      return replay.current;
    };
    switch (update.sessionUpdate) {
      case "user_message_chunk": {
        const part = userContentPart(update.content);
        if (!part) return;
        // 新的 user 消息开启新 turn：上一个 turn 已有非 user 内容时收尾。
        const lastItem = replay.current?.items.at(-1);
        if (replay.current && lastItem && lastItem.type !== "userMessage") {
          replay.turns.push(replay.current);
          replay.current = undefined;
        }
        const turn = ensureTurn();
        const last = turn.items.at(-1);
        if (last?.type === "userMessage") {
          const tail = last.content.at(-1);
          if (part.type === "text" && tail?.type === "text") tail.text += part.text;
          else last.content.push(part);
        } else {
          turn.items.push({
            id: `acp-user-${replay.turns.length}-${turn.items.length}`,
            type: "userMessage",
            content: [part],
          });
        }
        return;
      }
      case "agent_message_chunk": {
        const text = textOfContent(update.content);
        if (!text) return;
        const turn = ensureTurn();
        const itemId = `acp-msg-${update.messageId || turn.items.length}`;
        const last = turn.items.at(-1);
        if (last?.type === "agentMessage" && last.id === itemId) {
          last.text = `${last.text || ""}${text}`;
        } else {
          turn.items.push({ id: itemId, type: "agentMessage", text });
        }
        return;
      }
      case "agent_thought_chunk": {
        const text = textOfContent(update.content);
        if (!text) return;
        const turn = ensureTurn();
        const itemId = `acp-think-${update.messageId || turn.items.length}`;
        const last = turn.items.at(-1);
        if (last?.type === "reasoning" && last.id === itemId) {
          last.summary = `${last.summary || ""}${text}`;
        } else {
          turn.items.push({ id: itemId, type: "reasoning", summary: text });
        }
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        const call = update as unknown as AcpToolCall;
        const toolCallId = String(call.toolCallId || "");
        if (!toolCallId) return;
        const turn = ensureTurn();
        const index = turn.items.findIndex(
          (entry: any) => String(entry?.id) === `acp-tool-${toolCallId}`,
        );
        const merged = {
          ...(session.rawTools.get(toolCallId) || {}),
          ...call,
          toolCallId,
        };
        const item = this.normalizeToolCall(merged);
        // 回放也登记 rawTools：resume/load 后 request_permission 才能用
        // toolCallId 找回完整 kind/title/rawInput。终态只留合并骨架。
        session.rawTools.set(
          toolCallId,
          item.status === "completed" || item.status === "failed"
            ? slimToolCall(merged)
            : merged,
        );
        if (index >= 0) turn.items[index] = item;
        else turn.items.push(item);
        return;
      }
      case "plan": {
        const entries = Array.isArray(update.entries) ? update.entries : [];
        const turn = ensureTurn();
        const todos = entries.map((entry: any) => ({
          content: String(entry?.content || ""),
          status:
            entry?.status === "completed"
              ? "completed"
              : entry?.status === "in_progress"
                ? "inProgress"
                : "pending",
          priority: entry?.priority,
        }));
        const itemId = `acp-plan-${replay.turns.length}`;
        const index = turn.items.findIndex(
          (entry: any) => String(entry?.id) === itemId,
        );
        const item = {
          id: itemId,
          type: "extension",
          kind: "todo",
          agentId: this.id,
          status: "completed",
          payload: { todos },
        };
        if (index >= 0) turn.items[index] = item;
        else turn.items.push(item);
        return;
      }
      default:
        return;
    }
  }

  /** ACP toolCall → Codex 形状的 turn item。 */
  private normalizeToolCall(call: AcpToolCall): any {
    const id = `acp-tool-${call.toolCallId}`;
    const status = itemStatus(call.status);
    const kind = String(call.kind || "other");
    const title = String(call.title || kind);
    const output = toolOutputText(call);

    if (kind === "execute") {
      return {
        id,
        type: "commandExecution",
        command: shellCommandOf(call) || title,
        status,
        aggregatedOutput: output,
        ...(call.rawInput != null
          ? { input: capDeepStrings(call.rawInput) }
          : {}),
        tool: "bash",
      };
    }
    if (kind === "edit" || kind === "delete" || kind === "move") {
      const diffs = (call.content || []).filter(
        (entry) => entry?.type === "diff" && entry.path,
      );
      const changes = diffs.length
        ? diffs.map((entry) => ({
            path: String(entry.path),
            kind: kind === "delete" ? "delete" : "update",
            diff: pseudoDiff(entry.oldText, entry.newText),
          }))
        : (call.locations || []).map((location) => ({
            path: location.path,
            kind: kind === "delete" ? "delete" : "update",
          }));
      return { id, type: "fileChange", status, changes };
    }
    if (kind === "think")
      return { id, type: "reasoning", status, summary: output || title };
    if (kind === "read" || kind === "search") {
      const locations = call.locations || [];
      const input =
        call.rawInput && typeof call.rawInput === "object"
          ? (call.rawInput as Record<string, unknown>)
          : {};
      return {
        id,
        type: "commandExecution",
        command: title,
        status,
        aggregatedOutput: output,
        input: capDeepStrings(call.rawInput),
        commandActions:
          kind === "read"
            ? locations.map((location) => ({
                type: "read",
                path: location.path,
                line: location.line ?? undefined,
              }))
            : [
                {
                  type: "search",
                  query: String(
                    input.query || input.pattern || input.q || title,
                  ),
                  path: locations[0]?.path,
                },
              ],
      };
    }
    return {
      id,
      type: "dynamicToolCall",
      tool: title,
      status,
      arguments: capDeepStrings(call.rawInput),
      output: output || undefined,
      locations: call.locations,
      ...(status === "failed" && output
        ? { error: { message: output.slice(0, 500) } }
        : {}),
    };
  }

  // ------------------------------------------------------------- history

  private async loadHistory() {
    this.historyStatus = "loading";
    this.historyError = undefined;
    this.broadcast("snapshot", this.snapshot());
    try {
      const seen = new Set<string>();
      const listed = await this.listRemoteSessions();
      if (listed) {
        for (const info of listed) {
          const id = String(info.sessionId || "");
          if (!id) continue;
          seen.add(id);
          const existing = this.threads.get(id);
          const session = this.sessions.get(id);
          const live = session?.live;
          this.threads.set(id, {
            ...existing,
            agentId: this.id,
            id,
            providerId: existing?.providerId || `${this.id}-current`,
            name:
              existing?.name || info.title?.trim() || `${this.spec.name} 会话`,
            preview: existing?.preview || info.title?.trim() || "",
            cwd: info.cwd || existing?.cwd || "",
            model: existing?.model || "default",
            status:
              live || session?.turnId ? existing?.status || "running" : "idle",
            updatedAt: resolveUpdatedAt(info, existing, id),
            sessionId: id,
            controlMode: live ? "managed" : "history",
            // 本进程内已打开的会话，锁就在我们手里，不算被占用。
            locked: live ? undefined : sessionLockedOf(info) || undefined,
            ...this.options.threadSettings?.get(this.id, id),
          });
        }
        for (const [id, thread] of this.threads)
          if (!seen.has(id) && !this.sessions.get(id)?.live)
            this.threads.delete(id);
      }
      this.historyStatus = "ready";
      this.historyError = undefined;
    } catch (error: any) {
      this.historyStatus = "error";
      this.historyError = error?.message || String(error);
    }
    this.broadcast("agent.status", this.descriptor());
    this.broadcast("snapshot", this.snapshot());
  }

  /**
   * 返回 undefined 表示没有任何历史来源（保留缓存的 threads）；
   * 返回数组（可能为空）表示来源可信，未见 id 可被清理。
   */
  private async listRemoteSessions(): Promise<AcpSessionInfo[] | undefined> {
    if (
      this.client.online &&
      this.client.agentCapabilities.sessionCapabilities?.list
    ) {
      const sessions: AcpSessionInfo[] = [];
      let cursor: string | undefined;
      do {
        const result = await this.client.request("session/list", {
          ...(cursor ? { cursor } : {}),
        });
        sessions.push(
          ...(Array.isArray(result?.sessions) ? result.sessions : []),
        );
        cursor = result?.nextCursor || undefined;
      } while (cursor);
      return sessions;
    }
    if (!this.spec.listSessions) return undefined;
    return this.listSessionsViaCommand();
  }

  private async listSessionsViaCommand(): Promise<AcpSessionInfo[]> {
    const spec = this.spec.listSessions;
    if (!spec) return [];
    const command = spec.command || this.spec.command;
    const runner =
      this.options.execListCommand ||
      (async (cmd: string, args: string[], cwd?: string) => {
        const { stdout } = await execFileAsync(cmd, args, {
          cwd,
          timeout: 15_000,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
        });
        return stdout;
      });
    const dirs = spec.perDirectory
      ? [
          ...new Set(
            [
              ...(this.options.directories || []),
              ...[...this.threads.values()].map((thread) => thread.cwd),
            ].filter(Boolean),
          ),
        ]
      : [undefined];
    const rows: Record<string, unknown>[] = [];
    for (const dir of dirs) {
      let output: string;
      try {
        output = await runner(command, spec.args, dir);
      } catch {
        continue;
      }
      rows.push(...parseSessionListOutput(output, dir));
    }
    return rows.map((row) => {
      const value = (key: keyof typeof SESSION_FIELD_ALIASES) => {
        const custom = spec.fields?.[key];
        return pick(
          row,
          custom
            ? [custom, ...SESSION_FIELD_ALIASES[key]]
            : [...SESSION_FIELD_ALIASES[key]],
        );
      };
      const lockedKey = spec.fields?.locked;
      const locked =
        (lockedKey ? row[lockedKey] === true : false) ||
        sessionLockedOf(row) ||
        undefined;
      return {
        sessionId: value("sessionId"),
        cwd: value("cwd"),
        title: value("title"),
        updatedAt: value("updatedAt"),
        locked,
      };
    });
  }

  // ---------------------------------------------------------------- misc

  /**
   * 活动时间只能由 turn 生命周期和用户操作推进；session/list 刷新、
   * meta 更新（title/mode/usage）与 load 回放都不得调用。
   */
  private touch(thread: ThreadSummary) {
    thread.updatedAt = Date.now();
  }

  private mustThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`${this.spec.name} 会话不存在`);
    return thread;
  }

  /**
   * agent 拒绝打开被占用会话的错误（devin：-32015 +
   * data["cognition.ai/errorKind"]="session_locked"）。
   */
  private isSessionLockedError(error: any) {
    if (error?.data?.["cognition.ai/errorKind"] === "session_locked")
      return true;
    return /already open in another process|session[_ ]locked/i.test(
      String(error?.message || ""),
    );
  }

  /**
   * 把 agent 的会话级错误翻成可展示的版本。锁定冲突会顺带把
   * `thread.locked` 置位并广播，让列表立刻显示「占用中」。
   */
  private translateSessionError(thread: ThreadSummary, error: any): Error {
    if (!this.isSessionLockedError(error))
      return error instanceof Error ? error : new Error(String(error));
    if (!thread.locked) {
      thread.locked = true;
      this.broadcast("thread.updated", thread);
    }
    return new Error(
      `${this.spec.name} 会话正被其它进程占用（锁定中）。请关闭打开它的另一个实例后重试，关闭后 Deck 会直接接管。`,
    );
  }

  private withAuthHint(message: string) {
    if (!this.client.authMethods.length) return message;
    if (!/auth|login|credential|unauthorized|permission/i.test(message))
      return message;
    const hint = this.spec.authHint || `请先完成 ${this.spec.name} 的登录认证`;
    return `${message}\n${hint}`;
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
}

function permissionKind(call: AcpToolCall): ApprovalKind {
  const kind = String(call.kind || "");
  if (kind === "edit" || kind === "delete" || kind === "move") return "file";
  // request_permission 的语义是「从 options 里选一个」而非 Codex 的权限
  // 勾选：kind 缺失/未知（devin 快照常常没有 kind）也按命令卡渲染，保证
  // 前端按钮发出 decision；若落成 permission 卡，按钮只会回
  // {permissions, scope}，server 侧缺省 decline 等于全部拒绝。
  return "command";
}

/** configOptions select 的 options 是平铺数组或 {name, options:[...]} 分组。 */
function flattenConfigOptions(options: unknown) {
  const out: { id: string; name?: string; group?: string }[] = [];
  if (!Array.isArray(options)) return out;
  for (const entry of options as any[]) {
    if (!entry || typeof entry !== "object") continue;
    if (Array.isArray(entry.options)) {
      for (const child of entry.options) {
        const id = String(child?.value ?? child?.id ?? "");
        if (id)
          out.push({
            id,
            name: child?.name || child?.label,
            group: entry.name,
          });
      }
      continue;
    }
    const id = String(entry.value ?? entry.id ?? "");
    if (id) out.push({ id, name: entry.name || entry.label });
  }
  return out;
}

/** listSessions 命令输出：JSON 数组 / {sessions:[...]} / NDJSON 行。 */
export function parseSessionListOutput(
  output: string,
  fallbackCwd?: string,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const pushRow = (row: unknown) => {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      const record = { ...(row as Record<string, unknown>) };
      if (fallbackCwd && !record.cwd && !record.directory)
        record.cwd = fallbackCwd;
      rows.push(record);
    }
  };
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) parsed.forEach(pushRow);
    else if (parsed && typeof parsed === "object") {
      const sessions = (parsed as Record<string, unknown>).sessions;
      if (Array.isArray(sessions)) sessions.forEach(pushRow);
      else pushRow(parsed);
    }
    return rows;
  } catch {
    /* fall through to NDJSON */
  }
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      pushRow(JSON.parse(line));
    } catch {
      /* skip non-JSON lines */
    }
  }
  return rows;
}
