import type { ApprovalPolicy, SandboxMode } from "./types";

export const SANDBOX_OPTIONS: { value: SandboxMode; label: string }[] = [
  { value: "read-only", label: "Read Only" },
  { value: "workspace-write", label: "Workspace Write" },
  { value: "danger-full-access", label: "Full Access" },
];

export const APPROVAL_OPTIONS: { value: ApprovalPolicy; label: string }[] = [
  { value: "untrusted", label: "Untrusted" },
  { value: "on-request", label: "Ask for approval" },
  { value: "never", label: "Approve for me" },
];

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
