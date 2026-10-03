import {
  ArrowLeft,
  ArrowRightLeft,
  Minimize2,
  MoreHorizontal,
  Radar,
  SunMoon,
} from "lucide-react";
import type {
  AgentProfile,
  Provider,
  ThreadSummary,
  LostWakeWatcher,
  WakeWatcher,
} from "../types";
import { Status } from "../ui";
import { basename, formatTokens } from "../format";
import { ContextBar } from "../usage/ContextBar";

function agentBadgeLabel(agentId: string | undefined, agentName: string) {
  if (agentId === "claude") return "Claude";
  if (agentId === "opencode") return "OpenCode";
  if (!agentId || agentId === "codex") return "Codex";
  return agentName;
}

export function ChatHeader({
  thread,
  provider,
  agentName,
  pendingCount,
  locked,
  wake,
  onBack,
  onMenu,
  onAppearance,
  onSwitchProvider,
  onCompact,
  onWake,
}: {
  thread: ThreadSummary;
  provider?: Provider | AgentProfile;
  agentName: string;
  pendingCount: number;
  locked?: boolean;
  /** deck-wake 状态：code=已分配唤醒代号；watcher=本机正在监督的 watcher。 */
  wake?: { code?: string; watcher?: WakeWatcher; lost?: LostWakeWatcher[] };
  onBack: () => void;
  onMenu: () => void;
  onAppearance: () => void;
  onSwitchProvider: () => void;
  onCompact?: () => void;
  onWake?: () => void;
}) {
  const contextLabel =
    thread.tokenUsage?.used != null && thread.tokenUsage.limit != null
      ? `${formatTokens(thread.tokenUsage.used)}/${formatTokens(thread.tokenUsage.limit)}`
      : formatTokens(thread.tokenUsage?.used ?? thread.tokenUsage?.limit);
  const contextPercent =
    thread.tokenUsage?.used != null &&
    thread.tokenUsage.limit != null &&
    thread.tokenUsage.limit > 0
      ? Math.min(
          100,
          Math.round((thread.tokenUsage.used / thread.tokenUsage.limit) * 100),
        )
      : undefined;
  const hasUsage =
    thread.tokenUsage?.used != null || thread.tokenUsage?.limit != null;
  const canSwitchProvider =
    !thread.agentId ||
    thread.agentId === "codex" ||
    thread.agentId === "claude";
  const showStatus = thread.compacting || thread.status !== "idle";

  return (
    <header className="chat-header">
      <div className="chat-header-row1">
        <button className="icon-btn mobile-back" onClick={onBack} title="返回">
          <ArrowLeft />
        </button>
        <div className="chat-title">
          <div className="chat-title-row">
            <span
              className="desktop-chat-project"
              title={thread.cwd || undefined}
            >
              {basename(thread.cwd) || "项目"}
            </span>
            <span className="desktop-chat-separator" aria-hidden="true">
              /
            </span>
            <h2 title={thread.name}>{thread.name}</h2>
            {showStatus && (
              <Status
                status={thread.compacting ? "running" : thread.status}
                compact
                label={thread.compacting ? "正在运行" : undefined}
              />
            )}
            {thread.agentId === "claude" && (
              <span className={`claude-connection ${thread.claudeConnected ? "connected" : ""}`}
                title={thread.claudeConnected
                  ? "Deck 当前持有此会话的 Claude SDK 连接"
                  : "Deck 当前没有持有此会话的 Claude SDK 连接"}>
                Deck {thread.claudeConnected ? "已连接" : "未连接"}
              </span>
            )}
            {!canSwitchProvider && (
              <span
                className="desktop-chat-agent"
                title={provider?.name || agentName}
              >
                {provider?.name || agentName}
              </span>
            )}
            <span
              className={`mobile-agent-badge agent-badge agent-${thread.agentId || "codex"}`}
              title={`${agentName} 任务`}
            >
              {agentBadgeLabel(thread.agentId, agentName)}
            </span>
            {pendingCount > 0 && (
              <mark className="pending-count">{pendingCount}</mark>
            )}
          </div>
        </div>
        <div className="chat-header-actions">
          {hasUsage || thread.compacting ? (
            <div
              className="desktop-context"
              title={`上下文 ${contextLabel || "未知"}`}
            >
              <span className="desktop-context-label">上下文</span>
              <ContextBar
                usage={thread.tokenUsage}
                compacting={thread.compacting}
                onCompact={onCompact}
                showUnknown
              />
            </div>
          ) : onCompact ? (
            <button
              type="button"
              className="icon-btn"
              onClick={onCompact}
              title="压缩上下文"
              aria-label="压缩上下文"
            >
              <Minimize2 />
            </button>
          ) : null}
          {canSwitchProvider && (
            <button
              className="provider-switch secondary"
              onClick={onSwitchProvider}
              disabled={locked || (thread.agentId === "claude" && thread.claudeConnected)}
              title={thread.agentId === "claude" && thread.claudeConnected
                ? "Claude 会话仍保持连接；可创建分支并为分支选择其他供应商"
                : "为此 Session 切换供应商"}
            >
              <ArrowRightLeft />
              <span>
                {provider?.name ||
                  (thread.agentId === "claude" ? "Claude 中转" : "供应商")}
              </span>
            </button>
          )}
          {onWake && (
            <button
              type="button"
              className={`icon-btn wake-toggle${wake?.lost?.length ? " lost" : wake?.watcher ? " watching" : wake?.code ? " on" : ""}`}
              onClick={onWake}
              title={
                wake?.lost?.length
                  ? `deck-wake watcher 失联：${wake.lost[0].label}（点开处理）`
                  : wake?.watcher
                  ? `deck-wake 监督中：${wake.watcher.label} · 代号 ${wake.watcher.code}`
                  : wake?.code
                    ? `远程唤醒已开启 · 代号 ${wake.code}（本机暂无 watcher）`
                    : "远程唤醒未开启"
              }
              aria-label="远程唤醒"
            >
              <Radar />
            </button>
          )}
          <button
            type="button"
            className="icon-btn appearance-trigger"
            onClick={onAppearance}
            title="外观设置"
            aria-label="外观设置"
          >
            <SunMoon />
          </button>
          <button
            type="button"
            className="icon-btn overflow-menu"
            onClick={onMenu}
            title="更多"
            aria-label="更多会话操作"
          >
            <MoreHorizontal />
          </button>
        </div>
      </div>
      <div className="mobile-chat-meta">
        {thread.agentId === "claude" && (
          <span className="mobile-claude-connection">
            Deck {thread.claudeConnected ? "已连接" : "未连接"}
          </span>
        )}
        {showStatus && (
          <Status
            status={thread.compacting ? "running" : thread.status}
            compact
            label={thread.compacting ? "正在运行" : undefined}
          />
        )}
        {contextLabel ? (
          <span className="mobile-context" title={`上下文 ${contextLabel}`}>
            {contextPercent != null ? `${contextPercent}%` : contextLabel}
          </span>
        ) : null}
        <span className="mobile-project" title={thread.cwd || "项目未知"}>
          {basename(thread.cwd) || "项目未知"}
        </span>
        <span
          className="mobile-provider"
          title={provider?.name || "供应商未知"}
        >
          {provider?.name ||
            (thread.agentId === "claude"
              ? "Claude 中转"
              : (thread.agentId || "codex") === "codex"
                ? "供应商未知"
                : agentName)}
        </span>
      </div>
    </header>
  );
}
