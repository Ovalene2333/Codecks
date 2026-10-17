import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AgentAdapter,
  AgentApproval,
  AgentCapabilities,
  AgentCommand,
  AgentCreateThreadInput,
  AgentDescriptor,
  AgentPublicProfile,
  AgentSkill,
  AgentSnapshot,
} from "./types.js";
import type { ModelInfo, ThreadSummary, TurnImage } from "../types.js";
import type { ThreadSettingsStore } from "../thread-settings.js";
import { stopChildProcess } from "../process-tree.js";
import { findFreeListenPort } from "../runtime-port.js";
import {
  assertMessageInput,
  type AgentMessageAcceptance,
  type AgentMessageInput,
} from "./messages.js";

/**
 * V2 `/api/*` adapter，统一运行时通过 agentId="opencode" 暴露；可独立测试。
 * 以 2.0.32 的真实隔离实例核对消息、SSE、工具、审批/表单、分页与会话操作。
 * 流式原生 part 快照经 agent.event 进入共享渲染，inboxID 作为跨模型步骤的回合 ID。
 * 兼容 dev 构建 session.next.* 前缀；未接线路由显式报错，不吞成空成功。
 * 差异：项目级授权降为会话级；模型不声明推理强度档位；已提交撤回没有恢复接口。
 */

export const OPENCODE_V2_AGENT_ID = "opencode-v2";

const OPENCODE_V2_CAPABILITIES: AgentCapabilities = {
  // prompt 受理只确认入队，不保证追加到当前回合还是排队执行。
  messages: { busyBehavior: "unknown", interruptScope: "session" },
  approvals: true,
  // Deck 侧软归档（与 V1 一致）：V2 dev 构建没有原生归档接口，
  // 归档态写 thread-settings，服务端会话原样保留。
  archive: true,
  // DELETE /api/session/:id：按协议实现；dev 构建未接线时抛中文友好错误。
  delete: true,
  // POST /api/session/:id/fork {before?}：非破坏性分支；dev 构建未接线时
  // 抛中文友好错误（retryFromTurn 同理依赖它）。
  fork: true,
  // prompt files 附件：按协议 FileAttachment 映射；模型能力未知或明确
  // 不支持视觉时发送前直接拒绝，不等任务报错。
  images: true,
  interrupt: true,
  mcp: false,
  models: true,
  review: false,
  // updateThreadSettings 放行模型/子 agent 切换（均已验证）；
  // rename 走 Deck 侧标题先行（PATCH 未接线时原生重命名随后补上）。
  sessionSettings: true,
  shell: false,
  // skill/command 枚举已验证；调用走 POST /:id/command（未接线时友好失败）。
  skills: true,
};

export type OpenCodeV2AdapterOptions = {
  agentId?: string;
  bin?: string;
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
  killProcessTree?: (pid: number) => void;
  fetcher?: typeof fetch;
  initialThreads?: ThreadSummary[];
  initialDirectories?: string[];
  threadSettings?: ThreadSettingsStore;
};

type V2Session = {
  id: string;
  parentID?: string;
  fork?: { sessionID?: string; boundary?: unknown } | unknown;
  projectID?: string;
  agent?: string;
  model?: { id?: string; providerID?: string; variant?: string };
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  time?: { created?: number; updated?: number };
  title?: string;
  location?: { directory?: string };
  subpath?: string;
};

type V2Message = {
  id: string;
  time?: { created?: number; completed?: number };
  outcome?: string;
  files?: Array<{ data?: string; mime?: string; name?: string; uri?: string }>;
  type?: string;
  text?: string;
  agent?: string;
  model?: { id?: string; providerID?: string };
  content?: Array<{
    type?: string;
    text?: string;
    id?: string;
    name?: string;
    state?: {
      status?: string;
      input?: unknown;
      content?: Array<{ type?: string; text?: string; uri?: string }>;
      error?: { type?: string; message?: string };
      metadata?: Record<string, unknown>;
    };
  }>;
};

type V2Provider = {
  id: string;
  name?: string;
};

type V2Model = {
  id: string;
  providerID: string;
  name?: string;
  capabilities?: { input?: string[] };
  limit?: { context?: number; output?: number };
  enabled?: boolean;
};

/** V2 模型字符串与 V1 一致：`providerID/modelID`，`default` 为占位。 */
export function v2ModelString(providerID?: string, modelID?: string) {
  return providerID && modelID ? `${providerID}/${modelID}` : "default";
}

export function v2ProviderIdOf(model?: string) {
  const separator = (model || "").indexOf("/");
  return separator > 0 ? model!.slice(0, separator) : "";
}

const V2_DEFAULT_NAMES = new Set(["OpenCode V2 会话", "新 OpenCode V2 会话"]);

function isV2Slug(value?: string) {
  return /^[a-z]{3,}-[a-z]{3,}(?:-[a-z]{3,})?$/.test(String(value || "").trim());
}

function isV2DefaultName(name?: string) {
  const value = String(name || "").trim();
  if (!value) return true;
  if (V2_DEFAULT_NAMES.has(value)) return true;
  return isV2Slug(value);
}

function cleanPreview(value: unknown) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstUserPreview(messages: V2Message[]) {
  for (const message of messages || []) {
    if (message?.type !== "user") continue;
    const cleaned = cleanPreview(message.text);
    if (cleaned) return cleaned;
  }
  return "";
}

/**
 * 把 V2 effect 错误体（`{_tag, message}`）与 HTML 回退翻译成中文错误。
 * 未接线的路由在 dev 构建返回 SPA HTML（200 text/html），必须显式识别，
 * 不能当成空成功吞掉。
 */
export function v2ErrorFor(
  pathname: string,
  status: number,
  bodyText: string,
  contentType: string,
): Error | undefined {
  if (status >= 200 && status < 300) {
    if (/text\/html/.test(contentType || "") || /^\s*</.test(bodyText || ""))
      return new Error(
        `OpenCode V2 serve 尚未接线该接口（${pathname}），请升级 OpenCode V2 后重试`,
      );
    return undefined;
  }
  if (status === 404)
    return new Error(
      `OpenCode V2 serve 找不到该接口（${pathname}），请升级 OpenCode V2 后重试`,
    );
  try {
    const body = JSON.parse(bodyText || "{}");
    const message = String(body?.message || body?.error || "").trim();
    if (message) {
      if (body?._tag === "ServiceUnavailableError")
        return new Error(`OpenCode V2 暂不支持：${message}`);
      return new Error(`OpenCode V2 请求失败：${message}`);
    }
  } catch {}
  return new Error(`OpenCode V2 请求失败（${pathname}，HTTP ${status}）`);
}

function unwrapEnvelope(value: any) {
  if (value && typeof value === "object" && "data" in value) return value.data;
  return value;
}

/**
 * V2 content[] → Deck turn item。text/reasoning 直转；tool 按
 * commandExecution 归一（state.status streaming|running|completed|error）；
 * 未知类型保留为 extension（agentId 透传 opencode-v2），不丢原生数据。
 */
export function v2ContentToItem(content: any, message: V2Message, agentId = OPENCODE_V2_AGENT_ID): any | undefined {
  if (!content || typeof content.type !== "string") return undefined;
  if (content.type === "text")
    return {
      id: String(content.id || message.id || randomUUID()),
      type: "agentMessage",
      text: String(content.text || ""),
      ...(message.time?.created ? { startedAt: message.time.created } : {}),
    };
  if (content.type === "reasoning")
    return {
      id: String(content.id || message.id || randomUUID()),
      type: "reasoning",
      summary: String(content.text || ""),
      ...(message.time?.created ? { startedAt: message.time.created } : {}),
    };
  if (content.type === "tool") {
    const state = content.state || {};
    const outputs: string[] = [];
    for (const chunk of Array.isArray(state.content) ? state.content : []) {
      if (chunk?.type === "text" && chunk.text) outputs.push(String(chunk.text));
    }
    const output = outputs.join("\n\n") || String(state.error?.message || "");
    return {
      id: String(content.id || message.id || randomUUID()),
      type: "commandExecution",
      command: /^(shell|bash|exec)$/.test(String(content.name)) && state.input?.command
        ? String(state.input.command) : String(content.name || content.id || "OpenCode V2 工具"),
      status:
        state.status === "error"
          ? "failed"
          : state.status === "completed"
            ? "completed"
            : "inProgress",
      aggregatedOutput: output,
      tool: String(content.name || ""),
      ...(state.input != null ? { input: state.input } : {}),
      ...(state.metadata != null ? { metadata: state.metadata } : {}),
      ...(message.time?.created ? { startedAt: message.time.created } : {}),
    };
  }
  return {
    id: String(content.id || message.id || randomUUID()),
    type: "extension",
    kind: String(content.type || "unknown"),
    agentId,
    payload: content,
  };
}

/** V2 平铺消息 → Deck turns：user 消息开新轮，其余归入当前轮。 */
export function v2MessagesToTurns(messages: V2Message[], agentId = OPENCODE_V2_AGENT_ID) {
  const turns: any[] = [];
  let turn: any;
  for (const message of messages || []) {
    if (message?.type === "user") {
      turn = {
        id: String(message.id || randomUUID()),
        status: "completed",
        startedAt: Number(message.time?.created || Date.now()),
        items: [
          {
            id: String(message.id || randomUUID()),
            type: "userMessage",
            content: [
              ...(message.text ? [{ type: "text", text: message.text }] : []),
              ...(message.files || []).filter((file) => file.mime?.startsWith("image/")).map((file) => ({
                type: "image", url: file.uri || `data:${file.mime};base64,${file.data || ""}`,
                ...(file.name ? { name: file.name } : {}),
              })),
            ],
          },
        ],
      };
      turns.push(turn);
      continue;
    }
    if (!turn) continue;
    if (message?.type === "idle") {
      turn.endedAt = Number(message.time?.created || turn.startedAt);
      turn.status = message.outcome === "failed" ? "failed" : message.outcome === "interrupted" ? "interrupted" : "completed";
      continue;
    }
    if (message?.type === "assistant") {
      const providerID = String(message.model?.providerID || "").trim();
      const modelID = String(message.model?.id || "").trim();
      if (providerID && modelID) turn.model = `${providerID}/${modelID}`;
      for (const [ordinal, content] of (message.content || []).entries()) {
        const mapped = v2ContentToItem({ ...content, id: content.id || `${message.id}:${content.type}:${ordinal}` }, message, agentId);
        if (mapped) turn.items.push(mapped);
      }
      continue;
    }
    // compaction/system/synthetic 等：保留为 extension，不打断回合结构。
    const mapped = v2ContentToItem(
      { type: message?.type || "unknown", id: message?.id, text: message?.text },
      message,
      agentId,
    );
    if (mapped && mapped.type === "extension") turn.items.push(mapped);
  }
  for (const item of turns) {
    const last = item.items[item.items.length - 1];
    item.endedAt ??= Number(
      (last as any)?.startedAt || item.startedAt || Date.now(),
    );
  }
  return turns;
}

function v2SessionSummary(
  session: V2Session,
  status: ThreadSummary["status"] = "idle",
): ThreadSummary {
  const name = session.title || "OpenCode V2 会话";
  const nativeModel =
    session.model?.providerID && session.model?.id
      ? `${session.model.providerID}/${session.model.id}`
      : undefined;
  const tokens = session.tokens;
  const usage =
    tokens &&
    (Number(tokens.input) > 0 ||
      Number(tokens.output) > 0 ||
      Number(tokens.reasoning) > 0)
      ? {
          input: Number(tokens.input) || 0,
          output: Number(tokens.output) || 0,
          reasoningOutput: Number(tokens.reasoning) || 0,
        }
      : undefined;
  return {
    agentId: OPENCODE_V2_AGENT_ID,
    id: session.id,
    providerId: session.model?.providerID || "",
    name,
    preview: name,
    cwd: session.location?.directory || "",
    model: nativeModel || "default",
    status,
    updatedAt: Number(
      session.time?.updated || session.time?.created || Date.now(),
    ),
    sessionId: session.id,
    controlMode: "managed",
    ...(session.parentID ? { forkedFromId: session.parentID } : {}),
    ...(usage ? { tokenUsage: usage } : {}),
  };
}

/** subagent 衍生会话只带 parentID；fork 副本额外带 fork 标记，必须保留。 */
function isHiddenSubagentChild(session: V2Session) {
  return Boolean(session.parentID && !session.fork);
}

const REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_POST_TIMEOUT_MS = 60_000;
const REQUEST_RETRIES = 2;
const REQUEST_RETRY_DELAYS_MS = [300, 800];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function windowsCommand(command: string, args: string[]) {
  if (/\r|\n|"/.test(command))
    throw new Error("OPENCODE_V2_BIN 包含 Windows cmd 不支持的字符");
  const values = [command, ...args];
  return `call ${values.map((value) => `"${value}"`).join(" ")}`;
}

export class OpenCodeV2Adapter extends EventEmitter implements AgentAdapter {
  readonly id: string;
  private threads = new Map<string, ThreadSummary>();
  private approvals = new Map<string, AgentApproval & { sessionId: string; cwd: string }>();
  private runningTurns = new Map<string, string>();
  private sessionTitles = new Map<string, string>();
  /** fork 去重：同会话同时只进行一个分支（boundary 不同则明确拒绝）。 */
  private forkOperations = new Map<string, { boundary: string; promise: Promise<unknown> }>();
  /** delete 去重：重复点击共用同一个删除请求。 */
  private deleteOperations = new Map<string, Promise<unknown>>();
  /** send 串行锁：sendTurn 与 runSessionCommand 共用，防并发受理。 */
  private sendLocks = new Map<string, Promise<unknown>>();
  /** fork 出来的分支 id（refreshAll 期间同样识别为 Deck 托管分支）。 */
  private forkChildren = new Set<string>();
  /** 并发 message 读取合并，避免打开/索引/详情同时重复下载。 */
  private messageReads = new Map<string, Promise<{ data?: V2Message[]; cursor?: { previous?: string | null; next?: string | null } }>>();
  private providers: V2Provider[] = [];
  private models: V2Model[] = [];
  private skillCommands: AgentCommand[] = [];
  private serveProcess?: ChildProcess;
  private servePid?: number;
  private binOverride?: string;
  private baseUrl?: string;
  private online = false;
  private starting = false;
  private error?: string;
  private eventAbort?: AbortController;
  private lastTurnText = new Map<string, string>();
  private liveParts = new Map<string, any>();

  constructor(private options: OpenCodeV2AdapterOptions = {}) {
    super();
    this.id = options.agentId || OPENCODE_V2_AGENT_ID;
  }

  descriptor(): AgentDescriptor {
    return {
      id: this.id,
      name: this.id === "opencode" ? "OpenCode" : "OpenCode V2",
      protocol: "native",
      available: true,
      online: this.online,
      starting: this.starting,
      error: this.error,
      historyStatus: this.online ? "ready" : this.starting ? "loading" : "cached",
      capabilities: { ...OPENCODE_V2_CAPABILITIES },
    };
  }

  snapshot(): AgentSnapshot {
    const threads = [...this.threads.values()]
      .filter((thread) => !thread.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      threads,
      archivedThreads: [...this.threads.values()]
        .filter((thread) => thread.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt),
      approvals: [...this.approvals.values()],
    };
  }

  busyThreads(): ThreadSummary[] {
    return [...this.threads.values()].filter(
      (thread) =>
        thread.status === "running" ||
        thread.status === "waiting" ||
        [...this.approvals.values()].some((approval) => approval.sessionId === thread.id),
    );
  }

  isOnline() {
    return this.online;
  }

  private serverPassword: string | undefined;

  private authHeaders(): Record<string, string> {
    return this.serverPassword
      ? { Authorization: `Basic ${Buffer.from(`opencode:${this.serverPassword}`).toString("base64")}` }
      : {};
  }

  private get fetcher(): typeof fetch {
    return this.options.fetcher || fetch;
  }

  private bin() {
    return (
      this.binOverride ||
      this.options.bin ||
      process.env.OPENCODE_V2_BIN ||
      "opencode-v2"
    );
  }

  /** 供将来设置页切换 V2 可执行文件：下次 startAll 生效。 */
  selectExecutable(bin: string) {
    this.binOverride = String(bin || "").trim() || undefined;
  }

  private emitAgentEvent(thread: ThreadSummary, method: string, params: any) {
    this.broadcast("agent.event", {
      agentId: this.id,
      providerId: thread.providerId,
      method,
      params: { threadId: thread.id, turnId: thread.activeTurnId, ...params },
    });
  }

  private broadcast(method: string, params: any) {
    this.emit("event", { type: method, data: params });
  }

  private async request<T = any>(
    pathname: string,
    options: {
      method?: string;
      query?: Record<string, string | undefined>;
      body?: unknown;
      timeoutMs?: number;
      retry?: boolean;
      /** message 列表等需要同时拿 data 与 cursor 的接口：跳过信封剥离。 */
      rawEnvelope?: boolean;
    } = {},
  ): Promise<T> {
    if (!this.baseUrl) throw new Error("OpenCode V2 server 尚未启动");
    const method = options.method || "GET";
    const url = new URL(pathname, this.baseUrl);
    for (const [key, value] of Object.entries(options.query || {}))
      if (value !== undefined) url.searchParams.set(key, value);
    const idempotent = method === "GET";
    const timeoutMs =
      options.timeoutMs || (idempotent ? REQUEST_TIMEOUT_MS : REQUEST_POST_TIMEOUT_MS);
    const attempts = options.retry === false || !idempotent ? 1 : 1 + REQUEST_RETRIES;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0)
        await sleep(REQUEST_RETRY_DELAYS_MS[Math.min(attempt - 1, REQUEST_RETRY_DELAYS_MS.length - 1)]);
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      (timer as any)?.unref?.();
      try {
        const trace = process.env.OPENCODE_TRACE_REQUESTS === "1";
        const response = await this.fetcher(url.toString(), {
          method,
          headers: { ...this.authHeaders(), ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}) },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
          signal: controller.signal,
        });
        const headerMs = Date.now() - startedAt;
        const contentType = response.headers?.get?.("content-type") || "";
        const text = await response.text();
        if (trace)
          console.error(
            `[opencode-v2] ${method} ${pathname} -> ${response.status} (${headerMs}ms header, ${Date.now() - startedAt}ms total)`,
          );
        const friendly = v2ErrorFor(pathname, response.status, text, contentType);
        if (friendly) throw friendly;
        if (!text) return undefined as T;
        try {
          const parsed = JSON.parse(text);
          return (options.rawEnvelope ? parsed : unwrapEnvelope(parsed)) as T;
        } catch {
          throw new Error(`OpenCode V2 返回了非 JSON 响应（${pathname}）`);
        }
      } catch (error: any) {
        lastError = error;
        const message = String(error?.message || error || "");
        // 中文友好错误直接透出，不重试；超时/闪断类 GET 才重试。
        if (/OpenCode V2|尚未接线|暂不支持|找不到该接口/.test(message)) throw error;
        if (!idempotent || error?.name === "AbortError") {
          if (error?.name === "AbortError" && !idempotent) break;
          if (!idempotent) break;
        }
        if (attempt + 1 >= attempts) break;
        const retryable = /abort|timeout|terminated|ECONN|ENOTFOUND|fetch failed/i.test(message);
        if (!retryable) throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    const message = String((lastError as any)?.message || lastError || "请求失败");
    if (/abort/i.test((lastError as any)?.name || "") || /timeout/i.test(message))
      throw new Error(`OpenCode V2 连接闪断（${pathname} 超时），重试即可恢复`);
    throw lastError instanceof Error ? lastError : new Error(message);
  }

  private async probeHealth(): Promise<boolean> {
    if (!this.baseUrl) return false;
    try {
      const value = await this.request<any>("/api/session", { timeoutMs: 5000, retry: false });
      // V2 信封是 {data: [...]}；V1 同路径返回裸数组——拒绝跨版本复用。
      return Array.isArray((value as any)?.data) || Array.isArray(value);
    } catch {
      return false;
    }
  }

  async startAll(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    this.broadcast("agent.status", this.descriptor());
    try {
      if (await this.probeHealth()) {
        this.online = true;
        this.error = undefined;
        await this.refreshAll().catch(() => undefined);
        this.subscribeEvents();
        return;
      }
      const port = this.options.port || (await findFreeListenPort());
      this.baseUrl = `http://127.0.0.1:${port}`;
      const platform = this.options.platform || process.platform;
      const selected = this.bin();
      const command = platform === "win32" && selected === "opencode" ? "opencode.cmd" : selected;
      const batch = platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
      const serveArgs = ["serve", "--hostname", "127.0.0.1", "--port", String(port)];
      // V2 stable 始终要求鉴权；密码仅传给本轮子进程，不写入用户配置。
      this.serverPassword = process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || randomUUID();
      const spawnFn = this.options.spawnProcess || spawn;
      const child = spawnFn(
        batch ? process.env.ComSpec || "cmd.exe" : command,
        batch ? ["/d", "/s", "/c", windowsCommand(command, serveArgs)] : serveArgs, {
        env: { ...process.env, OPENCODE_PASSWORD: this.serverPassword, OPENCODE_SERVER_PASSWORD: this.serverPassword },
        windowsVerbatimArguments: batch || undefined,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk || "");
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      const exited = new Promise<number | null>((resolve) => {
        child.on("exit", (code) => resolve(code));
        child.on("error", () => resolve(null));
      });
      // 冷启动最多等 30 秒；V2 dev 构建 ECB 首次加载模型目录较慢。
      const deadline = Date.now() + 30_000;
      let healthy = false;
      let spawnError: string | undefined;
      while (Date.now() < deadline) {
        const code = await Promise.race([
          exited.then((value) => value as number | null | undefined),
          sleep(500).then(() => undefined),
        ]);
        if (code !== undefined) {
          spawnError = `OpenCode V2 启动失败（${command} 已退出）：${stderr.trim().slice(-500) || "无 stderr 输出"}`;
          break;
        }
        if (await this.probeHealth()) {
          healthy = true;
          break;
        }
      }
      if (!healthy) {
        stopChildProcess(child, this.options.killProcessTree);
        this.baseUrl = undefined;
        throw new Error(spawnError || `OpenCode V2 启动超时（${command} 无响应）`);
      }
      this.serveProcess = child;
      this.servePid = child.pid;
      child.on("exit", () => {
        if (this.serveProcess === child) {
          this.serveProcess = undefined;
          this.servePid = undefined;
          this.offline(new Error("OpenCode V2 serve 进程已退出"));
        }
      });
      this.online = true;
      this.error = undefined;
      await this.refreshAll().catch(() => undefined);
      this.subscribeEvents();
    } catch (error: any) {
      this.offline(error);
      throw error;
    } finally {
      this.starting = false;
      this.broadcast("agent.status", this.descriptor());
    }
  }

  private offline(error: unknown) {
    this.online = false;
    this.error = error instanceof Error ? error.message : String(error);
    this.eventAbort?.abort();
    this.eventAbort = undefined;
    this.forkOperations.clear();
    this.deleteOperations.clear();
    this.sendLocks.clear();
    this.messageReads.clear();
    this.liveParts.clear();
    this.runningTurns.clear();
    for (const thread of this.threads.values())
      if (thread.status === "running" || thread.status === "waiting")
        thread.status = "error";
    this.broadcast("agent.status", this.descriptor());
  }

  restart(): void {
    this.eventAbort?.abort();
    this.eventAbort = undefined;
    this.forkOperations.clear();
    this.deleteOperations.clear();
    this.sendLocks.clear();
    this.messageReads.clear();
    this.liveParts.clear();
    this.runningTurns.clear();
    const child = this.serveProcess;
    this.serveProcess = undefined;
    this.servePid = undefined;
    this.baseUrl = undefined;
    this.online = false;
    stopChildProcess(child, this.options.killProcessTree);
    this.broadcast("agent.status", this.descriptor());
  }

  async reload(): Promise<"process"> {
    this.restart();
    await this.startAll().catch(() => undefined);
    return "process";
  }

  runtimePids(): number[] {
    return this.servePid ? [this.servePid] : [];
  }

  private subscribeEvents() {
    if (!this.baseUrl || this.eventAbort) return;
    const abort = new AbortController();
    this.eventAbort = abort;
    void this.pumpEvents(abort.signal).catch(() => undefined);
  }

  private async pumpEvents(signal: AbortSignal): Promise<void> {
    if (!this.baseUrl) return;
    let backoff = 1000;
    let connected = false;
    while (!signal.aborted && this.baseUrl) {
      try {
        const response = await this.fetcher(new URL("/api/event", this.baseUrl).toString(), {
          headers: { ...this.authHeaders(), Accept: "text/event-stream" },
          signal,
        } as any);
        if (!response.ok || !response.body) throw new Error(`event 流 HTTP ${response.status}`);
        backoff = 1000;
        if (connected) {
          await this.refreshAll();
          for (const thread of this.threads.values()) this.emitAgentEvent(thread, "thread/historyUpdated", {});
        }
        connected = true;
        const reader = (response.body as any).getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done || signal.aborted) break;
          buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
          let index: number;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const chunk = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            for (const line of chunk.split("\n")) {
              const text = line.startsWith(":") ? "" : line.replace(/^data:\s?/, "").trim();
              if (!text || line.startsWith(":")) continue;
              try {
                this.onEvent(JSON.parse(text));
              } catch {}
            }
          }
        }
      } catch (error: any) {
        if (signal.aborted) return;
        await sleep(Math.min(backoff, 10_000));
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
  }

  /** SSE 信封 `{id, type, data, location?}` → Deck 事件。未知类型忽略。 */
  onEvent(envelope: any) {
    const type = String(envelope?.type || "");
    const data = envelope?.data || {};
    const sessionId =
      String(data.sessionID || data.sessionId || envelope?.durable?.aggregateID || "").trim();
    // 兼容 dev 构建的 session.next.* 前缀与协议包的 session.*。
    const suffix = type.replace(/^session\.next\./, "session.");
    const thread = sessionId ? this.threads.get(sessionId) : undefined;

    if (suffix === "server.connected") return;
    if (suffix === "session.inbox.delivered" && thread) {
      thread.activeTurnId = String(data.inboxID || thread.activeTurnId || "");
      this.runningTurns.set(thread.id, thread.activeTurnId!);
      thread.status = "running";
      this.emitAgentEvent(thread, "turn/started", {
        turn: { id: thread.activeTurnId, status: "inProgress" },
      });
      this.broadcast("thread.updated", thread);
      this.emitAgentEvent(thread, "thread/historyUpdated", {});
      return;
    }
    if (suffix === "session.created") {
      void this.ingestSession(data.info || data.session || data).catch(() => undefined);
      return;
    }
    if (suffix === "session.deleted") {
      if (sessionId) {
        this.purgeThread(sessionId);
        this.broadcast("thread.deleted", { agentId: this.id, threadId: sessionId });
      }
      return;
    }
    if (
      suffix === "session.renamed" ||
      suffix === "session.moved" ||
      suffix === "session.metadata.updated" ||
      suffix === "session.model.selected" ||
      suffix === "session.agent.selected"
    ) {
      if (sessionId) void this.request<V2Session>(`/api/session/${encodeURIComponent(sessionId)}`)
        .then((session) => this.ingestSession(session)).catch(() => undefined);
      return;
    }
    if (suffix === "session.forked") {
      void this.refreshAll().catch(() => undefined);
      return;
    }
    if (
      suffix === "session.revert.staged" ||
      suffix === "session.revert.committed" ||
      suffix === "session.revert.cleared"
    ) {
      if (thread) this.emitAgentEvent(thread, "thread/historyUpdated", { threadId: thread.id });
      return;
    }
    if (
      suffix === "session.step.started" ||
      suffix === "session.execution.started"
    ) {
      if (thread) {
        thread.status = "running";
        const turnId = String(data.assistantMessageID || data.messageID || "").trim();
        if (turnId && !thread.activeTurnId) {
          thread.activeTurnId = turnId;
          this.runningTurns.set(thread.id, turnId);
        }
        this.applyModelFromEvent(thread, data);
        thread.updatedAt = Date.now();
        this.broadcast("thread.updated", thread);
      }
      return;
    }
    if (
      suffix === "session.step.failed" ||
      suffix === "session.execution.succeeded" ||
      suffix === "session.execution.failed" ||
      suffix === "session.execution.interrupted"
    ) {
      if (thread) {
        const failed =
          suffix.endsWith(".failed") &&
          !/abort/i.test(String(data?.error?.message || data?.error || ""));
        thread.status = failed ? "error" : "idle";
        if (failed) thread.lastError = String(data?.error?.message || data?.error || "执行失败");
        else delete thread.lastError;
        this.emitAgentEvent(thread, "turn/completed", {
          turn: { id: thread.activeTurnId, status: failed ? "failed" : suffix.endsWith("interrupted") ? "interrupted" : "completed" },
        });
        thread.activeTurnId = undefined;
        this.runningTurns.delete(thread.id);
        for (const key of this.liveParts.keys())
          if (key.startsWith(`${thread.id}:`)) this.liveParts.delete(key);
        thread.updatedAt = Date.now();
        this.broadcast("thread.updated", thread);
        this.emitAgentEvent(thread, "thread/historyUpdated", { threadId: thread.id });
      }
      return;
    }
    if (suffix === "session.status") {
      if (thread) {
        const status = String(data.status || data.state || "").toLowerCase();
        if (status === "busy" || status === "running") thread.status = "running";
        else if (status === "idle") {
          if (!this.runningTurns.has(thread.id)) thread.status = "idle";
        } else if (status === "retry" || status === "waiting") thread.status = "waiting";
        thread.updatedAt = Date.now();
        this.broadcast("thread.updated", thread);
      }
      return;
    }
    if (suffix === "session.idle") {
      if (thread && !this.runningTurns.has(thread.id)) {
        thread.status = "idle";
        thread.activeTurnId = undefined;
        thread.updatedAt = Date.now();
        this.broadcast("thread.updated", thread);
      }
      return;
    }
    if (/^session\.(text|reasoning)\.(started|delta|ended)$/.test(suffix)) {
      if (!thread) return;
      const messageID = String(data.assistantMessageID || data.messageID || data.messageId || "");
      if (!messageID) return;
      const kind = suffix.includes(".reasoning.") ? "reasoning" : "text";
      const id = `${messageID}:${kind}:${data.ordinal ?? 0}`;
      const key = `${thread.id}:${id}`;
      const previous = this.liveParts.get(key);
      const text = suffix.endsWith(".ended")
        ? String(data.text ?? previous?.text ?? "")
        : String(previous?.text || "") + String(data.delta || "");
      const part = { id, type: kind, text };
      this.liveParts.set(key, part);
      this.emitAgentEvent(thread, "item/updated", { item: part });
      return;
    }
    if (/^session\.tool\.(called|progress|success|failed|input\.(delta|started|ended))$/.test(suffix)) {
      if (!thread) return;
      const id = String(data.id || data.partID || data.partId || data.tool?.id || "");
      if (!id) return;
      const key = `${thread.id}:${id}`;
      const previous = this.liveParts.get(key);
      const state = previous?.state || {};
      const part = {
        id, type: "tool", tool: String(data.name || data.tool?.name || previous?.tool || "OpenCode V2 工具"),
        state: {
          ...state,
          status: suffix.endsWith(".failed") ? "error" : suffix.endsWith(".success") ? "completed" : "running",
          ...(data.input !== undefined ? { input: data.input } : {}),
          ...(data.metadata ? { metadata: { ...state.metadata, ...data.metadata } } : {}),
          ...(data.content ? { output: data.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n\n") } : {}),
          ...(data.error ? { error: String(data.error.message || data.error) } : {}),
        },
      };
      this.liveParts.set(key, part);
      this.emitAgentEvent(thread, "item/updated", { item: part });
      return;
    }
    if (suffix === "session.usage.recorded" || suffix === "session.usage.updated") {
      if (thread) {
        const usage = data.usage || data.tokens || data;
        const input = Number(usage?.input ?? usage?.inputTokens ?? 0);
        const output = Number(usage?.output ?? usage?.outputTokens ?? 0);
        const reasoning = Number(usage?.reasoning ?? 0);
        if (input > 0 || output > 0 || reasoning > 0) {
          thread.tokenUsage = { input, output, reasoningOutput: reasoning };
          thread.updatedAt = Date.now();
          this.broadcast("thread.updated", thread);
        }
      }
      return;
    }
    if (
      suffix === "session.compaction.started" ||
      suffix === "session.compaction.delta" ||
      suffix === "session.compaction.ended" ||
      suffix === "session.compaction.failed"
    ) {
      if (thread) {
        thread.compacting = !suffix.endsWith(".ended") && !suffix.endsWith(".failed");
        thread.updatedAt = Date.now();
        this.broadcast("thread.updated", thread);
      }
      return;
    }
    if (suffix === "permission.asked") {
      this.ingestPermission(data.permission || data.request || data);
      return;
    }
    if (suffix === "permission.replied") {
      const id = String(data.requestID || data.id || "").trim();
      if (id && this.approvals.has(id)) {
        this.approvals.delete(id);
        this.broadcast("approval.resolved", { agentId: this.id, approvalId: id });
      }
      return;
    }
    if (suffix === "form.created" || suffix === "question.asked") {
      this.ingestForm(data.form || data.question || data);
      return;
    }
    if (suffix === "form.replied" || suffix === "form.cancelled") {
      const id = String(data.formID || data.id || "").trim();
      if (id && this.approvals.has(id)) {
        this.approvals.delete(id);
        this.broadcast("approval.resolved", { agentId: this.id, approvalId: id });
      }
    }
  }

  private applyModelFromEvent(thread: ThreadSummary, data: any) {
    const model = data?.model || {};
    const providerID = String(model.providerID || data?.providerID || "").trim();
    const modelID = String(model.id || model.modelID || data?.modelID || "").trim();
    if (providerID && modelID) {
      thread.resolvedModel = `${providerID}/${modelID}`;
      if (!thread.providerId) thread.providerId = providerID;
    }
    const agent = String(data?.agent || "").trim();
    if (agent) (thread as any).v2agent = agent;
  }

  private ingestPermission(raw: any) {
    const id = String(raw?.id || raw?.requestID || "").trim();
    const sessionId = String(raw?.sessionID || raw?.sessionId || "").trim();
    if (!id || !sessionId) return;
    const thread = this.threads.get(sessionId);
    this.approvals.set(id, {
      id,
      agentId: this.id,
      providerId: thread?.providerId,
      sessionId,
      sessionID: sessionId,
      kind: /edit|write|patch/.test(String(raw.action || "")) ? "file" : "command",
      command: (Array.isArray(raw.resources) ? raw.resources : []).join("\n") || String(raw.title || raw.action || "OpenCode V2 请求确认"),
      availableDecisions: ["decline", "accept", "acceptForSession"],
      cwd: thread?.cwd || "",
      request: {
        method: "opencode-v2/permission",
        params: {
          threadId: sessionId,
          title: String(raw?.title || raw?.name || raw?.action || "OpenCode V2 请求确认"),
          permission: raw,
        },
      },
    });
    this.broadcast("approval.requested", this.approvals.get(id));
    if (thread) {
      thread.status = "waiting";
      this.broadcast("thread.updated", thread);
    }
  }

  private ingestForm(raw: any) {
    const id = String(raw?.id || raw?.formID || "").trim();
    const sessionId = String(raw?.sessionID || raw?.sessionId || "").trim();
    if (!id || !sessionId) return;
    const thread = this.threads.get(sessionId);
    this.approvals.set(id, {
      id,
      agentId: this.id,
      providerId: thread?.providerId,
      sessionId,
      sessionID: sessionId,
      kind: "question",
      cwd: thread?.cwd || "",
      request: {
        method: "opencode-v2/question",
        params: {
          threadId: sessionId,
          title: String(raw?.title || "OpenCode V2 需要选择"),
          questions: raw?.questions || (raw?.fields || []).filter((field: any) => !field.hidden).map((field: any) => ({
            id: field.key,
            header: field.title || field.key,
            question: field.description || field.title || field.key,
            multiple: field.type === "multiselect",
            custom: field.custom ?? !field.options?.length,
            options: field.options || (field.type === "boolean" ? [{ label: "true" }, { label: "false" }] : []),
          })),
          raw,
        },
      },
    });
    this.broadcast("approval.requested", this.approvals.get(id));
    if (thread) {
      thread.status = "waiting";
      this.broadcast("thread.updated", thread);
    }
  }

  private requireThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("OpenCode V2 会话已删除或尚未加载");
    return thread;
  }

  /**
   * 模型先校验：格式必须为 provider/model；目录已就绪且模型不在目录里
   * 直接拒绝，不创建原生会话、不发送。目录为空（离线冷启动）时宽容，
   * 发送时再把关。
   */
  private async requireModelSetting(model: string, directory?: string) {
    const parsed = this.parseModelInput(model);
    if (!parsed) throw new Error(`模型格式应为 provider/model：${model}`);
    const models = directory ? await this.listModels(undefined, directory) : undefined;
    const known = models
      ? models.some((item) => item.model === model)
      : !this.models.length || this.models.some((item) => item.enabled !== false && item.providerID === parsed.providerID && item.id === parsed.id);
    if (!known) throw new Error(`未知模型 ${model}，请先在模型目录确认后重试`);
    return model.trim();
  }

  /** 发送前模型把关：非法设置大声失败，绝不带着空 modelID 发送。 */
  private sendModelOf(thread: ThreadSummary) {
    const raw = String(thread.model || "").trim();
    if (!raw || raw === "default") return undefined;
    return this.parseModelInput(raw) || undefined;
  }

  private async selectDefaultModel(thread: ThreadSummary) {
    const model = await this.request<V2Model | undefined>("/api/model/default", {
      query: { "location[directory]": thread.cwd },
    });
    if (!model?.id || !model.providerID) throw new Error("OpenCode V2 没有可用的默认模型，请先配置或选择模型");
    await this.request(`/api/session/${encodeURIComponent(thread.id)}/model`, {
      method: "POST", body: { model: { providerID: model.providerID, id: model.id } },
    });
    thread.providerId = model.providerID;
    thread.resolvedModel = `${model.providerID}/${model.id}`;
  }

  private userMessageIds(messages: V2Message[]) {
    return (messages || [])
      .filter((message) => message?.type === "user" && message?.id)
      .map((message) => String(message.id));
  }

  private async forkUserIds(thread: ThreadSummary) {
    const full: any = await this.readThread("", thread.id);
    return this.userMessageIds(
      (full?.turns || []).flatMap((turn: any) => [{ id: turn.id, type: "user" }]),
    );
  }

  /** send 串行化：同时只受理一轮，被顶掉的调用排队等前一轮受理完成。 */
  private serializeSend<T>(threadId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.sendLocks.get(threadId) || Promise.resolve();
    const pending = previous.catch(() => undefined).then(action);
    const tracked: Promise<unknown> = pending.catch(() => undefined);
    const cleanup = tracked.finally(() => {
      if (this.sendLocks.get(threadId) === cleanup) this.sendLocks.delete(threadId);
    });
    this.sendLocks.set(threadId, cleanup);
    return pending;
  }

  private purgeThread(sessionId: string) {
    this.threads.delete(sessionId);
    this.sessionTitles.delete(sessionId);
    this.forkChildren.delete(sessionId);
    this.runningTurns.delete(sessionId);
    this.lastTurnText.delete(sessionId);
    for (const key of this.liveParts.keys())
      if (key.startsWith(`${sessionId}:`)) this.liveParts.delete(key);
    for (const key of [...this.messageReads.keys()])
      if (key === sessionId || key.startsWith(`${sessionId}:`)) this.messageReads.delete(key);
    for (const [approvalId, approval] of this.approvals)
      if (approval.sessionId === sessionId) {
        this.approvals.delete(approvalId);
        this.broadcast("approval.resolved", { agentId: this.id, approvalId });
      }
  }

  private async ingestSession(raw: any) {
    if (!raw?.id) return;
    const session = raw as V2Session;
    if (isHiddenSubagentChild(session)) return;
    const existing = this.threads.get(session.id);
    const stored = this.options.threadSettings?.get(this.id, session.id);
    const thread: ThreadSummary = {
      ...existing,
      ...v2SessionSummary(session, existing?.status || "idle"),
      agentId: this.id,
      providerId:
        session.model?.providerID || existing?.providerId || "",
      cwd: session.location?.directory || existing?.cwd || "",
      model: session.model?.providerID && session.model?.id ? `${session.model.providerID}/${session.model.id}` : existing?.model || "default",
      archived: stored?.archived || undefined,
      ...(stored?.model ? { model: stored.model } : {}),
      ...(stored?.forkedFromId ? { forkedFromId: stored.forkedFromId } : {}),
    };
    const deckTitle = this.sessionTitles.get(session.id);
    const firstPreview = deckTitle && !isV2DefaultName(deckTitle) ? deckTitle : undefined;
    thread.name = firstPreview || thread.name;
    thread.preview = firstPreview || thread.preview;
    const current = existing ? Object.assign(existing, thread) : thread;
    this.threads.set(current.id, current);
    this.broadcast("thread.updated", current);
  }

  async refreshAll(): Promise<void> {
    if (!this.baseUrl) return;
    const sessions = await this.request<V2Session[]>("/api/session", { timeoutMs: 30_000 });
    const seen = new Set<string>();
    for (const session of sessions || []) {
      if (!session?.id || isHiddenSubagentChild(session)) continue;
      seen.add(session.id);
      await this.ingestSession(session).catch(() => undefined);
    }
    for (const id of [...this.threads.keys()])
      if (!seen.has(id)) this.threads.delete(id);
    await this.refreshCatalogs().catch(() => undefined);
    // 待审批补回：事件流断开期间漏掉的 permission/form。
    await this.backfillApprovals().catch(() => undefined);
    this.broadcast("snapshot", this.snapshot());
  }

  private async refreshCatalogs() {
    const [providers, models, agents, skills] = await Promise.all([
      this.request<any[]>("/api/provider", { timeoutMs: 15_000 }).catch(() => []),
      this.request<any[]>("/api/model", { timeoutMs: 15_000 }).catch(() => []),
      this.request<any[]>("/api/agent", { timeoutMs: 15_000 }).catch(() => []),
      this.request<any[]>("/api/skill", { timeoutMs: 15_000 }).catch(() => []),
    ]);
    this.providers = (providers || [])
      .filter((item) => item?.id)
      .map((item) => ({ id: String(item.id), name: String(item.name || item.id) }));
    this.models = (models || [])
      .filter((item) => item?.id && item?.providerID)
      .map((item) => ({
        id: String(item.id),
        providerID: String(item.providerID),
        name: String(item.name || item.id),
        capabilities: item.capabilities,
        limit: item.limit,
        enabled: item.enabled !== false,
      }));
    void agents;
    this.skillCommands = (skills || [])
      .filter((item) => item?.name)
      .map((item) => ({
        name: String(item.name),
        description: String(item.description || ""),
      }));
  }

  async agentCatalog(directory?: string): Promise<any[]> {
    return this.request<any[]>("/api/agent", { query: { "location[directory]": directory } });
  }

  // V2 provider 列表未提供 V1 connected 语义；保留未知态，不误报为无凭据。
  cachedConnectedProviders(_directory?: string): Set<string> | undefined {
    return undefined;
  }

  async probeConnectedProviders(_directory?: string): Promise<Set<string> | undefined> {
    return undefined;
  }

  async patchRuntimeConfig(config: Record<string, unknown>, directory?: string) {
    if (directory) throw new Error("OpenCode V2 项目配置已保存，请重启运行时使其生效");
    return this.request("/api/config", { method: "PATCH", body: config });
  }

  private async backfillApprovals() {
    const directories = new Set([
      ...this.options.initialDirectories || [],
      ...[...this.threads.values()].map((thread) => thread.cwd),
    ].filter(Boolean));
    if (!directories.size) directories.add("");
    await Promise.all([...directories].map(async (directory) => {
      const query = { "location[directory]": directory || undefined };
      const [permissions, forms] = await Promise.all([
        this.request<any[]>("/api/permission/request", { query, timeoutMs: 15_000 }).catch(() => []),
        this.request<any[]>("/api/form", { query, timeoutMs: 15_000 }).catch(() => []),
      ]);
      for (const raw of permissions || []) this.ingestPermission(raw?.request || raw);
      for (const raw of forms || []) this.ingestForm(raw?.form || raw);
    }));
  }

  async repairHistory(): Promise<void> {
    await this.refreshAll().catch(() => undefined);
  }

  publicProfiles(): AgentPublicProfile[] {
    return this.providers.map((profile) => ({
      id: profile.id,
      agentId: this.id,
      name: String(profile.name || profile.id),
      enabled: true,
      online: this.online,
    }));
  }

  async listModels(providerId?: string, directory?: string): Promise<ModelInfo[]> {
    const query = { "location[directory]": directory };
    const [models, providers] = directory ? await Promise.all([
      this.request<V2Model[]>("/api/model", { query }),
      this.request<V2Provider[]>("/api/provider", { query }),
    ]) : [this.models, this.providers];
    const scope = providerId
      ? models.filter((item) => item.providerID === providerId)
      : models;
    const entries: ModelInfo[] = scope
      .filter((item) => item.enabled !== false)
      .map((item) => ({
        id: `${item.providerID}/${item.id}`,
        model: `${item.providerID}/${item.id}`,
        displayName: String(item.name || item.id),
        groupName: providers.find((profile) => profile.id === item.providerID)?.name
          || item.providerID,
        supportsImages: Array.isArray(item.capabilities?.input)
          ? item.capabilities!.input!.includes("image")
          : undefined,
      }));
    return [
      { id: "default", model: "default", displayName: "跟随 OpenCode V2 默认", isDefault: true },
      ...entries,
    ];
  }

  private parseModelInput(model?: string) {
    const value = String(model || "").trim();
    if (!value || value === "default") return undefined;
    const separator = value.indexOf("/");
    if (separator <= 0) throw new Error(`模型格式应为 provider/model：${value}`);
    return {
      providerID: value.slice(0, separator),
      id: value.slice(separator + 1),
    };
  }

  async createThread(providerId: string, input: AgentCreateThreadInput): Promise<unknown> {
    const cwd = String(input.cwd || "").trim();
    if (!cwd) throw new Error("创建 OpenCode V2 会话需要工作目录");
    // 模型先校验：脏值直接拒绝，不创建原生会话、不落盘。
    const model = input.model?.trim() ? await this.requireModelSetting(input.model, cwd) : "default";
    const parsed = model === "default" ? undefined : this.parseModelInput(model);
    const session = await this.request<V2Session>("/api/session", {
      method: "POST",
      body: {
        location: { directory: cwd },
        ...(input.name?.trim() ? { title: input.name.trim() } : {}),
        ...(parsed ? { model: parsed } : {}),
      },
    });
    const displayName = input.name?.trim() || session.title || "新 OpenCode V2 会话";
    if (input.name?.trim()) this.sessionTitles.set(session.id, input.name.trim());
    const thread: ThreadSummary = {
      ...v2SessionSummary(session),
      agentId: this.id,
      providerId: providerId || session.model?.providerID || "",
      cwd,
      model,
      name: displayName,
      preview: displayName,
    };
    if (model !== "default") {
      await this.options.threadSettings
        ?.update(this.id, thread.id, { model })
        .catch(() => undefined);
    }
    this.threads.set(thread.id, thread);
    this.broadcast("thread.updated", thread);
    return thread;
  }

  private async readMessagesPage(thread: ThreadSummary, limit = 200, cursor?: string) {
    return this.request<{ data?: V2Message[]; cursor?: { previous?: string | null; next?: string | null } }>(
      `/api/session/${encodeURIComponent(thread.id)}/message`,
      {
        query: { limit: String(limit), ...(cursor ? { cursor } : {}) },
        rawEnvelope: true,
      },
    );
  }

  /** 并发 message 读取合并：同会话同时只发一个请求，成功/失败都释放。 */
  private readMessages(thread: ThreadSummary, limit = 200, cursor?: string) {
    if (cursor) return this.readMessagesPage(thread, limit, cursor);
    const key = `${thread.id}:${limit}`;
    const existing = this.messageReads.get(key);
    if (existing) return existing;
    const pending = this.readMessagesPage(thread, limit).finally(() => {
      if (this.messageReads.get(key) === pending) this.messageReads.delete(key);
    });
    this.messageReads.set(key, pending);
    return pending;
  }

  async readThread(
    providerId: string,
    threadId: string,
    options?: { turnLimit?: number; beforeTurn?: string },
  ): Promise<unknown> {
    const thread = this.requireThread(threadId);
    const session = await this.request<V2Session>(
      `/api/session/${encodeURIComponent(threadId)}`,
    );
    await this.ingestSession(session).catch(() => undefined);
    // message 按页走（单页上限 200）：无选项时翻页读全量供搜索索引；
    // turnLimit 只取尾部并在用户回合处对齐；beforeTurn 追加更早历史。
    const pages: V2Message[][] = [];
    let cursor: string | undefined;
    let hasMore = false;
    const maxPages = options && (options.turnLimit || options.beforeTurn) ? 10 : 50;
    for (let page = 0; page < maxPages; page++) {
      const result = await this.readMessages(thread, 200, cursor);
      const batch = Array.isArray(result?.data) ? result.data : [];
      // 服务端默认倒序（新在前）：统一按时间正序归一化。
      batch.sort(
        (a, b) => Number(a?.time?.created || 0) - Number(b?.time?.created || 0) || String(a.id).localeCompare(String(b.id)),
      );
      pages.unshift(batch);
      cursor = result?.cursor?.next || undefined;
      hasMore = Boolean(cursor);
      if (!cursor || !batch.length) {
        hasMore = false;
        break;
      }
      if (options?.turnLimit || options?.beforeTurn) {
        const count = countUserTurns(pages);
        if (options.beforeTurn && containsTurn(pages, options.beforeTurn)) break;
        if (options.turnLimit && count >= options.turnLimit + 1) break;
      }
    }
    const records = pages.flat();
    let turns = v2MessagesToTurns(records, this.id);
    if (options?.beforeTurn) {
      const index = turns.findIndex((item) => String(item.id) === options.beforeTurn);
      if (index > 0) turns = turns.slice(0, index);
    }
    const totalTurns = turns.length || undefined;
    const turnLimit = options?.turnLimit;
    const omitted =
      turnLimit && turns.length > turnLimit ? turns.length - turnLimit : 0;
    if (omitted > 0 && turnLimit) turns = turns.slice(-turnLimit);
    if ((thread.status === "running" || thread.status === "waiting") && turns.length && !options?.beforeTurn) {
      const active = turns[turns.length - 1];
      active.status = "inProgress";
      delete active.endedAt;
    }
    const full: any = {
      turns,
      ...(totalTurns !== undefined ? { totalTurns } : {}),
      ...(hasMore || omitted > 0
        ? { hasMoreTurns: true, __cachedTailOmitted: omitted > 0 ? omitted : 1 }
        : {}),
    };
    void providerId;
    return full;
  }

  async readTurn(_providerId: string, threadId: string, turnId: string): Promise<unknown> {
    const full: any = await this.readThread("", threadId);
    const turn = (full?.turns || []).find((item: any) => String(item.id) === turnId);
    if (!turn) throw new Error("找不到该回合，可能已被撤回或压缩");
    return { turns: [turn], totalTurns: 1 };
  }

  async renameThread(_providerId: string, threadId: string, name: string): Promise<unknown> {
    const thread = this.requireThread(threadId);
    const title = String(name || "").trim();
    if (!title) throw new Error("会话名称不能为空");
    // 该构建尚未接线 PATCH title：Deck 侧标题先行，原生重命名随后补上。
    try {
      await this.request(`/api/session/${encodeURIComponent(threadId)}`, {
        method: "PATCH",
        body: { title },
      });
    } catch (error: any) {
      if (!/尚未接线|找不到该接口/.test(String(error?.message || ""))) throw error;
    }
    this.sessionTitles.set(threadId, title);
    thread.name = title;
    thread.preview = title;
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async archiveThread(_providerId: string, threadId: string): Promise<unknown> {
    const thread = this.requireThread(threadId);
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("运行中的会话不能归档");
    thread.archived = true;
    await this.options.threadSettings
      ?.update(this.id, threadId, { archived: true })
      .catch(() => undefined);
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async unarchiveThread(_providerId: string, threadId: string): Promise<unknown> {
    const thread = this.requireThread(threadId);
    thread.archived = false;
    await this.options.threadSettings
      ?.update(this.id, threadId, { archived: null })
      .catch(() => undefined);
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async updateThreadSettings(
    _providerId: string,
    threadId: string,
    settings: Partial<AgentCreateThreadInput>,
  ): Promise<unknown> {
    const thread = this.requireThread(threadId);
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("任务结束后才能修改 OpenCode V2 会话设置");
    const model = settings.model?.trim();
    const agent = (settings as { agent?: string }).agent?.trim?.() || undefined;
    const effort = (settings as { reasoningEffort?: string }).reasoningEffort?.trim?.() || undefined;
    if (effort)
      throw new Error("OpenCode V2 模型没有推理强度档位，无需设置");
    if (model !== undefined) {
      if (!model || model === "default") {
        // 清空即回到“跟随默认”，不再把旧值写回去。
        await this.selectDefaultModel(thread);
        thread.model = "default";
        delete thread.modelLabel;
      } else {
        const validated = await this.requireModelSetting(model, thread.cwd);
        await this.request(`/api/session/${encodeURIComponent(threadId)}/model`, {
          method: "POST",
          body: { model: this.parseModelInput(validated)! },
        });
        thread.model = validated;
        thread.resolvedModel = validated;
        thread.providerId = v2ProviderIdOf(validated);
        const label = this.modelLabelFor(thread, validated);
        if (label) thread.modelLabel = label;
        else delete thread.modelLabel;
      }
    }
    if (agent) {
      await this.request(`/api/session/${encodeURIComponent(threadId)}/agent`, {
        method: "POST",
        body: { agent },
      });
    }
    if (model !== undefined || agent) {
      await this.options.threadSettings
        ?.update(this.id, threadId, {
          ...(model !== undefined ? { model: thread.model } : {}),
        })
        .catch(() => undefined);
    }
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    return thread;
  }

  /** 从模型目录里查 `provider/model` 的展示名。 */
  private modelLabelFor(thread: ThreadSummary, model: string) {
    void thread;
    const separator = model.indexOf("/");
    if (separator <= 0) return undefined;
    const found = this.models.find(
      (item) =>
        item.providerID === model.slice(0, separator) && item.id === model.slice(separator + 1),
    );
    return found?.name || undefined;
  }

  deleteThread(_providerId: string, threadId: string) {
    const existing = this.deleteOperations.get(threadId);
    if (existing) return existing;
    const pending = this.performDelete(threadId).finally(() => {
      if (this.deleteOperations.get(threadId) === pending)
        this.deleteOperations.delete(threadId);
    });
    this.deleteOperations.set(threadId, pending);
    return pending;
  }

  private async performDelete(threadId: string) {
    if (this.forkOperations.has(threadId))
      throw new Error("此会话正在创建分支，暂时不能删除");
    const thread = this.requireThread(threadId);
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("运行中的 OpenCode V2 会话不能删除");
    await this.request(`/api/session/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
    });
    this.purgeThread(threadId);
    this.broadcast("thread.deleted", { agentId: this.id, threadId });
    return { ok: true as const };
  }

  async sendMessage(
    providerId: string,
    threadId: string,
    input: AgentMessageInput,
  ): Promise<AgentMessageAcceptance> {
    const thread = this.requireThread(threadId);
    assertMessageInput(thread, input, OPENCODE_V2_CAPABILITIES.messages!);
    const busy = thread.status === "running" || thread.status === "waiting";
    const result: any = await this.sendTurn(providerId, threadId, input.text, input.images);
    return { disposition: busy ? "backend-managed" : "started", turnId: result.turnId };
  }

  async sendTurn(providerId: string, threadId: string, text: string, images?: TurnImage[]) {
    return this.serializeSend(threadId, () =>
      this.sendTurnLocked(providerId, threadId, text, images),
    );
  }

  private async sendTurnLocked(
    _providerId: string,
    threadId: string,
    text: string,
    images?: TurnImage[],
  ) {
    const thread = this.requireThread(threadId);
    if (!text.trim() && !images?.length) throw new Error("请输入指令或图片");
    if (thread.archived) throw new Error("会话已归档，请先恢复再发送");
    // 非法模型设置直接大声失败，绝不带着空 modelID 发送。
    const parsed = this.sendModelOf(thread);
    if (!parsed) await this.selectDefaultModel(thread);
    if (images?.length && parsed) {
      const meta = this.models.find(
        (item) => item.providerID === parsed.providerID && item.id === parsed.id,
      );
      const supportsImages =
        meta && Array.isArray(meta.capabilities?.input)
          ? meta.capabilities!.input!.includes("image")
          : undefined;
      if (supportsImages === false)
        throw new Error(
          `当前模型 ${thread.model} 不支持图片输入，请移除图片或改用支持视觉的模型后再发送`,
        );
    }
    const files = (images || []).map((image) => ({
      uri: String(image.url || ""),
      ...(image.name ? { name: String(image.name) } : {}),
    }));
    for (const file of files) if (!file.uri) throw new Error("图片地址不能为空");
    const admitted = await this.request<{
      id?: string;
      messageID?: string;
      messageId?: string;
    }>(`/api/session/${encodeURIComponent(threadId)}/prompt`, {
      method: "POST",
      body: {
        text: String(text || ""),
        ...(files.length ? { files } : {}),
      },
    });
    const turnId = String(admitted?.id || admitted?.messageID || admitted?.messageId || "").trim();
    thread.status = "running";
    if (turnId && !thread.activeTurnId) {
      thread.activeTurnId = turnId;
      this.runningTurns.set(thread.id, turnId);
    }
    this.lastTurnText.set(thread.id, String(text || ""));
    // 首条消息先在本地落标题，不用等服务端回包。
    const optimistic = cleanPreview(text);
    if (
      optimistic &&
      !String(this.sessionTitles.get(threadId) || "").trim() &&
      (isV2DefaultName(thread.name) || isV2DefaultName(thread.preview) || !this.sessionTitles.has(threadId))
    ) {
      if (this.sessionTitles.has(threadId) || isV2DefaultName(thread.name)) {
        this.sessionTitles.set(threadId, optimistic.slice(0, 42));
        thread.name = this.sessionTitles.get(threadId)!;
        thread.preview = thread.name;
      }
    }
    thread.lastError = undefined;
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    void _providerId;
    return { ok: true as const, turnId: turnId || undefined };
  }

  async interrupt(_providerId: string, threadId: string, _turnId: string): Promise<unknown> {
    const thread = this.requireThread(threadId);
    await this.request(`/api/session/${encodeURIComponent(threadId)}/interrupt`, {
      method: "POST",
      body: {},
      timeoutMs: 15_000,
      retry: false,
    });
    thread.status = "idle";
    thread.activeTurnId = undefined;
    this.runningTurns.delete(thread.id);
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    return { ok: true as const };
  }

  async forceStop(_providerId: string, threadId: string): Promise<unknown> {
    const thread = this.threads.get(threadId);
    if (!thread) return { ok: true as const };
    await this.interrupt("", threadId, "");
    thread.status = "idle";
    thread.activeTurnId = undefined;
    this.runningTurns.delete(thread.id);
    this.broadcast("thread.updated", thread);
    return { ok: true as const };
  }

  async resolveApproval(
    approvalId: string,
    body: string | { decision?: string; answers?: unknown },
  ): Promise<unknown> {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error("审批已处理或不存在");
    const decision = typeof body === "string" ? body : body.decision;
    const method = approval.request?.method;
    if (method === "opencode-v2/question") {
      const fields: any[] = approval.request.params?.raw?.fields || [];
      const answers = (body as any)?.answers;
      const answer: Record<string, unknown> = {};
      for (const [index, field] of fields.entries()) {
        const entry = Array.isArray(answers) ? answers.find((item: any) => item?.id === field.key) || answers[index] : undefined;
        if (!entry) {
          if (field.default !== undefined) answer[field.key] = field.default;
          continue;
        }
        const value = entry.other || entry.value || "";
        const values = entry.other ? [entry.other] : Array.isArray(entry.values) && entry.values.length ? entry.values : [value];
        const mapped = values.map((label: string) => field.options?.find((option: any) => option.label === label || option.value === label)?.value ?? label);
        answer[field.key] = field.type === "multiselect" ? mapped
          : field.type === "number" || field.type === "integer" ? Number(mapped[0])
          : field.type === "boolean" ? String(mapped[0]) === "true" : mapped[0];
      }
      const path = `/api/session/${encodeURIComponent(approval.sessionId)}/form/${encodeURIComponent(approvalId)}`;
      await this.request(decision === "decline" || decision === "cancel" ? path : `${path}/reply`, {
        method: decision === "decline" || decision === "cancel" ? "DELETE" : "POST",
        ...(decision === "decline" || decision === "cancel" ? {} : { body: { answer } }),
      });
    } else {
      const reply =
        decision === "acceptForSession" || decision === "always"
          ? "always"
          : // V2 配置接口未接线，项目级持久授权退化为会话级允许。
            decision === "allowForProject"
            ? "always"
            : decision === "decline" || decision === "cancel" || decision === "reject"
              ? "reject"
              : "once";
      await this.request(
        `/api/session/${encodeURIComponent(approval.sessionId)}/permission/${encodeURIComponent(approvalId)}/reply`,
        { method: "POST", body: { decision: reply } },
      );
    }
    this.approvals.delete(approvalId);
    this.broadcast("approval.resolved", { agentId: this.id, approvalId });
    const thread = this.threads.get(approval.sessionId);
    if (thread && thread.status === "waiting") {
      thread.status = "idle";
      this.broadcast("thread.updated", thread);
    }
    return { ok: true as const };
  }

  async listSessionCommands(_providerId: string, threadId: string): Promise<AgentCommand[]> {
    const thread = this.requireThread(threadId);
    const commands = await this.request<any[]>("/api/command", {
      timeoutMs: 15_000,
      query: { "location[directory]": thread.cwd },
    }).catch(() => []);
    return (commands || [])
      .filter((item) => item?.name)
      .map((item) => ({
        name: String(item.name),
        description: String(item.description || ""),
      }));
  }

  async listSkills(
    _providerId: string,
    threadId: string,
    _forceReload?: boolean,
  ): Promise<{ skills: AgentSkill[]; errors?: unknown[] }> {
    const thread = this.requireThread(threadId);
    const skills = await this.request<any[]>("/api/skill", {
      query: { "location[directory]": thread.cwd }, timeoutMs: 15_000,
    });
    return {
      skills: (skills || [])
        .filter((item) => item?.name)
        .map((item) => ({
          name: String(item.name),
          description: String(item.description || ""),
        })),
    };
  }

  /**
   * P0 通用命令透传：`POST /api/session/:id/command {name, text?}`。
   * 与 sendTurn 共用受理锁；命令执行期间会话标 running，结果走事件回流。
   */
  async runSessionCommand(
    providerId: string,
    threadId: string,
    command: string,
    args?: string,
  ): Promise<unknown> {
    return this.serializeSend(threadId, async () => {
      const thread = this.requireThread(threadId);
      if (thread.archived) throw new Error("会话已归档，请先恢复再操作");
      const name = String(command || "").trim().replace(/^\/+/, "");
      if (!name) throw new Error("命令名称不能为空");
      thread.status = "running";
      thread.activeTurnId = undefined;
      thread.lastError = undefined;
      thread.updatedAt = Date.now();
      this.broadcast("thread.updated", thread);
      try {
        await this.request(`/api/session/${encodeURIComponent(threadId)}/command`, {
          method: "POST",
          timeoutMs: 0,
          body: { name, text: args?.trim() || "" },
        });
      } catch (error: any) {
        const current = this.threads.get(thread.id);
        if (current && !current.activeTurnId && current.status === "running") {
          current.status = "idle";
          current.lastError = String(error?.message || error || "OpenCode V2 命令执行失败");
          current.updatedAt = Date.now();
          this.broadcast("thread.updated", current);
        }
        throw error;
      }
      void providerId;
      return { ok: true as const };
    });
  }

  async compactSession(_providerId: string, threadId: string): Promise<unknown> {
    const thread = this.requireThread(threadId);
    if (thread.archived) throw new Error("会话已归档，请先恢复再操作");
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("任务结束后才能压缩 OpenCode V2 会话上下文");
    thread.compacting = true;
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    try {
      await this.request(`/api/session/${encodeURIComponent(threadId)}/compact`, {
        method: "POST",
        body: {},
      });
      const current = this.threads.get(thread.id) || thread;
      // 压缩后旧的用量不再可信：等下一轮普通回复再重建。
      delete current.tokenUsage;
    } finally {
      const current = this.threads.get(thread.id);
      if (current) {
        current.compacting = undefined;
        current.updatedAt = Date.now();
        this.broadcast("thread.updated", current);
      }
    }
    void _providerId;
    return { ok: true as const };
  }

  /**
   * 撤回：先 `POST /:id/revert/stage {messageID, files?}` 拿到变更摘要核验，
   * 再 `POST /:id/revert/commit` 落实。不带 messageID 时以最后一条 user
   * 消息为边界，与原生 TUI 撤回最近一轮一致。
   */
  async revertSession(_providerId: string, threadId: string, messageID?: string) {
    const thread = this.requireThread(threadId);
    if (thread.archived) throw new Error("会话已归档，请先恢复再操作");
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("任务运行中不能撤回，请先停止任务");
    let target = String(messageID || "").trim();
    if (!target) {
      const full: any = await this.readThread("", threadId);
      const turns = (full?.turns || []).filter((turn: any) => turn?.id);
      const last = turns[turns.length - 1];
      if (!last) throw new Error("没有可撤回的用户消息");
      target = String(last.id);
    }
    const staged = await this.request<{ messageID?: string; files?: Array<{ additions?: number; deletions?: number }> }>(
      `/api/session/${encodeURIComponent(threadId)}/revert/stage`,
      { method: "POST", body: { messageID: target } },
    );
    const files = Array.isArray(staged?.files) ? staged.files : [];
    const summary = {
      messageID: String(staged?.messageID || target),
      files: files.length,
      additions: files.reduce((sum, file) => sum + (Number(file?.additions) || 0), 0),
      deletions: files.reduce((sum, file) => sum + (Number(file?.deletions) || 0), 0),
    };
    await this.request(`/api/session/${encodeURIComponent(threadId)}/revert/commit`, {
      method: "POST",
      body: {},
    });
    this.emitAgentEvent(thread, "thread/historyUpdated", { threadId });
    void _providerId;
    return summary;
  }

  /**
   * 恢复撤回：V2 只有“清除已暂存的撤回”（DELETE /revert），已 commit 的
   * 撤回没有原生恢复接口——与 V1 的 unrevert 语义不同，调用方应据此提示。
   */
  async unrevertSession(_providerId: string, threadId: string) {
    const thread = this.requireThread(threadId);
    if (thread.archived) throw new Error("会话已归档，请先恢复再操作");
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("任务运行中不能恢复撤回，请先停止任务");
    await this.request(`/api/session/${encodeURIComponent(threadId)}/revert`, {
      method: "DELETE",
    });
    this.emitAgentEvent(thread, "thread/historyUpdated", { threadId });
    void _providerId;
    return { ok: true as const };
  }

  /**
   * 非破坏性分支：`POST /api/session/:id/fork {before?}`。
   * V2 的 before 与 V1 的 messageID 同为排除语义：只复制该消息之前的历史。
   * 公开接口的 lastTurnId 表示保留所选轮次，因此要找到下一条 user 消息
   * 作为原生边界；直接传 messageID 时保留原生排除语义，供历史重试使用。
   */
  forkThread(
    _providerId: string,
    threadId: string,
    options: { messageID?: string; lastTurnId?: string } = {},
  ) {
    const boundary = JSON.stringify([options.messageID || "", options.lastTurnId || ""]);
    const existing = this.forkOperations.get(threadId);
    if (existing)
      return existing.boundary === boundary
        ? existing.promise
        : Promise.reject(new Error("此会话正在创建分支，请等待完成后再选择其他轮次"));
    const pending = this.performFork(threadId, options).finally(() => {
      if (this.forkOperations.get(threadId)?.promise === pending)
        this.forkOperations.delete(threadId);
    });
    this.forkOperations.set(threadId, { boundary, promise: pending });
    return pending;
  }

  private async performFork(
    threadId: string,
    options: { messageID?: string; lastTurnId?: string },
  ) {
    if (this.deleteOperations.has(threadId))
      throw new Error("此会话正在删除，暂时不能创建分支");
    const source = this.requireThread(threadId);
    if (source.archived) throw new Error("会话已归档，请先恢复再分支");
    if (source.status === "running" || source.status === "waiting")
      throw new Error("会话正在运行或等待确认，无法分支");
    let before = String(options.messageID || "").trim();
    if (options.lastTurnId) {
      const selected = String(options.lastTurnId).trim();
      const userIds = await this.forkUserIds(source);
      const index = userIds.indexOf(selected);
      if (index < 0) throw new Error("找不到分支所选的消息");
      before = userIds[index + 1] || "";
    }
    let forked: V2Session;
    try {
      forked = await this.request<V2Session>(
        `/api/session/${encodeURIComponent(threadId)}/fork`,
        { method: "POST", body: before ? { before } : {} },
      );
    } catch (error: any) {
      const detail = String(error?.message || error || "OpenCode V2 分支失败");
      if (/尚未接线|找不到该接口/.test(detail)) throw error;
      throw error instanceof Error ? error : new Error(detail);
    }
    if (!forked?.id) throw new Error("OpenCode V2 分支失败：服务端未返回新会话");
    this.forkChildren.add(forked.id);
    this.sessionTitles.set(forked.id, "");
    const branchName = `${source.name || forked.title || "会话"} · 分支`;
    try {
      await this.request(`/api/session/${encodeURIComponent(forked.id)}`, {
        method: "PATCH",
        body: { title: branchName },
        // 命名是辅助动作：该构建尚未接线也不影响已创建的分支。
        timeoutMs: 1_500,
      });
      this.sessionTitles.set(forked.id, branchName);
    } catch {}
    const branch: ThreadSummary = {
      ...v2SessionSummary(forked),
      agentId: this.id,
      providerId: source.providerId,
      cwd: forked.location?.directory || source.cwd,
      model: source.model || "default",
      name: branchName,
      preview: branchName,
      status: "idle",
      activeTurnId: undefined,
      lastError: undefined,
      forkedFromId: threadId,
      updatedAt: Date.now(),
    };
    // 先落内存（并发事件/refreshAll 靠 forkChildren 认分支），再落盘；
    // 落盘失败必须回滚原生分支，否则“前端报失败、原生留孤儿”。
    this.threads.set(branch.id, branch);
    try {
      await this.options.threadSettings?.update(this.id, branch.id, {
        providerId: source.providerId,
        model: branch.model,
        forkedFromId: threadId,
      });
    } catch (error: any) {
      this.threads.delete(branch.id);
      this.forkChildren.delete(branch.id);
      this.sessionTitles.delete(branch.id);
      await this.request(`/api/session/${encodeURIComponent(branch.id)}`, {
        method: "DELETE",
      }).catch(() => undefined);
      throw new Error(
        `分支已创建但本地保存失败，已回滚清理，请重试：${String(error?.message || error)}`,
      );
    }
    this.broadcast("thread.updated", branch);
    return branch;
  }

  /**
   * 从指定 user 消息分支并用新文本重试：以目标 turn 自身作为排除边界
   * （首轮则空分支），再在新分支上 sendTurn。原分支完整保留。
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
    const branch: any = await this.forkThread(source.providerId, threadId, {
      messageID: String(turnId || "").trim() || undefined,
    });
    try {
      await this.sendTurn(source.providerId, branch.id, value, images);
    } catch (error: any) {
      const current = this.threads.get(branch.id);
      if (current) {
        current.lastError = String(error?.message || error);
        this.broadcast("thread.updated", current);
      }
      throw error;
    }
    return this.threads.get(branch.id) || branch;
  }
}

function countUserTurns(pages: V2Message[][]) {
  let count = 0;
  for (const page of pages)
    for (const message of page) if (message?.type === "user") count++;
  return count;
}

function containsTurn(pages: V2Message[][], turnId: string) {
  return pages.some((page) => page.some((message) => String(message?.id) === turnId));
}
