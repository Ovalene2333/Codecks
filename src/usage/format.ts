import type { RateLimitWindow, RateLimits } from "../types";

export const OFFICIAL_USAGE_TITLE = "Official 账号额度";
export const USAGE_UNAVAILABLE = "额度不可用";

export function formatResetCountdown(
  window?: RateLimitWindow | null,
): string {
  let seconds = window?.resetAfterSeconds;
  if (seconds == null && window?.resetsAt)
    seconds = Math.max(0, Math.round((window.resetsAt - Date.now()) / 1000));
  if (seconds == null) return "";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.max(1, Math.round(seconds / 3600))}h`;
  return `${Math.max(1, Math.round(seconds / 86_400))}d`;
}

export function formatWindowLength(minutes?: number) {
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return "";
  if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function usageWindow(limits?: RateLimits | null) {
  if (limits?.primary?.usedPercent != null) return limits.primary;
  if (limits?.secondary?.usedPercent != null) return limits.secondary;
  if (limits?.monthly?.usedPercent != null) return limits.monthly;
  const extra = limits?.byLimitId ? Object.values(limits.byLimitId) : [];
  return extra.find((window) => window.usedPercent != null);
}

export function usageChipMetric(
  limits?: RateLimits | null,
  error?: string,
): string {
  const window = usageWindow(limits);
  if (error || !window || window.usedPercent == null) return USAGE_UNAVAILABLE;
  const pct = Math.round(window.usedPercent);
  const reset = formatResetCountdown(window);
  return reset ? `${pct}% · ${reset}` : `${pct}%`;
}

export function usageTone(limits?: RateLimits | null) {
  const window = usageWindow(limits);
  const pct = window?.usedPercent ?? 0;
  if (window?.reached || pct >= 100 || limits?.spendControlReached) return "danger";
  if (pct >= 85) return "warn";
  return "ok";
}
