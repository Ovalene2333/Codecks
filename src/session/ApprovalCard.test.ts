import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard } from "./ApprovalCard";
import type { Approval } from "../types";

function render(approval: Approval) {
  return renderToStaticMarkup(
    createElement(ApprovalCard, {
      approval,
      onResolve: () => undefined,
    }),
  );
}

test("Claude approval cards name Claude Code instead of Codex", () => {
  const html = render({
    id: "approval-1",
    agentId: "claude",
    providerId: "claude-provider",
    kind: "command",
    command: "npm test",
    request: {
      method: "item/commandExecution/requestApproval",
      params: {},
    },
  });

  assert.match(html, /Claude Code 请求执行命令/);
  assert.match(html, /请确认是否允许 Claude Code 继续执行/);
  assert.doesNotMatch(html, /Codex 请求/);
});

test("Codex approval cards keep the Codex actor label", () => {
  const html = render({
    id: "approval-2",
    providerId: "codex-provider",
    kind: "file",
    request: { method: "item/fileChange/requestApproval", params: {} },
  });

  assert.match(html, /Codex 请求修改文件/);
});
