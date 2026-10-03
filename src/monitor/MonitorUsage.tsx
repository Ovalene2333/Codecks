import { useMemo, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { formatTokens, sessionKey } from "../format";
import type { RateLimitWindow, RuntimeSnapshot, ThreadSummary } from "../types";
import { estimateCost, formatCost } from "../usage/cost";
import {
  formatResetLabel,
  rankedQuotaWindows,
  remainingPercent,
} from "../usage/format";
import { buildUsageStats } from "../usage/stats";
import type { UsageView } from "../usage/UsageChip";
import { contextPercent, contextTone } from "./activity";

const CONTEXT_ALERT = 80;

function LimitRow({ label, window }: { label: string; window?: RateLimitWindow }) {
  const left = remainingPercent(window?.usedPercent);
  if (left == null) return null;
  const tone =
    window?.reached || left <= 0 ? "danger" : left <= 15 ? "warn" : "";
  const reset = formatResetLabel(window);
  return (
    <div className={`monitor-meter ${tone}`}>
      <div className="monitor-meter-label">
        <span>{label}</span>
        <b>剩余 {left}%</b>
        {reset ? <small>{reset}</small> : null}
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
  // 按会话排行的用量在「明细」抽屉里看，首页右栏只留总量、额度和需要处理的上下文。
  const { totals, cost, crowded } = useMemo(() => {
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
      crowded,
    };
  }, [threads]);
  const limits = runtime?.rateLimits;
  // 只展示最容易触顶的两个窗口（一般就是 5h 和 7d），按窗口时长短到长排。
  const quotaRows = rankedQuotaWindows(limits)
    .slice(0, 2)
    .sort(
      (a, b) =>
        (a.durationMins ?? Number.MAX_SAFE_INTEGER) -
          (b.durationMins ?? Number.MAX_SAFE_INTEGER) ||
        a.remaining - b.remaining,
    );
  const plan = limits?.planName || runtime?.account?.planType;
  const planLabel = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "";
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
            <span>Codex{planLabel ? ` ${planLabel}` : ""} 额度</span>
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
              {quotaRows.map((row) => (
                <LimitRow key={row.id} label={row.label} window={row.window} />
              ))}
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
    </section>
  );
}
