import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ClaudeProviderStore,
  classifyClaudeEnvironment,
} from "./claude-profiles.js";
import { ClaudeAdapter } from "./agents/claude-adapter.js";

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-claude-providers-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ClaudeProviderStore(dir);
  await store.load();
  return { dir, store, file: path.join(dir, "claude-providers.json") };
}

test("Claude custom profiles work without CC Switch and secrets never reach public profiles", async (t) => {
  const { dir, store, file } = await fixture(t);
  const id = await store.upsert({
    name: "Independent relay",
    baseUrl: "https://relay.example.test",
    apiKey: "private-key",
    model: "sonnet",
  });
  const restored = new ClaudeProviderStore(dir);
  await restored.load();
  assert.equal(restored.profiles()[0].env.ANTHROPIC_API_KEY, "private-key");
  if (process.platform !== "win32")
    assert.equal((await stat(file)).mode & 0o777, 0o600);
  const adapter = new ClaudeAdapter({
    profileSource: () => restored.profiles(),
    historyFiles: async () => [],
  });
  await adapter.reloadProfiles();
  const publicProfiles = adapter.publicProfiles();
  assert.equal(
    publicProfiles.find((profile) => profile.id === id)?.kind,
    "custom",
  );
  assert.equal(
    publicProfiles.find((profile) => profile.id === id)?.hasApiKey,
    true,
  );
  assert.equal(JSON.stringify(publicProfiles).includes("private-key"), false);
  const thread = await adapter.createThread(id, { cwd: dir });
  assert.equal(thread.providerId, id);
  assert.equal(thread.model, "sonnet");
  assert.ok(publicProfiles.some((profile) => profile.id === "claude-local"));
});

test("custom and imported Claude profiles coexist; removing the source retains local and custom profiles", async (t) => {
  const { store } = await fixture(t);
  const id = await store.upsert({
    name: "Deck relay",
    baseUrl: "https://deck.test",
    apiKey: "token",
    authType: "auth-token",
  });
  assert.equal(store.profiles()[0].env.ANTHROPIC_AUTH_TOKEN, "token");
  let imported = [
    {
      ...store.profiles()[0],
      id: "claude-cc-relay",
      kind: "cc-switch" as const,
      current: true,
    },
  ];
  const adapter = new ClaudeAdapter({
    profileSource: () => [...store.profiles(), ...imported],
  });
  await adapter.reloadProfiles();
  assert.equal(
    adapter.publicProfiles().find((profile) => profile.id === "claude-local")
      ?.current,
    false,
  );
  imported = [];
  await adapter.reloadProfiles();
  assert.deepEqual(
    adapter.publicProfiles().map((profile) => profile.id),
    [id, "claude-local"],
  );
  assert.equal(
    adapter.publicProfiles().find((profile) => profile.id === "claude-local")
      ?.current,
    true,
  );
  await store.remove(id);
  await adapter.reloadProfiles();
  assert.deepEqual(
    adapter.publicProfiles().map((profile) => profile.id),
    ["claude-local"],
  );
});

test("Claude profile updates retain credentials, serialize writes, and cannot delete imported or local profiles", async (t) => {
  const { store, file } = await fixture(t);
  const [first, second] = await Promise.all([
    store.upsert({
      name: "First",
      baseUrl: "https://first.test",
      apiKey: "key",
    }),
    store.upsert({
      name: "Second",
      baseUrl: "https://second.test",
      apiKey: "other",
    }),
  ]);
  await store.upsert({
    id: first,
    name: "Renamed",
    baseUrl: "https://new.test",
  });
  assert.equal(store.profiles()[0].env.ANTHROPIC_API_KEY, "key");
  await assert.rejects(store.remove("claude-local"), /只能删除/);
  await assert.rejects(store.remove("claude-cc-relay"), /只能删除/);
  await store.remove(second);
  assert.equal(JSON.parse(await readFile(file, "utf8")).length, 1);
});

test("corrupt Claude configuration is preserved and does not prevent the local fallback", async (t) => {
  const { store, file } = await fixture(t);
  await writeFile(file, "{broken");
  await store.load();
  assert.deepEqual(store.profiles(), []);
  const adapter = new ClaudeAdapter({ profileSource: () => store.profiles() });
  await adapter.reloadProfiles();
  assert.equal(adapter.publicProfiles()[0].id, "claude-local");
  await assert.rejects(
    store.upsert({
      name: "Relay",
      baseUrl: "https://relay.test",
      apiKey: "secret",
    }),
    /不会覆盖/,
  );
  assert.equal(await readFile(file, "utf8"), "{broken");
});

test("Claude authentication validation rejects invalid endpoints and empty credentials", async (t) => {
  const { store } = await fixture(t);
  assert.equal(
    classifyClaudeEnvironment({ ANTHROPIC_API_KEY: " " }).supported,
    false,
  );
  assert.equal(
    classifyClaudeEnvironment({ CLAUDE_CODE_USE_BEDROCK: "1" }).supported,
    true,
  );
  await assert.rejects(
    store.upsert({ name: "No key", baseUrl: "https://relay.test" }),
    /API Key/,
  );
  await assert.rejects(
    store.upsert({
      name: "Bad URL",
      baseUrl: "file:///tmp/secret",
      apiKey: "key",
    }),
  );
});
