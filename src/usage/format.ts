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

export function usageChipMetric(
  limits?: RateLimits | null,
  error?: string,
): string {
  if (error || !limits?.primary || limits.primary.usedPercent == null)
    return USAGE_UNAVAILABLE;
  const pct = Math.round(limits.primary.usedPercent);
  const reset = formatResetCountdown(limits.primary);
  return reset ? `${pct}% · ${reset}` : `${pct}%`;
}

export function usageTone(limits?: RateLimits | null) {
  const pct = limits?.primary?.usedPercent ?? 0;
  if (limits?.primary?.reached || pct >= 100) return "danger";
  if (pct >= 85) return "warn";
  return "ok";
}
