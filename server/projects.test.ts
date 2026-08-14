import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { normalizeProjectPath, ProjectStore } from "./projects.js";

test("windows and wsl paths collapse to the same project key", () => {
  assert.equal(
    normalizeProjectPath("D:\\Code\\demo-app"),
    normalizeProjectPath("/mnt/d/Code/demo-app"),
  );
  assert.equal(normalizeProjectPath("D:\\"), "/mnt/d");
  assert.equal(normalizeProjectPath("D:"), "/mnt/d");
});

test("windows drive plus /mnt/d alias joins the same project", () => {
  assert.equal(
    normalizeProjectPath("D:\\mnt\\d\\Work\\sample_project"),
    normalizeProjectPath("/mnt/d/Work/sample_project"),
  );
  assert.equal(
    normalizeProjectPath("/mnt/d/mnt/d/Work/sample_project"),
    "/mnt/d/work/sample_project",
  );
});

test("wsl UNC share paths join the corresponding POSIX project", () => {
  assert.equal(
    normalizeProjectPath("\\\\wsl.localhost\\Ubuntu\\mnt\\d\\Code\\demo"),
    normalizeProjectPath("D:\\Code\\demo"),
  );
  assert.equal(
    normalizeProjectPath("\\\\wsl$\\Ubuntu\\home\\tester\\repo"),
    "/home/tester/repo",
  );
});

test("windows extended-length prefixes join the same project", () => {
  assert.equal(
    normalizeProjectPath("\\\\?\\D:\\Code\\demo"),
    normalizeProjectPath("D:\\Code\\demo"),
  );
  assert.equal(
    normalizeProjectPath("\\\\?\\D:\\Code\\demo"),
    normalizeProjectPath("/mnt/d/Code/demo"),
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

test("load rematerializes aliased keys into one project", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-deck-alias-"));
  await writeFile(
    path.join(dir, "projects.json"),
    JSON.stringify([
      {
        key: "D:\\mnt\\d\\Work\\sample_project",
        cwd: "D:\\mnt\\d\\Work\\sample_project",
        updatedAt: 2,
      },
      {
        key: "/mnt/d/work/sample_project",
        cwd: "/mnt/d/Work/sample_project",
        name: "Sample",
        updatedAt: 1,
      },
    ]),
  );
  const store = new ProjectStore(dir);
  await store.load();
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].key, "/mnt/d/work/sample_project");
  assert.equal(store.list()[0].name, "Sample");
});

test("rememberSeen records unknown directories without touching defaults", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-deck-seen-"));
  const store = new ProjectStore(dir);
  await store.load();
  await store.upsert({
    cwd: "/mnt/d/Code/kept",
    name: "Kept",
    defaults: { model: "gpt-a", requestMaxRetries: 8 },
  });
  assert.equal(
    await store.rememberSeenMany([
      { cwd: "/mnt/d/Code/kept", updatedAt: 99 },
      { cwd: "D:\\Code\\fresh", updatedAt: 12 },
      { cwd: "", updatedAt: 1 },
    ]),
    true,
  );
  assert.equal(await store.rememberSeen("D:\\Code\\fresh"), false);
  const rows = store.list();
  const kept = rows.find((item) => item.name === "Kept");
  const fresh = rows.find((item) => item.cwd === "D:\\Code\\fresh");
  assert.equal(kept?.defaults?.model, "gpt-a");
  assert.equal(kept?.defaults?.requestMaxRetries, 8);
  assert.equal(fresh?.name, undefined);
  assert.equal(fresh?.defaults, undefined);
});

test("connection overlay prefers the latest project for a provider", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-deck-overlay-"));
  const store = new ProjectStore(dir);
  await store.load();
  await store.upsert({
    cwd: "/tmp/a",
    defaults: { providerId: "relay", requestMaxRetries: 8 },
  });
  await store.upsert({
    cwd: "/tmp/b",
    defaults: { providerId: "relay", requestMaxRetries: 3, streamMaxRetries: 9 },
  });
  await store.upsert({
    cwd: "/tmp/c",
    defaults: { requestMaxRetries: 1 },
  });
  assert.deepEqual(store.overlayForProvider("relay"), {
    requestMaxRetries: 3,
    streamMaxRetries: 9,
  });
  assert.deepEqual(store.overlayForProvider("other"), {
    requestMaxRetries: 1,
  });
  await store.setConnectionOverlay({ streamIdleTimeoutMs: 120000 });
  const again = new ProjectStore(dir);
  await again.load();
  assert.equal(again.getPreferences().streamIdleTimeoutMs, 120000);
  assert.equal(again.overlayForProvider("other").requestMaxRetries, 1);
});

test("clearing retry fields removes them from project defaults", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-deck-clear-"));
  const store = new ProjectStore(dir);
  await store.load();
  await store.upsert({
    cwd: "/tmp/a",
    defaults: { model: "gpt-a", requestMaxRetries: 8 },
  });
  const saved = await store.upsert({
    cwd: "/tmp/a",
    defaults: { model: "gpt-a", requestMaxRetries: null },
  });
  assert.equal(saved.defaults?.model, "gpt-a");
  assert.equal(saved.defaults?.requestMaxRetries, undefined);
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
