import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSettingsStore } from "./agent-settings.js";

async function withDir<T>(run: (dir: string) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-agent-settings-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a fresh store has no explicit choices", async () => {
  await withDir(async (dir) => {
    const store = new AgentSettingsStore(dir);
    await store.load();
    assert.equal(store.enabled("kimi"), undefined);
  });
});

test("explicit choices survive a reload and can be cleared back to the default", async () => {
  await withDir(async (dir) => {
    const first = new AgentSettingsStore(dir);
    await first.load();
    await first.setEnabled("kimi", true);
    await first.setEnabled("devin", false);

    const second = new AgentSettingsStore(dir);
    await second.load();
    assert.equal(second.enabled("kimi"), true);
    assert.equal(second.enabled("devin"), false);

    await second.setEnabled("kimi", null);
    const third = new AgentSettingsStore(dir);
    await third.load();
    assert.equal(third.enabled("kimi"), undefined);
    assert.equal(third.enabled("devin"), false);
  });
});

test("writes are atomic and leave no temp files behind", async () => {
  await withDir(async (dir) => {
    const store = new AgentSettingsStore(dir);
    await store.load();
    await Promise.all([
      store.setEnabled("a", true),
      store.setEnabled("b", false),
      store.setEnabled("c", true),
    ]);
    const files = await readdir(dir);
    assert.deepEqual(files, ["agent-settings.json"]);
    const saved = JSON.parse(
      await readFile(path.join(dir, "agent-settings.json"), "utf8"),
    );
    assert.deepEqual(saved, {
      version: 1,
      agents: {
        a: { enabled: true },
        b: { enabled: false },
        c: { enabled: true },
      },
    });
  });
});

test("a corrupt or foreign file falls back to empty instead of blocking startup", async () => {
  await withDir(async (dir) => {
    const file = path.join(dir, "agent-settings.json");
    const originalError = console.error;
    console.error = () => {};
    try {
      await writeFile(file, "{ not json");
      const broken = new AgentSettingsStore(dir);
      await broken.load();
      assert.equal(broken.enabled("kimi"), undefined);
      // 原文件保留现场，直到下一次写入才覆盖。
      assert.equal(await readFile(file, "utf8"), "{ not json");
    } finally {
      console.error = originalError;
    }

    // 版本不对或字段类型不对的条目被忽略，合法条目照常读取。
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        agents: {
          good: { enabled: false },
          bad: { enabled: "yes" },
          worse: null,
          array: [true],
        },
      }),
    );
    const partial = new AgentSettingsStore(dir);
    await partial.load();
    assert.equal(partial.enabled("good"), false);
    assert.equal(partial.enabled("bad"), undefined);
    assert.equal(partial.enabled("worse"), undefined);
    assert.equal(partial.enabled("array"), undefined);

    await writeFile(
      file,
      JSON.stringify({ version: 2, agents: { x: { enabled: true } } }),
    );
    const future = new AgentSettingsStore(dir);
    await future.load();
    assert.equal(future.enabled("x"), undefined);
  });
});

test("setting the value that is already stored does not touch the disk", async () => {
  await withDir(async (dir) => {
    const store = new AgentSettingsStore(dir);
    await store.load();
    await store.setEnabled("kimi", null);
    await store.setEnabled("kimi", true);
    const file = path.join(dir, "agent-settings.json");
    const before = await readFile(file, "utf8");
    await rm(file);
    await store.setEnabled("kimi", true);
    await assert.rejects(readFile(file, "utf8"), { code: "ENOENT" });
    assert.ok(before.includes('"kimi"'));
  });
});
