import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  const reassigned = await restored.ensureSessionAliases([{ agentId: "codex", threadId: "thread-1" }]);
  assert.equal(reassigned.aliases.get(JSON.stringify(["codex", "thread-1"])), first);
});

test("session aliases avoid reserved identifiers and wake codes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-thread-settings-alias-reserved-"));
  const store = new ThreadSettingsStore(dir);
  await store.load();
  const { aliases: assigned } = await store.ensureSessionAliases(
    [{ agentId: "codex", threadId: "thread-1" }],
    ["s-reserved", "s-0000000"],
  );
  const alias = assigned.get(JSON.stringify(["codex", "thread-1"]))!;
  assert.notEqual(alias, "s-reserved");
  await assert.rejects(store.ensureWakeCode("codex", "thread-2", alias), /已被占用/);
});

test("wake codes are generated, survive restarts, and resolve back to the thread", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-thread-settings-wake-"));
  const store = new ThreadSettingsStore(dir);
  await store.load();
  const code = await store.ensureWakeCode("opencode", "session-1");
  assert.match(code, /^[0-9a-f]{8}$/);
  // 幂等：再次领取返回同一代号，preferred 被忽略。
  assert.equal(await store.ensureWakeCode("opencode", "session-1"), code);
  assert.equal(
    await store.ensureWakeCode("opencode", "session-1", "gpu-box"),
    code,
  );
  assert.deepEqual(store.findByWakeCode(code), {
    agentId: "opencode",
    threadId: "session-1",
  });

  const restored = new ThreadSettingsStore(dir);
  await restored.load();
  assert.deepEqual(restored.findByWakeCode(code), {
    agentId: "opencode",
    threadId: "session-1",
  });
  assert.deepEqual(restored.listWakeCodes(), [
    { code, agentId: "opencode", threadId: "session-1" },
  ]);
});

test("custom wake codes are validated and unique across agents", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-thread-settings-wake2-"));
  const store = new ThreadSettingsStore(dir);
  await store.load();
  assert.equal(
    await store.ensureWakeCode("opencode", "s-1", "gpu-train"),
    "gpu-train",
  );
  await assert.rejects(
    store.ensureWakeCode("claude", "s-2", "gpu-train"),
    /已被占用/,
  );
  await assert.rejects(store.ensureWakeCode("claude", "s-2", "Bad Code!"));
  // 不同会话各自生成不冲突的随机代号。
  const another = await store.ensureWakeCode("claude", "s-2");
  assert.notEqual(another, "gpu-train");
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

test("clearWakeCode drops the mapping and empty settings entries", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-thread-settings-wake3-"));
  const store = new ThreadSettingsStore(dir);
  await store.load();
  const code = await store.ensureWakeCode("opencode", "session-1");
  await store.clearWakeCode("opencode", "session-1");
  assert.equal(store.findByWakeCode(code), undefined);
  assert.equal(store.get("opencode", "session-1"), undefined);
  // 清除不存在的代号是 no-op。
  await store.clearWakeCode("opencode", "session-1");
  // 会话删除时代号随设置一起消失。
  const again = await store.ensureWakeCode("opencode", "session-2");
  await store.remove("opencode", "session-2");
  assert.equal(store.findByWakeCode(again), undefined);
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
