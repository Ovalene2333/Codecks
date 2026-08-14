import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_OPTIONS,
  reasoningEffortLabel,
  SANDBOX_OPTIONS,
  unwrapAssistantMarkup,
} from "./codexLabels";

test("sandbox and approval options use native Codex labels", () => {
  assert.deepEqual(
    SANDBOX_OPTIONS.map((item) => item.label),
    ["Read Only", "Workspace Write", "Full Access"],
  );
  assert.deepEqual(
    APPROVAL_OPTIONS.map((item) => item.label),
    ["Untrusted", "Ask for approval", "Approve for me"],
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
