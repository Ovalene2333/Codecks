import {
  ArrowLeft,
  ArrowRightLeft,
  MoreHorizontal,
  SunMoon,
} from "lucide-react";
import type { Provider, ThreadSummary } from "../types";
import { Status } from "../ui";
import { basename, formatTokens } from "../format";
import { ContextBar } from "../usage/ContextBar";

export function ChatHeader({
  thread,
  provider,
  agentName,
  pendingCount,
  locked,
  onBack,
  onMenu,
  onAppearance,
  onSwitchProvider,
  onCompact,
}: {
  thread: ThreadSummary;
  provider?: Provider;
  agentName: string;
  pendingCount: number;
  locked?: boolean;
  onBack: () => void;
  onMenu: () => void;
  onAppearance: () => void;
  onSwitchProvider: () => void;
  onCompact?: () => void;
}) {
  const contextLabel =
    thread.tokenUsage?.used != null && thread.tokenUsage.limit != null
      ? `${formatTokens(thread.tokenUsage.used)}/${formatTokens(thread.tokenUsage.limit)}`
      : formatTokens(thread.tokenUsage?.used ?? thread.tokenUsage?.limit);

  return (
    <header className="chat-header">
      <div className="chat-header-row1">
        <button className="icon-btn mobile-back" onClick={onBack} title="返回">
          <ArrowLeft />
        </button>
        <div className="chat-title">
          <div className="chat-title-row">
            <h2 title={thread.name}>{thread.name}</h2>
            <span
              className={`mobile-agent-badge agent-badge agent-${thread.agentId || "codex"}`}
              title={`${agentName} 任务`}
            >
              {thread.agentId === "claude" ? "Claude" : "Codex"}
            </span>
            {pendingCount > 0 && (
              <mark className="pending-count">{pendingCount}</mark>
            )}
          </div>
          <p className="chat-title-meta">
            <Status
              status={thread.compacting ? "running" : thread.status}
              compact
              label={thread.compacting ? "正在运行" : undefined}
            />
            <span className="chat-location">
              {basename(thread.cwd)}
              {thread.agentId === "claude"
                ? ` · ${agentName}`
                : provider?.name
                  ? ` · ${provider.name}`
                  : ""}
            </span>
          </p>
        </div>
        <div className="chat-header-actions">
          <span
            className={`chat-agent-badge agent-badge agent-${thread.agentId || "codex"}`}
            title={`${agentName} 任务`}
          >
            {thread.agentId === "claude" ? "Claude" : "Codex"}
          </span>
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
          {thread.agentId !== "claude" && (
            <button
              className="provider-switch secondary"
              onClick={onSwitchProvider}
              disabled={locked}
              title="为此 Session 切换供应商"
            >
              <ArrowRightLeft />
              <span>{provider?.name || "供应商"}</span>
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
        <Status
          status={thread.compacting ? "running" : thread.status}
          compact
          label={thread.compacting ? "正在运行" : undefined}
        />
        <span
          className="mobile-context"
          title={`上下文 ${contextLabel || "未知"}`}
        >
          {contextLabel || "--/--"}
        </span>
        <span className="mobile-project" title={thread.cwd || "项目未知"}>
          {basename(thread.cwd) || "项目未知"}
        </span>
        <span
          className="mobile-provider"
          title={provider?.name || "供应商未知"}
        >
          {thread.agentId === "claude"
            ? agentName
            : provider?.name || "供应商未知"}
        </span>
      </div>
    </header>
  );
}
