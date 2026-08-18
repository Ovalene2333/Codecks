import assert from "node:assert/strict";
import test from "node:test";
import {
  agentIdFor,
  approvalPath,
  capabilitiesFor,
  defaultAgentId,
  providerForThread,
  threadActionPath,
  threadPath,
} from "./agents.ts";

test("old session data defaults to Codex Agent routes", () => {
  assert.equal(agentIdFor({}), "codex");
  assert.equal(
    threadPath({ id: "thread/1" }),
    "/agents/codex/threads/thread%2F1",
  );
  assert.equal(
    threadActionPath({ id: "thread/1" }, "turns"),
    "/agents/codex/threads/thread%2F1/turns",
  );
});

test("Claude routes and fallback capabilities are isolated", () => {
  assert.equal(
    approvalPath({ id: "approval/1", agentId: "claude" }),
    "/agents/claude/approvals/approval%2F1",
  );
  const capabilities = capabilitiesFor(undefined, { agentId: "claude" });
  assert.equal(capabilities.approvals, true);
  assert.equal(capabilities.interrupt, true);
  assert.equal(capabilities.fork, false);
  assert.equal(capabilities.sessionSettings, false);
});

test("new sessions keep the preferred Agent when available and fall back online", () => {
  const agents = [
    {
      id: "codex" as const,
      name: "Codex",
      available: true,
      online: true,
      capabilities: capabilitiesFor(undefined, { agentId: "codex" }),
    },
    {
      id: "claude" as const,
      name: "Claude Code",
      available: true,
      online: false,
      capabilities: capabilitiesFor(undefined, { agentId: "claude" }),
    },
  ];
  assert.equal(defaultAgentId(agents, "codex"), "codex");
  assert.equal(defaultAgentId(agents, "claude"), "codex");
});

test("Claude sessions resolve exact and current relay profiles", () => {
  const profiles = [
    {
      id: "claude-cc-current",
      agentId: "claude" as const,
      name: "Current relay",
      current: true,
      enabled: true,
    },
    {
      id: "claude-cc-other",
      agentId: "claude" as const,
      name: "Other relay",
      enabled: true,
    },
  ];
  assert.equal(
    providerForThread([], profiles, {
      agentId: "claude",
      providerId: "claude-current",
    })?.name,
    "Current relay",
  );
  assert.equal(
    providerForThread([], profiles, {
      agentId: "claude",
      providerId: "claude-cc-other",
    })?.name,
    "Other relay",
  );
});
