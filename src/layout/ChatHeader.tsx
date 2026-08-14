import { ArrowLeft, ArrowRightLeft, MoreHorizontal } from "lucide-react";
import type { Provider, ThreadSummary } from "../types";
import { Status } from "../ui";
import { basename } from "../format";
import { ContextBar } from "../usage/ContextBar";
import { SessionToolbar } from "./SessionToolbar";
import type { ApprovalPolicy, Personality, SandboxMode } from "../types";

export function ChatHeader({
  thread,
  provider,
  pendingCount,
  locked,
  onBack,
  onMenu,
  onSwitchProvider,
  onSettings,
  onCompact,
}: {
  thread: ThreadSummary;
  provider?: Provider;
  pendingCount: number;
  locked?: boolean;
  onBack: () => void;
  onMenu: () => void;
  onSwitchProvider: () => void;
  onSettings: (settings: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: SandboxMode;
    approvalPolicy?: ApprovalPolicy;
    personality?: Personality;
  }) => void;
  onCompact: () => void;
}) {
  return (
    <header className="chat-header">
      <div className="chat-header-row1">
        <button className="icon-btn mobile-back" onClick={onBack} title="返回">
          <ArrowLeft />
        </button>
        <div className="chat-title">
          <div className="chat-title-row">
            <h2 title={thread.name}>{thread.name}</h2>
            {pendingCount > 0 && (
              <mark className="pending-count">{pendingCount}</mark>
            )}
          </div>
          <p>
            <Status status={thread.status} compact />
            <span>
              {basename(thread.cwd)}
              {provider?.name ? ` · ${provider.name}` : ""}
            </span>
          </p>
        </div>
        <div className="chat-header-actions">
          <button
            className="provider-switch secondary"
            onClick={onSwitchProvider}
            disabled={locked}
            title="为此 Session 切换供应商"
          >
            <ArrowRightLeft />
            <span>{provider?.name || "供应商"}</span>
          </button>
          <ContextBar
            usage={thread.tokenUsage}
            compacting={thread.compacting}
            onCompact={onCompact}
          />
          <button className="icon-btn overflow-menu" onClick={onMenu} title="更多">
            <MoreHorizontal />
          </button>
        </div>
      </div>
      <div className="chat-header-row2">
        <SessionToolbar
          thread={thread}
          locked={locked}
          onSettings={onSettings}
          onCompact={onCompact}
          showContext={false}
        />
      </div>
    </header>
  );
}
