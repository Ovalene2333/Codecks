import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { CodexManager } from "./manager.js";
import {
  CodexUsageStore,
  loadCodexRolloutUsages,
  parseCodexRolloutUsageLine,
  parseWslCodexUsages,
  threadIdFromRolloutPath,
  wslCodexUsageArgs,
} from "./codex-usage.js";

const threadId = "019ffddc-408f-7e00-b7a1-5444c1acadf8";
const execFileAsync = promisify(execFile);

function tokenCount(total: number, used: number, limit = 258_400) {
  return JSON.stringify({
    timestamp: "2026-08-15T13:23:48.099Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: total - 500,
          cached_input_tokens: 4_000,
          output_tokens: 500,
          reasoning_output_tokens: 120,
          total_tokens: total,
        },
        last_token_usage: {
          input_tokens: used - 100,
          cached_input_tokens: 2_000,
          output_tokens: 100,
          reasoning_output_tokens: 20,
          total_tokens: used,
        },
        model_context_window: limit,
      },
    },
  });
}

test("Codex rollout token_count restores cumulative and context usage", () => {
  assert.deepEqual(parseCodexRolloutUsageLine(tokenCount(43_534, 27_294)), {
    total: 43_534,
    used: 27_294,
    limit: 258_400,
    input: 39_034,
    cachedInput: 4_000,
    output: 500,
    reasoningOutput: 120,
  });
  assert.equal(parseCodexRolloutUsageLine('{"type":"event_msg"}'), undefined);
});

test("persisted Codex usage migrates inclusive input to uncached input", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deck-usage-migrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    path.join(root, "codex-usage.json"),
    JSON.stringify({
      version: 1,
      threads: {
        [threadId]: {
          total: 20_000,
          input: 18_000,
          cachedInput: 7_500,
          output: 2_000,
        },
      },
    }),
  );
  const store = new CodexUsageStore(root);
  await store.load();
  assert.equal(store.get(threadId)?.input, 10_500);
});

test("new usage without totals is not normalized twice across restarts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deck-usage-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new CodexUsageStore(root);
  await first.load();
  await first.set(threadId, { input: 1_000, cachedInput: 8_000 });

  const second = new CodexUsageStore(root);
  await second.load();
  assert.equal(second.get(threadId)?.input, 1_000);
});

test("native rollout recovery reads the latest token_count from the file tail", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deck-codex-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "sessions", "2026", "08", "15");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-08-15T21-25-29-${threadId}.jsonl`);
  await writeFile(
    file,
    [
      tokenCount(10_000, 8_000),
      JSON.stringify({ type: "response_item", payload: "x".repeat(300_000) }),
      tokenCount(43_534, 27_294),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ].join("\n"),
  );

  const restored = await loadCodexRolloutUsages({
    codexHome: root,
    wanted: new Set([threadId]),
  });
  assert.equal(restored.get(threadId)?.total, 43_534);
  assert.equal(restored.get(threadId)?.used, 27_294);
});

test("WSL usage output maps rollout paths back to thread ids", () => {
  const file = `/home/test/.codex/sessions/2026/08/15/rollout-x-${threadId}.jsonl`;
  const parsed = parseWslCodexUsages(
    `${file}\t${tokenCount(30_000, 12_000)}\n`,
  );
  assert.equal(parsed.get(threadId)?.limit, 258_400);
  assert.equal(threadIdFromRolloutPath(file), threadId);
  assert.equal(
    wslCodexUsageArgs("/home/test/.codex").at(-2),
    "/home/test/.codex",
  );
});

test("WSL usage scripts read the latest token_count without quote loss", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deck-wsl-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, "archived_sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `rollout-x-${threadId}.jsonl`),
    `${[tokenCount(12_000, 8_000), tokenCount(33_000, 17_000)].join("\n")}\n`,
  );
  const args = wslCodexUsageArgs(root);
  const { stdout } = await execFileAsync("sh", args.slice(2));
  const restored = parseWslCodexUsages(stdout);
  assert.equal(restored.get(threadId)?.total, 33_000);
  assert.equal(restored.get(threadId)?.used, 17_000);
});

test("Codex usage store survives a new server instance", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deck-usage-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new CodexUsageStore(root);
  await first.load();
  await first.set(threadId, { total: 30_000, used: 12_000, limit: 258_400 });
  await first.flush();

  const second = new CodexUsageStore(root);
  await second.load();
  assert.deepEqual(second.get(threadId), {
    total: 30_000,
    used: 12_000,
    limit: 258_400,
  });
});

test("Codex token usage notifications are persisted", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deck-usage-notify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = { id: "local", model: "gpt-test" };
  const manager = new CodexManager(
    { runtimeProfile: () => provider, listPublic: () => [] } as any,
    root,
  ) as any;
  manager.upsertThread(provider, {
    id: threadId,
    cwd: "/work/project",
    preview: "live",
  });
  manager.onNotification({
    method: "thread/tokenUsage/updated",
    params: {
      threadId,
      tokenUsage: {
        total: {
          totalTokens: 44_000,
          inputTokens: 43_000,
          outputTokens: 1_000,
        },
        last: { totalTokens: 19_000 },
        modelContextWindow: 258_400,
      },
    },
  });
  await manager.usageStore.flush();

  const restored = new CodexUsageStore(root);
  await restored.load();
  assert.deepEqual(restored.get(threadId), {
    total: 44_000,
    used: 19_000,
    limit: 258_400,
    input: 43_000,
    output: 1_000,
  });
});

test("explicit Codex history repair backfills usage then reuses it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "deck-usage-restart-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex-home");
  const sessionDir = path.join(codexHome, "sessions", "2026", "08", "15");
  await mkdir(sessionDir, { recursive: true });
  const rollout = path.join(sessionDir, `rollout-x-${threadId}.jsonl`);
  await writeFile(rollout, tokenCount(55_000, 23_000));
  const provider = {
    id: "local",
    name: "Local",
    kind: "local-profile",
    model: "gpt-test",
    codexHome,
  };
  const store = {
    runtimeProviders: () => [],
    runtimeProfile: () => provider,
    listPublic: () => [],
    get: () => provider,
  };
  const client = {
    request: async (method: string, params: any) => {
      if (method !== "thread/list") throw new Error(method);
      return {
        data: params.archived
          ? []
          : [{ id: threadId, cwd: "/work/project", preview: "history" }],
      };
    },
  };

  const first = new CodexManager(store as any, root) as any;
  first.ensure = async () => client;
  await first.usageStore.load();
  await first.repairHistory();
  assert.equal(first.listThreads()[0].tokenUsage.total, 55_000);
  await first.usageStore.flush();

  await rm(rollout);
  const second = new CodexManager(store as any, root) as any;
  second.ensure = async () => client;
  await second.startAll();
  assert.deepEqual(second.listThreads()[0].tokenUsage, {
    total: 55_000,
    used: 23_000,
    limit: 258_400,
    input: 50_500,
    cachedInput: 4_000,
    output: 500,
    reasoningOutput: 120,
  });
});
