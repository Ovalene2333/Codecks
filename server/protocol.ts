import type {
  AccountInfo,
  ApprovalKind,
  FileChange,
  RateLimitWindow,
  RateLimits,
  TokenUsage,
} from "./types.js";

export function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
}

export function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
}

export function timestampFromId(id?: string): number | undefined {
  if (!id) return undefined;
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex) || hex[12] !== "7") return undefined;
  const ms = Number.parseInt(hex.slice(0, 12), 16);
  if (!Number.isFinite(ms) || ms < 1e12 || ms > Date.now() + 3_600_000)
    return undefined;
  return ms;
}

export function parseTimestamp(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (value == null || value === "") continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value > 0 && value < 1e12) return Math.round(value * 1000);
      if (value >= 1e12) return Math.round(value);
      continue;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) continue;
      if (/^\d+(\.\d+)?$/.test(trimmed)) {
        const numeric = Number(trimmed);
        if (Number.isFinite(numeric)) {
          if (numeric > 0 && numeric < 1e12) return Math.round(numeric * 1000);
          if (numeric >= 1e12) return Math.round(numeric);
        }
      }
      const parsed = Date.parse(trimmed);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
}

export function parseTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  const nested =
    data.tokenUsage && typeof data.tokenUsage === "object"
      ? (data.tokenUsage as Record<string, unknown>)
      : data.token_usage && typeof data.token_usage === "object"
        ? (data.token_usage as Record<string, unknown>)
        : data.usage && typeof data.usage === "object"
          ? (data.usage as Record<string, unknown>)
          : data;
  const used = pickNumber(
    nested.used,
    nested.usedTokens,
    nested.used_tokens,
    nested.totalTokens,
    nested.total_tokens,
    nested.lastTokensUsed,
    nested.tokens,
    nested.tokenCount,
    nested.token_count,
  );
  const limit = pickNumber(
    nested.limit,
    nested.contextWindow,
    nested.context_window,
    nested.maxTokens,
    nested.max_tokens,
    nested.contextLimit,
    nested.context_limit,
    nested.window,
  );
  const input = pickNumber(
    nested.input,
    nested.inputTokens,
    nested.input_tokens,
  );
  const output = pickNumber(
    nested.output,
    nested.outputTokens,
    nested.output_tokens,
  );
  if (used == null && limit == null && input == null && output == null)
    return undefined;
  const usage: TokenUsage = {};
  if (used != null) usage.used = used;
  if (limit != null) usage.limit = limit;
  if (input != null) usage.input = input;
  if (output != null) usage.output = output;
  return usage;
}

export function parseRateLimitWindow(raw: unknown): RateLimitWindow | undefined {
  if (typeof raw === "number" && Number.isFinite(raw))
    return { limit: raw };
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  const usedPercent = pickNumber(
    data.usedPercent,
    data.used_percent,
    data.percentUsed,
    data.percent_used,
    data.usedPercentage,
    data.used_percentage,
  );
  const used = pickNumber(data.used, data.usedTokens, data.used_tokens);
  const limit = pickNumber(
    data.limit,
    data.allowed,
    data.limitTokens,
    data.limit_tokens,
  );
  const resetAfterSeconds = pickNumber(
    data.resetAfterSeconds,
    data.reset_after_seconds,
    data.resetsInSeconds,
    data.resets_in_seconds,
    data.resetsAfterSeconds,
    data.window_remaining_seconds,
  );
  let resetsAt = pickNumber(
    data.resetsAt,
    data.resets_at,
    data.resetAt,
    data.reset_at,
  );
  if (resetsAt != null && resetsAt > 0 && resetsAt < 1e12) resetsAt *= 1000;
  const windowDurationMins = pickNumber(
    data.windowDurationMins,
    data.window_duration_mins,
    data.windowMinutes,
    data.window_minutes,
  );
  const reached = Boolean(
    data.reached ||
      data.limitReached ||
      data.limit_reached ||
      (usedPercent != null && usedPercent >= 100),
  );
  if (
    usedPercent == null &&
    used == null &&
    limit == null &&
    resetAfterSeconds == null &&
    resetsAt == null &&
    windowDurationMins == null
  )
    return undefined;
  return {
    usedPercent,
    used,
    limit,
    resetsAt,
    resetAfterSeconds,
    windowDurationMins,
    reached,
  };
}

export function parseRateLimits(raw: unknown): RateLimits | null {
  if (raw == null) return null;
  if (typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const root =
    data.rateLimits && typeof data.rateLimits === "object"
      ? (data.rateLimits as Record<string, unknown>)
      : data.rate_limits && typeof data.rate_limits === "object"
        ? (data.rate_limits as Record<string, unknown>)
        : data;
  if (root == null) return null;
  const primary = parseRateLimitWindow(
    root.primary ||
      root.primaryWindow ||
      root.primary_window ||
      root.fiveHour ||
      root.five_hour,
  );
  const secondary = parseRateLimitWindow(
    root.secondary ||
      root.secondaryWindow ||
      root.secondary_window ||
      root.weekly ||
      root.week,
  );
  const byLimitId: Record<string, RateLimitWindow> = {};
  const extra = root.byLimitId || root.by_limit_id || root.limits || root.credits;
  if (Array.isArray(extra)) {
    for (const item of extra) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const id = pickString(row.limitId, row.limit_id, row.id, row.name);
      const window = parseRateLimitWindow(item);
      if (id && window) byLimitId[id] = window;
    }
  } else if (extra && typeof extra === "object") {
    for (const [id, item] of Object.entries(extra)) {
      const window = parseRateLimitWindow(item);
      if (window) byLimitId[id] = window;
    }
  }
  const planType = pickString(
    root.planType,
    root.plan_type,
    data.planType,
    data.plan_type,
  );
  const planName = pickString(
    root.planName,
    root.plan_name,
    data.planName,
    data.plan_name,
  );
  const monthly = parseRateLimitWindow(
    data.individualLimit ||
      data.individual_limit ||
      root.individualLimit ||
      root.individual_limit ||
      root.monthly,
  );
  const resetCredits = pickNumber(
    (data.rateLimitResetCredits as Record<string, unknown> | undefined)
      ?.availableCount,
    (data.rate_limit_reset_credits as Record<string, unknown> | undefined)
      ?.availableCount,
    (data.rateLimitResetCredits as Record<string, unknown> | undefined)
      ?.available_count,
    (root.rateLimitResetCredits as Record<string, unknown> | undefined)
      ?.availableCount,
  );
  const spendControlReached =
    data.spendControlReached === true ||
    data.spend_control_reached === true ||
    root.spendControlReached === true ||
    root.spend_control_reached === true
      ? true
      : data.spendControlReached === false ||
          data.spend_control_reached === false ||
          root.spendControlReached === false ||
          root.spend_control_reached === false
        ? false
        : undefined;
  const rateLimitReachedType = pickString(
    data.rateLimitReachedType,
    data.rate_limit_reached_type,
    root.rateLimitReachedType,
    root.rate_limit_reached_type,
  );
  if (rateLimitReachedType && primary && !primary.reached)
    primary.reached = true;
  if (
    !primary &&
    !secondary &&
    !monthly &&
    !Object.keys(byLimitId).length &&
    !planType &&
    !planName &&
    resetCredits == null &&
    spendControlReached == null
  )
    return null;
  return {
    primary,
    secondary,
    monthly,
    byLimitId: Object.keys(byLimitId).length ? byLimitId : undefined,
    planType,
    planName,
    resetCredits,
    spendControlReached,
    rateLimitReachedType,
  };
}

export function parseAccount(raw: unknown): AccountInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  const acc =
    data.account && typeof data.account === "object"
      ? (data.account as Record<string, unknown>)
      : data;
  const plan =
    acc.plan && typeof acc.plan === "object"
      ? (acc.plan as Record<string, unknown>)
      : {};
  const authMode = pickString(
    acc.authMode,
    acc.auth_mode,
    acc.type,
    acc.accountType,
    acc.account_type,
    plan.authMode,
    plan.type,
    data.authMode,
    data.auth_mode,
  );
  const planType = pickString(
    acc.planType,
    acc.plan_type,
    plan.type,
    plan.planType,
    plan.plan_type,
    data.planType,
    data.plan_type,
  );
  const email = pickString(
    acc.email,
    acc.chatgptEmail,
    acc.chatgpt_email,
    data.email,
  );
  const chatgpt = isChatgptAuthMode(authMode) || acc.chatgpt === true;
  return { authMode, planType, email, chatgpt };
}

export function normalizeAuthMode(value?: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, "");
}

export function isChatgptAuthMode(value?: string) {
  const mode = normalizeAuthMode(value);
  return mode === "chatgpt" || mode === "personalaccesstoken";
}

export function isChatgptAccount(account?: AccountInfo | null) {
  if (!account) return false;
  if (account.chatgpt === true) return true;
  return isChatgptAuthMode(account.authMode);
}

export function classifyApprovalMethod(method: string): ApprovalKind {
  const value = method.toLowerCase();
  if (value.includes("filechange") || value.includes("file_change"))
    return "file";
  if (value.includes("permission")) return "permission";
  if (
    value.includes("requestuserinput") ||
    value.includes("userinput") ||
    value.includes("question")
  )
    return "question";
  if (
    value.includes("command") ||
    value.includes("execcommand") ||
    value.includes("commandexecution") ||
    value.includes("apply_patch") ||
    value.includes("requestapproval")
  )
    return "command";
  return "unknown";
}

export function formatCommand(command: unknown): string | undefined {
  if (typeof command === "string" && command.trim()) return command;
  if (Array.isArray(command))
    return command.map((part) => String(part)).join(" ");
}

export function parseFileChanges(raw: unknown): FileChange[] | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  return raw.map((item) => {
    const row = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    return {
      path: String(row.path || row.file || row.filename || ""),
      kind: pickString(row.kind, row.type, row.changeType, row.change_type),
      diff: pickString(row.diff, row.patch, row.unifiedDiff, row.unified_diff),
    };
  });
}

export type SandboxModeValue =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export function parseSandboxMode(
  ...values: unknown[]
): SandboxModeValue | undefined {
  for (const value of values) {
    const parsed = parseOneSandbox(value);
    if (parsed) return parsed;
  }
}

export function sandboxPolicyFromMode(mode?: string) {
  const parsed = parseSandboxMode(mode);
  if (!parsed) return undefined;
  if (parsed === "danger-full-access") return { type: "dangerFullAccess" };
  if (parsed === "read-only") return { type: "readOnly" };
  return { type: "workspaceWrite" };
}

function parseOneSandbox(value: unknown): SandboxModeValue | undefined {
  if (typeof value === "string") {
    const key = value
      .trim()
      .toLowerCase()
      .replace(/[_:]/g, "-")
      .replace(/^-+/, "");
    if (
      key === "workspace-write" ||
      key === "workspacewrite" ||
      key === "workspace"
    )
      return "workspace-write";
    if (key === "read-only" || key === "readonly") return "read-only";
    if (
      key === "danger-full-access" ||
      key === "dangerfullaccess" ||
      key === "full-access" ||
      key === "fullaccess"
    )
      return "danger-full-access";
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const data = value as Record<string, unknown>;
  return (
    parseOneSandbox(data.type) ||
    parseOneSandbox(data.sandbox) ||
    parseOneSandbox(data.sandboxMode) ||
    parseOneSandbox(data.sandbox_mode) ||
    parseOneSandbox(data.sandboxPolicy) ||
    parseOneSandbox(data.sandbox_policy) ||
    parseOneSandbox(data.id) ||
    parseOneSandbox(data.permissions)
  );
}
