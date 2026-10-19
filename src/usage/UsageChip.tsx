import { Gauge } from "lucide-react";
import type { RuntimeSnapshot } from "../types";
import {
  CODEX_QUOTA_TITLE,
  formatResetLabel,
  remainingPercent,
  RESET_IMMINENT,
  usageChipMetric,
  usageTone,
  usageWindow,
  usageWindowLabel,
} from "./format";
import { Tip } from "../kit";

export type UsageView = "stats" | "limits";

export function UsageChip({
  runtime,
  onOpen,
}: {
  runtime?: RuntimeSnapshot;
  onOpen: () => void;
}) {
  const window = usageWindow(runtime?.rateLimits);
  const windowLabel = usageWindowLabel(runtime?.rateLimits);
  const metric = usageChipMetric(runtime?.rateLimits, runtime?.rateLimitsError);
  const tone = runtime?.rateLimits ? usageTone(runtime.rateLimits) : "muted";
  const pct =
    runtime?.rateLimitsError || !window
      ? undefined
      : remainingPercent(window.usedPercent);
  // 只有算出未来时间的倒计时才进提示；过期快照的“即将重置”不再打扰收起态。
  const reset = pct != null && window ? formatResetLabel(window) : undefined;
  const resetText = reset && reset !== RESET_IMMINENT ? `（${reset}）` : "";
  const tipText =
    pct != null
      ? `${CODEX_QUOTA_TITLE} · 剩余 ${pct}% · ${windowLabel || "当前"}窗口${resetText}`
      : `${CODEX_QUOTA_TITLE} · ${metric}`;
  return (
    <Tip content={tipText} align="start">
      <button
        type="button"
        className={`usage-chip ${tone}${pct != null ? " has-track" : ""}`}
        aria-label={tipText}
        onClick={onOpen}
      >
        <Gauge className="usage-chip-icon" aria-hidden="true" />
        <span className="usage-chip-label">{CODEX_QUOTA_TITLE}</span>
        <span className="usage-chip-metric">
          {pct != null ? (
            <>
              {pct}%
              {windowLabel ? (
                <span className="usage-chip-window">{windowLabel}</span>
              ) : null}
            </>
          ) : (
            "—"
          )}
        </span>
        {pct != null ? (
          <i className="usage-chip-track" aria-hidden="true">
            <b style={{ width: `${pct}%` }} />
          </i>
        ) : null}
      </button>
    </Tip>
  );
}
