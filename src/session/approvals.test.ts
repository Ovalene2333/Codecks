import test from "node:test";
import assert from "node:assert/strict";
import type { Approval, ThreadSummary } from "../types.ts";
import {
  approvalPreview,
  approvalThreadId,
  threadForApproval,
} from "./approvals.ts";

const approval: Approval = {
  id: "thread-1:approval-1",
  providerId: "official",
  kind: "command",
  request: { method: "command/requestApproval", params: {} },
  command: "npm test",
};
const thread: ThreadSummary = {
  id: "thread-1",
  providerId: "official",
  name: "会话",
  preview: "",
  cwd: "/tmp/project",
  model: "gpt",
  status: "waiting",
  updatedAt: 1,
};

test("approval thread ids support explicit params and composite ids", () => {
  assert.equal(approvalThreadId(approval), "thread-1");
  assert.equal(
    approvalThreadId({
      ...approval,
      id: "opaque",
      request: { ...approval.request, params: { threadId: "explicit" } },
    }),
    "explicit",
  );
});

test("approval helpers find the matching provider session and preview command", () => {
  assert.equal(threadForApproval(approval, [thread]), thread);
  assert.equal(
    threadForApproval(approval, [{ ...thread, providerId: "another" }]),
    undefined,
  );
  assert.equal(approvalPreview(approval), "npm test");
});
