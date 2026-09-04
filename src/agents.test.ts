import assert from "node:assert/strict";
import test from "node:test";
import {
  agentIdFor,
  approvalPath,
  capabilitiesFor,
  defaultAgentId,
  opencodeProviderId,
  providerForThread,
  threadActionPath,
  threadArchivePath,
  threadPath,
  threadRemovePath,
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

test("OpenCode archive and delete go through the generic Agent API", () => {
  assert.equal(
    threadArchivePath(
      { id: "s1", agentId: "opencode", providerId: "opencode:/work" },
      "archive",
    ),
    "/agents/opencode/threads/s1/archive",
  );
  assert.equal(
    threadArchivePath(
      { id: "s1", agentId: "opencode", providerId: "opencode:/work" },
      "unarchive",
    ),
    "/agents/opencode/threads/s1/unarchive",
  );
  assert.equal(
    threadRemovePath({
      id: "s1",
      agentId: "opencode",
      providerId: "opencode:/work",
    }),
    "/agents/opencode/threads/s1",
  );
  // Codex keeps the legacy manager routes.
  assert.equal(
    threadArchivePath({ id: "t1", agentId: "codex", providerId: "deck_x" }, "archive"),
    "/threads/deck_x/t1/archive",
  );
  assert.equal(
    threadRemovePath({ id: "t1", agentId: "codex", providerId: "deck_x" }),
    "/threads/deck_x/t1",
  );
});

test("OpenCode model ids carry the provider they run on", () => {
  assert.equal(opencodeProviderId("anthropic/claude-sonnet-4-5"), "anthropic");
  assert.equal(opencodeProviderId("openai/gpt-5"), "openai");
  assert.equal(opencodeProviderId("default"), "");
  assert.equal(opencodeProviderId(""), "");
  assert.equal(opencodeProviderId(undefined), "");
});

test("OpenCode sessions resolve their provider from the model in use", () => {
  const profiles = [
    {
      id: "anthropic",
      agentId: "opencode" as const,
      name: "Anthropic",
      connected: true,
    },
    {
      id: "openai",
      agentId: "opencode" as const,
      name: "OpenAI",
    },
  ];
  // The stored providerId predates a model switch; the model wins.
  assert.equal(
    providerForThread([], profiles, {
      agentId: "opencode",
      providerId: "openai",
      model: "default",
      resolvedModel: "anthropic/claude-sonnet-4-5",
    })?.name,
    "Anthropic",
  );
  assert.equal(
    providerForThread([], profiles, {
      agentId: "opencode",
      providerId: "openai",
      model: "openai/gpt-5",
    })?.name,
    "OpenAI",
  );
  // Without a concrete model the stored provider still applies.
  assert.equal(
    providerForThread([], profiles, {
      agentId: "opencode",
      providerId: "openai",
      model: "default",
    })?.name,
    "OpenAI",
  );
});
