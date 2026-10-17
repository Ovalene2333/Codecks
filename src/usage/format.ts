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
export function rankedQuotaWindows(
  limits?: RateLimits | null,
): QuotaWindowRow[] {
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
  push("monthly", "月度额度", limits?.monthly);
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

/**
 * 收起态（侧栏芯片、欢迎页）显示的窗口短标签，如 5h / 7d / 月度额度。
 * 注意：这里故意不用重置倒计时——快照过期时倒计时恒为“即将重置”，
 * 且缺数据时直接消失；窗口时长一定有值，收起态显示更稳定。
 */
export function usageWindowLabel(limits?: RateLimits | null): string {
  return rankedQuotaWindows(limits)[0]?.label || "";
}

export function remainingPercent(usedPercent?: number) {
  if (usedPercent == null || !Number.isFinite(usedPercent)) return undefined;
  return Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
}

export function usageChipMetric(
  limits?: RateLimits | null,
  error?: string,
): string {
  const rows = rankedQuotaWindows(limits);
  const window = rows[0]?.window;
  if (error || !window || window.usedPercent == null) return USAGE_UNAVAILABLE;
  const pct = remainingPercent(window.usedPercent)!;
  const label = rows[0]?.label || "";
  return label ? `${pct}% · ${label}` : `${pct}%`;
}

export function usageTone(limits?: RateLimits | null) {
  const window = usageWindow(limits);
  const pct = window?.usedPercent ?? 0;
  if (window?.reached || pct >= 100 || limits?.spendControlReached)
    return "danger";
  if (pct >= 85) return "warn";
  return "ok";
}

const MONTH_MINS = 30 * 24 * 60;

export interface AccountQuotaSample {
  stageTokens: number;
  stageCost: number;
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface AccountQuotaEstimate {
  stageTokens: number;
  stageCost: number;
  windowQuota: number;
  windowCost: number;
  monthlyQuota: number;
  monthlyCost: number;
  usedPercent: number;
  windowLabel: string;
}

/** 只用同一周期内配对采样的 token / 费用与额度百分比增量。 */
export function estimateAccountQuota(
  samples?: AccountQuotaSample[],
): AccountQuotaEstimate | undefined {
  const sample = samples
    ?.filter(
      (s) =>
        s.resetsAt > Date.now() &&
        s.usedPercent > 0 &&
        s.usedPercent <= 100 &&
        s.stageTokens > 0 &&
        s.stageCost >= 0 &&
        s.windowDurationMins > 0,
    )
    .sort((a, b) => b.windowDurationMins - a.windowDurationMins)[0];
  if (!sample) return undefined;
  const windowQuota = sample.stageTokens / (sample.usedPercent / 100);
  const windowCost = sample.stageCost / (sample.usedPercent / 100);
  return {
    ...sample,
    windowQuota,
    windowCost,
    monthlyQuota: (windowQuota * MONTH_MINS) / sample.windowDurationMins,
    monthlyCost: (windowCost * MONTH_MINS) / sample.windowDurationMins,
    windowLabel: formatWindowLength(sample.windowDurationMins) || "窗口",
  };
}
