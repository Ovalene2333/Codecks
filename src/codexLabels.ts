import type {
  ApprovalMode,
  ApprovalPolicy,
  ApprovalsReviewer,
  SandboxMode,
} from "./types";

export const SANDBOX_OPTIONS: { value: SandboxMode; label: string }[] = [
  { value: "read-only", label: "Read Only" },
  { value: "workspace-write", label: "Workspace Write" },
  { value: "danger-full-access", label: "Full Access" },
];

export const APPROVAL_OPTIONS: { value: ApprovalMode; label: string }[] = [
  { value: "untrusted", label: "Untrusted" },
  { value: "on-request", label: "Ask for approval" },
  { value: "auto-review", label: "Approve for me" },
  { value: "never", label: "Never ask" },
];

export function approvalMode(
  approvalPolicy?: ApprovalPolicy,
  approvalsReviewer?: ApprovalsReviewer,
): ApprovalMode {
  if (approvalsReviewer === "auto_review") return "auto-review";
  return approvalPolicy || "on-request";
}

export function approvalSettings(mode: ApprovalMode): {
  approvalPolicy: ApprovalPolicy;
  approvalsReviewer: ApprovalsReviewer;
} {
  if (mode === "auto-review")
    return { approvalPolicy: "on-request", approvalsReviewer: "auto_review" };
  return { approvalPolicy: mode, approvalsReviewer: "user" };
}

export function settingsForApprovalMode(
  mode: ApprovalMode,
  sandbox: SandboxMode,
) {
  return {
    sandbox:
      mode === "auto-review" && sandbox === "danger-full-access"
        ? ("workspace-write" as const)
        : sandbox,
    ...approvalSettings(mode),
  };
}

export function settingsForSandboxMode(
  sandbox: SandboxMode,
  mode: ApprovalMode,
) {
  return {
    sandbox,
    ...(sandbox === "danger-full-access" && mode === "auto-review"
      ? approvalSettings("never")
      : approvalSettings(mode)),
  };
}

export function approvalModeLabel(
  approvalPolicy?: ApprovalPolicy,
  approvalsReviewer?: ApprovalsReviewer,
) {
  const mode = approvalMode(approvalPolicy, approvalsReviewer);
  return (
    APPROVAL_OPTIONS.find((option) => option.value === mode)?.label || mode
  );
}

const EFFORT_LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  "x-high": "Extra High",
  max: "Max",
  ultra: "Ultra",
};

export function reasoningEffortLabel(value: string) {
  const key = value.trim().toLowerCase();
  return EFFORT_LABELS[key] || value;
}

export function unwrapAssistantMarkup(text: string) {
  if (typeof text !== "string") return "";
  return text.replace(/<\/?(coding-cot|analysis|thinking|thought)>/gi, "");
}
