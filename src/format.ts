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

export function formatTokens(value?: number) {
  if (value == null || !Number.isFinite(value)) return "";
  if (value < 1000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(value / 1000)}k`;
}

export function sessionKey(thread: { providerId: string; id: string }) {
  return `${thread.providerId}:${thread.id}`;
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
