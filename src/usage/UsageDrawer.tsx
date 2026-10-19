import { useCallback, useEffect, useMemo, useState } from "react";
import { Clock3, Folder, Gauge, MessageSquare, RefreshCw } from "lucide-react";
import type { ProjectRecord, RuntimeSnapshot, ThreadSummary } from "../types";
import {
  CODEX_QUOTA_TITLE,
  estimateAccountQuota,
  formatResetLabel,
  formatWindowLength,
  remainingPercent,
} from "./format";
import { Drawer } from "../ui";
import { Empty, Seg, Tip } from "../kit";
import { formatTokens, relativeTime } from "../format";
import { buildUsageStats, type UsageTotals } from "./stats";
import { estimateCost, formatCost, planPrice } from "./cost";

import type { UsageView } from "./UsageChip";

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
      <Seg<UsageView>
        label="用量视图"
        className="usage-tabs"
        value={tab}
        onChange={setTab}
        items={[
          { value: "stats", label: "统计" },
          { value: "limits", label: CODEX_QUOTA_TITLE },
        ]}
      />
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
        <p className="usage-note">按公开 API 目录价折算。</p>
      </section>
      <Seg<"projects" | "sessions">
        label="统计层级"
        className="usage-level"
        value={level}
        onChange={setLevel}
        items={[
          {
            value: "projects",
            label: (
              <>
                项目 <em>{stats.projects.length}</em>
              </>
            ),
          },
          {
            value: "sessions",
            label: (
              <>
                会话 <em>{stats.sessions.length}</em>
              </>
            ),
          },
        ]}
      />
      {rows.length ? (
        <div className="usage-ranking">
          {level === "projects"
            ? stats.projects.map((row) => (
                <UsageRow
                  key={row.key}
                  icon={<Folder />}
                  title={row.name}
                  subtitle={`${row.sessionCount} 个会话，${row.cwd}`}
                  totals={row.totals}
                  max={max}
                />
              ))
            : stats.sessions.map((row) => (
                <UsageRow
                  key={row.key}
                  icon={<MessageSquare />}
                  title={row.thread.name}
                  subtitle={`${relativeTime(row.thread.updatedAt)}，${row.thread.model}`}
                  totals={row.totals}
                  max={max}
                  current={row.key === currentSessionKey}
                />
              ))}
        </div>
      ) : (
        <Empty
          compact
          icon={<Gauge />}
          title="暂无会话用量"
          desc="运行一次任务后，累计 Token 会显示在这里。"
        />
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
      {details.length ? <p>{details.join("，")}</p> : null}
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
  const plan = limits?.planName || runtime?.account?.planType;
  const planName = plan
    ? plan.charAt(0).toUpperCase() + plan.slice(1)
    : "Codex";
  const price = planPrice(plan);
  const quota = estimateAccountQuota(runtime?.accountQuotaSamples);
  return (
    <div className="usage-limits">
      <div className="quota-account">
        <div className="quota-account-icon">
          <Gauge aria-hidden="true" />
        </div>
        <div className="quota-account-info">
          <div className="quota-plan-name">
            {planName}
            <span>{price != null ? `$${price}/月` : "官方账号"}</span>
          </div>
          <p>{runtime?.account?.email || "ChatGPT 账号额度"}</p>
        </div>
        <button
          type="button"
          className="quota-refresh"
          onClick={() => onRefresh(true)}
          disabled={refreshing}
          aria-label="刷新额度"
        >
          <RefreshCw className={refreshing ? "spin" : ""} aria-hidden="true" />
          <span>{refreshing ? "刷新中" : "刷新"}</span>
        </button>
      </div>
      <div className="quota-section-heading">
        <h3>可用额度</h3>
        <span>按窗口独立重置</span>
      </div>
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
          <UsageWindow label="主窗口" window={limits.primary} />
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
      {quota && !runtime?.rateLimitsError ? (
        <details className="quota-estimate">
          <summary>
            <span>账号额度估算</span>
            <strong>
              ≈ {formatCost(quota.windowCost)}{" "}
              <small>/{quota.windowLabel}</small>
            </strong>
          </summary>
          <p>
            本次观测在当前 {quota.windowLabel} 周期内消耗{" "}
            {formatTokens(quota.stageTokens)} Token，折算{" "}
            {formatCost(quota.stageCost)}，额度增加{" "}
            {quota.usedPercent.toFixed(1)} 个百分点。 据此估算本周期总额约{" "}
            {formatCost(quota.windowCost)}，约 {formatTokens(quota.windowQuota)}{" "}
            Token；按 30 天折算约 {formatCost(quota.monthlyCost)}/月。
            按模型目录价折算，仅供参考，并非订阅实际扣费。
          </p>
        </details>
      ) : null}
      {!quota && limits && !runtime?.rateLimitsError ? (
        <p className="usage-note">
          正在积累本周期的用量样本，额度百分比变化后显示估算。重置或重启后重新观测。
        </p>
      ) : null}
      <p className="usage-note quota-note">
        额度来自官方 ChatGPT 账号，与当前会话供应商无关。
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
    windowDurationMins?: number;
  };
}) {
  if (!window) return null;
  const usedPct =
    window.usedPercent != null ? Math.round(window.usedPercent) : null;
  const remainingPct = remainingPercent(window.usedPercent);
  const reset = formatResetLabel(window);
  const duration = formatWindowLength(window.windowDurationMins);
  const tone =
    window.reached || remainingPct === 0
      ? "danger"
      : (usedPct ?? 0) >= 85
        ? "hot"
        : "";
  return (
    <div className={`usage-window quota-window ${tone}`}>
      <div className="quota-window-heading">
        <b>{label}</b>
        {duration ? <span>{duration}窗口</span> : null}
      </div>
      <div className="quota-window-value">
        <strong>
          {remainingPct == null ? "—" : remainingPct}
          <small>{remainingPct == null ? "" : "%"}</small>
        </strong>
        <span>{window.reached ? "已达上限" : "剩余额度"}</span>
      </div>
      <div
        className="quota-track"
        role="meter"
        aria-label={`${label}剩余额度`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remainingPct ?? undefined}
        aria-valuetext={
          remainingPct == null ? "额度未知" : `剩余 ${remainingPct}%`
        }
      >
        <i style={{ width: `${remainingPct ?? 0}%` }} />
      </div>
      <div className="quota-window-reset">
        <Clock3 aria-hidden="true" />
        <span>{reset || "重置时间未知"}</span>
      </div>
    </div>
  );
}
