import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { findFreeListenPort } from "../runtime-port.js";
import type {
  ApprovalKind,
  ApprovalQuestion,
  ModelInfo,
  ThreadSummary,
  TurnImage,
} from "../types.js";
import type { ThreadSettingsStore } from "../thread-settings.js";
import type { AgentCapabilities, AgentDescriptor, AgentId } from "./types.js";

const OPENCODE_CAPABILITIES: AgentCapabilities = {
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
  initialThreads?: ThreadSummary[];
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
};

function modelSupportsImages(meta?: OpenCodeModelMeta): boolean | undefined {
  if (!meta) return undefined;
  const inputs = meta.modalities?.input;
  if (Array.isArray(inputs))
    return inputs.some((item) => /^image/i.test(String(item)));
  if (typeof meta.attachment === "boolean") return meta.attachment;
  return undefined;
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
  return {
    agentId: "opencode",
    id: session.id,
    providerId: profileId(session),
    name: session.title || "OpenCode 会话",
    preview: session.title || "OpenCode 会话",
    cwd: session.directory || "",
    model: "default",
    status,
    updatedAt: Number(
      session.time?.updated || session.time?.created || Date.now(),
    ),
    sessionId: session.id,
    controlMode: "managed",
  };
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

function normalizeMessages(session: OpenCodeSession, records: any[]) {
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
  return {
    id: session.id,
    cwd: session.directory || "",
    model: "default",
    turns,
  };
}

/**
 * Maps a native OpenCode part to the shared Codex-shaped turn item. Tool
 * parts keep their structured input/metadata and unknown part types become
 * `extension` items with the raw payload attached so per-agent frontend
 * adapters can render what OpenCode natively produced (todos, questions...).
 */
export function openCodePartToItem(part: any): any | undefined {
  if (!part?.type && !part?.tool) return undefined;
  if (part.type === "text")
    return { id: String(part.id), type: "agentMessage", text: part.text || "" };
  if (part.type === "reasoning")
    return { id: String(part.id), type: "reasoning", summary: part.text || "" };
  if (part.type === "tool") {
    const state = part.state || {};
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
  private configDefault?: { providerID: string; modelID: string };
  private approvals = new Map<string, any>();
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
    return {
      threads: this.listThreads(),
      approvals: [...this.approvals.values()],
    };
  }

  publicProfiles() {
    return this.profiles.map((profile) => ({
      id: profile.id,
      agentId: this.id,
      name: profile.name,
      enabled: true,
      online: this.online,
    }));
  }

  listModels(providerId?: string): ModelInfo[] {
    const matched = providerId
      ? this.profiles.filter((item) => item.id === providerId)
      : this.profiles;
    const scope = matched.length ? matched : this.profiles;
    const entries: ModelInfo[] = [];
    for (const profile of scope) {
      const groupName = profile.name || profile.id;
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
        if (ready) this.offline(detail);
        else rejectProcessFailure(detail);
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
      child?.kill();
      this.offline(detail);
      throw detail;
    } finally {
      this.starting = false;
      this.broadcast("agent.status", this.descriptor());
    }
  }

  async refreshAll() {
    const [sessions, providers, config] = await Promise.all([
      this.request<OpenCodeSession[]>("/session"),
      this.request<unknown>("/provider").catch(() => []),
      this.request<unknown>("/config").catch(() => undefined),
    ]);
    this.profiles = normalizeProfiles(providers);
    this.configDefault = configDefaultModel(config);
    const seen = new Set<string>();
    for (const session of sessions) {
      seen.add(session.id);
      const existing = this.threads.get(session.id);
      this.threads.set(session.id, {
        ...sessionSummary(
          session,
          existing?.status === "running" || existing?.status === "waiting"
            ? existing.status
            : "idle",
        ),
        ...existing,
        ...this.options.threadSettings?.get(this.id, session.id),
        agentId: this.id,
      });
    }
    for (const [id, thread] of this.threads)
      if (
        !seen.has(id) &&
        thread.status !== "running" &&
        thread.status !== "waiting"
      )
        this.threads.delete(id);
    this.broadcast("agent.status", this.descriptor());
    this.broadcast("snapshot", this.snapshot());
  }

  busyThreads() {
    return this.listThreads().filter(
      (thread) => thread.status === "running" || thread.status === "waiting",
    );
  }

  restart() {
    this.eventAbort?.abort();
    this.eventAbort = undefined;
    const child = this.process;
    this.process = undefined;
    child?.kill();
    this.online = false;
    for (const thread of this.busyThreads()) {
      thread.status = "offline";
      thread.activeTurnId = undefined;
    }
  }

  listThreads() {
    return [...this.threads.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createThread(
    providerId: string,
    input: { cwd: string; name?: string; model?: string },
  ) {
    const session = await this.request<OpenCodeSession>("/session", {
      method: "POST",
      directory: input.cwd,
      body: { title: input.name },
    });
    const thread = {
      ...sessionSummary(session),
      providerId: providerId || profileId(session),
      cwd: input.cwd,
      model: input.model || "default",
      name: input.name || session.title || "新 OpenCode 会话",
    };
    this.threads.set(thread.id, thread);
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async readThread(_providerId: string, threadId: string) {
    const thread = this.requireThread(threadId);
    const records = await this.request<any[]>(
      `/session/${encodeURIComponent(threadId)}/message`,
      { directory: thread.cwd },
    );
    return {
      ...normalizeMessages({ id: thread.id, directory: thread.cwd }, records),
      agentId: this.id,
      providerId: thread.providerId,
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
    thread.name = next;
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    return thread;
  }

  async updateThreadSettings(
    _providerId: string,
    threadId: string,
    settings: { model?: string },
  ) {
    const thread = this.requireThread(threadId);
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("任务结束后才能修改 OpenCode 会话设置");
    if (settings.model) thread.model = settings.model;
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
    this.broadcast("thread.updated", thread);
    this.emitAgentEvent(thread, "turn/started", {
      threadId,
      turn: { id: turnId, status: "inProgress" },
    });
    const model = parsed;
    await this.request(`/session/${encodeURIComponent(threadId)}/message`, {
      method: "POST",
      directory: thread.cwd,
      body: {
        parts: [
          ...(text ? [textPart(text)] : []),
          ...(images || []).map(imagePart),
        ],
        ...(model ? { model } : {}),
      },
    });
    return { turn: { id: turnId, status: "inProgress" } };
  }

  async interrupt(_providerId: string, threadId: string, _turnId: string) {
    const thread = this.requireThread(threadId);
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
      const summary = sessionSummary(body.info);
      this.threads.set(summary.id, {
        ...this.threads.get(summary.id),
        ...summary,
      });
      this.broadcast("thread.updated", this.threads.get(summary.id));
      return;
    }
    if (payload?.type === "session.deleted" && sessionId) {
      this.threads.delete(sessionId);
      this.broadcast("thread.deleted", {
        agentId: this.id,
        threadId: sessionId,
      });
      return;
    }
    if (payload?.type === "session.status" && thread) {
      thread.status = body.status?.type === "busy" ? "running" : "idle";
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
    if (payload?.type === "message.part.updated" && thread) {
      const part = body.part;
      if (part?.type === "text" && body.delta)
        this.emitAgentEvent(thread, "item/agentMessage/delta", {
          threadId: thread.id,
          turnId: thread.activeTurnId,
          itemId: part.messageID || part.id,
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
    this.broadcast("agent.status", this.descriptor());
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
