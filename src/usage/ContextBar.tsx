import { formatTokens } from "../format";
import type { TokenUsage } from "../types";

export function ContextBar({
  usage,
  compacting,
  onCompact,
  showUnknown = false,
}: {
  usage?: TokenUsage;
  compacting?: boolean;
  onCompact?: () => void;
  showUnknown?: boolean;
}) {
  const hasData = usage?.used != null || usage?.limit != null;
  if (!hasData && onCompact && !showUnknown)
    return (
      <button
        type="button"
        className="text-btn compact-btn"
        onClick={onCompact}
        disabled={compacting}
      >
        压缩
      </button>
    );
  const pct =
    usage?.limit && usage.limit > 0
      ? Math.min(100, Math.round(((usage.used || 0) / usage.limit) * 100))
      : undefined;
  const label =
    usage?.used != null && usage.limit != null
      ? `${formatTokens(usage.used)}/${formatTokens(usage.limit)}`
      : pct != null
        ? `${pct}%`
        : "";
  if (!hasData && !showUnknown) return null;
  return (
    <div className={`context-bar ${compacting ? "pulse" : ""}`}>
      <div className="context-track">
        <i style={{ width: `${pct || 0}%` }} />
      </div>
      <span>{label || "--/--"}</span>
      {onCompact ? (
        <button
          type="button"
          className="text-btn compact-btn"
          onClick={onCompact}
          disabled={compacting}
        >
          压缩
        </button>
      ) : null}
    </div>
  );
}
