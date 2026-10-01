import { useEffect, useState } from "react";
import { HeartPulse } from "lucide-react";
import { api } from "../api";
import type { AgentDescriptor, HostStats, Provider, ThreadSummary } from "../types";
import { formatBytes, formatDuration } from "./activity";
import { agentHealth, sessionHealth } from "./health";

const HOST_POLL_MS = 5_000;

/** 只在监控台打开且页面可见时轮询本机资源，切到后台即停。 */
function useHostStats() {
  const [stats, setStats] = useState<HostStats>();
  const [error, setError] = useState("");
  useEffect(() => {
    let timer: number | undefined;
    let stopped = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await api<HostStats>("/monitor/host");
        if (stopped) return;
        // 旧版服务端没有这个接口，请求会落到 index.html 兜底，拿到的不是 JSON。
        if (typeof next?.memTotal !== "number" || !next.deck) {
          setStats(undefined);
          setError("服务端版本较旧，重启 Deck 后可查看本机资源");
          return;
        }
        setStats(next);
        setError("");
      } catch (loadError: any) {
        if (!stopped) setError(loadError?.message || "本机状态读取失败");
      }
    };
    const onVisibility = () => void load();
    void load();
    timer = window.setInterval(load, HOST_POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return { stats, error };
}

function Meter({ label, value, percent }: { label: string; value: string; percent?: number }) {
  const tone = percent == null ? "" : percent >= 90 ? "danger" : percent >= 75 ? "warn" : "";
  return (
    <div className={`monitor-meter ${tone}`}>
      <div className="monitor-meter-label">
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <i className="monitor-meter-track" aria-hidden="true">
        <b style={{ width: `${percent ?? 0}%` }} />
      </i>
    </div>
  );
}

export function MonitorHealth({
  agents,
  providers,
  threads,
  onOpenAgentSettings,
}: {
  agents: AgentDescriptor[];
  providers: Provider[];
  threads: ThreadSummary[];
  /** 打开设置的 Agent 页（启用/停用/重载）。 */
  onOpenAgentSettings?: () => void;
}) {
  const { stats, error } = useHostStats();
  const sessions = sessionHealth(threads);
  const brokenProviders = providers.filter((provider) => provider.enabled && provider.error);
  const rows = agents.map((agent) => ({ agent, health: agentHealth(agent) }));
  // 未启用的 agent 不占列表高度，收进一行可展开的折叠区；原因在展开后或设置里能看到。
  const active = rows.filter((row) => row.health.tone !== "off");
  const inactive = rows.filter((row) => row.health.tone === "off");
  const memUsed = stats ? stats.memTotal - stats.memAvailable : undefined;
  const memPercent =
    stats && stats.memTotal > 0 ? Math.round((memUsed! / stats.memTotal) * 100) : undefined;
  const cpu = stats?.cpuPercent != null ? Math.round(stats.cpuPercent) : undefined;
  const sessionNotes = [
    sessions.locked ? `${sessions.locked} 个被其它进程占用` : "",
    sessions.offline ? `${sessions.offline} 个离线` : "",
    sessions.connected ? `${sessions.connected} 个 Claude 常驻连接` : "",
  ].filter(Boolean);

  const renderRow = ({ agent, health }: (typeof rows)[number]) => {
    const detail =
      health.tone === "error" || health.tone === "warn"
        ? agent.error || agent.historyError
        : health.note;
    return (
      <li key={agent.id} className={`tone-${health.tone}`}>
        <i aria-hidden="true" />
        <span>{agent.name}</span>
        <b>{health.label}</b>
        {detail ? (
          <small title={detail}>
            {health.tone === "ok" || health.tone === "busy" ? "最近错误：" : ""}
            {detail}
          </small>
        ) : null}
      </li>
    );
  };

  return (
    <section id="monitor-health" className="monitor-panel monitor-health" aria-label="运行健康">
      <header className="monitor-panel-head">
        <HeartPulse aria-hidden="true" />
        <h2>运行健康</h2>
        {onOpenAgentSettings ? (
          <button
            type="button"
            className="text-btn monitor-panel-link"
            onClick={onOpenAgentSettings}
          >
            管理
          </button>
        ) : null}
      </header>
      <ul className="monitor-health-list">
        {active.map(renderRow)}
        {brokenProviders.map((provider) => (
          <li key={`provider:${provider.id}`} className="tone-error">
            <i aria-hidden="true" />
            <span>{provider.name}</span>
            <b>供应商异常</b>
            <small title={provider.error}>{provider.error}</small>
          </li>
        ))}
      </ul>
      {inactive.length ? (
        <details className="monitor-health-off">
          <summary>
            <span>
              未启用 <b>{inactive.length}</b>
            </span>
            <em>{inactive.map((row) => row.agent.name).join(" · ")}</em>
          </summary>
          <ul className="monitor-health-list">{inactive.map(renderRow)}</ul>
        </details>
      ) : null}
      {sessionNotes.length ? (
        <p className="monitor-muted">会话：{sessionNotes.join(" · ")}</p>
      ) : null}
      <div className="monitor-usage-block">
        <div className="monitor-usage-subhead">
          <span>本机</span>
          {stats ? (
            <small>
              {stats.platform}/{stats.arch} · {stats.cpuCount} 核
            </small>
          ) : null}
        </div>
        {stats ? (
          <>
            <Meter label="CPU" value={cpu != null ? `${cpu}%` : "—"} percent={cpu} />
            <Meter
              label="内存"
              value={`${formatBytes(memUsed)} / ${formatBytes(stats.memTotal)}`}
              percent={memPercent}
            />
            <dl className="monitor-health-facts">
              {stats.platform !== "win32" ? (
                <>
                  <dt>负载</dt>
                  <dd>{stats.loadavg.map((value) => value.toFixed(2)).join(" / ")}</dd>
                </>
              ) : null}
              <dt>Deck 进程</dt>
              <dd>
                {formatBytes(stats.deck.rss)} · 已运行 {formatDuration(stats.deck.uptimeSec * 1_000)}
              </dd>
              <dt>连接</dt>
              <dd>{stats.deck.clients} 个客户端</dd>
            </dl>
          </>
        ) : (
          <p className="monitor-muted">{error || "正在读取…"}</p>
        )}
      </div>
    </section>
  );
}
