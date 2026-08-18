import type {
  ApprovalMode,
  ApprovalPolicy,
  ApprovalsReviewer,
  ClaudePermissionMode,
  Personality,
  SandboxMode,
  ThreadSummary,
} from "../types";
import {
  approvalMode,
  APPROVAL_OPTIONS,
  SANDBOX_OPTIONS,
  settingsForApprovalMode,
  settingsForSandboxMode,
} from "../codexLabels";
import { Minimize2 } from "lucide-react";
import { ModelPicker } from "../ModelPicker";

export const CLAUDE_PERMISSION_OPTIONS: {
  value: ClaudePermissionMode;
  label: string;
}[] = [
  { value: "default", label: "Ask when needed" },
  { value: "acceptEdits", label: "Auto-accept edits" },
  { value: "plan", label: "Plan mode" },
  { value: "dontAsk", label: "Deny prompts" },
  { value: "bypassPermissions", label: "Bypass permissions" },
];

export function SessionToolbar({
  thread,
  locked,
  onSettings,
  onCompact,
  variant = "inline",
}: {
  thread: ThreadSummary;
  locked?: boolean;
  onSettings: (settings: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: SandboxMode;
    approvalPolicy?: ApprovalPolicy;
    approvalsReviewer?: ApprovalsReviewer;
    permissionMode?: ClaudePermissionMode;
    personality?: Personality;
  }) => void;
  onCompact: () => void;
  variant?: "inline" | "panel";
}) {
  return (
    <div
      className={`session-toolbar session-toolbar--${variant} ${locked ? "locked" : ""}`}
    >
      <div className="toolbar-fields">
        <ModelPicker
          agentId={thread.agentId || "codex"}
          compact
          disabled={locked}
          providerId={thread.providerId}
          model={thread.model}
          reasoningEffort={thread.reasoningEffort || ""}
          onChange={(next) => onSettings(next)}
        />
        {thread.agentId === "claude" ? (
          <label className="toolbar-select">
            <span className="toolbar-field-label">权限</span>
            <select
              aria-label="Claude permissions"
              title="Claude permissions"
              disabled={locked}
              value={thread.permissionMode || "default"}
              onChange={(event) =>
                onSettings({
                  permissionMode: event.target.value as ClaudePermissionMode,
                })
              }
            >
              {CLAUDE_PERMISSION_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label className="toolbar-select">
              <span className="toolbar-field-label">沙箱</span>
              <select
                aria-label="Sandbox"
                title="Sandbox"
                disabled={locked}
                value={
                  typeof thread.sandbox === "string"
                    ? thread.sandbox
                    : "workspace-write"
                }
                onChange={(event) =>
                  onSettings(
                    settingsForSandboxMode(
                      event.target.value as SandboxMode,
                      approvalMode(
                        thread.approvalPolicy,
                        thread.approvalsReviewer,
                      ),
                    ),
                  )
                }
              >
                {SANDBOX_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="toolbar-select">
              <span className="toolbar-field-label">审批</span>
              <select
                aria-label="Approvals"
                title="Approvals"
                disabled={locked}
                value={approvalMode(
                  thread.approvalPolicy,
                  thread.approvalsReviewer,
                )}
                onChange={(event) =>
                  onSettings(
                    settingsForApprovalMode(
                      event.target.value as ApprovalMode,
                      thread.sandbox || "workspace-write",
                    ),
                  )
                }
              >
                {APPROVAL_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="toolbar-select">
              <span className="toolbar-field-label">风格</span>
              <select
                aria-label="Personality"
                title="Personality"
                disabled={locked}
                value={thread.personality || ""}
                onChange={(event) =>
                  onSettings({
                    personality: (event.target.value || undefined) as
                      Personality | undefined,
                  })
                }
              >
                <option value="">Default</option>
                <option value="pragmatic">Pragmatic</option>
                <option value="friendly">Friendly</option>
                <option value="none">None</option>
              </select>
            </label>
          </>
        )}
      </div>
      {locked && <small className="toolbar-hint">任务结束后生效</small>}
      {thread.agentId !== "claude" && (
        <button
          type="button"
          className="text-btn compact-btn"
          onClick={onCompact}
          disabled={Boolean(thread.compacting)}
        >
          <Minimize2 />
          压缩
        </button>
      )}
    </div>
  );
}
