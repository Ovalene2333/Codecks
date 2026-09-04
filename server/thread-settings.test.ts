import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ThreadSettingsStore } from "./thread-settings.js";

test("thread settings survive a store restart and retain every explicit choice", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-thread-settings-"));
  const store = new ThreadSettingsStore(dir);
  await store.load();
  await store.update("codex", "thread-1", {
    providerId: "provider-a",
    model: "gpt-5.6",
    reasoningEffort: "high",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    personality: "pragmatic",
    serviceTier: "priority",
  });

  const restored = new ThreadSettingsStore(dir);
  await restored.load();
  assert.deepEqual(restored.get("codex", "thread-1"), {
    providerId: "provider-a",
    model: "gpt-5.6",
    reasoningEffort: "high",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    personality: "pragmatic",
    serviceTier: "priority",
  });
});

test("OpenCode thread settings survive a store restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-thread-settings-oc-"));
  const store = new ThreadSettingsStore(dir);
  await store.load();
  await store.update("opencode", "session-1", { model: "openai/gpt-5" });

  const restored = new ThreadSettingsStore(dir);
  await restored.load();
  assert.deepEqual(restored.get("opencode", "session-1"), {
    model: "openai/gpt-5",
  });
});

test("resetting a service tier removes its saved override", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-thread-settings-tier-"));
  const store = new ThreadSettingsStore(dir);
  await store.update("codex", "thread-1", { serviceTier: "priority" });
  await store.update("codex", "thread-1", { serviceTier: null });
  assert.deepEqual(store.get("codex", "thread-1"), undefined);
});

test("archived flag persists until explicitly cleared", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-thread-settings-arch-"));
  const store = new ThreadSettingsStore(dir);
  await store.update("opencode", "session-1", {
    model: "openai/gpt-5",
    archived: true,
  });
  assert.deepEqual(store.get("opencode", "session-1"), {
    model: "openai/gpt-5",
    archived: true,
  });

  const restored = new ThreadSettingsStore(dir);
  await restored.load();
  assert.deepEqual(restored.get("opencode", "session-1"), {
    model: "openai/gpt-5",
    archived: true,
  });

  await restored.update("opencode", "session-1", { archived: null });
  assert.deepEqual(restored.get("opencode", "session-1"), {
    model: "openai/gpt-5",
  });
});

test("cached session summaries migrate without replacing an existing choice", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-thread-settings-cache-"));
  const store = new ThreadSettingsStore(dir);
  await store.update("codex", "thread-1", { model: "gpt-picked" });
  await store.seedFromThreads([
    {
      agentId: "codex",
      id: "thread-1",
      providerId: "official",
      name: "Existing",
      preview: "cached",
      cwd: "/work",
      model: "gpt-default",
      status: "idle",
      updatedAt: 1,
      sandbox: "workspace-write",
    },
    {
      agentId: "claude",
      id: "thread-2",
      providerId: "claude-current",
      name: "Migrated",
      preview: "cached",
      cwd: "/work",
      model: "sonnet",
      status: "idle",
      updatedAt: 1,
      permissionMode: "acceptEdits",
    },
  ]);

  assert.deepEqual(store.get("codex", "thread-1"), { model: "gpt-picked" });
  assert.deepEqual(store.get("claude", "thread-2"), {
    providerId: "claude-current",
    model: "sonnet",
    permissionMode: "acceptEdits",
  });
});
