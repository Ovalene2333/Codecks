import type {
  ApprovalPolicy,
  Personality,
  SandboxMode,
  ThreadSummary,
} from "../types";
import { APPROVAL_OPTIONS, SANDBOX_OPTIONS } from "../codexLabels";
import { ModelPicker } from "../ModelPicker";
import { ContextBar } from "../usage/ContextBar";

export function SessionToolbar({
  thread,
  locked,
  onSettings,
  onCompact,
}: {
  thread: ThreadSummary;
  locked?: boolean;
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
          <span>Sandbox</span>
          <select
            disabled={locked}
            value={
              typeof thread.sandbox === "string"
                ? thread.sandbox
                : "workspace-write"
            }
            onChange={(event) =>
              onSettings({ sandbox: event.target.value as SandboxMode })
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
          <span>Approval policy</span>
          <select
            disabled={locked}
            value={thread.approvalPolicy || "on-request"}
            onChange={(event) =>
              onSettings({
                approvalPolicy: event.target.value as ApprovalPolicy,
              })
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
          <span>Personality</span>
          <select
            disabled={locked}
            value={thread.personality || ""}
            onChange={(event) =>
              onSettings({
                personality: (event.target.value || undefined) as
                  | Personality
                  | undefined,
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
      <ContextBar
        usage={thread.tokenUsage}
        compacting={thread.compacting}
        onCompact={onCompact}
      />
    </div>
  );
}
