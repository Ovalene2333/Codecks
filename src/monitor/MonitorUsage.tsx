import { useMemo, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { formatTokens, sessionKey } from "../format";
import type { RateLimitWindow, RuntimeSnapshot, ThreadSummary } from "../types";
import { estimateCost, formatCost } from "../usage/cost";
import {
  formatResetCountdown,
  formatWindowLength,
  remainingPercent,
} from "../usage/format";
import { buildUsageStats } from "../usage/stats";
import type { UsageView } from "../usage/UsageChip";
import { contextPercent, contextTone } from "./activity";

const TOP_SESSIONS = 3;
const CONTEXT_ALERT = 80;

function LimitRow({ label, window }: { label: string; window?: RateLimitWindow }) {
  const left = remainingPercent(window?.usedPercent);
  if (left == null) return null;
  const tone =
    window?.reached || left <= 0 ? "danger" : left <= 15 ? "warn" : "";
  const reset = formatResetCountdown(window);
  return (
    <div className={`monitor-meter ${tone}`}>
      <div className="monitor-meter-label">
        <span>{label}</span>
        <b>剩余 {left}%</b>
        {reset ? <small>{reset} 后重置</small> : null}
      </div>
      <i className="monitor-meter-track" aria-hidden="true">
        <b style={{ width: `${left}%` }} />
      </i>
    </div>
  );
}

export function MonitorUsage({
  threads,
  runtime,
  onSelect,
  onRefreshLimits,
  onOpenUsage,
}: {
  threads: ThreadSummary[];
  runtime?: RuntimeSnapshot;
  onSelect: (thread: ThreadSummary) => void;
  onRefreshLimits: (force?: boolean) => Promise<void>;
  onOpenUsage: (view: UsageView) => void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const { totals, cost, top, crowded } = useMemo(() => {
    const stats = buildUsageStats(threads);
    const cost = stats.sessions.reduce(
      (sum, row) =>
        sum + estimateCost(row.totals, row.thread.resolvedModel || row.thread.model),
      0,
    );
    const crowded = stats.sessions
      .map((row) => ({ thread: row.thread, percent: contextPercent(row.thread.tokenUsage) }))
      .filter((row) => row.percent != null && row.percent >= CONTEXT_ALERT)
      .sort((left, right) => right.percent! - left.percent!);
    return {
      totals: stats.totals,
      cost,
      top: stats.sessions.slice(0, TOP_SESSIONS),
      crowded,
    };
  }, [threads]);
  const limits = runtime?.rateLimits;
  const primary = formatWindowLength(limits?.primary?.windowDurationMins);
  const secondary = formatWindowLength(limits?.secondary?.windowDurationMins);
  const hasLimits = Boolean(limits || runtime?.rateLimitsError);
  const refresh = async () => {
    setRefreshing(true);
    try {
      await onRefreshLimits(true);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="monitor-panel monitor-usage" aria-label="用量与额度">
      <header className="monitor-panel-head">
        <Gauge aria-hidden="true" />
        <h2>用量与额度</h2>
        <button
          type="button"
          className="text-btn monitor-panel-link"
          onClick={() => onOpenUsage("stats")}
        >
          明细
        </button>
      </header>
      <div className="monitor-usage-totals">
        <div>
          <small>累计 Token</small>
          <b>{totals.total ? formatTokens(totals.total) : "—"}</b>
        </div>
        <div>
          <small>折算费用</small>
          <b>{cost > 0 ? `≈ ${formatCost(cost)}` : "—"}</b>
        </div>
      </div>
      {totals.total > 0 ? (
        <p className="monitor-usage-split">
          输入 {formatTokens(totals.input) || 0}
          {totals.cachedInput ? ` · 缓存 ${formatTokens(totals.cachedInput)}` : ""}
          {` · 输出 ${formatTokens(totals.output) || 0}`}
        </p>
      ) : null}
      {hasLimits ? (
        <div className="monitor-usage-block">
          <div className="monitor-usage-subhead">
            <span>{limits?.planName || runtime?.account?.planType || "Official"} 额度</span>
            <button
              type="button"
              className="icon-btn"
              onClick={refresh}
              disabled={refreshing}
              title="刷新额度"
              aria-label="刷新额度"
            >
              <RefreshCw className={refreshing ? "spin" : ""} />
            </button>
          </div>
          {runtime?.rateLimitsError || !limits ? (
            <p className="monitor-muted">{runtime?.rateLimitsError || "额度不可用"}</p>
          ) : (
            <>
              <LimitRow label={primary ? `主窗口 · ${primary}` : "主窗口"} window={limits.primary} />
              <LimitRow
                label={secondary ? `次窗口 · ${secondary}` : "次窗口"}
                window={limits.secondary}
              />
              <LimitRow label="月度" window={limits.monthly} />
            </>
          )}
        </div>
      ) : null}
      {crowded.length ? (
        <div className="monitor-usage-block">
          <div className="monitor-usage-subhead">
            <span>上下文将满</span>
          </div>
          {crowded.map(({ thread, percent }) => (
            <button
              type="button"
              key={sessionKey(thread)}
              className={`monitor-usage-row ${contextTone(percent)}`}
              onClick={() => onSelect(thread)}
            >
              <span title={thread.name}>{thread.name}</span>
              <b>{percent}%</b>
            </button>
          ))}
        </div>
      ) : null}
      {top.length ? (
        <div className="monitor-usage-block">
          <div className="monitor-usage-subhead">
            <span>用量最多</span>
          </div>
          {top.map((row) => (
            <button
              type="button"
              key={row.key}
              className="monitor-usage-row"
              onClick={() => onSelect(row.thread)}
            >
              <span title={row.thread.name}>{row.thread.name}</span>
              <b>{formatTokens(row.totals.total)}</b>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
