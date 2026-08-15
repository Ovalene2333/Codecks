import { useCallback, useEffect, useMemo, useState } from "react";
import { Folder, Gauge, MessageSquare } from "lucide-react";
import type { ProjectRecord, RuntimeSnapshot, ThreadSummary } from "../types";
import {
  formatResetCountdown,
  formatWindowLength,
  remainingPercent,
  usageChipMetric,
  usageTone,
} from "./format";
import { Drawer } from "../ui";
import { formatTokens, relativeTime } from "../format";
import { buildUsageStats, type UsageTotals } from "./stats";

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
      title="用量统计与 Official 额度"
      onClick={onOpen}
    >
      <Gauge />
      <span className="usage-chip-metric">{metric}</span>
    </button>
  );
}

export function UsageDrawer({
  runtime,
  threads,
  projects,
  currentSessionKey,
  onRefreshLimits,
  onClose,
}: {
  runtime?: RuntimeSnapshot;
  threads: ThreadSummary[];
  projects?: ProjectRecord[];
  currentSessionKey?: string;
  onRefreshLimits: () => Promise<void>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"stats" | "limits">("stats");
  const [refreshingLimits, setRefreshingLimits] = useState(false);
  const refreshLimits = useCallback(async () => {
    setRefreshingLimits(true);
    try {
      await onRefreshLimits();
    } finally {
      setRefreshingLimits(false);
    }
  }, [onRefreshLimits]);

  useEffect(() => {
    if (tab === "limits") void refreshLimits();
  }, [refreshLimits, tab]);

  return (
    <Drawer title="用量" onClose={onClose}>
      <div className="usage-tabs" role="tablist" aria-label="用量视图">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "stats"}
          className={tab === "stats" ? "on" : ""}
          onClick={() => setTab("stats")}
        >
          统计
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "limits"}
          className={tab === "limits" ? "on" : ""}
          onClick={() => setTab("limits")}
        >
          账号额度
        </button>
      </div>
      {tab === "stats" ? (
        <UsageStats
          threads={threads}
          projects={projects}
          currentSessionKey={currentSessionKey}
        />
      ) : (
        <OfficialLimits
          runtime={runtime}
          refreshing={refreshingLimits}
          onRefresh={refreshLimits}
        />
      )}
    </Drawer>
  );
}

function UsageStats({
  threads,
  projects,
  currentSessionKey,
}: {
  threads: ThreadSummary[];
  projects?: ProjectRecord[];
  currentSessionKey?: string;
}) {
  const [level, setLevel] = useState<"projects" | "sessions">("projects");
  const stats = useMemo(
    () => buildUsageStats(threads, projects),
    [threads, projects],
  );
  const rows = level === "projects" ? stats.projects : stats.sessions;
  const max = rows[0]?.totals.total || 0;

  return (
    <div className="usage-stats">
      <section className="usage-summary" aria-label="累计 token 用量">
        <span>累计 token</span>
        <strong>{formatTokens(stats.totals.total)}</strong>
        <div className="usage-summary-grid">
          <UsageMetric label="输入" value={stats.totals.input} />
          <UsageMetric label="缓存输入" value={stats.totals.cachedInput} />
          <UsageMetric label="输出" value={stats.totals.output} />
        </div>
      </section>
      <div className="usage-level" role="tablist" aria-label="统计层级">
        <button
          type="button"
          role="tab"
          aria-selected={level === "projects"}
          className={level === "projects" ? "on" : ""}
          onClick={() => setLevel("projects")}
        >
          项目 <em>{stats.projects.length}</em>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={level === "sessions"}
          className={level === "sessions" ? "on" : ""}
          onClick={() => setLevel("sessions")}
        >
          会话 <em>{stats.sessions.length}</em>
        </button>
      </div>
      {rows.length ? (
        <div className="usage-ranking">
          {level === "projects"
            ? stats.projects.map((row) => (
                <UsageRow
                  key={row.key}
                  icon={<Folder />}
                  title={row.name}
                  subtitle={`${row.sessionCount} 个会话 · ${row.cwd}`}
                  totals={row.totals}
                  max={max}
                />
              ))
            : stats.sessions.map((row) => (
                <UsageRow
                  key={row.key}
                  icon={<MessageSquare />}
                  title={row.thread.name}
                  subtitle={`${relativeTime(row.thread.updatedAt)} · ${row.thread.model}`}
                  totals={row.totals}
                  max={max}
                  current={row.key === currentSessionKey}
                />
              ))}
        </div>
      ) : (
        <div className="usage-empty">
          <Gauge />
          <b>暂无 session 用量</b>
          <span>运行一次任务后，累计 token 会显示在这里。</span>
        </div>
      )}
      {stats.totals.reasoningOutput > 0 ? (
        <p className="usage-note">
          推理输出 {formatTokens(stats.totals.reasoningOutput)}
          ，已包含在输出或总量中。
        </p>
      ) : null}
    </div>
  );
}

function UsageMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <small>{label}</small>
      <b>{value ? formatTokens(value) : "—"}</b>
    </div>
  );
}

function UsageRow({
  icon,
  title,
  subtitle,
  totals,
  max,
  current,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  totals: UsageTotals;
  max: number;
  current?: boolean;
}) {
  const width = max ? Math.max(3, (totals.total / max) * 100) : 0;
  const details = [
    totals.input ? `输入 ${formatTokens(totals.input)}` : "",
    totals.cachedInput ? `缓存 ${formatTokens(totals.cachedInput)}` : "",
    totals.output ? `输出 ${formatTokens(totals.output)}` : "",
  ].filter(Boolean);
  return (
    <div className={`usage-rank-row ${current ? "current" : ""}`}>
      <div className="usage-rank-main">
        <span className="usage-rank-icon">{icon}</span>
        <div>
          <b title={title}>{title}</b>
          <small title={subtitle}>{subtitle}</small>
        </div>
        {current ? <em>当前</em> : null}
        <strong>{formatTokens(totals.total)}</strong>
      </div>
      <div className="usage-rank-track">
        <i style={{ width: `${width}%` }} />
      </div>
      {details.length ? <p>{details.join(" · ")}</p> : null}
    </div>
  );
}

function OfficialLimits({
  runtime,
  refreshing,
  onRefresh,
}: {
  runtime?: RuntimeSnapshot;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const limits = runtime?.rateLimits;
  const extra = limits?.byLimitId ? Object.entries(limits.byLimitId) : [];
  const primaryLength = formatWindowLength(limits?.primary?.windowDurationMins);
  return (
    <div className="usage-limits">
      <p className="usage-plan">
        {limits?.planName || runtime?.account?.planType || "Official"}
        {runtime?.account?.email ? ` · ${runtime.account.email}` : ""}
      </p>
      {runtime?.rateLimitsError || !limits ? (
        <div className="usage-unavailable" aria-live="polite">
          <p>
            {refreshing
              ? "正在读取 Official 账号额度…"
              : runtime?.rateLimitsError || "额度不可用"}
          </p>
          <button type="button" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "刷新中…" : "重新读取"}
          </button>
        </div>
      ) : (
        <div className="usage-windows">
          <UsageWindow
            label={primaryLength ? `主窗口 · ${primaryLength}` : "主窗口"}
            window={limits.primary}
          />
          <UsageWindow label="次窗口" window={limits.secondary} />
          <UsageWindow label="月度额度" window={limits.monthly} />
          {extra.map(([id, window]) => (
            <UsageWindow key={id} label={id} window={window} />
          ))}
          {limits.resetCredits != null ? (
            <p className="usage-session">可用重置次数：{limits.resetCredits}</p>
          ) : null}
          {limits.spendControlReached ? (
            <p className="usage-unavailable">已触及消费控制上限</p>
          ) : null}
        </div>
      )}
      <p className="usage-note">
        额度来自 Runtime 的 Official ChatGPT 登录，不是当前 session
        的中转供应商。
      </p>
    </div>
  );
}

function UsageWindow({
  label,
  window,
}: {
  label: string;
  window?: {
    usedPercent?: number;
    reached?: boolean;
    resetAfterSeconds?: number;
    resetsAt?: number;
  };
}) {
  if (!window) return null;
  const usedPct =
    window.usedPercent != null ? Math.round(window.usedPercent) : null;
  const remainingPct = remainingPercent(window.usedPercent);
  const reset = formatResetCountdown(window);
  return (
    <div
      className={`usage-window ${window.reached || (usedPct ?? 0) >= 85 ? "hot" : ""}`}
    >
      <div>
        <b>{label}</b>
        <small>{reset ? `重置 ${reset}` : "重置时间未知"}</small>
      </div>
      <strong>{remainingPct == null ? "—" : `剩余 ${remainingPct}%`}</strong>
      <div className="context-track">
        <i style={{ width: `${remainingPct || 0}%` }} />
      </div>
    </div>
  );
}
