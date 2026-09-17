import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
   * ACP 没有强制的历史列举接口。`sessionCapabilities.list` 优先走
   * `session/list`；不支持时回落到这个本地命令（如 `devin list --format
   * json`）。命令应输出 JSON 数组或 {sessions:[...]}，字段名宽松匹配。
   */
  listSessions?: {
    command?: string;
    args: string[];
    /** true → 在每个已知项目目录下各执行一次（devin list 按目录列会话）。 */
    perDirectory?: boolean;
  };
  /** agent 不支持 configOptions 模型目录时的静态模型列表。 */
  models?: { id: string; name?: string; description?: string }[];
}

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
  /** toolCallId → 已归一化的 deck item。 */
  tools: Map<string, any>;
  commands: AcpAvailableCommand[];
  modes?: AcpSessionModeState;
  configOptions: AcpSessionConfigOption[];
  /** 本地收集的 turn 历史（live 累积或 load 回放结果）。 */
  turns: any[];
  /** session/load 回放在此累积，与实时 turn 分流。 */
  replay?: { turns: any[]; current?: any };
  /** 每个 messageId 的流式文本累积。 */
  messageText: Map<string, string>;
  thoughtText: string;
  thoughtItemId?: string;
  /** 进行中的 session/load。 */
  loading?: Promise<any[]>;
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
  return parts.join("\n\n").trim();
}

function shellCommandOf(call: AcpToolCall): string {
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
      approvals: true,
      archive: true,
      delete: Boolean(caps.sessionCapabilities?.delete),
      fork: false,
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

  restart() {
    // 先把挂起的 permission 请求应答 cancelled，再停进程。
    for (const approval of this.approvals.values()) {
      this.client.respond(approval.requestId, {
        outcome: { outcome: "cancelled" },
      });
    }
    this.approvals.clear();
    void this.client.stop();
    for (const session of this.sessions.values()) session.live = false;
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
    for (const session of this.sessions.values()) session.live = false;
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
        tools: new Map(),
        commands: [],
        configOptions: [],
        turns: [],
        messageText: new Map(),
        thoughtText: "",
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
    if (Array.isArray(result?.configOptions))
      session.configOptions = result.configOptions;
    const model = this.currentModelOf(session);
    if (model) thread.resolvedModel = model;
  }

  private currentModelOf(session: AcpSessionState) {
    const option = (session.configOptions || []).find(
      (item) => item?.category === "model" && item?.type === "select",
    );
    return typeof option?.currentValue === "string"
      ? option.currentValue
      : "";
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
    if (input.model && input.model !== "default")
      await this.applyModel(thread, session, input.model).catch(() => {
        /* 模型应用失败不阻塞建会话 */
      });
    if (input.sessionMode)
      await this.applyMode(thread, session, input.sessionMode).catch(() => {
        /* 同上 */
      });
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async readThread(_providerId: string, threadId: string) {
    const thread = this.mustThread(threadId);
    const session = this.sessionFor(threadId);
    const busy = thread.status === "running" || thread.status === "waiting";
    if (!busy && this.client.online && this.client.agentCapabilities.loadSession) {
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
    return {
      id: threadId,
      agentId: this.id,
      providerId: thread.providerId,
      cwd: thread.cwd,
      model: thread.resolvedModel || thread.model,
      sessionMode: thread.sessionMode,
      sessionModes: thread.sessionModes,
      turns: session.turns,
      tokenUsage: thread.tokenUsage,
    };
  }

  async renameThread(_providerId: string, threadId: string, name: string) {
    const thread = this.mustThread(threadId);
    const next = name.trim();
    if (!next) throw new Error("会话名称不能为空");
    thread.name = next;
    thread.updatedAt = Date.now();
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
    if (this.client.online && this.client.agentCapabilities.sessionCapabilities?.delete)
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
    thread.updatedAt = Date.now();
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
    const option = (session.configOptions || []).find(
      (item) => item?.category === "model" && item?.type === "select",
    );
    if (!option || !session.live) return;
    await this.client.request("session/set_config_option", {
      sessionId: thread.id,
      configId: option.id,
      value: model,
    });
    thread.resolvedModel = model;
  }

  // ------------------------------------------------------------------- turn

  async sendTurn(
    _providerId: string,
    threadId: string,
    text: string,
    images?: TurnImage[],
  ) {
    const thread = this.mustThread(threadId);
    if (thread.archived) throw new Error("会话已归档，请先恢复再发送");
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error(`${this.spec.name} 会话正在运行`);
    if (!text.trim() && !images?.length) throw new Error("请输入指令或图片");
    await this.ensureClient();
    await this.ensureLive(thread);
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
    session.tools.clear();
    session.messageText.clear();
    session.thoughtText = "";
    session.thoughtItemId = undefined;
    thread.status = "running";
    thread.activeTurnId = turnId;
    thread.updatedAt = Date.now();
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
          content: [{ type: "text", text }],
        },
      ],
    };
    session.turns.push(turn);
    this.broadcast("thread.updated", thread);
    this.emitAgentEvent(thread, {
      method: "turn/started",
      params: { threadId: thread.id, turn: { id: turnId, status: "inProgress" } },
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
      if (reason === "cancelled") this.completeTurn(thread, turnId, "cancelled");
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
    }
  }

  private completeTurn(
    thread: ThreadSummary,
    turnId: string,
    status: string,
  ) {
    thread.status = "idle";
    thread.activeTurnId = undefined;
    thread.updatedAt = Date.now();
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
    thread.updatedAt = Date.now();
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
    const toolCall = (params.toolCall || {}) as AcpToolCall;
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
    body: string | { decision?: string },
  ) {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error("审批已处理或不存在");
    const decision =
      typeof body === "string" ? body : body.decision || "decline";
    const outcome = this.permissionOutcome(approval.options, decision);
    this.client.respond(approval.requestId, { outcome });
    this.approvals.delete(approvalId);
    const thread = this.threads.get(approval.threadId);
    if (thread) {
      thread.status = decision === "cancel" ? thread.status : "running";
      if (decision === "cancel") thread.status = "running";
      this.broadcast("thread.updated", thread);
    }
    this.broadcast("approval.resolved", { agentId: this.id, approvalId });
    return { ok: true };
  }

  private permissionOutcome(
    options: AcpPermissionOption[],
    decision: string,
  ) {
    const find = (kind: string) =>
      options.find((option) => option.kind === kind);
    const option =
      decision === "accept"
        ? find("allow_once") || find("allow_always") || options[0]
        : decision === "acceptForSession"
          ? find("allow_always") || find("allow_once") || options[0]
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
    const catalog = new Map<string, ModelInfo>();
    for (const model of this.spec.models || [])
      catalog.set(model.id, {
        id: model.id,
        model: model.id,
        displayName: model.name || model.id,
      });
    for (const session of this.sessions.values()) {
      for (const option of session.configOptions || []) {
        if (option?.category !== "model" || option?.type !== "select")
          continue;
        for (const value of flattenConfigOptions(option.options)) {
          if (!catalog.has(value.id))
            catalog.set(value.id, {
              id: value.id,
              model: value.id,
              displayName: value.name || value.id,
              groupName: value.group,
              isDefault: option.currentValue === value.id,
            });
        }
      }
    }
    return [...catalog.values()];
  }

  private hasModelCatalog() {
    if (this.spec.models?.length) return true;
    for (const session of this.sessions.values())
      if (
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
    if (session.replay) {
      this.applyReplayUpdate(session.replay, update);
      return;
    }
    if (thread) this.applyLiveUpdate(thread, session, update);
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
        const itemId = `acp-msg-${
          update.messageId || turnId || session.id
        }`;
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
        session.thoughtText += text;
        const itemId = `acp-think-${update.messageId || turnId || session.id}`;
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
        const previous = session.tools.get(toolCallId);
        const merged = { ...(previous?.__raw || {}), ...call, toolCallId };
        const item = this.normalizeToolCall(merged, previous);
        item.__raw = merged;
        session.tools.set(toolCallId, item);
        upsertItem(item);
        const terminal =
          item.status === "completed" || item.status === "failed";
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
      case "available_commands_update":
        session.commands = Array.isArray(update.availableCommands)
          ? update.availableCommands
          : [];
        return;
      case "current_mode_update":
        if (update.currentModeId) {
          thread.sessionMode = String(update.currentModeId);
          this.broadcast("thread.updated", thread);
        }
        return;
      case "config_option_update":
        if (Array.isArray(update.configOptions)) {
          session.configOptions = update.configOptions;
          const model = this.currentModelOf(session);
          if (model) thread.resolvedModel = model;
          this.broadcast("thread.updated", thread);
        }
        return;
      case "session_info_update":
        if (typeof update.title === "string" && update.title.trim()) {
          thread.name = update.title.trim();
          thread.updatedAt = Date.now();
          this.broadcast("thread.updated", thread);
        }
        return;
      case "usage_update": {
        const used = Number(update.used) || 0;
        const size = Number(update.size) || 0;
        thread.tokenUsage = {
          total: used,
          used,
          ...(size ? { limit: size } : {}),
        };
        this.broadcast("thread.updated", thread);
        return;
      }
      default:
        return;
    }
  }

  /** session/load 回放：同样的归一化，但只建 turns、不发流式事件。 */
  private applyReplayUpdate(
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
        const text = textOfContent(update.content);
        if (!text) return;
        // 新的 user 消息开启新 turn：上一个 turn 已有非 user 内容时收尾。
        const lastItem = replay.current?.items.at(-1);
        if (replay.current && lastItem && lastItem.type !== "userMessage") {
          replay.turns.push(replay.current);
          replay.current = undefined;
        }
        const turn = ensureTurn();
        const last = turn.items.at(-1);
        if (last?.type === "userMessage") {
          last.content[0].text += text;
        } else {
          turn.items.push({
            id: `acp-user-${replay.turns.length}-${turn.items.length}`,
            type: "userMessage",
            content: [{ type: "text", text }],
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
        const previous = index >= 0 ? turn.items[index] : undefined;
        const merged = { ...(previous?.__raw || {}), ...call, toolCallId };
        const item = this.normalizeToolCall(merged, previous);
        item.__raw = merged;
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
  private normalizeToolCall(call: AcpToolCall, previous?: any): any {
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
        ...(call.rawInput != null ? { input: call.rawInput } : {}),
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
        input: call.rawInput,
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
      arguments: call.rawInput,
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
              existing?.name ||
              info.title?.trim() ||
              `${this.spec.name} 会话`,
            preview: existing?.preview || info.title?.trim() || "",
            cwd: info.cwd || existing?.cwd || "",
            model: existing?.model || "default",
            status:
              live || session?.turnId
                ? existing?.status || "running"
                : "idle",
            updatedAt:
              Date.parse(info.updatedAt || "") ||
              existing?.updatedAt ||
              Date.now(),
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
    if (this.client.online && this.client.agentCapabilities.sessionCapabilities?.list) {
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
      ? [...new Set(
          [
            ...(this.options.directories || []),
            ...[...this.threads.values()].map((thread) => thread.cwd),
          ].filter(Boolean),
        )]
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
    return rows.map((row) => ({
      sessionId: pick(row, ["sessionId", "session_id", "id", "sessionID"]),
      cwd:
        pick(row, [
          "cwd",
          "directory",
          "workingDirectory",
          "working_directory",
          "path",
          "workspace",
        ]) || "",
      title: pick(row, ["title", "name", "summary", "description"]),
      updatedAt: pick(row, [
        "updatedAt",
        "updated_at",
        "lastActivityAt",
        "last_active_at",
        "createdAt",
        "created_at",
        "timestamp",
      ]),
      locked: sessionLockedOf(row) || undefined,
    }));
  }

  // ---------------------------------------------------------------- misc

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
    const hint =
      this.spec.id === "devin"
        ? `请先在终端运行 ${this.spec.command} auth login 完成登录`
        : `请先完成 ${this.spec.name} 的登录认证`;
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
  if (kind === "execute") return "command";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file";
  return "permission";
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
          out.push({ id, name: child?.name || child?.label, group: entry.name });
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
