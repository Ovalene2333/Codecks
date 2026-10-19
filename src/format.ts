import type { AgentId, TokenUsage } from "./types";

export const fmtTime = (time: number) => {
  if (!Number.isFinite(time)) return "";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(time);
  } catch {
    return "";
  }
};

export function displayText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value))
    return value.map(displayText).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const row = value as Record<string, unknown>;
    return displayText(row.text ?? row.content ?? row.summary ?? row.delta);
  }
  return "";
}

export function changeKindLabel(kind: unknown): string {
  if (typeof kind === "string" && kind.trim()) return kind;
  if (kind && typeof kind === "object") {
    const row = kind as Record<string, unknown>;
    const type = row.type ?? row.kind ?? row.changeType ?? row.change_type;
    if (typeof type === "string" && type.trim()) return type;
  }
  return "修改";
}

/** 文件改动类型的中文显示名；`changeKindLabel` 的英文值仍用作 CSS 类名。 */
const CHANGE_KIND_TEXT: Record<string, string> = {
  add: "新增",
  create: "新增",
  update: "修改",
  modify: "修改",
  delete: "删除",
  remove: "删除",
  move: "移动",
  rename: "重命名",
  changes: "改动",
};

export function changeKindText(label: string): string {
  return CHANGE_KIND_TEXT[label.toLowerCase()] || label;
}

export const basename = (p: string) =>
  p.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) || p;

export function relativeTime(time: number) {
  if (!Number.isFinite(time) || time <= 0) return "";
  const delta = Date.now() - time;
  if (delta < 45_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.max(1, Math.round(delta / 60_000))} 分钟前`;
  if (delta < 86_400_000)
    return `${Math.max(1, Math.round(delta / 3_600_000))} 小时前`;
  if (delta < 30 * 86_400_000)
    return `${Math.max(1, Math.round(delta / 86_400_000))} 天前`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
  }).format(time);
}

const TOKEN_NUMBER_FORMAT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  useGrouping: true,
});

const TOKEN_UNITS = [
  { divisor: 1_000, suffix: "K" },
  { divisor: 1_000_000, suffix: "M" },
  { divisor: 1_000_000_000, suffix: "B" },
] as const;

export function formatTokens(value?: number) {
  if (value == null || !Number.isFinite(value)) return "";
  if (Math.abs(value) < 1_000)
    return TOKEN_NUMBER_FORMAT.format(Math.round(value));

  let unitIndex = 0;
  for (let index = 1; index < TOKEN_UNITS.length; index += 1) {
    if (Math.abs(value) < TOKEN_UNITS[index].divisor) break;
    unitIndex = index;
  }
  while (unitIndex < TOKEN_UNITS.length - 1) {
    const scaled = Math.abs(value) / TOKEN_UNITS[unitIndex].divisor;
    if (Math.round(scaled * 100) / 100 < 1_000) break;
    unitIndex += 1;
  }
  const unit = TOKEN_UNITS[unitIndex];
  return `${TOKEN_NUMBER_FORMAT.format(value / unit.divisor)}${unit.suffix}`;
}

/**
 * 统计口径：优先用供应商原生会话累计值（tokenUsageTotal），否则退回
 * thread.tokenUsage（最新一步/上下文档位）。只把后者当累计值会导致
 * OpenCode 会话显示成几百 token。
 */
export function threadUsage(thread?: {
  tokenUsage?: TokenUsage;
  tokenUsageTotal?: TokenUsage;
}): TokenUsage | undefined {
  if (!thread) return undefined;
  const total = thread.tokenUsageTotal;
  const usage = thread.tokenUsage;
  // 分支的基线都按 threadUsage 记，所以 total 缺失时要补上占位字段，
  // 否则新建分支的用量会被当成 0。
  if (total) return usage ? { ...usage, ...total } : total;
  return usage;
}

export function sessionKey(thread: {
  agentId?: AgentId;
  providerId: string;
  id: string;
}) {
  return `${thread.agentId || "codex"}:${thread.providerId}:${thread.id}`;
}

export function threadIsUnsent(thread: {
  preview?: string;
  tokenUsage?: unknown;
  lastError?: string;
  activeTurnId?: string;
  status?: string;
}) {
  return (
    (!thread.preview || thread.preview === "新会话") &&
    !thread.tokenUsage &&
    !thread.lastError &&
    !thread.activeTurnId &&
    thread.status !== "running" &&
    thread.status !== "waiting" &&
    thread.status !== "error"
  );
}

export function distinctPreview(name: string, preview: string) {
  const title = name.trim();
  const text = preview.trim();
  if (!text) return "";
  if (!title) return text;
  if (text === title) return "";
  const stem = title.replace(/[.…]+$/u, "").trim();
  if (stem && (text.startsWith(stem) || stem.startsWith(text))) return "";
  return text;
}

export function displayCommand(command: string) {
  const value = command.trim();
  const wrapped = value.match(
    /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-(?:lc?|c)\s+([\s\S]+)$/i,
  );
  if (!wrapped) return value;
  let inner = wrapped[1].trim();
  const quote = inner[0];
  if ((quote === "'" || quote === '"') && inner.endsWith(quote) && inner.length > 1) {
    inner = inner.slice(1, -1);
  }
  return inner;
}

export function shortenPath(path: string, cwd?: string) {
  const norm = path.replace(/\\/g, "/");
  const root = (cwd || "").replace(/\\/g, "/");
  if (root && norm.toLowerCase().startsWith(root.toLowerCase())) {
    return norm.slice(root.length).replace(/^\/+/, "") || norm;
  }
  return path;
}
