import type {
  ApprovalMode,
  ApprovalPolicy,
  ApprovalsReviewer,
  SandboxMode,
} from "./types";

// 选项的 value 是 Codex 原生枚举，必须原样透传；label 只用于界面显示。
export const SANDBOX_OPTIONS: { value: SandboxMode; label: string }[] = [
  { value: "read-only", label: "只读" },
  { value: "workspace-write", label: "工作区可写" },
  { value: "danger-full-access", label: "完全访问" },
];

export const APPROVAL_OPTIONS: { value: ApprovalMode; label: string }[] = [
  { value: "untrusted", label: "不受信任" },
  { value: "on-request", label: "每次询问" },
  { value: "auto-review", label: "自动批准" },
  { value: "never", label: "从不询问" },
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
  none: "无",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  "x-high": "极高",
  max: "最高",
  ultra: "极致",
};

export function reasoningEffortLabel(value: string) {
  const key = value.trim().toLowerCase();
  return EFFORT_LABELS[key] || value;
}

/**
 * 输入框格子带里的压缩显示：全压成两个字，完整名称走 title/aria。
 * 推理强度与手填值天然 ≤2 字，直接原样发过。
 */
const CONTEXT_SHORT_LABELS: Record<string, string> = {
  只读: "只读",
  工作区可写: "可写",
  完全访问: "完全",
  不受信任: "不信",
  每次询问: "询问",
  自动批准: "自动",
  从不询问: "从不",
  按需询问: "按需",
  自动接受编辑: "接受",
  计划模式: "计划",
  拒绝提示: "拒绝",
  跳过权限确认: "跳过",
};

export function contextShortLabel(label: string) {
  return CONTEXT_SHORT_LABELS[label] || label;
}

export function sandboxLabel(value: string) {
  return SANDBOX_OPTIONS.find((option) => option.value === value)?.label || value;
}

const PERSONALITY_LABELS: Record<string, string> = {
  pragmatic: "务实",
  friendly: "友好",
  none: "无",
};

export function personalityLabel(value: string) {
  return PERSONALITY_LABELS[value] || value;
}

/**
 * 目录没声明 `supportedReasoningEfforts` 时的手填候选（自定义供应商 /
 * 手输模型）。后端本就透传 effort，这里只补 UI，不新增能力。
 */
export const FALLBACK_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export function unwrapAssistantMarkup(text: string) {
  if (typeof text !== "string") return "";
  return text.replace(/<\/?(coding-cot|analysis|thinking|thought)>/gi, "");
}
