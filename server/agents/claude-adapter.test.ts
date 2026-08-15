import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ClaudeAdapter } from "./claude-adapter.js";

test("Claude history summaries reuse unchanged files across server instances", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deck-claude-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session.jsonl");
  const index = path.join(root, "history-index.json");
  await writeFile(file, "first");
  let reads = 0;
  let files = [file];
  const historyReader = async () => {
    reads += 1;
    const summary = {
      agentId: "claude" as const,
      id: "different-session-id",
      providerId: "claude-current",
      cwd: "/work",
      preview: "cached",
      model: "claude-test",
      status: "idle" as const,
      updatedAt: 1,
    };
    return {
      summary,
      thread: {
        id: summary.id,
        cwd: summary.cwd,
        model: summary.model,
        turns: [],
      },
    };
  };
  const options = {
    historyFiles: async () => files,
    historyIndexFile: index,
    historyReader,
  };

  await new ClaudeAdapter(options).startAll();
  await new ClaudeAdapter(options).startAll();
  assert.equal(reads, 1);

  await writeFile(file, "changed-size");
  const third = new ClaudeAdapter(options);
  await third.startAll();
  assert.equal(reads, 2);

  files = [];
  await third.refreshAll();
  assert.equal(third.listThreads().length, 0);
});

const waitFor = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition timed out");
};

function mockQuery(
  run: (params: any) => AsyncGenerator<any, void>,
  calls: any[],
) {
  return ((params: any) => {
    calls.push(params);
    const stream: any = run(params);
    stream.interrupt = async () => {
      stream.interrupted = true;
      await stream.return();
    };
    return stream;
  }) as any;
}

test("Claude adapter creates, streams, approves, and completes a native session", async () => {
  const calls: any[] = [];
  let permissionResult: any;
  const queryFactory = mockQuery(async function* (params) {
    const inputs = [];
    for await (const input of params.prompt) inputs.push(input);
    assert.equal(inputs[0].message.content[0].text, "ship it");
    yield {
      type: "system",
      subtype: "init",
      model: "claude-sonnet-test",
      cwd: "/work",
      session_id: inputs[0].session_id,
    };
    yield {
      type: "stream_event",
      uuid: "message-1",
      session_id: inputs[0].session_id,
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Working" },
      },
    };
    permissionResult = await params.options.canUseTool(
      "Bash",
      { command: "npm test" },
      {
        signal: new AbortController().signal,
        toolUseID: "tool-1",
        suggestions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash", ruleContent: "npm test" }],
            behavior: "allow",
            destination: "session",
          },
        ],
      },
    );
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
        output_tokens: 4,
      },
      modelUsage: { test: { contextWindow: 200_000 } },
      session_id: inputs[0].session_id,
    };
  }, calls);
  const adapter = new ClaudeAdapter({
    queryFactory,
    historyFiles: async () => [],
  });
  const events: any[] = [];
  adapter.on("event", (event) => events.push(event));
  await adapter.startAll();
  const thread: any = await adapter.createThread("claude-current", {
    cwd: "/work",
    model: "claude-sonnet-test",
  });

  const started: any = await adapter.sendTurn(
    thread.providerId,
    thread.id,
    "ship it",
  );
  await waitFor(() => adapter.snapshot().approvals.length === 1);
  const approval: any = adapter.snapshot().approvals[0];
  assert.equal(approval.agentId, "claude");
  assert.equal(approval.command, "npm test");
  await adapter.resolveApproval(approval.id, {
    decision: "acceptForSession",
  });
  await waitFor(() => adapter.listThreads()[0].status === "idle");

  assert.equal(started.turn.status, "inProgress");
  assert.equal(permissionResult.behavior, "allow");
  assert.equal(permissionResult.updatedPermissions.length, 1);
  assert.equal(calls[0].options.extraArgs["session-id"], thread.id);
  assert.deepEqual(adapter.listThreads()[0].tokenUsage, {
    total: 19,
    used: 19,
    limit: 200_000,
    input: 13,
    cachedInput: 2,
    output: 4,
  });
  assert.ok(
    events.some(
      (event) =>
        event.type === "agent.event" &&
        event.data.agentId === "claude" &&
        event.data.method === "item/agentMessage/delta",
    ),
  );
});

test("Claude adapter resumes history and keeps secrets server-side", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "claude-adapter-"));
  const history = path.join(dir, "session-history.jsonl");
  const ccSwitch = path.join(dir, "cc-switch.db");
  const db = new DatabaseSync(ccSwitch);
  db.exec(
    "create table providers (id text, app_type text, name text, settings_config text, icon_color text, is_current integer, sort_index integer)",
  );
  db.prepare("insert into providers values (?, ?, ?, ?, ?, ?, ?)").run(
    "profile",
    "claude",
    "Private profile",
    JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "super-secret" } }),
    null,
    1,
    0,
  );
  db.close();
  const historySource = [
    {
      type: "user",
      uuid: "u1",
      sessionId: "session-history",
      cwd: "/work",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "continue" },
    },
    { type: "last-prompt", leafUuid: "u1", sessionId: "session-history" },
  ]
    .map(JSON.stringify)
    .join("\n");
  await writeFile(history, historySource);
  const calls: any[] = [];
  const queryFactory = mockQuery(async function* (params) {
    for await (const _input of params.prompt) void _input;
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {
        input_tokens: 1,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 1,
      },
      modelUsage: {},
      session_id: "session-history",
    };
  }, calls);
  const adapter = new ClaudeAdapter({
    queryFactory,
    historyFiles: async () => [history],
    ccSwitchPath: ccSwitch,
  });
  await adapter.startAll();
  await writeFile(history, "{temporarily-broken");
  await adapter.refreshAll();
  assert.equal(adapter.listThreads().length, 1);
  await writeFile(history, historySource);
  await adapter.sendTurn("claude-current", "session-history", "resume please");
  await waitFor(() => adapter.listThreads()[0].status === "idle");
  assert.equal(calls[0].options.resume, "session-history");
  assert.equal(calls[0].options.env.ANTHROPIC_AUTH_TOKEN, "super-secret");
  assert.equal(
    JSON.stringify({
      snapshot: adapter.snapshot(),
      profiles: adapter.publicProfiles(),
    }).includes("super-secret"),
    false,
  );
});

test("Claude adapter records spawn errors and can be restarted repeatedly", async () => {
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [],
    queryFactory: (() => {
      throw new Error("spawn failed");
    }) as any,
  });
  await adapter.startAll();
  const thread: any = await adapter.createThread("claude-current", {
    cwd: "/work",
  });
  await adapter.sendTurn(thread.providerId, thread.id, "run");
  await waitFor(() => adapter.listThreads()[0].status === "error");
  assert.match(adapter.listThreads()[0].lastError || "", /spawn failed/);
  adapter.restart();
  adapter.restart();
  assert.equal(adapter.descriptor().online, false);
});

test("Claude adapter coalesces concurrent startup", async () => {
  let loads = 0;
  let release!: () => void;
  const adapter = new ClaudeAdapter({
    historyFiles: async () => {
      loads += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [];
    },
  });
  const first = adapter.startAll();
  const second = adapter.startAll();
  await waitFor(() => Boolean(release));
  release();
  await Promise.all([first, second]);
  assert.equal(loads, 1);
  assert.equal(adapter.descriptor().online, true);
  assert.equal(adapter.descriptor().capabilities.archive, false);
  assert.equal(adapter.descriptor().capabilities.review, false);
});

test("Claude adapter interrupts an active query", async () => {
  let release!: () => void;
  let interrupted = false;
  const queryFactory = (() => {
    const stream: any = (async function* () {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    })();
    stream.interrupt = async () => {
      interrupted = true;
      release();
    };
    return stream;
  }) as any;
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [],
    queryFactory,
  });
  await adapter.startAll();
  const thread: any = await adapter.createThread("claude-current", {
    cwd: "/work",
  });
  const started: any = await adapter.sendTurn(
    thread.providerId,
    thread.id,
    "wait",
  );
  await adapter.interrupt(thread.providerId, thread.id, started.turn.id);
  await waitFor(() => adapter.listThreads()[0].status === "idle");
  assert.equal(interrupted, true);
});
