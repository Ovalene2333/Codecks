import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadSummary } from "../types.ts";

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: () => null,
    setItem: () => undefined,
  },
  configurable: true,
});

const thread: ThreadSummary = {
  id: "thread-1",
  providerId: "official",
  name: "会话",
  preview: "",
  cwd: "/tmp/project",
  model: "gpt-5.4",
  status: "idle",
  updatedAt: Date.now(),
  sandbox: "workspace-write",
  approvalPolicy: "on-request",
};

test("permissions command renders browser-friendly controls", async () => {
  const { CommandModal } = await import("./CommandModal.tsx");
  const html = renderToStaticMarkup(
    createElement(CommandModal, {
      mode: { kind: "permissions" },
      thread,
      locked: false,
      onSettings: async () => true,
      onInsert: () => undefined,
      onClose: () => undefined,
    }),
  );

  assert.match(html, /权限与审批/);
  assert.match(html, /workspace-write/);
  assert.match(html, /on-request/);
  assert.match(html, /class="primary"/);
});

test("locked model command keeps settings visible but disables changes", async () => {
  const { CommandModal } = await import("./CommandModal.tsx");
  const html = renderToStaticMarkup(
    createElement(CommandModal, {
      mode: { kind: "model" },
      thread,
      locked: true,
      onSettings: async () => true,
      onInsert: () => undefined,
      onClose: () => undefined,
    }),
  );

  assert.match(html, /模型与推理强度/);
  assert.match(html, /任务结束后才能修改模型/);
  assert.match(html, /disabled=""/);
});
