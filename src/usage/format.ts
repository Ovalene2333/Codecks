import type { RateLimitWindow, RateLimits } from "../types";

export const CODEX_QUOTA_TITLE = "Codex 额度";
export const USAGE_UNAVAILABLE = "额度不可用";
export const RESET_IMMINENT = "即将重置";

function resetCountdownSeconds(window?: RateLimitWindow | null) {
  // resetsAt 是绝对时间戳，渲染时现算不会过期；resetAfterSeconds 是抓取时刻的
  // 相对值，快照缓存重放后会偏大，只在没有 resetsAt 时才退回到它。
  if (window?.resetsAt != null)
    return Math.round((window.resetsAt - Date.now()) / 1000);
  return window?.resetAfterSeconds ?? null;
}

export function formatResetCountdown(window?: RateLimitWindow | null): string {
  const seconds = resetCountdownSeconds(window);
  if (seconds == null) return "";
  if (seconds <= 0) return RESET_IMMINENT;
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.max(1, Math.round(seconds / 3600))}h`;
  return `${Math.max(1, Math.round(seconds / 86_400))}d`;
}

/** 「5h 后重置」/「即将重置」/「」，直接可渲染的完整文案。 */
export function formatResetLabel(window?: RateLimitWindow | null): string {
  const countdown = formatResetCountdown(window);
  if (!countdown) return "";
  return countdown === RESET_IMMINENT ? countdown : `${countdown} 后重置`;
}

export function formatWindowLength(minutes?: number) {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return "";
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export interface QuotaWindowRow {
  id: string;
  /** 窗口标签：有时长用时长（5h / 7d），否则退回窗口名。 */
  label: string;
  window: RateLimitWindow;
  durationMins?: number;
  /** 剩余百分比，越小越容易触顶。 */
  remaining: number;
}

/**
 * 有剩余数据的额度窗口按「更容易触顶」排序：剩余百分比最低在前，
 * 并列时短窗口优先。首页只取前两个展示（通常就是 5h 和 7d）。
 */
export function rankedQuotaWindows(limits?: RateLimits | null): QuotaWindowRow[] {
  const rows: QuotaWindowRow[] = [];
  const push = (id: string, name: string, window?: RateLimitWindow) => {
    const remaining = remainingPercent(window?.usedPercent);
    if (!window || remaining == null) return;
    rows.push({
      id,
      label: formatWindowLength(window.windowDurationMins) || name,
      window,
      durationMins: window.windowDurationMins,
      remaining,
    });
  };
  push("primary", "主窗口", limits?.primary);
  push("secondary", "次窗口", limits?.secondary);
  push("monthly", "月度", limits?.monthly);
  for (const [id, window] of Object.entries(limits?.byLimitId || {}))
    push(`limit:${id}`, id, window);
  rows.sort(
    (a, b) =>
      a.remaining - b.remaining ||
      (a.durationMins ?? Number.MAX_SAFE_INTEGER) -
        (b.durationMins ?? Number.MAX_SAFE_INTEGER),
  );
  return rows;
}

export function usageWindow(limits?: RateLimits | null) {
  return rankedQuotaWindows(limits)[0]?.window;
}

export function remainingPercent(usedPercent?: number) {
  if (usedPercent == null || !Number.isFinite(usedPercent)) return undefined;
  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

export function usageChipMetric(
  limits?: RateLimits | null,
  error?: string,
): string {
  const window = usageWindow(limits);
  if (error || !window || window.usedPercent == null) return USAGE_UNAVAILABLE;
  const pct = remainingPercent(window.usedPercent)!;
  const reset = formatResetCountdown(window);
  return reset ? `${pct}% · ${reset}` : `${pct}%`;
}

export function usageTone(limits?: RateLimits | null) {
  const window = usageWindow(limits);
  const pct = window?.usedPercent ?? 0;
  if (window?.reached || pct >= 100 || limits?.spendControlReached)
    return "danger";
  if (pct >= 85) return "warn";
  return "ok";
}

const DAY_MS = 86_400_000;
const MONTH_MINS = 30 * 24 * 60;

export interface AccountQuotaEstimate {
  /** 命中窗口（月度 > 周度 > 主窗口）内实测消耗的 token。 */
  stageTokens: number;
  /** 阶段用量 / 已用百分比反推出的该窗口总额度。 */
  windowQuota: number;
  /** 按窗口长度放大到一个月（30 天）的估算额度。 */
  monthlyQuota: number;
  usedPercent: number;
  windowLabel: string;
}

/**
 * 用「窗口内实测阶段用量 ÷ 官方已用百分比」反推帐号额度。
 * rateLimits 只给百分比不给绝对量，分子来自按天累计的 token 消耗，
 * 阶段覆盖不到一天粒度时按 UTC 日桶与窗口时间重叠计入。
 */
export function estimateAccountQuota(
  limits?: RateLimits | null,
  daily?: Record<string, number>,
): AccountQuotaEstimate | undefined {
  const window = limits?.monthly || limits?.secondary || limits?.primary;
  const usedPercent = window?.usedPercent;
  const windowMins = window?.windowDurationMins;
  if (
    !window ||
    usedPercent == null ||
    usedPercent <= 0 ||
    !windowMins ||
    windowMins <= 0 ||
    !daily
  )
    return undefined;
  const end =
    window.resetsAt ??
    (window.resetAfterSeconds != null
      ? Date.now() + window.resetAfterSeconds * 1000
      : undefined);
  const start = end != null ? end - windowMins * 60_000 : Date.now() - windowMins * 60_000;
  let stageTokens = 0;
  for (const [day, tokens] of Object.entries(daily)) {
    const dayStart = Date.parse(`${day}T00:00:00Z`);
    if (!Number.isFinite(dayStart) || !tokens) continue;
    if (dayStart + DAY_MS > start && dayStart < (end ?? Date.now()))
      stageTokens += tokens;
  }
  if (!stageTokens) return undefined;
  const windowQuota = stageTokens / (usedPercent / 100);
  return {
    stageTokens,
    windowQuota,
    monthlyQuota: windowQuota * (MONTH_MINS / windowMins),
    usedPercent,
    windowLabel: formatWindowLength(windowMins) || "窗口",
  };
}
