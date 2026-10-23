import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("deferred settings keep the latest choice across restart and apply once", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-deferred-settings-"));
  const store = new ThreadSettingsStore(dir);
  await store.update("codex", "thread-1", { model: "model-a" });
  await store.defer("codex", "thread-1", { model: "model-b", sandbox: "read-only" });
  await store.defer("codex", "thread-1", { model: "model-c" });
  await store.update("codex", "thread-1", { model: "model-a" });

  const restored = new ThreadSettingsStore(dir);
  await restored.load();
  assert.equal(restored.get("codex", "thread-1")?.model, "model-c");
  assert.deepEqual(restored.deferred("codex", "thread-1"), {
    model: "model-c",
    sandbox: "read-only",
  });
  let applied;
  await restored.applyDeferred("codex", "thread-1", async (settings) => {
    applied = settings;
  });
  assert.deepEqual(applied, { model: "model-c", sandbox: "read-only" });
  assert.equal(restored.deferred("codex", "thread-1"), undefined);
  const afterApply = new ThreadSettingsStore(dir);
  await afterApply.load();
  assert.equal(afterApply.deferred("codex", "thread-1"), undefined);
});

test("failed or superseded deferred settings remain available for the next turn", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-deferred-failure-"));
  const store = new ThreadSettingsStore(dir);
  await store.defer("claude", "thread-1", { model: "model-a" });
  await assert.rejects(
    store.applyDeferred("claude", "thread-1", async () => {
      throw new Error("runtime unavailable");
    }),
    /runtime unavailable/,
  );
  assert.equal(store.deferred("claude", "thread-1")?.model, "model-a");
  await store.applyDeferred("claude", "thread-1", async () => {
    await store.defer("claude", "thread-1", { model: "model-b" });
  });
  assert.equal(store.deferred("claude", "thread-1")?.model, "model-b");
  await store.remove("claude", "thread-1");
  assert.equal(store.deferred("claude", "thread-1"), undefined);
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

test("session aliases are assigned by default, persist, and survive thread removal", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-thread-settings-alias-"));
  const store = new ThreadSettingsStore(dir);
  await store.load();
  const { aliases: assigned } = await store.ensureSessionAliases([
    { agentId: "opencode", threadId: "session-2" },
    { agentId: "codex", threadId: "thread-1" },
  ]);
  const first = assigned.get(JSON.stringify(["codex", "thread-1"]))!;
  const second = assigned.get(JSON.stringify(["opencode", "session-2"]))!;
  assert.match(first, /^s-[a-z0-9]{7}$/);
  assert.match(second, /^s-[a-z0-9]{7}$/);
  assert.notEqual(first, second);
  assert.equal(store.sessionAlias("codex", "thread-1"), first);
  assert.deepEqual(store.findSessionByAlias(second), { agentId: "opencode", threadId: "session-2" });

  const restored = new ThreadSettingsStore(dir);
  await restored.load();
  assert.equal(restored.sessionAlias("codex", "thread-1"), first);
  assert.deepEqual(restored.findSessionByAlias(first), { agentId: "codex", threadId: "thread-1" });
  await restored.ensureSessionAliases([{ agentId: "codex", threadId: "thread-1" }]);
  assert.equal(restored.sessionAlias("codex", "thread-1"), first);

  await restored.remove("codex", "thread-1");
  assert.equal(restored.get("codex", "thread-1"), undefined);
  assert.equal(restored.isDeleted("codex", "thread-1"), true, "删除后保留墓碑，@s- 才能明确报 DELETED");
  const reloaded = new ThreadSettingsStore(dir);
  await reloaded.load();
  assert.equal(reloaded.isDeleted("codex", "thread-1"), true);
  const reassigned = await reloaded.ensureSessionAliases([{ agentId: "codex", threadId: "thread-1" }]);
  assert.equal(reassigned.aliases.get(JSON.stringify(["codex", "thread-1"])), first);
  assert.equal(reloaded.isDeleted("codex", "thread-1"), false, "同一 id 原生会话重新出现时撤销墓碑");
});

test("session aliases avoid reserved identifiers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-thread-settings-alias-reserved-"));
  const store = new ThreadSettingsStore(dir);
  await store.load();
  const { aliases: assigned } = await store.ensureSessionAliases(
    [{ agentId: "codex", threadId: "thread-1" }],
    ["s-reserved", "s-0000000"],
  );
  const alias = assigned.get(JSON.stringify(["codex", "thread-1"]))!;
  assert.notEqual(alias, "s-reserved");
  assert.notEqual(alias, "s-0000000");
});

test("session aliases stay stable when all existing aliases are reserved", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-alias-stable-"));
  try {
    const targets = [
      { agentId: "codex" as const, threadId: "demo-a" },
      { agentId: "claude" as const, threadId: "demo-b" },
    ];
    const store = new ThreadSettingsStore(dir);
    await store.load();
    const initial = await store.ensureSessionAliases(targets);
    for (const batch of [[targets[0]], targets, [...targets].reverse()]) {
      const result = await store.ensureSessionAliases(batch, store.listSessionAliases().map((item) => item.alias));
      assert.equal(result.changed, false);
      for (const target of batch) {
        const key = JSON.stringify([target.agentId, target.threadId]);
        assert.equal(result.aliases.get(key), initial.aliases.get(key));
      }
    }
    const restored = new ThreadSettingsStore(dir);
    await restored.load();
    const result = await restored.ensureSessionAliases(targets, restored.listSessionAliases().map((item) => item.alias));
    assert.equal(result.changed, false);
    assert.deepEqual(result.aliases, initial.aliases);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("session alias allocation reserves other sessions and repairs duplicate owners", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-alias-owners-"));
  try {
    const store = new ThreadSettingsStore(dir);
    await store.load();
    await store.update("codex", "demo-a", { alias: "s-aaaaaaa" });
    await store.update("codex", "demo-b", { alias: "s-aaaaaaa" });
    // 固定候选检查生成器收到的占用集合，不依赖随机碰撞。
    (store as any).generateSessionAlias = (used: Set<string>) => {
      assert.equal(used.has("s-aaaaaaa"), true);
      assert.equal(used.has("s-bbbbbbb"), true);
      return "s-ccccccc";
    };
    const result = await store.ensureSessionAliases(
      [{ agentId: "codex", threadId: "demo-b" }], ["s-bbbbbbb"],
    );
    assert.equal(result.changed, true);
    assert.equal(store.sessionAlias("codex", "demo-a"), "s-aaaaaaa");
    assert.equal(store.sessionAlias("codex", "demo-b"), "s-ccccccc");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("turn model snapshots persist, dedupe by turn id, and drop with the thread", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-thread-settings-turns-"));
  const store = new ThreadSettingsStore(dir);
  await store.load();
  await store.recordTurnModel("codex", "t-1", "turn-1", { model: "sol" });
  await store.recordTurnModel("codex", "t-1", "turn-2", {
    model: "luna",
    reasoningEffort: "high",
  });
  // 同 turnId 重记只原位覆盖，不产生第二条。
  await store.recordTurnModel("codex", "t-1", "turn-1", { model: "sol-v2" });

  assert.deepEqual(store.turnModel("codex", "t-1", "turn-1"), {
    turnId: "turn-1",
    model: "sol-v2",
  });
  assert.deepEqual(
    store.turnModelList("codex", "t-1").map((entry) => entry.model),
    ["sol-v2", "luna"],
  );
  assert.equal(store.turnModel("codex", "t-1", "missing"), undefined);

  const restored = new ThreadSettingsStore(dir);
  await restored.load();
  assert.deepEqual(
    restored.turnModelList("codex", "t-1").map((entry) => entry.turnId),
    ["turn-1", "turn-2"],
  );
  // turnModels 是会话内注解，不混进 ThreadSummary 下发给客户端。
  assert.deepEqual(restored.get("codex", "t-1"), undefined);

  await restored.remove("codex", "t-1");
  assert.deepEqual(restored.turnModelList("codex", "t-1"), []);
});

test("turn stats persist, dedupe by turn id, and drop with the thread", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-thread-settings-stats-"));
  const store = new ThreadSettingsStore(dir);
  await store.load();
  await store.recordTurnStats("codex", "t-1", "turn-1", {
    startedAt: 1_000,
    endedAt: 3_000,
    durationMs: 2_000,
    outputTokens: 100,
    tps: 50,
  });
  // 空快照不落地。
  await store.recordTurnStats("codex", "t-1", "turn-0", {});
  // 同 turnId 重记只原位覆盖。
  await store.recordTurnStats("codex", "t-1", "turn-1", {
    startedAt: 1_000,
    endedAt: 4_000,
    durationMs: 3_000,
    outputTokens: 150,
    tps: 50,
  });

  assert.deepEqual(store.turnStats("codex", "t-1", "turn-1"), {
    turnId: "turn-1",
    startedAt: 1_000,
    endedAt: 4_000,
    durationMs: 3_000,
    outputTokens: 150,
    tps: 50,
  });
  assert.equal(store.turnStats("codex", "t-1", "turn-0"), undefined);

  const restored = new ThreadSettingsStore(dir);
  await restored.load();
  assert.deepEqual(restored.turnStats("codex", "t-1", "turn-1")?.tps, 50);

  await restored.remove("codex", "t-1");
  assert.equal(restored.turnStats("codex", "t-1", "turn-1"), undefined);
});


test("streaming thread updates retain deferred effort including explicit default", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-deferred-display-"));
  try {
    const store = new ThreadSettingsStore(dir);
    const thread = { agentId: "codex", id: "demo", reasoningEffort: "medium", status: "running" } as Parameters<ThreadSettingsStore["withDeferredSettings"]>[0];
    assert.equal(store.withDeferredSettings(thread), thread);
    await store.defer("codex", "demo", { reasoningEffort: "high" });
    for (const reasoningEffort of [undefined, "medium", "high"]) {
      const display = store.withDeferredSettings({ ...thread, reasoningEffort });
      assert.equal(display.reasoningEffort, "high");
      assert.equal(display.settingsDeferred, true);
      assert.equal(display.status, "running");
    }
    await store.defer("codex", "demo", { reasoningEffort: "" });
    assert.equal(store.withDeferredSettings(thread).reasoningEffort, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test("legacy wake identities are discarded while stable session aliases survive", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-alias-upgrade-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "thread-settings.json"), JSON.stringify({
    version: 1, settings: { codex: { demo: { wakeCode: "old-demo", alias: "s-0e67727", name: "Demo" } } },
  }));
  const store = new ThreadSettingsStore(dir);
  await store.load();
  assert.equal((store.get("codex", "demo") as any).wakeCode, undefined);
  assert.equal(store.sessionAlias("codex", "demo"), "s-0e67727");
  const { aliases } = await store.ensureSessionAliases([{ agentId: "codex", threadId: "demo" }]);
  assert.equal(aliases.get(JSON.stringify(["codex", "demo"])), "s-0e67727");
});
