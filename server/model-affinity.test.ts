import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelAffinityStore, modelAffinityScope } from "./model-affinity.js";

async function withDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "model-affinity-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("scope key keeps opencode directories apart from provider ids", () => {
  assert.equal(
    modelAffinityScope("opencode", { directory: "/work/a" }),
    "opencode:/work/a",
  );
  assert.equal(
    modelAffinityScope("codex", { providerId: "openai" }),
    "codex:openai",
  );
  assert.equal(modelAffinityScope("codex", {}), "codex:default");
  assert.equal(
    modelAffinityScope("opencode", {}),
    modelAffinityScope("opencode", { directory: "" }),
  );
});

test("recordUse tracks counts and last, surviving reload", async () => {
  await withDir(async (dir) => {
    const store = new ModelAffinityStore(dir);
    await store.load();
    await store.recordUse("opencode", { directory: "/work" }, "zai/glm-5.3");
    await store.recordUse("opencode", { directory: "/work" }, "zai/glm-5.2");
    await store.recordUse("opencode", { directory: "/work" }, "zai/glm-5.3");
    const restored = new ModelAffinityStore(dir);
    await restored.load();
    assert.deepEqual(restored.get("opencode", { directory: "/work" }), {
      starred: [],
      counts: { "zai/glm-5.3": 2, "zai/glm-5.2": 1 },
      last: "zai/glm-5.3",
      updatedAt: restored.get("opencode", { directory: "/work" }).updatedAt,
    });
    assert.ok(
      restored.get("opencode", { directory: "/work" }).updatedAt > 0,
    );
  });
});

test("recordUse ignores blank or oversized model ids", async () => {
  await withDir(async (dir) => {
    const store = new ModelAffinityStore(dir);
    await store.load();
    const blank = await store.recordUse("codex", { providerId: "p" }, "   ");
    assert.deepEqual(blank.counts, {});
    assert.equal(blank.last, null);
    const long = await store.recordUse(
      "codex",
      { providerId: "p" },
      `m${"x".repeat(2000)}`,
    );
    assert.deepEqual(long.counts, {});
  });
});

test("setStarred pins newest first and toggles off", async () => {
  await withDir(async (dir) => {
    const store = new ModelAffinityStore(dir);
    await store.load();
    const scope = { providerId: "openai" } as const;
    await store.setStarred("codex", scope, "openai/gpt-5.2", true);
    await store.setStarred("codex", scope, "openai/gpt-5.1", true);
    assert.deepEqual(store.get("codex", scope).starred, [
      "openai/gpt-5.1",
      "openai/gpt-5.2",
    ]);
    await store.setStarred("codex", scope, "openai/gpt-5.1", false);
    assert.deepEqual(store.get("codex", scope).starred, ["openai/gpt-5.2"]);
    const restored = new ModelAffinityStore(dir);
    await restored.load();
    assert.deepEqual(restored.get("codex", scope).starred, [
      "openai/gpt-5.2",
    ]);
  });
});

test("scopes stay isolated per agent and directory", async () => {
  await withDir(async (dir) => {
    const store = new ModelAffinityStore(dir);
    await store.load();
    await store.recordUse("opencode", { directory: "/a" }, "m/a");
    await store.setStarred("opencode", { directory: "/b" }, "m/b", true);
    await store.recordUse("codex", { providerId: "p" }, "m/c");
    assert.equal(store.get("opencode", { directory: "/a" }).last, "m/a");
    assert.deepEqual(
      store.get("opencode", { directory: "/b" }).starred,
      ["m/b"],
    );
    assert.equal(store.get("codex", { providerId: "p" }).last, "m/c");
    assert.deepEqual(store.get("opencode", { directory: "/a" }).starred, []);
  });
});

test("counts prune to the most used models", async () => {
  await withDir(async (dir) => {
    const store = new ModelAffinityStore(dir);
    await store.load();
    const scope = { providerId: "big" } as const;
    for (let i = 0; i < 250; i += 1) {
      await store.recordUse("codex", scope, `model-${i}`);
    }
    await store.recordUse("codex", scope, "model-0");
    await store.recordUse("codex", scope, "model-0");
    const entry = store.get("codex", scope);
    assert.equal(Object.keys(entry.counts).length, 200);
    assert.ok(entry.counts["model-0"] === 3);
    assert.equal(entry.last, "model-0");
  });
});

test("corrupt json falls back to empty instead of crashing startup", async () => {
  await withDir(async (dir) => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dir, "model-affinity.json"), "{oops", "utf8");
    const store = new ModelAffinityStore(dir);
    await store.load();
    assert.deepEqual(store.get("opencode", { directory: "/w" }), {
      starred: [],
      counts: {},
      last: null,
      updatedAt: 0,
    });
  });
});
