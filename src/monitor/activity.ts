import { displayCommand, shortenPath } from "../format";
import { commandPresentation } from "../session/turn-items";
import type {
  ActivityItem,
  ThreadActivity,
  ThreadSummary,
  TokenUsage,
} from "../types";

export type StepKind =
  | "command"
  | "read"
  | "explore"
  | "edit"
  | "tool"
  | "web"
  | "agent"
  | "think"
  | "reply"
  | "compact";

export interface StepDescription {
  kind: StepKind;
  label: string;
  target: string;
}

/** 等模型时 3 分钟没动静算可疑；命令本身可能长时间无输出，放宽到 10 分钟。 */
export const STALL_MS = 3 * 60_000;
export const COMMAND_STALL_MS = 10 * 60_000;

const SHELL_TOOLS = new Set(["bash", "shell", "exec", "execute", "command", "run", "sh"]);
const KNOWN_TOOLS: Record<string, [StepKind, string]> = {
  task: ["agent", "子代理"],
  agent: ["agent", "子代理"],
  webfetch: ["web", "抓取网页"],
  fetch: ["web", "抓取网页"],
  websearch: ["web", "网页搜索"],
  web_search: ["web", "网页搜索"],
};
const TARGET_KEYS = [
  "description",
  "url",
  "query",
  "q",
  "pattern",
  "file_path",
  "filePath",
  "path",
  "command",
];

function firstInput(item: ActivityItem, cwd?: string) {
  for (const key of TARGET_KEYS) {
    const value = item.input?.[key];
    if (value) return /path$|^file/i.test(key) ? shortenPath(value, cwd) : value;
  }
  return "";
}

function namedTool(item: ActivityItem, cwd?: string): StepDescription {
  const known = KNOWN_TOOLS[String(item.tool || "").toLowerCase()];
  if (known) return { kind: known[0], label: known[1], target: firstInput(item, cwd) };
  const name = [item.server, item.tool].filter(Boolean).join(".");
  return { kind: "tool", label: name || "调用工具", target: firstInput(item, cwd) };
}

/** 把服务端精简过的 item 翻成一行“动作 + 对象”，与时间线的措辞保持一致。 */
export function describeStep(item: ActivityItem, cwd?: string): StepDescription {
  switch (item.type) {
    case "agentMessage":
      return { kind: "reply", label: "输出回复", target: "" };
    case "reasoning":
      return { kind: "think", label: "思考中", target: "" };
    case "contextCompaction":
      return { kind: "compact", label: "压缩上下文", target: "" };
    case "fileChange": {
      const paths = (item.changes || []).map((change) => shortenPath(change.path, cwd));
      const count = item.changeCount || paths.length;
      const target = paths[0]
        ? count > 1
          ? `${paths[0]} 等 ${count} 个文件`
          : paths[0]
        : "";
      return { kind: "edit", label: "编辑", target };
    }
    case "webSearch":
      return { kind: "web", label: "网页搜索", target: item.query || "" };
    case "subagent":
    case "collabAgentToolCall":
      return {
        kind: "agent",
        label: "子代理",
        target: [item.title || item.agent || item.tool, item.activity]
          .filter(Boolean)
          .join(" · "),
      };
    case "imageView":
      return { kind: "read", label: "查看图片", target: shortenPath(item.path || "", cwd) };
    case "imageGeneration":
      return { kind: "tool", label: "生成图片", target: "" };
    case "mcpToolCall":
    case "dynamicToolCall":
      return namedTool(item, cwd);
    case "commandExecution": {
      const presentation = commandPresentation(item, cwd);
      if (presentation.kind !== "command")
        return {
          kind: presentation.kind,
          label: presentation.label || "执行",
          target: presentation.target,
        };
      if (presentation.target)
        return { kind: "command", label: "执行", target: displayCommand(presentation.target) };
      const tool = String(item.tool || "").toLowerCase();
      if (tool && !SHELL_TOOLS.has(tool)) return namedTool(item, cwd);
      return { kind: "command", label: "执行", target: displayCommand(item.command || "") };
    }
    default:
      return { kind: "tool", label: item.tool || item.type, target: "" };
  }
}

export function threadIsActive(thread: ThreadSummary) {
  return (
    thread.status === "running" ||
    thread.status === "waiting" ||
    thread.status === "starting" ||
    Boolean(thread.compacting)
  );
}

/** 追踪器没见到回合开始（Deck 重启前就在跑）时，退回会话 updatedAt 近似。 */
export function turnStartedAt(thread: ThreadSummary, activity?: ThreadActivity) {
  if (!threadIsActive(thread)) return undefined;
  return activity?.turnStartedAt ?? thread.updatedAt;
}

/**
 * 运行中却长时间没有任何流式事件：返回已安静的毫秒数，否则 undefined。
 * 等待审批/输入的会话卡在用户这边，不算。
 */
export function stalledFor(
  thread: ThreadSummary,
  activity: ThreadActivity | undefined,
  now: number,
) {
  if (!activity || (thread.status !== "running" && !thread.compacting))
    return undefined;
  const quiet = now - activity.lastEventAt;
  const limit =
    activity.step?.item.type === "commandExecution" ? COMMAND_STALL_MS : STALL_MS;
  return quiet >= limit ? quiet : undefined;
}

/** 秒表式计时：00:42、03:12、1:02:03。 */
export function formatElapsed(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/** 口语化时长：32 秒、4 分 12 秒、1 小时 3 分。 */
export function formatDuration(ms: number) {
  const total = Math.max(0, Math.round(ms / 1_000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return total % 60 ? `${minutes} 分 ${total % 60} 秒` : `${minutes} 分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} 天 ${hours % 24} 小时` : `${days} 天`;
}

export function turnResultLabel(status: string) {
  if (status === "failed" || status === "error") return "失败";
  if (status === "interrupted" || status === "cancelled") return "已中断";
  return "已完成";
}

export function contextPercent(usage?: TokenUsage) {
  if (usage?.used == null || !usage.limit || usage.limit <= 0) return undefined;
  return Math.min(100, Math.round((usage.used / usage.limit) * 100));
}

export function contextTone(percent?: number) {
  if (percent == null) return "";
  if (percent >= 95) return "danger";
  if (percent >= 80) return "warn";
  return "";
}

export function formatBytes(bytes?: number) {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) {
    value /= 1_024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
