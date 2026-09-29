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

test("OpenCode question cards render native options with descriptions", () => {
  const html = render({
    id: "s1:que_1",
    agentId: "opencode",
    providerId: "p",
    kind: "question",
    request: { method: "opencode/question", params: {} },
    questions: [
      {
        id: "que_1",
        header: "实现方案",
        prompt: "用哪种持久化？",
        options: [
          { label: "SQLite" },
          { label: "JSON 文件" },
        ],
      },
    ],
  } as Approval);

  assert.match(html, /kind-question/);
  assert.match(html, /实现方案/);
  assert.match(html, /用哪种持久化？/);
  assert.match(html, /question-option/);
  assert.match(html, /提交回答/);
});

test("ACP permission cards render the agent's own options", () => {
  const html = render({
    id: "acp-1",
    agentId: "devin",
    providerId: "p",
    kind: "command",
    command: "cat /etc/hostname",
    request: {
      method: "session/request_permission",
      params: {
        options: [
          { optionId: "allow_once", name: "Allow", kind: "allow_once" },
          {
            optionId: "allow_session",
            name: "Yes, allow `cat` commands (this session)",
            kind: "allow_always",
          },
          {
            optionId: "allow_always_global",
            name: "Yes, always allow `cat` commands in all projects",
            kind: "allow_always",
          },
          {
            optionId: "switch_bypass",
            name: "Yes, switch to bypass mode",
            kind: "allow_always",
          },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      },
    },
  } as Approval);

  // devin 的每一档都原样渲染，不退化成 拒绝/允许一次/本会话允许 三键。
  assert.match(html, /option-list/);
  assert.match(html, /Allow/);
  assert.match(html, /this session/);
  assert.match(html, /all projects/);
  assert.match(html, /bypass mode/);
  assert.match(html, /Reject/);
  assert.doesNotMatch(html, /本会话允许/);
});

test("non-ACP approvals keep the decision buttons", () => {
  const html = render({
    id: "acp-2",
    agentId: "devin",
    providerId: "p",
    kind: "command",
    command: "ls",
    request: { method: "session/request_permission", params: {} },
  } as Approval);
  assert.match(html, /允许一次/);
  assert.doesNotMatch(html, /option-list/);
});

test("Claude question cards include all four questions and multi-select guidance", () => {
  const html = render({
    id: "claude-question",
    agentId: "claude",
    providerId: "claude-local",
    kind: "question",
    request: { method: "item/requestUserInput", params: {} },
    questions: [1, 2, 3, 4].map((index) => ({
      header: `Topic ${index}`,
      question: `Question ${index}?`,
      multiSelect: index === 4,
      options: [{ label: "First" }, { label: "Second" }],
    })),
  } as Approval);
  assert.match(html, /Question 4\?/);
  assert.match(html, /可多选/);
  assert.equal((html.match(/class="question-card"/g) || []).length, 4);
});
