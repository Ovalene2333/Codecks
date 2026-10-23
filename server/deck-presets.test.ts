import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DeckPresetsStore } from "./deck-presets.js";
import {
  boundedAskPermissions,
  resolveAskConfiguration,
} from "./ask-settings.js";

test("named combinations persist, resolve atomically and retain agent permission policy", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-presets-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "presets.json");
  const store = new DeckPresetsStore(file);
  await store.load();
  const preset = {
    name: "review",
    agentId: "demo",
    providerId: "acme",
    model: "demo-model",
    reasoningEffort: "high",
  };
  await store.replace([preset]);
  const restored = new DeckPresetsStore(file);
  await restored.load();
  const selection = restored.resolve({ preset: "review" });
  assert.equal(selection.targetAgentId, "demo");
  assert.deepEqual(selection.configuration, {
    providerId: "acme",
    model: "demo-model",
    reasoningEffort: "high",
  });
  const defaults = {
    model: "other-model",
    sandbox: "read-only" as const,
    allowedPermissions: { sandbox: ["workspace-write" as const] },
  };
  assert.deepEqual(resolveAskConfiguration(defaults, selection.configuration), {
    ...selection.configuration,
    sandbox: "read-only",
  });
  assert.throws(
    () => boundedAskPermissions(defaults, { sandbox: "danger-full-access" }),
    /允许集合/,
  );
  assert.throws(() => restored.resolve({ preset: "missing" }), /预设不存在/);
  assert.throws(
    () => restored.resolve({ preset: "review", targetAgentId: "other" }),
    /不一致/,
  );
  assert.throws(
    () => restored.resolve({ preset: "review", model: "other" }),
    /不能/,
  );
  assert.throws(
    () => restored.resolve({ preset: "review", configuration: {} }),
    /不能/,
  );
  assert.throws(() => restored.resolve({}), /指定/);
  assert.deepEqual(restored.resolve({ targetAgentId: "demo" }), {
    targetAgentId: "demo",
    configuration: undefined,
  });
  assert.deepEqual(
    restored.resolve({ targetAgentId: "demo", model: "manual" }).configuration
      ?.model,
    "manual",
  );
  for (const invalid of [
    [preset, preset],
    [{ ...preset, model: " " }],
    [{ ...preset, name: "bad name" }],
    [{ ...preset, sandbox: "danger-full-access" }],
  ])
    await assert.rejects(restored.replace(invalid));
  assert.deepEqual(restored.list(), [preset]);
  await restored.replace([]);
  const removed = new DeckPresetsStore(file);
  await removed.load();
  assert.deepEqual(removed.list(), []);
  await writeFile(file, "broken");
  await assert.rejects(removed.load(), /读取失败/);
});
