import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeProjectPath, ProjectStore } from "./projects.js";

test("windows and wsl paths collapse to the same project key", () => {
  assert.equal(
    normalizeProjectPath("D:\\Code\\codex_auto_pilot"),
    normalizeProjectPath("/mnt/d/Code/codex_auto_pilot"),
  );
  assert.equal(normalizeProjectPath("D:\\"), "/mnt/d");
  assert.equal(normalizeProjectPath("D:"), "/mnt/d");
});

test("windows extended-length prefixes join the same project", () => {
  assert.equal(
    normalizeProjectPath("\\\\?\\D:\\Code\\BSHT"),
    normalizeProjectPath("D:\\Code\\BSHT"),
  );
  assert.equal(
    normalizeProjectPath("\\\\?\\D:\\Code\\BSHT"),
    normalizeProjectPath("/mnt/d/Code/BSHT"),
  );
});

test("project upsert persists alias pin and defaults", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-deck-proj-"));
  const store = new ProjectStore(dir);
  await store.load();
  const saved = await store.upsert({
    cwd: "D:\\Code\\demo",
    name: "Demo",
    pinned: true,
    defaults: { model: "gpt-test", sandbox: "read-only" },
  });
  assert.equal(saved.key, normalizeProjectPath("D:\\Code\\demo"));
  assert.equal(saved.name, "Demo");
  assert.equal(saved.pinned, true);
  const again = new ProjectStore(dir);
  await again.load();
  assert.equal(again.list()[0].name, "Demo");
  assert.equal(again.list()[0].defaults?.model, "gpt-test");
  assert.match(await readFile(path.join(dir, "projects.json"), "utf8"), /Demo/);
});

test("rememberCreate fills missing defaults and records recent dirs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-deck-pref-"));
  const store = new ProjectStore(dir);
  await store.load();
  await store.rememberCreate({
    cwd: "/mnt/d/Code/one",
    providerId: "local",
    model: "gpt-a",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
  });
  await store.rememberCreate({
    cwd: "/mnt/d/Code/one",
    providerId: "other",
    model: "gpt-b",
  });
  const project = store.list()[0];
  assert.equal(project.defaults?.model, "gpt-a");
  assert.equal(project.defaults?.providerId, "local");
  assert.equal(store.getPreferences().lastModel, "gpt-b");
  assert.deepEqual(store.getPreferences().recentDirs, ["/mnt/d/Code/one"]);
});

test("hidden and remove only touch deck metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-deck-hide-"));
  const store = new ProjectStore(dir);
  await store.load();
  await store.upsert({ cwd: "/tmp/a", hidden: true, name: "A" });
  assert.equal(store.list()[0].hidden, true);
  await store.remove("/tmp/a");
  assert.equal(store.list().length, 0);
});
