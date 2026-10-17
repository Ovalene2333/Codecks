import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AskSettingsStore, resolveAskConfiguration } from "./ask-settings.js";

test("ask defaults persist per target; empty manual configuration resets to native defaults", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-ask-settings-"));
  try {
    const file = path.join(dir, "settings.json");
    const first = new AskSettingsStore(file); await first.load();
    assert.deepEqual(first.get("demo"), {});
    await first.set("demo", { providerId: "acme", model: "demo-model", reasoningEffort: "high" });
    const second = new AskSettingsStore(file); await second.load();
    assert.equal(second.get("demo").reasoningEffort, "high");
    assert.deepEqual(second.get("other"), {});
    const manual = resolveAskConfiguration(second.get("demo"), { model: "other-model" });
    assert.deepEqual(manual, { model: "other-model" });
    assert.equal(second.get("demo").model, "demo-model");
    assert.deepEqual(resolveAskConfiguration(second.get("demo"), {}), {});
    await second.set("demo", {});
    const third = new AskSettingsStore(file); await third.load();
    assert.deepEqual(third.get("demo"), {});
  } finally { await rm(dir, { recursive: true, force: true }); }
});
