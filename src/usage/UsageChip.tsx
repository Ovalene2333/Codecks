import { useCallback, useEffect, useMemo, useState } from "react";
import { Folder, Gauge, MessageSquare } from "lucide-react";
import type { ProjectRecord, RuntimeSnapshot, ThreadSummary } from "../types";
import {
  CODEX_QUOTA_TITLE,
  estimateAccountQuota,
  formatResetLabel,
  formatWindowLength,
  remainingPercent,
  RESET_IMMINENT,
  usageChipMetric,
  usageTone,
  usageWindow,
  usageWindowLabel,
} from "./format";
import { Drawer } from "../ui";
import { Tip } from "../kit";
import { formatTokens, relativeTime } from "../format";
import { buildUsageStats, type UsageTotals } from "./stats";
import { estimateCost, formatCost, planPrice } from "./cost";

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
  const reset =
    pct != null && window ? formatResetLabel(window) : undefined;
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

export function UsageDrawer({
  runtime,
  threads,
  projects,
  currentSessionKey,
  initialView = "stats",
  onRefreshLimits,
  onClose,
}: {
  runtime?: RuntimeSnapshot;
  threads: ThreadSummary[];
  projects?: ProjectRecord[];
  currentSessionKey?: string;
  initialView?: UsageView;
  onRefreshLimits: (force?: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<UsageView>(initialView);
  const [refreshingLimits, setRefreshingLimits] = useState(false);
  const refreshLimits = useCallback(
    async (force = false) => {
      setRefreshingLimits(true);
      try {
        await onRefreshLimits(force);
      } finally {
        setRefreshingLimits(false);
      }
    },
    [onRefreshLimits],
  );

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
          {CODEX_QUOTA_TITLE}
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
  const cost = stats.sessions.reduce(
    (sum, row) =>
      sum +
      estimateCost(row.totals, row.thread.resolvedModel || row.thread.model),
    0,
  );

  return (
    <div className="usage-stats">
      <section className="usage-summary" aria-label="累计 Token 用量">
        <span>累计 Token</span>
        <strong>{formatTokens(stats.totals.total)}</strong>
        <div className="usage-summary-grid">
          <UsageMetric label="输入" value={stats.totals.input} />
          <UsageMetric label="缓存输入" value={stats.totals.cachedInput} />
          <UsageMetric label="输出" value={stats.totals.output} />
        </div>
      </section>
      <section className="usage-summary usage-cost" aria-label="估算费用">
        <span>估算费用</span>
        <strong>{formatCost(cost)}</strong>
        <p className="usage-note">
          按公开 API 目录价折算，仅供参考。
        </p>
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
          <b>暂无会话用量</b>
          <span>运行一次任务后，累计 Token 会显示在这里。</span>
        </div>
      )}
      {stats.totals.reasoningOutput > 0 ? (
        <p className="usage-note">
          {`推理输出 ${formatTokens(stats.totals.reasoningOutput)}，已包含在输出或总量中。`}
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
  onRefresh: (force?: boolean) => void;
}) {
  const limits = runtime?.rateLimits;
  const extra = limits?.byLimitId ? Object.entries(limits.byLimitId) : [];
  const primaryLength = formatWindowLength(limits?.primary?.windowDurationMins);
  const plan = limits?.planName || runtime?.account?.planType;
  const planName = plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : "Codex";
  const price = planPrice(plan);
  const quota = estimateAccountQuota(limits, runtime?.accountUsageDaily);
  return (
    <div className="usage-limits">
      <p className="usage-plan">
        {planName}
        {price != null ? ` · $${price}/月` : ""}
        {runtime?.account?.email ? ` · ${runtime.account.email}` : ""}
      </p>
      {quota ? (
        <p className="usage-plan" title="阶段用量 ÷ 窗口已用百分比，按窗口长度放大到一个月">
          {`估算本期额度 ≈ ${formatTokens(quota.monthlyQuota)} Token/月（${quota.windowLabel}窗口实测 ${formatTokens(quota.stageTokens)} Token ≈ ${Math.round(quota.usedPercent)}%）`}
        </p>
      ) : null}
      {runtime?.rateLimitsError || !limits ? (
        <div className="usage-unavailable" aria-live="polite">
          <p>
            {refreshing
              ? `正在读取 ${CODEX_QUOTA_TITLE}…`
              : runtime?.rateLimitsError || "额度不可用"}
          </p>
          <button
            type="button"
            onClick={() => onRefresh(true)}
            disabled={refreshing}
          >
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
        额度按官方 ChatGPT 登录计算，与当前会话使用的供应商无关。
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
  const reset = formatResetLabel(window);
  return (
    <div
      className={`usage-window ${window.reached || (usedPct ?? 0) >= 85 ? "hot" : ""}`}
    >
      <div>
        <b>{label}</b>
        <small>{reset || "重置时间未知"}</small>
      </div>
      <strong>{remainingPct == null ? "—" : `剩余 ${remainingPct}%`}</strong>
      <div className="context-track">
        <i style={{ width: `${remainingPct || 0}%` }} />
      </div>
    </div>
  );
}
