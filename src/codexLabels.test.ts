import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_OPTIONS,
  approvalMode,
  approvalSettings,
  reasoningEffortLabel,
  SANDBOX_OPTIONS,
  settingsForApprovalMode,
  settingsForSandboxMode,
  unwrapAssistantMarkup,
} from "./codexLabels";

test("sandbox and approval options use native Codex labels", () => {
  assert.deepEqual(
    SANDBOX_OPTIONS.map((item) => item.label),
    ["Read Only", "Workspace Write", "Full Access"],
  );
  assert.deepEqual(
    APPROVAL_OPTIONS.map((item) => item.label),
    ["Untrusted", "Ask for approval", "Approve for me", "Never ask"],
  );
});

test("Approve for me maps to Codex auto-review without changing legacy never", () => {
  assert.deepEqual(approvalSettings("auto-review"), {
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
  });
  assert.equal(approvalMode("on-request", "auto_review"), "auto-review");
  assert.equal(approvalMode("never", "user"), "never");
  assert.deepEqual(
    settingsForApprovalMode("auto-review", "danger-full-access"),
    {
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      approvalsReviewer: "auto_review",
    },
  );
  assert.deepEqual(
    settingsForSandboxMode("danger-full-access", "auto-review"),
    {
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
    },
  );
});

test("reasoningEffortLabel maps Codex effort ids", () => {
  assert.equal(reasoningEffortLabel("low"), "Low");
  assert.equal(reasoningEffortLabel("xhigh"), "Extra High");
  assert.equal(reasoningEffortLabel("max"), "Max");
  assert.equal(reasoningEffortLabel("ultra"), "Ultra");
  assert.equal(reasoningEffortLabel("low-fast response"), "low-fast response");
});

test("unwrapAssistantMarkup drops wrapper tags without splitting blocks", () => {
  assert.equal(
    unwrapAssistantMarkup("前言\n<coding-cot>\n分析过程\n</coding-cot>\n正文"),
    "前言\n\n分析过程\n\n正文",
  );
  assert.equal(unwrapAssistantMarkup("<analysis>还没写完"), "还没写完");
});
