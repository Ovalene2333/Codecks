import { Minimize2 } from "lucide-react";
import { Button } from "../kit";
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
      <Button
        variant="ghost"
        size="sm"
        className="compact-btn"
        busy={compacting}
        onClick={onCompact}
      >
        压缩
      </Button>
    );
  const pct =
    usage?.used != null && usage.limit && usage.limit > 0
      ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
      : undefined;
  const label =
    usage?.used != null && usage.limit != null
      ? `${formatTokens(usage.used)}/${formatTokens(usage.limit)}`
      : usage?.used != null
        ? formatTokens(usage.used)
        : usage?.limit != null
          ? `--/${formatTokens(usage.limit)}`
          : "";
  if (!hasData && !showUnknown) return null;
  return (
    <div className={`context-bar ${compacting ? "pulse" : ""}`}>
      <div className="context-track">
        <i style={{ width: `${pct || 0}%` }} />
      </div>
      <span title={label || "上下文未知"}>
        {pct != null ? `${pct}%` : label || "--/--"}
      </span>
      {onCompact ? (
        <Button
          variant="ghost"
          size="sm"
          className="compact-btn"
          busy={compacting}
          onClick={onCompact}
          title="压缩上下文"
          aria-label="压缩上下文"
        >
          <Minimize2 />
        </Button>
      ) : null}
    </div>
  );
}
