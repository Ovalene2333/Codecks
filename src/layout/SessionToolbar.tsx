import { Select } from "../kit/Select";
import { Button } from "../kit";
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
  { value: "default", label: "按需询问" },
  { value: "acceptEdits", label: "自动接受编辑" },
  { value: "plan", label: "计划模式" },
  { value: "dontAsk", label: "拒绝提示" },
  { value: "bypassPermissions", label: "跳过权限确认" },
];

export function SessionToolbar({
  thread,
  onSettings,
  onCompact,
  variant = "inline",
  showCompact = true,
}: {
  thread: ThreadSummary;
  onSettings: (settings: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: SandboxMode;
    approvalPolicy?: ApprovalPolicy;
    approvalsReviewer?: ApprovalsReviewer;
    permissionMode?: ClaudePermissionMode;
    personality?: Personality;
    sessionMode?: string;
  }) => void;
  onCompact: () => void;
  variant?: "inline" | "panel";
  showCompact?: boolean;
}) {
  const agentId = thread.agentId || "codex";
  const isCodex = agentId === "codex";
  const modelFields = (
    <ModelPicker
      agentId={agentId}
      cwd={thread.cwd}
      compact
      providerId={thread.providerId}
      model={thread.model}
      reasoningEffort={thread.reasoningEffort || ""}
      reasoningLabel={variant === "panel" ? "推理强度" : undefined}
      onChange={(next) => onSettings(next)}
    />
  );
  const claudePermissionField = (
    <label className="toolbar-select">
      <span className="toolbar-field-label">权限</span>
      <Select
        aria-label="Claude 权限"
        title="Claude 权限"
        value={thread.permissionMode || "default"}
        onValueChange={(nextValue) =>
          onSettings({
            permissionMode: nextValue as ClaudePermissionMode,
          })
        }
      >
        {CLAUDE_PERMISSION_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </label>
  );
  const sessionModeField = thread.sessionModes?.length ? (
    <label className="toolbar-select">
      <span className="toolbar-field-label">模式</span>
      <Select
        aria-label="会话模式"
        title="会话模式"
        value={thread.sessionMode || ""}
        onValueChange={(nextValue) => onSettings({ sessionMode: nextValue })}
      >
        {!thread.sessionMode && <option value="">默认</option>}
        {thread.sessionModes.map((mode) => (
          <option
            key={mode.id}
            value={mode.id}
            title={mode.description || undefined}
          >
            {mode.name || mode.id}
          </option>
        ))}
      </Select>
    </label>
  ) : null;
  const sandboxField = (
    <label className="toolbar-select">
      <span className="toolbar-field-label">沙箱</span>
      <Select
        aria-label="沙箱"
        title="沙箱"
        value={
          typeof thread.sandbox === "string"
            ? thread.sandbox
            : "workspace-write"
        }
        onValueChange={(nextValue) =>
          onSettings(
            settingsForSandboxMode(
              nextValue as SandboxMode,
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
      </Select>
    </label>
  );
  const approvalField = (
    <label className="toolbar-select">
      <span className="toolbar-field-label">审批策略</span>
      <Select
        aria-label="审批策略"
        title="审批策略"
        value={approvalMode(thread.approvalPolicy, thread.approvalsReviewer)}
        onValueChange={(nextValue) =>
          onSettings(
            settingsForApprovalMode(
              nextValue as ApprovalMode,
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
      </Select>
    </label>
  );
  const personalityField = (
    <label className="toolbar-select">
      <span className="toolbar-field-label">回复风格</span>
      <Select
        aria-label="回复风格"
        title="回复风格"
        value={thread.personality || ""}
        onValueChange={(nextValue) =>
          onSettings({
            personality: (nextValue || undefined) as
              Personality | undefined,
          })
        }
      >
        <option value="">默认</option>
        <option value="pragmatic">务实</option>
        <option value="friendly">友好</option>
        <option value="none">无</option>
      </Select>
    </label>
  );
  const executionFields = isCodex ? (
    <>
      {sandboxField}
      {approvalField}
    </>
  ) : agentId === "claude" ? (
    claudePermissionField
  ) : agentId === "opencode" || agentId === "opencode-v2" ? null : (
    sessionModeField
  );
  const executionTitle =
    !isCodex && agentId !== "claude" ? "会话模式" : "执行权限";

  return (
    <div
      className={`session-toolbar session-toolbar--${variant}`}
    >
      {variant === "panel" ? (
        <>
          <section className="session-settings-section">
            <h3>模型与推理</h3>
            <div className="session-settings-grid">
              {modelFields}
              {isCodex && personalityField}
            </div>
          </section>
          {executionFields && (
            <section className="session-settings-section">
              <h3>{executionTitle}</h3>
              <div className="session-settings-grid">{executionFields}</div>
            </section>
          )}
        </>
      ) : (
        <div className="toolbar-fields">
          {modelFields}
          {agentId === "claude" ? (
            claudePermissionField
          ) : agentId === "opencode" || agentId === "opencode-v2" ? null : isCodex ? (
            <>
              {sandboxField}
              {approvalField}
              {personalityField}
            </>
          ) : (
            sessionModeField
          )}
        </div>
      )}
      {showCompact && (thread.agentId || "codex") === "codex" && (
        <Button
          variant="ghost"
          size="sm"
          className="compact-btn"
          busy={Boolean(thread.compacting)}
          onClick={onCompact}
        >
          <Minimize2 />
          压缩
        </Button>
      )}
    </div>
  );
}
