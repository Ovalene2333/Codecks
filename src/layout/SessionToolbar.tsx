import type {
  ApprovalMode,
  ApprovalPolicy,
  ApprovalsReviewer,
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
import { ModelPicker } from "../ModelPicker";
import { ContextBar } from "../usage/ContextBar";

export function SessionToolbar({
  thread,
  locked,
  onSettings,
  onCompact,
  showContext = true,
}: {
  thread: ThreadSummary;
  locked?: boolean;
  onSettings: (settings: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: SandboxMode;
    approvalPolicy?: ApprovalPolicy;
    approvalsReviewer?: ApprovalsReviewer;
    personality?: Personality;
  }) => void;
  onCompact: () => void;
  showContext?: boolean;
}) {
  return (
    <div className={`session-toolbar ${locked ? "locked" : ""}`}>
      <div className="toolbar-fields">
        <ModelPicker
          compact
          disabled={locked}
          providerId={thread.providerId}
          model={thread.model}
          reasoningEffort={thread.reasoningEffort || ""}
          onChange={(next) => onSettings(next)}
        />
        <label className="toolbar-select">
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
                  approvalMode(thread.approvalPolicy, thread.approvalsReviewer),
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
      </div>
      {locked && <small className="toolbar-hint">任务结束后生效</small>}
      {showContext ? (
        <ContextBar
          usage={thread.tokenUsage}
          compacting={thread.compacting}
          onCompact={onCompact}
        />
      ) : null}
    </div>
  );
}
