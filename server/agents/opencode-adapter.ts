import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { allowOpenCodeExternalDirectories, openCodeGlobalDir } from "../opencode-config.js";
import { assertMessageInput, messageBusy, type AgentMessageInput, type AgentMessageAcceptance } from "./messages.js";
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
  // prompt_async 的 204 只确认受理，不保证它追加到当前回合还是后续执行。
  messages: { busyBehavior: "unknown", interruptScope: "session" },
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
  /** 覆盖全局 opencode 配置目录（reload 的新鲜度检查用）；默认走
   * `openCodeGlobalDir()` 的 OPENCODE_CONFIG_DIR > XDG > ~/.config 解析。 */
  openCodeConfigDir?: string;
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

/**
 * `provider/model` 唯一解析器（写入与读取全链路共用）。
 * 严格语义：整体 trim 后按首个 `/` 切分，两段再各自 trim，都不能为空，
 * modelID 不得多带 `/`。`"a/"`、`" openai / "`、`"a/b/c"` 一律返回
 * undefined——调用方写入时大声拒绝、读取时按未知模型走默认，绝不带着
 * 空格/空段发给 serve 让它静默回退。
 */
function parseModelSetting(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  const separator = text.indexOf("/");
  if (separator <= 0) return undefined;
  const providerID = text.slice(0, separator).trim();
  const modelID = text.slice(separator + 1).trim();
  if (!providerID || !modelID || modelID.includes("/")) return undefined;
  return { providerID, modelID };
}

function configDefaultModel(config: unknown) {
  const configured = (config as any)?.model;
  if (typeof configured === "string") {
    const parsed = parseModelSetting(configured);
    if (parsed) return parsed;
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
const PROJECT_CATALOG_TTL_MS = 10 * 60_000;
/**
 * opencode serve（Bun 进程）长时间运行内存只增不减（数百 MB 级）。
 * 空闲超过该时长、且没有忙碌会话/待审批时，把 serve 杀掉重建一次；
 * 会话列表从 /session 重新拉回，Deck 内数据不受影响。设 0 关闭。
 */
const OPENCODE_IDLE_RESTART_DEFAULT_MS = 30 * 60_000;
const OPENCODE_IDLE_RESTART_CHECK_MS = 60_000;

function configuredIdleRestartMs() {
  const raw = process.env.OPENCODE_IDLE_RESTART_MS?.trim();
  if (raw === undefined || raw === "") return OPENCODE_IDLE_RESTART_DEFAULT_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0
    ? value
    : OPENCODE_IDLE_RESTART_DEFAULT_MS;
}

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

/**
 * 用户手动停止（/session/:id/abort）时 OpenCode 经 session.error 上报
 * MessageAbortedError（部分版本叫 AbortedError），文案只有 "Aborted"。
 * 这是预期内的中断而非任务失败，不应走错误态/横幅。
 */
function isAbortError(error: any) {
  if (/abort/i.test(String(error?.name || ""))) return true;
  const message = String(
    error?.data?.message || error?.message || error || "",
  ).trim();
  return (
    /^aborted$/i.test(message) ||
    /^the [\w ]+ was aborted$/i.test(message) ||
    /MessageAbortedError|AbortedError/.test(message)
  );
}

function sessionSummary(
  session: OpenCodeSession,
  status: ThreadSummary["status"] = "idle",
): ThreadSummary {
  const name = session.title || session.slug || "OpenCode 会话";
  const variant = session.model?.variant;
  // 原生会话自带的模型（Deck 外建的、或旧落盘丢失时）：有就用，不再一律
  // 写死 "default"。Deck 显式设置（existing/settings 后 spread）优先。
  const nativeModel =
    session.model?.providerID && session.model?.id
      ? `${session.model.providerID}/${session.model.id}`
      : undefined;
  return {
    agentId: "opencode",
    id: session.id,
    providerId: profileId(session),
    name,
    preview: name,
    cwd: session.directory || "",
    model: nativeModel || "default",
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
  let assistants: any[] = [];
  for (const record of records || []) {
    const message = record?.info || record?.message || record;
    const parts = Array.isArray(record?.parts) ? record.parts : [];
    if (message?.role === "user") {
      if (turn) finalizeTurnStats(turn, assistants, false);
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
                // synthetic part 是系统注入内容（提醒/续接提示等），不是
                // 用户敲的字，不进用户气泡。
                content: parts
                  .filter(
                    (part: any) =>
                      !part.synthetic &&
                      (part.type === "text" || part.type === "file"),
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
      assistants = [];
      continue;
    }
    if (message?.role !== "assistant" || !turn) continue;
    // 回合统计的 token/时间来源：逐条累加本轮 assistant 回复。
    assistants.push(message);
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
    // 同类型 part 计数一次算好：逐 part filter 是 O(P²)，大包下提到循环外。
    // text 排除 synthetic，其它类型按 type 直接计数，与原 filter 等价。
    let textCount = 0;
    const typeCounts = new Map<string, number>();
    for (const candidate of parts) {
      const candidateType = candidate?.type;
      if (typeof candidateType !== "string") continue;
      if (candidateType === "text") {
        if (!candidate.synthetic) textCount += 1;
      } else typeCounts.set(candidateType, (typeCounts.get(candidateType) || 0) + 1);
    }
    for (const part of parts) {
      const mapped = openCodePartToItem(part);
      if (!mapped) continue;
      if (mapped.type === "agentMessage" || mapped.type === "reasoning") {
        const sameCount =
          part.type === "text" ? textCount : typeCounts.get(part.type) || 0;
        const stats = partStatsFromMessage(message, part, sameCount);
        if (stats) mapped.stats = stats;
      }
      turn.items.push(mapped);
    }
  }
  if (activeTurnId && turns.length > 0) {
    const activeTurn = turns[turns.length - 1];
    activeTurn.id = activeTurnId;
    activeTurn.status = "inProgress";
  }
  if (turn)
    finalizeTurnStats(turn, assistants, Boolean(activeTurnId && turns.length > 0));
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

/**
 * 当条 assistant 回复的生成 token（output + reasoning）：回合 stats 与
 * 直播 turn/progress 共用同一口径。summary/压缩类消息由调用方过滤。
 */
export function generatedTokens(info: any) {
  const tokens = info?.tokens || {};
  return tokenNumber(tokens.output) + tokenNumber(tokens.reasoning);
}

/**
 * OpenCode 原生计时：tool 取 `state.time.{start,end}`（completed/error 态），
 * text/reasoning 取 part 级 `time.{start,end?}`。缺失时返回空对象，
 * 调用方直接展开即可（无计时就不展示，不断言）。
 */
function partTiming(source: any): {
  startedAt?: number;
  endedAt?: number;
} {
  const time = source?.state?.time ?? source?.time;
  const startedAt = Number(time?.start);
  const endedAt = Number(time?.end);
  const timing: { startedAt?: number; endedAt?: number } = {};
  if (Number.isFinite(startedAt) && startedAt > 0) timing.startedAt = startedAt;
  if (Number.isFinite(endedAt) && endedAt > 0) timing.endedAt = endedAt;
  return timing;
}

/** 生成类 part（text/reasoning）的产出 token 口径：reasoning 取 tokens.reasoning，
 * text 取 tokens.output——OpenCode 的 token 是 message 级，按 part 类型认领。 */
export function generatedTokenOfPart(
  info: any,
  part: any,
): number | undefined {
  const tokens = info?.tokens || {};
  const value = part?.type === "reasoning"
    ? tokenNumber(tokens.reasoning)
    : part?.type === "text" && !part.synthetic
      ? tokenNumber(tokens.output)
      : 0;
  return value > 0 ? value : undefined;
}

/**
 * per-part TPS：reasoning/text part 自带毫秒级时间窗，OpenCode 的 token
 * 虽是 message 级，但窗口与 token 一一对应（一个模型调用一条 message），
 * 认领后即为真值。同名同类 part 超过一个时归属有歧义，直接不算。
 * live 转发路径整条 message 的 parts 不在手边，跳过多 part 歧义检查，
 * 由调用方保证（OpenCode 实测每条 message 至多各一个）。
 */
export function partStatsFromMessage(
  info: any,
  part: any,
  sameCount = 1,
): { durationMs: number; outputTokens: number; tps: number } | undefined {
  if (part?.type !== "reasoning" && part?.type !== "text") return undefined;
  if (sameCount > 1) return undefined;
  const start = Number(part?.time?.start);
  const end = Number(part?.time?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return undefined;
  const outputTokens = generatedTokenOfPart(info, part);
  if (!outputTokens) return undefined;
  const durationMs = end - start;
  return {
    durationMs,
    outputTokens,
    tps: Math.round((outputTokens / (durationMs / 1000)) * 10) / 10,
  };
}

/**
 * 回合统计（TPS/用时）：startedAt 取 user 消息 time.created；endedAt 取
 * 末条有效 assistant 回复的 time.completed（无则回落 time.updated）；
 * outputTokens 为回合内各 assistant 消息生成 token 之和（跳过 summary）。
 * 进行中回合只给 startedAt + outputTokens，不编造 endedAt。
 */
function finalizeTurnStats(turn: any, assistants: any[], active: boolean) {
  if (!turn || !Array.isArray(assistants) || assistants.length === 0) return;
  const usable = assistants.filter(
    (info) => info && info.summary !== true,
  );
  const outputTokens = usable.reduce(
    (sum, info) => sum + generatedTokens(info),
    0,
  );
  if (outputTokens <= 0) return;
  const startedAt = Number(turn.startedAt) || 0;
  const stats: {
    startedAt?: number;
    endedAt?: number;
    durationMs?: number;
    outputTokens: number;
    tps?: number;
  } = { outputTokens };
  if (startedAt > 0) stats.startedAt = startedAt;
  if (!active) {
    const last = usable[usable.length - 1];
    const completed = Number(last?.time?.completed ?? last?.time?.updated);
    if (Number.isFinite(completed) && completed > 0) {
      stats.endedAt = completed;
      const durationMs = completed - startedAt;
      if (startedAt > 0 && durationMs > 0) {
        stats.durationMs = durationMs;
        stats.tps = Math.round((outputTokens / (durationMs / 1000)) * 10) / 10;
      }
    }
  }
  turn.stats = stats;
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
    return {
      id: String(part.id),
      type: "agentMessage",
      text: part.text || "",
      ...partTiming(part),
    };
  if (part.type === "reasoning")
    return {
      id: String(part.id),
      type: "reasoning",
      summary: part.text || "",
      ...partTiming(part),
    };
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
        ...partTiming(part),
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
      ...partTiming(part),
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
  private messageReads = new Map<string, Promise<{ records: any[]; next?: string }>>();
  private forkOperations = new Map<string, { boundary: string; promise: Promise<ThreadSummary> }>();
  private deleteOperations = new Map<string, Promise<{ ok: boolean }>>();
  // Only compact message boundaries are retained; tool output never lives here.
  private historyBoundaries = new Map<string, {
    cwd: string; updated: number; revert: string; at: number; userIds: string[];
  }>();
  private profiles: OpenCodeProfile[] = [];
  private connected = new Set<string>();
  /** `/provider` 最近一次成功返回后为 true；失败不清旧数据，但不再冒充新鲜。 */
  private catalogLoaded = false;
  private configDefault?: { providerID: string; modelID: string };
  private projectCatalogs = new Map<string, OpenCodeCatalog>();
  private projectCatalogsAt = new Map<string, number>();
  private projectCatalogsLoading = new Map<string, Promise<OpenCodeCatalog>>();
  private approvals = new Map<string, any>();
  /** Role of the last seen OpenCode message, used to skip replayed user parts. */
  private messageRoles = new Map<string, string>();
  private partTypes = new Map<string, string>();
  // Native fork preserves old message timestamps while assigning a new session.
  private sessionCreatedAt = new Map<string, number>();
  private copiedMessages = new Map<string, string>();
  private copiedHistoryTimers = new Map<string, NodeJS.Timeout>();
  /** messageId → 最近一次 message.updated 的 tokens（per-part stats 认领用）。 */
  private messageUsageFields = new Map<
    string,
    { output: number; reasoning: number }
  >();
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
  private processStartedAt = 0;
  private lastServeActivityAt = Date.now();
  private idleRestartTimer?: NodeJS.Timeout;
  private recoveryTimer?: NodeJS.Timeout;
  private recoveryAttempts = 0;
  private recoveryEpoch = 0;
  private eventAbort?: AbortController;
  private fetcher: Fetcher;
  private processStderr = "";
  /** sessionId → 待落盘的 idle 定时器：防抖窗口内仍算运行中。 */
  private idleTimers = new Map<string, NodeJS.Timeout>();

  /**
   * 进行中回合的生成 token 累计（turn/progress 直播用）。message.updated
   * 自带完整 info（含 tokens），按 messageId 累加当轮 output+reasoning，
   * 1Hz 节流推送；结束/新回合开始时清理或覆盖，同时只跟踪一个回合。
   */
  private runningTurns = new Map<
    string,
    {
      turnId: string;
      startedAt: number;
      /** 该会话最近一次事件时间：看门狗只查“静默”的 running 线程。 */
      lastEventAt: number;
      outputs: Map<string, number>;
      lastEmitAt: number;
    }
  >();
  /** running 看门狗单发定时器：无 running 线程时不常驻。 */
  private watchdogTimer?: NodeJS.Timeout;
  /** directory → 已排期的配置生效（dispose 实例）任务，避免重复排期。 */
  private pendingConfigRefreshes = new Set<string>();
  /** threadId → 在途的发送受理：只串行化受理（prompt 受理即释放），不等待整轮结束。 */
  private sendLocks = new Map<string, Promise<unknown>>();

  /**
   * 同一会话的 sendTurn/runSessionCommand 串行受理：后到的调用等前一次
   * 受理完成再进，配合忙时拒绝，避免两轮互相覆盖 activeTurnId、事件串话。
   * 锁只保受理瞬间（prompt_async/command 发出即释放），不阻塞整轮。
   */
  private serializeSend<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.sendLocks.get(threadId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(task);
    this.sendLocks.set(threadId, pending);
    try {
      return pending as Promise<T>;
    } finally {
      void (pending as Promise<unknown>)
        .catch(() => undefined)
        .then(() => {
          if (this.sendLocks.get(threadId) === pending)
            this.sendLocks.delete(threadId);
        });
    }
  }

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

  /** 已有 serve 直到 adapter.restart() 才会退出。 */
  selectExecutable(bin: string) {
    this.options.bin = bin || undefined;
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
      this.beginRunningTurn(thread, thread.activeTurnId);
      this.emitAgentEvent(thread, "turn/started", {
        threadId: thread.id,
        turn: { id: thread.activeTurnId, status: "inProgress" },
      });
    }
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
  }

  /**
   * 开始跟踪一个回合的生成 token（turn/progress 直播）。新回合覆盖旧记录，
   * 同时只保留一个；调用方在设置 activeTurnId 后调用。
   */
  private beginRunningTurn(thread: ThreadSummary, turnId: string) {
    const now = Date.now();
    this.runningTurns.set(thread.id, {
      turnId: String(turnId),
      startedAt: now,
      lastEventAt: now,
      outputs: new Map(),
      lastEmitAt: 0,
    });
    this.armWatchdog();
  }

  /** 回合结束（完成/失败/中断/离线）即停止跟踪，避免累计串到下一轮。 */
  private endRunningTurn(threadId: string) {
    this.runningTurns.delete(String(threadId || ""));
  }

  /**
   * running 看门狗：SSE 静默停流（进程活着、事件没了）时，没有任何事件能把
   * running 翻回 idle，前端永久转圈。看门狗只查“长时间无事件”的 running
   * 线程，用 GET /session/status 对账：serve 明确 idle 或根本不认该会话才
   * 本地归位；serve 还在跑或查不到状态时只续命，不碰状态。
   */
  private armWatchdog() {
    if (this.watchdogTimer) return;
    let hasRunning = false;
    for (const [threadId] of this.runningTurns) {
      if (this.threads.get(threadId)?.status === "running") {
        hasRunning = true;
        break;
      }
    }
    if (!hasRunning) return;
    this.watchdogTimer = setTimeout(
      () => void this.watchRunningTurns(),
      30_000,
    );
    this.watchdogTimer.unref?.();
  }

  private async watchRunningTurns() {
    this.watchdogTimer = undefined;
    const now = Date.now();
    for (const [threadId, tracked] of this.runningTurns) {
      const thread = this.threads.get(threadId);
      // waiting 由审批事件驱动、error 已终态，看门狗只管 running。
      if (!thread || thread.status !== "running") continue;
      if (now - tracked.lastEventAt < 60_000) continue;
      try {
        const statuses = await this.request<Record<string, { type?: string }>>(
          "/session/status",
          { directory: thread.cwd, retry: false, timeoutMs: 10_000 },
        );
        const current = this.threads.get(threadId);
        if (!current || current.status !== "running") continue;
        const state = statuses?.[threadId]?.type;
        if (!state || state === "idle") {
          this.applyIdle(current);
        } else {
          const still = this.runningTurns.get(threadId);
          if (still) still.lastEventAt = Date.now();
        }
      } catch {
        // 对账失败（serve 抖动）：续命等下一轮，绝不凭猜测改状态。
        const still = this.runningTurns.get(threadId);
        if (still) still.lastEventAt = Date.now();
      }
    }
    this.armWatchdog();
  }

  /**
   * message.updated 的 assistant info 自带当条 tokens：按 messageId 累加
   * 本轮生成 token，1Hz 节流推 turn/progress 供底部状态块显示实时 TPS。
   * 只收当前活跃回合的样本；turnId 对不上说明走了未接线的起点，
   * 直接按新回合重建，避免把旧累计串进去。
   */
  private noteTurnTokens(thread: ThreadSummary, info: any) {
    const turnId = String(thread.activeTurnId || "");
    if (!turnId) return;
    let running = this.runningTurns.get(thread.id);
    if (!running || running.turnId !== turnId) {
      this.beginRunningTurn(thread, turnId);
      running = this.runningTurns.get(thread.id);
      if (!running) return;
    }
    running.outputs.set(String(info?.id || ""), generatedTokens(info));
    const now = Date.now();
    if (now - running.lastEmitAt < 1_000) return;
    running.lastEmitAt = now;
    let outputTokens = 0;
    for (const value of running.outputs.values()) outputTokens += value;
    this.emitAgentEvent(thread, "turn/progress", {
      threadId: thread.id,
      turnId: running.turnId,
      outputTokens,
      elapsedMs: Math.max(0, now - running.startedAt),
    });
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
    // 直播累计到此为止；异常路径（abort/error）的残留由下一轮
    // beginRunningTurn 覆盖，noteTurnTokens 以 activeTurnId 为准不会误收。
    this.endRunningTurn(thread.id);
    // 会话已空闲即压缩结束（summarize 自身也走 busy→idle）；遗留的
    // compacting 在此自愈，避免 UI 永久显示“正在压缩上下文”。
    thread.compacting = undefined;
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    this.emitAgentEvent(thread, "turn/completed", {
      threadId: thread.id,
      turn: { id: completedTurnId, status: "completed" },
    });
  }

  /**
   * `opencode serve` 按目录把配置缓存在实例里：项目 `opencode.json(c)` 写完
   * 后，只有该目录的实例被 dispose，新会话才会读到新规则。dispose 会丢掉实例
   * 里的在途回合，所以不能在手头这个回合还在跑的时候做——轮询到该项目所有
   * 会话都空闲再 dispose。全程 best-effort：失败或被后续 reload/重启抢先，
   * 规则也已经在文件里，不会丢。
   */
  private scheduleProjectConfigRefresh(directory: string) {
    const key = `config-refresh:${directory}`;
    if (this.pendingConfigRefreshes.has(key)) return;
    this.pendingConfigRefreshes.add(key);
    const attempt = async (left: number) => {
      if (!this.online) {
        this.pendingConfigRefreshes.delete(key);
        return;
      }
      const statuses = await this.request<Record<string, { type?: string }>>(
        "/session/status",
        { directory, retry: false },
      ).catch(() => undefined);
      const busy = statuses
        ? Object.values(statuses).some((entry) => entry?.type && entry.type !== "idle")
        : false;
      if (!busy) {
        this.pendingConfigRefreshes.delete(key);
        await this.request("/instance/dispose", {
          method: "POST",
          directory,
          retry: false,
        }).catch(() => undefined);
        return;
      }
      if (left <= 0) {
        this.pendingConfigRefreshes.delete(key);
        return;
      }
      const timer = setTimeout(() => void attempt(left - 1), 2_000);
      // 定时器不应拖住进程退出。
      (timer as unknown as { unref?: () => void }).unref?.();
    };
    void attempt(150);
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
    if (directory) {
      const at = this.projectCatalogsAt.get(directory) ?? 0;
      return this.loadProjectCatalog(
        directory,
        Date.now() - at > PROJECT_CATALOG_TTL_MS,
      ).then((catalog) =>
        this.modelList(
          providerId,
          catalog.profiles,
          catalog.connected,
          catalog.defaultModel,
        ),
      );
    }
    return this.modelList(providerId, this.profiles, this.connected, this.configDefault);
  }

  private loadProjectCatalog(directory: string, refresh = false) {
    const cached = this.projectCatalogs.get(directory);
    if (cached && !refresh) return Promise.resolve(cached);
    const pending = this.projectCatalogsLoading.get(directory);
    if (pending) return pending;
    const loading = this.fetchProjectCatalog(directory, cached).finally(() => {
      if (this.projectCatalogsLoading.get(directory) === loading)
        this.projectCatalogsLoading.delete(directory);
    });
    this.projectCatalogsLoading.set(directory, loading);
    return loading;
  }

  /** 强制刷新目录。上游不可用时退回旧缓存，避免模型卡直接空白。 */
  private async fetchProjectCatalog(
    directory: string,
    fallback?: OpenCodeCatalog,
  ): Promise<OpenCodeCatalog> {
    try {
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
      this.projectCatalogsAt.set(directory, Date.now());
      return catalog;
    } catch (error) {
      if (fallback) return fallback;
      throw error;
    }
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
    // 显式 provider 未命中（目录 catalog 新旧交替、刚改配置时常见）：
    // 只保留 default 占位，不回退到全量目录——否则前端按“X 的模型”渲染，
    // 用户却选走了别的供应商的模型，设置与筛选器分叉。
    const scope = providerId ? matched : ranked;
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
   * 缓存里的 connected：全局看 refreshAll 的成果，项目看目录级缓存
   * （TTL 内）。不发任何 HTTP，设置页列表用它秒回；没加载过、离线或
   * 缓存过期返回 undefined，前端再调下面的新鲜探测补齐。
   */
  cachedConnectedProviders(directory?: string): Set<string> | undefined {
    if (!this.online) return undefined;
    if (directory) {
      const catalog = this.projectCatalogs.get(directory);
      if (!catalog) return undefined;
      const at = this.projectCatalogsAt.get(directory) ?? 0;
      if (Date.now() - at > PROJECT_CATALOG_TTL_MS) return undefined;
      return catalog.connected;
    }
    return this.catalogLoaded ? this.connected : undefined;
  }

  /**
   * 向运行中的 serve 询问哪些供应商当前可用（`/provider` 的 connected）。
   * 凭据来自 auth.json、环境变量或配置，由 OpenCode 自己判断，Deck 不读取
   * 这些文件。离线或探测失败返回 undefined，表示未知而不是“无 Key”。
   */
  async probeConnectedProviders(
    directory?: string,
  ): Promise<Set<string> | undefined> {
    if (!this.online) return undefined;
    try {
      const providers = await this.request<unknown>("/provider", {
        directory,
        retry: false,
        timeoutMs: 5_000,
      });
      return connectedProviderIds(providers);
    } catch {
      return undefined;
    }
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
   * `PATCH /config`：把配置写进运行中的 server。注意它的副作用：serve 会
   * dispose 该目录的实例再按新配置重建，实例里的在途回合和挂起的权限都会
   * 丢，且它落盘的是 `<项目>/config.json`（不在 serve 的配置读取列表里，
   * 重启后不生效）。只适合没有在途回合时调用。
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
    if (directory) {
      this.projectCatalogs.delete(directory);
      this.projectCatalogsAt.delete(directory);
    } else {
      this.projectCatalogs.clear();
      this.projectCatalogsAt.clear();
    }
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
        // serve 直接继承 Deck 的环境：按 HOME/XDG_* 或 OPENCODE_CONFIG_DIR
        // 定位配置与 auth.json，与 Deck 的配置编辑读同一套目录。
        env: process.env,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: commandIsBatch || undefined,
      });
      this.process = child;
      this.processStartedAt = Date.now();
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
          this.scheduleRecovery();
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
      if (this.process !== child || !this.online)
        throw new Error("OpenCode server 在载入会话期间已退出");
      void this.consumeEvents();
      this.armIdleRestart();
      this.recoveryAttempts = 0;
      if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
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
    // A fresh serve cannot continue the old process's active turn. Release the
    // delivery queue only after the native session has been loaded successfully.
    if (this.online && existing?.status === "offline") {
      merged.status = "idle";
      merged.activeTurnId = undefined;
      merged.compacting = undefined;
    }
    // 旧版本会把“仅有上下文上限、没有 token 记录”的用量也存进缓存，
    // 刷新时清掉这种 used=0 残留，避免侧栏一直显示 0/xxx。
    if (!merged.tokenUsage?.used) delete merged.tokenUsage;
    return merged;
  }

  /**
   * fork 证据：服务端 `fork` 字段、Deck 发起的 fork 记录、已可见分支、
   * 或落盘的分支关系。四者任一成立即按分支保留，不按 subagent 隐藏。
   * 落盘证据专治重启后内存清零：旧版 serve 的原生会话没有 `fork` 字段。
   */
  private isForkChild(session: OpenCodeSession) {
    if (!session.parentID) return false;
    if (session.fork != null) return true;
    if (this.forkChildren.has(session.id)) return true;
    const known = this.threads.get(session.id);
    if (known?.forkedFromId) return true;
    if (this.options.threadSettings?.get(this.id, session.id)?.forkedFromId) {
      this.forkChildren.add(session.id);
      return true;
    }
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
    this.projectCatalogsAt.clear();
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
      this.request<unknown>("/provider").catch(() => undefined),
      this.request<unknown>("/config").catch(() => undefined),
    ]);
    if (providers !== undefined) {
      this.profiles = normalizeProfiles(providers);
      this.connected = connectedProviderIds(providers);
      this.catalogLoaded = true;
    } else {
      // /provider 拉取失败（网络抖动、serve 忙）时保留旧目录：把模型卡
      // 清成空白反而制造"供应商坏了"的错觉，缓一小段旧数据无害。
    }
    if (config !== undefined) this.configDefault = configDefaultModel(config);
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
    // 目录级模型目录是低频变化的数据：refreshAll 清缓存后立即后台预热，
    // 不等下一次打开模型选择卡时再花两轮 HTTP 现拉。
    for (const directory of directories) {
      if (!directory) continue;
      void this.loadProjectCatalog(directory, true).catch(() => undefined);
    }
  }

  busyThreads() {
    return this.listThreads().filter(
      (thread) => thread.status === "running" || thread.status === "waiting",
    );
  }

  runtimePids() {
    const pid = this.process?.pid;
    return typeof pid === "number" ? [pid] : [];
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

  /**
   * 轻量重载：opencode serve 把每个目录的实例（配置 + 供应商目录）缓存在
   * 内存里，外部编辑 opencode.json 或 `opencode auth login` 新增供应商后，
   * 必须先 dispose 对应实例，下次访问才会按当前文件重建。走
   * `POST /instance/dispose` 而不是 PATCH /config：后者会把合并结果回写
   * 进用户配置文件。旧版本缺这个端点时退化为整体重启。
   *
   * 例外：全局配置文件（`~/.config/opencode/opencode.json*` 或
   * `OPENCODE_CONFIG_DIR` 指向的目录）在 serve 里按进程生命周期缓存，
   * dispose 不会重读——文件比进程新时只能整体重启。
   *
   * 重载结束后校验效果：运行中的 serve 若供应商目录仍是空的（典型如启动时
   * 拉 models.dev 超时，进程级 provider 注册表把 opencode-go 这类只存在于
   * 目录里的供应商弄丢），dispose 救不回来，自动升级为进程重启并返回
   * "process"；常规目录重载返回 "instances"。
   */
  async reload(): Promise<"instances" | "process"> {
    if (!this.online) {
      this.restart();
      await this.startAll();
      return "process";
    }
    if (this.processStartedAt) {
      const dir = this.options.openCodeConfigDir || openCodeGlobalDir();
      for (const basename of ["opencode.json", "opencode.jsonc"]) {
        try {
          const file = path.join(dir, basename);
          if ((await stat(file)).mtimeMs > this.processStartedAt) {
            this.restart();
            await this.startAll();
            return "process";
          }
        } catch {}
      }
    }
    const directories = new Set<string>();
    for (const directory of this.options.initialDirectories || [])
      directories.add(directory);
    for (const thread of this.threads.values())
      if (thread.cwd) directories.add(thread.cwd);
    for (const directory of this.projectCatalogs.keys())
      directories.add(directory);
    const dispose = async (directory?: string) => {
      try {
        await this.request("/instance/dispose", {
          method: "POST",
          directory,
        });
        return true;
      } catch {
        return false;
      }
    };
    const results = await Promise.all([
      dispose(),
      ...[...directories].map((directory) => dispose(directory)),
    ]);
    if (!results.some(Boolean)) {
      this.restart();
      await this.startAll();
      return "process";
    }
    await this.refreshAll();
    // 重载自检：serve 在线但没有任何已连接供应商，说明进程级目录坏了
    //（启动时 models.dev 拉取失败之类），dispose 重不来，只能重启。
    if (this.online && this.profiles.length === 0) {
      this.restart();
      await this.startAll();
      return "process";
    }
    return "instances";
  }

  private scheduleRecovery() {
    if (this.recoveryTimer || this.recoveryAttempts >= 3) return;
    const epoch = this.recoveryEpoch;
    const delay = 1_000 * 2 ** this.recoveryAttempts++;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      void this.startAll().catch(() => {
        if (epoch === this.recoveryEpoch) this.scheduleRecovery();
      });
    }, delay);
    this.recoveryTimer.unref?.();
  }

  restart() {
    this.recoveryEpoch++;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.recoveryAttempts = 0;
    this.runningTurns.clear();
    this.messageReads.clear();
    this.historyBoundaries.clear();
    this.clearCopiedHistory();
    if (this.idleRestartTimer) clearInterval(this.idleRestartTimer);
    this.idleRestartTimer = undefined;
    this.eventAbort?.abort();
    this.eventAbort = undefined;
    const child = this.process;
    this.process = undefined;
    this.killChild(child);
    this.online = false;
    this.lastServeActivityAt = Date.now();
    this.clearAllIdleTimers();
    for (const thread of this.busyThreads()) {
      thread.status = "offline";
      thread.activeTurnId = undefined;
    }
  }

  /** serve 一上线就挂空闲回收检查；restart 会同时把它摘掉。 */
  private armIdleRestart() {
    this.lastServeActivityAt = Date.now();
    if (this.idleRestartTimer) clearInterval(this.idleRestartTimer);
    const timer = setInterval(
      () => this.maybeIdleRestart(),
      OPENCODE_IDLE_RESTART_CHECK_MS,
    );
    // 空闲时不该由这个检查器撑住事件循环。
    timer.unref?.();
    this.idleRestartTimer = timer;
  }

  private maybeIdleRestart() {
    const idleMs = configuredIdleRestartMs();
    if (idleMs <= 0) return;
    if (!this.online || this.starting || this.startingTask) return;
    if (this.busyThreads().length > 0 || this.approvals.size > 0) return;
    if (Date.now() - this.lastServeActivityAt < idleMs) return;
    // 回收即按 restart → startAll 快速换一个干净 serve；
    // startOnce 成功后重新武装本检查。
    this.restart();
    this.broadcast("agent.status", this.descriptor());
    void this.startAll().catch(() => undefined);
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
    // 模型先校验：脏值直接拒绝，不创建原生会话、不落盘。
    const model = input.model?.trim()
      ? this.requireModelSetting(input.model)
      : "default";
    const effort = input.reasoningEffort?.trim() || undefined;
    const session = await this.request<OpenCodeSession>("/session", {
      method: "POST",
      directory: input.cwd,
      body: { title: input.name },
    });
    const displayName = input.name || session.title || "新 OpenCode 会话";
    this.sessionTitles.set(session.id, String(input.name || session.title || "").trim());
    const thread = {
      ...sessionSummary(session),
      providerId: providerId || profileId(session),
      cwd: input.cwd,
      model,
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
  /** 从项目目录（或全局 profile 表）里查 `providerId/modelId` 的展示名。 */
  private modelLabelFor(thread: ThreadSummary, model: string): string | undefined {
    const parsed = this.modelInput(model);
    if (!parsed) return undefined;
    const profiles = this.projectCatalogs.get(thread.cwd)?.profiles || this.profiles;
    const meta = profiles.find((item) => item.id === parsed.providerID)?.models?.[
      parsed.modelID
    ];
    return meta && (meta.name || meta.displayName)
      ? (meta.name || meta.displayName)!
      : undefined;
  }

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
    if (resolved) {
      const label = this.modelLabelFor(thread, resolved);
      if (label) next.modelLabel = label;
      else if (resolved !== thread.resolvedModel) delete next.modelLabel;
    }
    if (tokenUsage) next.tokenUsage = tokenUsage;
    else delete next.tokenUsage;
    this.threads.set(next.id, next);
    this.broadcast("thread.updated", next);
    return next;
  }

  /**
   * 模型支持的推理强度档位：目录 catalog / 全局 profiles 里查到模型才返回
   * 档位表（无 variants 元数据返回空数组）；模型未知或 catalog 未加载返回
   * undefined，调用方保持宽容（不带 variant），等 catalog 就绪后再校验。
   */
  private supportedEfforts(thread: ThreadSummary, model: string): string[] | undefined {
    const parsed = this.modelInput(model);
    if (!parsed) return undefined;
    const profiles = this.projectCatalogs.get(thread.cwd)?.profiles || this.profiles;
    const meta = profiles.find((item) => item.id === parsed.providerID)?.models?.[parsed.modelID];
    if (!meta) return undefined;
    return modelVariants(meta)?.map((item) => item.reasoningEffort) || [];
  }

  /**
   * 档位校验（发送与写入共用）：模型未知/catalog 未加载时返回 undefined，
   * 调用方不带 variant（宽容，等 catalog 就绪后再校验）；模型已知但档位
   * 不在允许表时大声失败，绝不静默按默认档位跑。
   */
  private checkEffortSupported(thread: ThreadSummary, model: string, effort: string): string | undefined {
    const supported = this.supportedEfforts(thread, model);
    if (!supported) return undefined;
    if (!supported.length)
      throw new Error(
        `当前模型 ${model} 未配置推理强度档位，无法应用 ${effort}；请在供应商配置中为该模型声明 variants 后再发送`,
      );
    if (!supported.includes(effort))
      throw new Error(
        `当前模型 ${model} 不支持推理强度 ${effort}（可选：${supported.join("、")}），请在会话设置里重新选择`,
      );
    return effort;
  }

  /**
   * Effort chosen in Deck. Models that advertise a variant list keep the
   * allowlist; an effort the model does not offer fails fast (otherwise the
   * turn would silently run at the server default while settings show
   * another level). Unknown models still drop, avoiding variant sends
   * before the provider catalog has loaded.
   * A catalog entry without any variant metadata means the provider never
   * declared `variants` for that model: OpenCode answers such a prompt with
   * "Variant unavailable" and the whole turn fails, so fail fast here with
   * the config hint instead of letting the user hit it mid-run.
   */
  private threadVariant(thread: ThreadSummary) {
    const effort = thread.reasoningEffort?.trim();
    if (!effort) return undefined;
    const raw = thread.model || thread.resolvedModel || "";
    if (!raw || raw === "default") return undefined;
    const parsed = this.modelInput(raw);
    if (!parsed) return undefined;
    return this.checkEffortSupported(thread, `${parsed.providerID}/${parsed.modelID}`, effort);
  }

  private modelContextLimit(providerID: string, modelID: string, directory?: string) {
    const profiles = this.projectCatalogs.get(directory || "")?.profiles || this.profiles;
    const profile = profiles.find((item) => item.id === providerID);
    const limit = profile?.models?.[modelID]?.limit?.context;
    return typeof limit === "number" && limit > 0 ? limit : undefined;
  }

  private readMessagePage(thread: ThreadSummary, limit?: number, before?: string) {
    const query = new URLSearchParams();
    if (limit) query.set("limit", String(limit));
    if (before) query.set("before", before);
    const suffix = query.size ? `?${query}` : "";
    const key = thread.id + suffix;
    const existing = this.messageReads.get(key);
    if (existing) return existing;
    let next: string | undefined;
    const pending = this.request<any[]>(
      `/session/${encodeURIComponent(thread.id)}/message${suffix}`,
      { directory: thread.cwd,
        onResponse: (response) => { next = response.headers?.get("x-next-cursor") || undefined; },
      },
    ).then((records) => ({ records, next })).finally(() => {
      if (this.messageReads.get(key) === pending) this.messageReads.delete(key);
    });
    this.messageReads.set(key, pending);
    return pending;
  }

  private readMessages(thread: ThreadSummary): Promise<any[]> {
    return this.readMessagePage(thread).then((page) => page.records);
  }

  private invalidateHistory(threadId: string) {
    this.historyBoundaries.delete(threadId);
    for (const key of this.messageReads.keys())
      if (key === threadId || key.startsWith(`${threadId}?`)) this.messageReads.delete(key);
  }

  private async readTailMessages(thread: ThreadSummary, turns: number, targetTurnId?: string) {
    // Native limits count messages, not turns. Cursor pages avoid downloading
    // overlapping tool output when one user turn spans many assistant steps.
    let limit = Math.max(32, Math.min(256, turns * 2));
    let before: string | undefined;
    let records: any[] = [];
    const cursors = new Set<string>();
    for (;;) {
      let page: { records: any[]; next?: string };
      try {
        page = await this.readMessagePage(thread, limit, before);
      } catch (error) {
        // Older servers may reject the optional pagination query.
        if (!/OpenCode API (400|422)/.test(String(error))) throw error;
        return { records: await this.readMessages(thread), partial: false };
      }
      records = before ? [...page.records, ...records] : page.records;
      const userIds = this.userMessageIds(records);
      const complete = targetTurnId ? userIds.includes(targetTurnId) : userIds.length > turns;
      if (page.next) {
        if (cursors.has(page.next))
          throw new Error("OpenCode 历史分页游标重复，请重试");
        if (complete) return { records, partial: true };
        cursors.add(page.next);
        before = page.next;
        continue;
      }
      if (before || page.records.length !== limit) return { records, partial: false };
      // V1 releases with limit but no cursor support can still fetch a bounded
      // tail. Only those releases need to enlarge and repeat the tail request.
      if (complete) return { records, partial: true };
      limit *= 2;
    }
  }

  private userMessageIds(records: any[]) {
    return records
      .map((record) => record?.info || record?.message || record)
      .filter((info) => info?.role === "user" && info?.id)
      .map((info) => String(info.id));
  }

  private async forkUserIds(thread: ThreadSummary, selected: string) {
    const cached = this.historyBoundaries.get(thread.id);
    if (cached && cached.cwd === thread.cwd && Date.now() - cached.at < 60_000) {
      // Validate against native metadata, including external TUI edits/reverts.
      const session = await this.request<any>(`/session/${encodeURIComponent(thread.id)}`, {
        directory: thread.cwd,
      });
      if (Number(session?.time?.updated) === cached.updated &&
          String(session?.revert?.messageID || "") === cached.revert)
        return cached.userIds;
    }
    return this.userMessageIds((await this.readTailMessages(thread, 1, selected)).records);
  }

  async readThread(_providerId: string, threadId: string, options?: {
    turnLimit?: number;
    beforeTurn?: string;
  }) {
    const thread = this.requireThread(threadId);
    // Model labels and context limits enrich the transcript in the background;
    // they must never add latency to opening the session itself.
    const catalog =
      thread.cwd && !this.projectCatalogs.has(thread.cwd)
        ? this.loadProjectCatalog(thread.cwd).catch(() => undefined)
        : undefined;
    const readStartedAt = Date.now();
    const sessionRead = this.request<OpenCodeSession & { revert?: { messageID?: string } }>(
      `/session/${encodeURIComponent(threadId)}`, { directory: thread.cwd },
    );
    const turnLimit = Number(options?.turnLimit);
    const paged = Number.isFinite(turnLimit) && turnLimit > 0 && !options?.beforeTurn;
    const history = paged
      ? sessionRead.then((session) => session?.revert?.messageID
          // A staged revert may hide an arbitrarily large tail. Preserve the
          // native boundary exactly instead of mistaking hidden history for empty.
          ? this.readMessages(thread).then((records) => ({ records, partial: false }))
          : this.readTailMessages(thread, Math.floor(turnLimit)))
      : this.readMessages(thread).then((records) => ({ records, partial: false }));
    const [page, session] = await Promise.all([
      history,
      sessionRead,
    ]);
    if (!this.threads.has(threadId)) throw new Error("OpenCode 会话已删除");
    const allRecords = page.records;
    const updated = Number(session?.time?.updated);
    const liveStatus = this.threads.get(threadId)?.status;
    // Metadata fetched concurrently must predate the message read. Otherwise
    // it may describe an edit that the message snapshot does not contain yet.
    if (Number.isFinite(updated) && updated > 0 && updated < readStartedAt &&
        liveStatus === "idle") {
      this.historyBoundaries.delete(threadId);
      this.historyBoundaries.set(threadId, {
        cwd: thread.cwd, updated, revert: String(session?.revert?.messageID || ""),
        at: Date.now(), userIds: this.userMessageIds(allRecords),
      });
      while (this.historyBoundaries.size > 32)
        this.historyBoundaries.delete(this.historyBoundaries.keys().next().value!);
    }
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
    // await 期间 session.updated 可能已把 threads 里的对象换成新实例，
    // 命名/用量必须基于现行对象合并，否则会把新字段顶回旧值。
    const base = this.threads.get(threadId) || thread;
    const renamed = page.partial ? base : this.applyFirstMessageNaming(base, records);
    const current = this.applyThreadUsage(renamed, records);
    const usageAt = current.updatedAt;
    const usageTurn = current.activeTurnId;
    if (catalog && !this.projectCatalogs.has(thread.cwd))
      void catalog.then((loaded) => {
        const latest = this.threads.get(threadId);
        if (loaded && latest && latest.updatedAt === usageAt && latest.activeTurnId === usageTurn)
          this.applyThreadUsage(latest, records);
      });
    const normalized = normalizeMessages(
      { id: current.id, directory: current.cwd }, records,
      current.status === "running" || current.status === "waiting"
        ? current.activeTurnId : undefined,
    );
    return {
      ...normalized,
      ...(page.partial ? {
        turns: normalized.turns.slice(-Math.floor(turnLimit)),
        // The exact old-turn count is intentionally unknown without reading it.
        __cachedTailOmitted: 1,
        hasMoreTurns: true,
      } : {}),
      agentId: this.id,
      providerId: current.providerId,
      model: current.model,
      ...(current.resolvedModel
        ? { resolvedModel: current.resolvedModel }
        : {}),
      ...(current.tokenUsage ? { tokenUsage: current.tokenUsage } : {}),
    };
  }

  async readTurn(_providerId: string, threadId: string, turnId: string) {
    const thread = this.requireThread(threadId);
    const session = await this.request<OpenCodeSession & { revert?: { messageID?: string } }>(
      `/session/${encodeURIComponent(threadId)}`, { directory: thread.cwd },
    );
    const reverted = String(session?.revert?.messageID || "");
    const history = reverted ? { records: await this.readMessages(thread) }
      : await this.readTailMessages(thread, 1, turnId === thread.activeTurnId ? undefined : turnId);
    const end = reverted ? history.records.findIndex((record) =>
      String((record?.info || record?.message || record)?.id) === reverted) : -1;
    const records = end >= 0 ? history.records.slice(0, end) : history.records;
    const full = normalizeMessages({ id: threadId, directory: thread.cwd }, records,
      thread.status === "running" || thread.status === "waiting" ? thread.activeTurnId : undefined);
    const turn = full.turns.find((item) => String(item.id) === turnId);
    if (!turn) throw new Error("找不到该回合，可能已被撤回或压缩");
    return turn;
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
    const current = this.threads.get(threadId) || thread;
    current.name = next;
    current.updatedAt = Date.now();
    this.broadcast("thread.updated", current);
    return current;
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
    if (settings.model !== undefined) {
      const trimmed = typeof settings.model === "string" ? settings.model.trim() : "";
      if (!trimmed || trimmed === "default") {
        // 清空即回到“跟随默认”：删显式模型与派生展示，不再把旧值写回去。
        thread.model = "default";
        delete thread.resolvedModel;
        delete thread.modelLabel;
      } else {
        const model = this.requireModelSetting(settings.model);
        thread.model = model;
        // 和 model 一起刷新 resolvedModel，输入框格子不用等下轮才换名。
        thread.resolvedModel = model;
        const label = this.modelLabelFor(thread, model);
        if (label) thread.modelLabel = label;
        else delete thread.modelLabel;
      }
    }
    if (settings.reasoningEffort !== undefined) {
      const effort =
        typeof settings.reasoningEffort === "string" ? settings.reasoningEffort.trim() : "";
      if (effort) {
        // 写入时即校验：模型已知且档位不在允许表直接拒绝，不留到发送时
        // 静默按默认档位跑。模型未知/catalog 未就绪时宽容，发送时把关。
        const raw =
          thread.model && thread.model !== "default"
            ? thread.model
            : thread.resolvedModel || "";
        if (raw) this.checkEffortSupported(thread, raw, effort);
        thread.reasoningEffort = settings.reasoningEffort;
      } else thread.reasoningEffort = undefined;
    }
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

  /**
   * 会话本地清理统一入口：deleteThread / session.deleted 共用。
   * 清 idle 定时器、turn 跟踪、分支/标题/子会话映射，并撤掉该会话（含其
   * subagent 子会话）的挂起审批。调用方负责原生 DELETE 与广播。
   */
  private purgeThread(sessionId: string) {
    const copiedTimer = this.copiedHistoryTimers.get(sessionId);
    if (copiedTimer) clearTimeout(copiedTimer);
    this.copiedHistoryTimers.delete(sessionId);
    this.sessionCreatedAt.delete(sessionId);
    for (const [id, owner] of this.copiedMessages)
      if (owner === sessionId) this.copiedMessages.delete(id);
    this.clearIdleTimer(sessionId);
    this.endRunningTurn(sessionId);
    // 先收集要撤审批的会话：自己 + 挂在它名下的 subagent 子会话。
    const approvalSessions = new Set([sessionId]);
    for (const [child, parent] of this.childParents)
      if (parent === sessionId) approvalSessions.add(child);
    this.threads.delete(sessionId);
    this.invalidateHistory(sessionId);
    this.sessionTitles.delete(sessionId);
    this.forkChildren.delete(sessionId);
    for (const child of approvalSessions) {
      this.childParents.delete(child);
      const partId = this.childTaskParts.get(child);
      if (partId) this.taskPartSnapshots.delete(partId);
      this.childTaskParts.delete(child);
      this.pendingChildActivity.delete(child);
    }
    // 挂起审批：thread 已摘除，clearApproval 只发 approval.resolved，
    // 不会把已删会话翻回 running，也不会触发多余的状态回查。
    for (const [approvalId, approval] of this.approvals)
      if (approvalSessions.has(approval.sessionID))
        this.clearApproval(approvalId);
  }

  deleteThread(_providerId: string, threadId: string) {
    const existing = this.deleteOperations.get(threadId);
    if (existing) return existing;
    const pending = this.performDelete(threadId).finally(() => {
      if (this.deleteOperations.get(threadId) === pending) this.deleteOperations.delete(threadId);
    });
    this.deleteOperations.set(threadId, pending);
    return pending;
  }

  private async performDelete(threadId: string) {
    if (this.forkOperations.has(threadId)) throw new Error("此会话正在创建分支，暂时不能删除");
    const thread = this.requireThread(threadId);
    if (thread.status === "running" || thread.status === "waiting")
      throw new Error("运行中的 OpenCode 会话不能删除");
    await this.request(`/session/${encodeURIComponent(threadId)}`, {
      method: "DELETE",
      directory: thread.cwd,
    });
    this.purgeThread(threadId);
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
  forkThread(
    _providerId: string,
    threadId: string,
    options: { messageID?: string; lastTurnId?: string } = {},
  ) {
    const boundary = JSON.stringify([options.messageID || "", options.lastTurnId || ""]);
    const existing = this.forkOperations.get(threadId);
    if (existing) return existing.boundary === boundary ? existing.promise
      : Promise.reject(new Error("此会话正在创建分支，请等待完成后再选择其他轮次"));
    const pending = this.performFork(threadId, options).finally(() => {
      if (this.forkOperations.get(threadId)?.promise === pending) this.forkOperations.delete(threadId);
    });
    this.forkOperations.set(threadId, { boundary, promise: pending });
    return pending;
  }

  private async performFork(
    threadId: string,
    options: { messageID?: string; lastTurnId?: string },
  ) {
    if (this.deleteOperations.has(threadId)) throw new Error("此会话正在删除，暂时不能创建分支");
    const source = this.requireThread(threadId);
    if (source.archived) throw new Error("会话已归档，请先恢复再分支");
    if (source.status === "running" || source.status === "waiting")
      throw new Error("会话正在运行或等待确认，无法分支");
    let boundary = String(options.messageID || "").trim();
    if (options.lastTurnId) {
      const selected = String(options.lastTurnId).trim();
      let userIds = await this.forkUserIds(source, selected);
      if (!userIds.includes(selected)) userIds = this.userMessageIds(await this.readMessages(source));
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
        // Naming is auxiliary; do not hold a successful fork for a minute.
        timeoutMs: 1_500,
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
    // 先落内存（并发事件/refreshAll 靠 forkChildren 认分支），再落盘；
    // 落盘失败必须回滚原生分支，否则“前端报失败、原生留孤儿”，重试越堆越多。
    this.threads.set(branch.id, branch);
    try {
      await this.options.threadSettings?.update(this.id, branch.id, {
        providerId: source.providerId,
        model: branch.model,
        reasoningEffort: source.reasoningEffort,
        forkedFromId: threadId,
      });
    } catch (error: any) {
      this.threads.delete(branch.id);
      this.forkChildren.delete(branch.id);
      this.sessionTitles.delete(branch.id);
      await this.request(`/session/${encodeURIComponent(branch.id)}`, {
        method: "DELETE",
        directory: branch.cwd,
      }).catch(() => undefined);
      throw new Error(
        `分支已创建但本地保存失败，已回滚清理，请重试：${String(error?.message || error)}`,
      );
    }
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
    const records = await this.readMessages(source);
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
    try {
      await this.sendTurn(source.providerId, branch.id, value, images);
    } catch (error: any) {
      // 分支本身可用（历史完整保留），只是新一轮没发出去：把失败挂在分支上
      // 并广播，用户直接在该分支重试，不用再建一个分支堆垃圾。
      const current = this.threads.get(branch.id);
      if (current) {
        current.lastError = String(error?.message || error || "重试发送失败");
        current.updatedAt = Date.now();
        this.broadcast("thread.updated", current);
      }
      throw error;
    }
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
    // 同 forkThread：先落内存再落盘，落盘失败回滚原生会话。
    this.threads.set(branch.id, branch);
    try {
      await this.options.threadSettings?.update(this.id, branch.id, {
        providerId: source.providerId,
        model: branch.model,
        reasoningEffort: source.reasoningEffort,
        forkedFromId: source.id,
      });
    } catch (error: any) {
      this.threads.delete(branch.id);
      this.forkChildren.delete(branch.id);
      this.sessionTitles.delete(branch.id);
      await this.request(`/session/${encodeURIComponent(branch.id)}`, {
        method: "DELETE",
        directory: branch.cwd,
      }).catch(() => undefined);
      throw new Error(
        `分支已创建但本地保存失败，已回滚清理，请重试：${String(error?.message || error)}`,
      );
    }
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
    providerId: string,
    threadId: string,
    command: string,
    args?: string,
  ) {
    return this.serializeSend(threadId, () =>
      this.runSessionCommandLocked(providerId, threadId, command, args),
    );
  }

  private async runSessionCommandLocked(
    _providerId: string,
    threadId: string,
    command: string,
    args?: string,
  ) {
    const thread = this.requireThread(threadId);
    if (thread.archived) throw new Error("会话已归档，请先恢复再操作");
    // 命令同样独占一轮：与 sendTurn 共用受理锁，被顶掉的旧轮补 interrupted。
    const displacedTurnId =
      thread.status === "running" || thread.status === "waiting"
        ? thread.activeTurnId
        : undefined;
    const name = String(command || "").trim().replace(/^\/+/, "");
    if (!name) throw new Error("命令名称不能为空");
    // 模型沿用会话当前选择：非法设置直接大声失败，见 sendModelOf。
    const parsed = this.sendModelOf(thread);
    const variant = this.threadVariant(thread);
    const turnId = randomUUID();
    this.clearIdleTimer(thread.id);
    thread.status = "running";
    thread.activeTurnId = turnId;
    this.beginRunningTurn(thread, turnId);
    thread.lastError = undefined;
    thread.updatedAt = Date.now();
    this.broadcast("thread.updated", thread);
    this.emitAgentEvent(thread, "turn/started", {
      threadId,
      turn: { id: turnId, status: "inProgress" },
    });
    if (displacedTurnId && displacedTurnId !== turnId)
      this.emitAgentEvent(thread, "turn/completed", {
        threadId,
        turn: { id: displacedTurnId, status: "interrupted" },
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
      // 命令执行期间 session.updated 等事件会用 mergeThread 换掉 threads
      // 里的对象，回滚要落在现行对象上，写旧引用会让会话永久卡 running。
      const current = this.threads.get(thread.id);
      if (!current || current.activeTurnId !== turnId) return;
      const detail = String(error?.message || error || "OpenCode 命令执行失败");
      this.clearIdleTimer(thread.id);
      // 命令运行中被手动停止：同 session.error 的中断语义，不当失败展示。
      if (isAbortError(error)) {
        current.status = "idle";
        current.activeTurnId = undefined;
        current.lastError = undefined;
        current.compacting = undefined;
        current.updatedAt = Date.now();
        this.broadcast("thread.updated", current);
        this.emitAgentEvent(current, "turn/completed", {
          threadId,
          turn: { id: turnId, status: "interrupted" },
        });
        return;
      }
      current.status = "error";
      current.activeTurnId = undefined;
      current.lastError = detail;
      current.updatedAt = Date.now();
      this.broadcast("thread.updated", current);
      this.emitAgentEvent(current, "turn/completed", {
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
    // 显式设置非法时大声失败；已解析模型只采纳合法值，脏值跳过走默认。
    const explicit = this.sendModelOf(thread);
    const resolvedInput =
      !explicit && thread.resolvedModel
        ? this.modelInput(thread.resolvedModel)
        : undefined;
    const resolved =
      explicit ||
      (resolvedInput?.providerID && resolvedInput?.modelID
        ? resolvedInput
        : undefined);
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
      // summarize 期间的 session.updated / 历史重载会用 mergeThread 换掉
      // threads 里的对象（compacting 随 ...existing 拷到新对象上），清理
      // 必须落在现行对象上，写旧引用等于没清、标记会永久残留。
      const current = this.threads.get(thread.id) || thread;
      // The summary request reports its old input context. A new ordinary
      // reply is needed before there is a trustworthy post-compaction value.
      delete current.tokenUsage;
    } finally {
      const current = this.threads.get(thread.id);
      if (current) {
        current.compacting = undefined;
        current.updatedAt = Date.now();
        this.broadcast("thread.updated", current);
      }
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
      const records = await this.readMessages(thread);
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

  async sendMessage(providerId: string, threadId: string, input: AgentMessageInput): Promise<AgentMessageAcceptance> {
    const thread = this.requireThread(threadId);
    assertMessageInput(thread, input, OPENCODE_CAPABILITIES.messages!);
    const busy = messageBusy(thread);
    const result = await this.sendTurn(providerId, threadId, input.text, input.images);
    return { disposition: busy ? "backend-managed" : "started", turnId: result.turn.id };
  }

  async sendTurn(
    providerId: string,
    threadId: string,
    text: string,
    images?: TurnImage[],
  ) {
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
    // 忙时允许接管（feedback/abort-then-send 与 messages 能力依赖它）：
    // 受理锁保证同时只有一个受理，被顶掉的旧轮记下来，后面补 interrupted，
    // 否则前端旧轮转圈永远收不到 turn/completed。
    const displacedTurnId =
      thread.status === "running" || thread.status === "waiting"
        ? thread.activeTurnId
        : undefined;
    if (thread.status !== "running" && thread.status !== "waiting" &&
      this.options.threadSettings?.deferred?.(this.id, threadId))
      await this.options.threadSettings.applyDeferred(this.id, threadId, (settings) =>
        this.updateThreadSettings(_providerId, threadId, settings),
      );
    // 非法模型设置直接大声失败，绝不带着空 modelID 发送（见 sendModelOf）。
    const parsed = this.sendModelOf(thread);
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
    // The reasoning effort is a per-message variant; only send one the model
    // actually advertises, otherwise OpenCode rejects the request. Resolved
    // before the running markers so a rejected variant cannot leave the
    // thread stuck in "running" with no turn event to correct it.
    const variant = this.threadVariant(thread);
    const turnId = randomUUID();
    this.clearIdleTimer(thread.id);
    thread.status = "running";
    thread.activeTurnId = turnId;
    this.beginRunningTurn(thread, turnId);
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
    // 忙时接管：旧轮已被新 prompt 顶掉，补发 interrupted 让前端闭环。
    if (displacedTurnId && displacedTurnId !== turnId)
      this.emitAgentEvent(thread, "turn/completed", {
        threadId,
        turn: { id: displacedTurnId, status: "interrupted" },
      });
    const model = parsed;
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
      // 回滚前验 turnId：慢请求的失败不能砸掉后来者已接管的新轮。
      const detail = String(error?.message || error || "OpenCode 任务发送失败");
      this.clearIdleTimer(thread.id);
      const current = this.threads.get(thread.id);
      if (!current || current.activeTurnId !== turnId) throw error;
      current.status = "error";
      current.activeTurnId = undefined;
      current.lastError = detail;
      current.updatedAt = Date.now();
      this.broadcast("thread.updated", current);
      this.emitAgentEvent(current, "turn/completed", {
        threadId,
        turn: { id: turnId, status: "failed", error: { message: detail } },
      });
      throw error;
    }
    return { turn: { id: turnId, status: "inProgress" } };
  }

  async interrupt(_providerId: string, threadId: string, turnId: string) {
    const thread = this.requireThread(threadId);
    if (thread.archived) throw new Error("会话已归档，请先恢复再操作");
    // turnId 一致性：只打断自己这轮。调用方拿着过期 turnId 进来说明该轮
    // 已被接管或结束，此时 abort 会误杀新轮，直接拒绝比误杀诚实。
    if (turnId && thread.activeTurnId && thread.activeTurnId !== turnId)
      throw new Error("该轮次已结束或被新轮接管，无需打断");
    try {
      // 停止按钮不能跟着等 60s：abort 轻量，10s 发不出去就是真有问题。
      await this.request(`/session/${encodeURIComponent(threadId)}/abort`, {
        method: "POST",
        directory: thread.cwd,
        retry: false,
        timeoutMs: 10_000,
      });
    } catch (error: any) {
      // abort 没发出去：本地状态原样保留（后续事件仍能纠正），抛可重试的
      // 明确错误，不要让上层误以为“已停止”。真卡死走 forceStop 强制归位。
      const detail = String(error?.message || error || "未知错误");
      throw new Error(`停止请求发送失败（${detail}），请重试或使用紧急停止`);
    }
    return { ok: true };
  }

  /**
   * 紧急停止：SSE 断流丢事件会让会话永久卡在 running/waiting，常规打断
   * 与删除、归档全部被占用检查挡住。这里不经任何状态校验：后端在线就
   * 尽力 abort（失败不阻塞），随后撤掉挂起审批并把本地状态强制归位 idle。
   */
  async forceStop(_providerId: string, threadId: string) {
    const thread = this.requireThread(threadId);
    this.request(`/session/${encodeURIComponent(threadId)}/abort`, {
      method: "POST",
      directory: thread.cwd,
      retry: false,
    }).catch(() => undefined);
    const turnId = thread.activeTurnId;
    // 先撤审批：clearApproval 会把 waiting 搬回 running，之后统一落 idle。
    for (const [approvalId, approval] of this.approvals)
      if (
        approval.sessionID === threadId ||
        this.childParents.get(approval.sessionID) === threadId
      )
        this.clearApproval(approvalId);
    this.clearIdleTimer(threadId);
    // 审批清理期间 session.updated 可能已换掉 threads 里的对象，归位
    // 必须落在现行对象上，写旧引用等于没清。
    const current = this.threads.get(threadId) || thread;
    current.status = "idle";
    current.activeTurnId = undefined;
    current.compacting = undefined;
    current.lastError = undefined;
    current.updatedAt = Date.now();
    this.endRunningTurn(threadId);
    this.broadcast("thread.updated", current);
    this.emitAgentEvent(current, "turn/completed", {
      threadId,
      turn: { id: turnId || "opencode", status: "interrupted" },
    });
    return { ok: true as const };
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
      const persistent = decision === "allowForProject";
      if (persistent) {
        const permission = approval.request.params?.permission;
        if (permission?.permission !== "external_directory" || !approval.cwd)
          throw new Error("仅支持为当前项目持久授权项目外目录");
        const patterns = Array.isArray(permission.always) && permission.always.length
          ? permission.always : permission.patterns;
        // 只落盘，不碰运行中的实例：PATCH /config 会让 serve dispose 该目录的
        // 实例，挂起的权限请求和在途回合一起消失（表现为 agent 被中止），而且
        // 它写回的 <项目>/config.json 并不在 serve 的配置读取列表里。规则对
        // 新会话生效的时机见 scheduleProjectConfigRefresh。
        await allowOpenCodeExternalDirectories(approval.cwd, patterns);
      }
      const reply =
        decision === "acceptForSession" || persistent
          ? "always"
          : decision === "accept"
            ? "once"
            : "reject";
      // 回复必须先于任何会 dispose 实例的动作，否则这条权限已经被 serve 丢掉。
      await this.request(`/permission/${encodeURIComponent(approval.permissionId)}/reply`, {
        method: "POST",
        directory: approval.cwd,
        body: { reply },
      });
      this.clearApproval(approvalId);
      if (persistent && approval.cwd)
        this.scheduleProjectConfigRefresh(approval.cwd);
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
      const current = this.threads.get(thread.id);
      if (!current || current.status !== "running") return;
      const status = statuses?.[thread.id]?.type;
      if (!status || status === "idle") this.applyIdle(current);
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
      availableDecisions: ["decline", "accept", "acceptForSession",
        ...(kind === "external_directory" && thread?.cwd && patterns.length ? ["allowForProject"] : [])],
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
    this.lastServeActivityAt = Date.now();
    const payload = event?.payload || event;
    const body = payload?.properties || {};
    const sessionId =
      body.sessionID ||
      body.info?.sessionID ||
      body.info?.id ||
      body.part?.sessionID ||
      body.session?.id;
    if (sessionId) {
      // A read started before an event cannot satisfy a subsequent fresh read.
      this.invalidateHistory(sessionId);
    }
    const thread = sessionId ? this.threads.get(sessionId) : undefined;
    // 看门狗心跳：该会话的在途回合记一次事件时间，静默 running 才会被对账。
    if (sessionId) {
      const tracked = this.runningTurns.get(sessionId);
      if (tracked) tracked.lastEventAt = Date.now();
    }
    // 实例被 dispose（我们自己的 reload、外部 PATCH /config 等）后，对应
    // 目录的供应商/模型目录缓存作废，下次 listModels 重新拉取。
    if (payload?.type === "server.instance.disposed") {
      const directory = String(
        body.directory || event?.directory || "",
      ).trim();
      if (directory) {
        this.projectCatalogs.delete(directory);
        this.projectCatalogsAt.delete(directory);
      } else {
        this.projectCatalogs.clear();
        this.projectCatalogsAt.clear();
      }
      return;
    }
    if (
      payload?.type === "session.created" ||
      payload?.type === "session.updated"
    ) {
      const session = body.info as OpenCodeSession | undefined;
      if (!session?.id) return;
      const created = Number(session.time?.created);
      if (Number.isFinite(created) && created > 0)
        this.boundedPut(this.sessionCreatedAt, session.id, created);
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
      this.purgeThread(sessionId);
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
      // 回合终态：停掉 token 跟踪，否则 runningTurns 残留被下一轮误收。
      this.endRunningTurn(thread.id);
      const turnId = thread.activeTurnId || "opencode";
      // 手动停止走中断分支：idle + turn interrupted，不算失败、不写 lastError。
      if (isAbortError(body.error)) {
        thread.status = "idle";
        thread.activeTurnId = undefined;
        thread.lastError = undefined;
        thread.compacting = undefined;
        thread.updatedAt = Date.now();
        this.broadcast("thread.updated", thread);
        for (const [id, approval] of this.approvals)
          if (approval.sessionID === thread.id) this.clearApproval(id);
        this.emitAgentEvent(thread, "turn/completed", {
          threadId: thread.id,
          turn: { id: turnId, status: "interrupted" },
        });
        return;
      }
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
      const created = Number(info?.time?.created);
      const sessionCreated = this.sessionCreatedAt.get(sessionId);
      if (thread && info?.id && sessionCreated && Number.isFinite(created) &&
          created > 0 && created < sessionCreated && thread.status === "idle" && !thread.activeTurnId) {
        this.boundedPut(this.copiedMessages, String(info.id), sessionId);
        this.scheduleCopiedHistory(sessionId);
        return;
      }
      if (info?.id) this.copiedMessages.delete(String(info.id));
      // per-part TPS 记忆：part 转发时的 info.tokens 以 message 为键留底
      // （含 0 值，part 完成时 tokens 已定型即可认领）。
      const tokens = info?.tokens || {};
      const messageId = String(info?.id || body?.messageID || "");
      if (messageId)
        this.boundedPut(this.messageUsageFields, messageId, {
          output: tokenNumber(tokens.output),
          reasoning: tokenNumber(tokens.reasoning),
        });
      if (thread && info?.role === "assistant")
        this.noteTurnTokens(thread, info);
      return;
    }
    if (payload?.type === "message.part.delta") {
      if (
        !thread ||
        body.field !== "text" ||
        !body.partID ||
        (thread.status === "idle" && !thread.activeTurnId &&
          this.copiedMessages.get(String(body.messageID || "")) === sessionId) ||
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
      if (thread.status === "idle" && !thread.activeTurnId &&
          this.copiedMessages.get(String(body.part?.messageID || "")) === sessionId) {
        this.scheduleCopiedHistory(sessionId);
        return;
      }
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
      else {
        // reasoning/text part 完成事件转发前认领 per-part stats；
        // 无时间窗或 token 缺失时保持原样（前端不展示，不编造）。
        if (part?.type === "text" || part?.type === "reasoning") {
          const stats = partStatsFromMessage(
            {
              tokens: this.messageUsageFields.get(String(part.messageID || "")),
            },
            part,
          );
          if (stats) part = { ...part, stats };
        }
        this.emitAgentEvent(thread, "item/updated", {
          threadId: thread.id,
          turnId: thread.activeTurnId,
          item: part,
        });
      }
    }
  }

  private scheduleCopiedHistory(sessionId: string) {
    const previous = this.copiedHistoryTimers.get(sessionId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.copiedHistoryTimers.delete(sessionId);
      const thread = this.threads.get(sessionId);
      if (thread) this.emitAgentEvent(thread, "thread/historyUpdated", { threadId: sessionId });
    }, 250);
    timer.unref?.();
    this.copiedHistoryTimers.set(sessionId, timer);
  }

  private clearCopiedHistory() {
    for (const timer of this.copiedHistoryTimers.values()) clearTimeout(timer);
    this.copiedHistoryTimers.clear();
    this.copiedMessages.clear();
    this.sessionCreatedAt.clear();
  }

  private rememberRole(messageId: unknown, role: unknown) {
    const id = String(messageId || "").trim();
    if (!id) return;
    this.messageRoles.set(id, String(role || ""));
    // 超限删最旧的游标删除：整表重建是 O(N) 抖动，message.updated 风暴下每条都抖一次。
    if (this.messageRoles.size > 400) {
      let drop = this.messageRoles.size - 200;
      for (const key of this.messageRoles.keys()) {
        if (drop-- <= 0) break;
        this.messageRoles.delete(key);
      }
    }
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
    return parseModelSetting(value);
  }

  /**
   * 会话模型设置校验（写入路径专用，读取保持宽容）。
   * `default` 或 `provider/model`（两侧都不能为空）才合法。手填模式下
   * 的半截输入（如 `opencode-go/`）一旦落盘，每轮会以空 modelID 发给
   * serve，serve 静默回退到默认模型——设置显示与实际执行从此分叉，且
   * 全程无报错。写入时直接大声拒绝，绝不静默存脏值。
   */
  private requireModelSetting(value: string) {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("模型不能为空，请在会话设置里重新选择模型");
    if (trimmed === "default") return trimmed;
    const parsed = this.modelInput(trimmed);
    if (!parsed?.providerID || !parsed?.modelID)
      throw new Error(
        `模型格式无效：应为 provider/model（如 opencode-go/glm-5.3-flash），当前为“${trimmed}”，请重新选择`,
      );
    // 存归一化形式（分段 trim），内存与落盘用同一个字符串，重启不分叉。
    return `${parsed.providerID}/${parsed.modelID}`;
  }

  /**
   * 发送路径的模型解析：显式设置必须合法，否则大声失败，绝不能带着空
   * modelID 发给 serve（serve 会静默回退到默认模型，造成“设置一个模型、
   * 实际跑另一个模型”）。历史脏数据（如 `opencode-go/`）走到这里会被
   * 拦下，用户重选模型即可恢复。
   */
  private sendModelOf(thread: ThreadSummary) {
    if (!thread.model || thread.model === "default") return undefined;
    const parsed = this.modelInput(thread.model.trim());
    if (!parsed?.providerID || !parsed?.modelID)
      throw new Error(
        `当前模型设置“${thread.model}”无效，不发送以免静默用错模型；请在会话设置里重新选择模型`,
      );
    return parsed;
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
      onResponse?: (response: Response) => void;
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
      const started = Date.now();
      let headersMs: number | undefined;
      let status: number | undefined;
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
        headersMs = Date.now() - started;
        status = response.status;
        if (response.ok) options.onResponse?.(response);
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
        this.lastServeActivityAt = Date.now();
        if (response.status === 204) return undefined as T;
        // Keep the deadline and retry handler alive through body consumption.
        return await response.json() as T;
      } catch (error: any) {
        // HTTP 状态错误直接抛（fork 的 404 兜底依赖原文案），不重试。
        if (String(error?.message || "").startsWith("OpenCode API "))
          throw error;
        lastError = error;
        if (attempt + 1 >= maxAttempts || !isTransientRequestError(error))
          throw this.requestError(error);
      } finally {
        if (timer) clearTimeout(timer);
        if (process.env.OPENCODE_TRACE_REQUESTS === "1")
          console.info("[OpenCode request]", JSON.stringify({
            method: options.method || "GET",
            endpoint: pathname.split("?")[0].replace(/(\/session\/)[^/]+/, "$1:id"),
            attempt: attempt + 1, status, headersMs, totalMs: Date.now() - started,
            timedOut: abort.signal.aborted,
          }));
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
    this.messageReads.clear();
    this.historyBoundaries.clear();
    this.clearCopiedHistory();
    this.online = false;
    this.error = error instanceof Error ? error.message : String(error);
    this.clearAllIdleTimers();
    if (this.idleRestartTimer) clearInterval(this.idleRestartTimer);
    this.idleRestartTimer = undefined;
    for (const thread of this.busyThreads()) {
      const turnId = thread.activeTurnId;
      thread.status = "offline";
      thread.activeTurnId = undefined;
      thread.compacting = undefined;
      this.endRunningTurn(thread.id);
      if (turnId) this.emitAgentEvent(thread, "turn/completed", {
        threadId: thread.id,
        turn: { id: turnId, status: "interrupted" },
      });
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
