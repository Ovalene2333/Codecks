import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_OPTIONS,
  approvalMode,
  approvalSettings,
  contextShortLabel,
  reasoningEffortLabel,
  SANDBOX_OPTIONS,
  settingsForApprovalMode,
  settingsForSandboxMode,
  unwrapAssistantMarkup,
} from "./codexLabels";

test("sandbox and approval labels are localized while keeping native Codex values", () => {
  assert.deepEqual(
    SANDBOX_OPTIONS.map((item) => item.value),
    ["read-only", "workspace-write", "danger-full-access"],
  );
  assert.deepEqual(
    SANDBOX_OPTIONS.map((item) => item.label),
    ["只读", "工作区可写", "完全访问"],
  );
  assert.deepEqual(
    APPROVAL_OPTIONS.map((item) => item.value),
    ["untrusted", "on-request", "auto-review", "never"],
  );
  assert.deepEqual(
    APPROVAL_OPTIONS.map((item) => item.label),
    ["不受信任", "每次询问", "自动批准", "从不询问"],
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
  assert.equal(reasoningEffortLabel("low"), "低");
  assert.equal(reasoningEffortLabel("xhigh"), "极高");
  assert.equal(reasoningEffortLabel("max"), "最高");
  assert.equal(reasoningEffortLabel("ultra"), "极致");
  assert.equal(reasoningEffortLabel("low-fast response"), "low-fast response");
});

test("contextShortLabel compresses strip chips to two characters", () => {
  assert.equal(contextShortLabel("只读"), "只读");
  assert.equal(contextShortLabel("工作区可写"), "可写");
  assert.equal(contextShortLabel("完全访问"), "完全");
  assert.equal(contextShortLabel("不受信任"), "不信");
  assert.equal(contextShortLabel("每次询问"), "询问");
  assert.equal(contextShortLabel("自动批准"), "自动");
  assert.equal(contextShortLabel("从不询问"), "从不");
  assert.equal(contextShortLabel("按需询问"), "按需");
  assert.equal(contextShortLabel("自动接受编辑"), "接受");
  assert.equal(contextShortLabel("计划模式"), "计划");
  assert.equal(contextShortLabel("拒绝提示"), "拒绝");
  assert.equal(contextShortLabel("跳过权限确认"), "跳过");
  assert.equal(contextShortLabel("高"), "高");
  assert.equal(contextShortLabel("手填模型"), "手填模型");
});

test("unwrapAssistantMarkup drops wrapper tags without splitting blocks", () => {
  assert.equal(
    unwrapAssistantMarkup("前言\n<coding-cot>\n分析过程\n</coding-cot>\n正文"),
    "前言\n\n分析过程\n\n正文",
  );
  assert.equal(unwrapAssistantMarkup("<analysis>还没写完"), "还没写完");
});
