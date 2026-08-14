import { Gauge } from "lucide-react";
import type { RuntimeSnapshot, TokenUsage } from "../types";
import {
  formatResetCountdown,
  OFFICIAL_USAGE_TITLE,
  usageChipMetric,
  usageTone,
} from "./format";
import { Drawer } from "../ui";
import { formatTokens } from "../format";

export function UsageChip({
  runtime,
  onOpen,
}: {
  runtime?: RuntimeSnapshot;
  onOpen: () => void;
}) {
  const metric = usageChipMetric(runtime?.rateLimits, runtime?.rateLimitsError);
  const tone = runtime?.rateLimits ? usageTone(runtime.rateLimits) : "muted";
  return (
    <button
      type="button"
      className={`usage-chip ${tone}`}
      title={OFFICIAL_USAGE_TITLE}
      onClick={onOpen}
    >
      <Gauge />
      <span className="usage-chip-metric">{metric}</span>
    </button>
  );
}

export function UsageDrawer({
  runtime,
  sessionUsage,
  onClose,
}: {
  runtime?: RuntimeSnapshot;
  sessionUsage?: TokenUsage;
  onClose: () => void;
}) {
  const limits = runtime?.rateLimits;
  const extra = limits?.byLimitId
    ? Object.entries(limits.byLimitId)
    : [];
  return (
    <Drawer title={OFFICIAL_USAGE_TITLE} onClose={onClose}>
      <p className="usage-plan">
        {limits?.planName || runtime?.account?.planType || "Official"}
        {runtime?.account?.email ? ` · ${runtime.account.email}` : ""}
      </p>
      {runtime?.rateLimitsError || !limits ? (
        <p className="usage-unavailable">
          {runtime?.rateLimitsError || "额度不可用"}
        </p>
      ) : (
        <div className="usage-windows">
          <UsageWindow label="主窗口" window={limits.primary} />
          <UsageWindow label="次窗口" window={limits.secondary} />
          {extra.map(([id, window]) => (
            <UsageWindow key={id} label={id} window={window} />
          ))}
        </div>
      )}
      {sessionUsage && (sessionUsage.used != null || sessionUsage.limit != null) && (
        <p className="usage-session">
          当前会话 token：
          {sessionUsage.used != null ? formatTokens(sessionUsage.used) : "—"}
          {sessionUsage.limit != null ? ` / ${formatTokens(sessionUsage.limit)}` : ""}
        </p>
      )}
      <p className="usage-note">
        额度来自 Runtime 的 Official ChatGPT 登录，不是当前 Session 的中转供应商。
      </p>
    </Drawer>
  );
}

function UsageWindow({
  label,
  window,
}: {
  label: string;
  window?: { usedPercent?: number; reached?: boolean; resetAfterSeconds?: number; resetsAt?: number };
}) {
  if (!window) return null;
  const pct = window.usedPercent != null ? Math.round(window.usedPercent) : null;
  const reset = formatResetCountdown(window);
  return (
    <div className={`usage-window ${window.reached || (pct ?? 0) >= 85 ? "hot" : ""}`}>
      <div>
        <b>{label}</b>
        <small>{reset ? `重置 ${reset}` : "重置时间未知"}</small>
      </div>
      <strong>{pct == null ? "—" : `${pct}%`}</strong>
      <div className="context-track">
        <i style={{ width: `${pct || 0}%` }} />
      </div>
    </div>
  );
}
