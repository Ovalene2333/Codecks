import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ThreadSettingsStore } from "../thread-settings.js";
import { readClaudeHistory } from "./claude-history.js";
import {
  claudeRuntimePreference,
  ClaudeAdapter,
  defaultClaudeHome,
  findClaudeExecutable,
  windowsClaudeLaunchSpec,
  wslClaudeLaunchSpec,
} from "./claude-adapter.js";

const relayProfile = {
  id: "claude-cc-relay",
  name: "Relay",
  color: "#d97757",
  current: true,
  official: false,
  supported: true,
  env: {
    ANTHROPIC_BASE_URL: "https://relay.example.test",
    ANTHROPIC_AUTH_TOKEN: "relay-secret",
  },
};

const backupRelayProfile = {
  ...relayProfile,
  id: "claude-cc-backup",
  name: "Backup relay",
  current: false,
  env: {
    ANTHROPIC_BASE_URL: "https://backup-relay.example.test",
    ANTHROPIC_AUTH_TOKEN: "backup-secret",
  },
};

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

test("Claude keeps one SDK process across turns and keeps its provider bound", async () => {
  const calls: any[] = [];
  const inputs: string[] = [];
  let closed = false;
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [],
    initialProfiles: [relayProfile, backupRelayProfile],
    queryFactory: ((params: any) => {
      calls.push(params);
      const stream: any = (async function* () {
        for await (const input of params.prompt) {
          const blocks = input.message.content;
          inputs.push(blocks.find((block: any) => block.type === "text")?.text);
          yield {
            type: "result", subtype: "success", is_error: false,
            usage: {}, modelUsage: {}, session_id: input.session_id,
          };
        }
      })();
      stream.close = () => { closed = true; };
      stream.interrupt = async () => undefined;
      stream.setModel = async () => undefined;
      stream.setPermissionMode = async () => undefined;
      return stream;
    }) as any,
  });
  await adapter.startAll();
  const thread = await adapter.createThread(relayProfile.id, { cwd: "/work" });
  await adapter.sendTurn(thread.providerId, thread.id, "first");
  await waitFor(() => adapter.listThreads()[0]?.status === "idle");
  await adapter.sendTurn(thread.providerId, thread.id, "second");
  await waitFor(() => inputs.length === 2 && adapter.listThreads()[0]?.status === "idle");
  assert.deepEqual(inputs, ["first", "second"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.ANTHROPIC_AUTH_TOKEN, "relay-secret");
  await assert.rejects(
    adapter.deleteThread(thread.providerId, thread.id),
    /Deck 当前.*保持 SDK 连接/,
  );
  await assert.rejects(
    adapter.updateThreadSettings(relayProfile.id, thread.id, { providerId: backupRelayProfile.id }),
    /创建分支/,
  );
  assert.equal(closed, false);
  await adapter.deleteThread(thread.providerId, thread.id, { closeConnection: true });
  assert.equal(closed, true);
  assert.equal(adapter.listThreads().length, 0);
});

test("Claude deletion reports the actual external lock owner", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deck-claude-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "external.jsonl");
  const sessions = path.join(root, "sessions");
  await mkdir(sessions);
  await writeFile(file, JSON.stringify({
    type: "user", uuid: "external-user", sessionId: "external", cwd: root,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "original" },
  }) + "\n");
  await writeFile(path.join(sessions, `${process.pid}.json`),
    JSON.stringify({ sessionId: "external", pid: process.pid, name: "Agent View" }));
  const adapter = new ClaudeAdapter({ claudeHome: root, historyFiles: async () => [file] });
  await adapter.startAll();
  await assert.rejects(adapter.deleteThread("claude-local", "external"),
    new RegExp(`PID ${process.pid}.*Agent View`));
  assert.equal(adapter.listThreads().length, 1);
  await rm(path.join(sessions, `${process.pid}.json`));
  await adapter.deleteThread("claude-local", "external");
  assert.equal(adapter.listThreads().length, 0);
});

test("Claude branch starts disconnected and retains its own provider setting", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deck-claude-branch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "source.jsonl");
  await writeFile(file, JSON.stringify({
    type: "user", uuid: "source-user", sessionId: "source", cwd: root,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "original" },
  }) + "\n");
  const settings = new ThreadSettingsStore(root);
  await settings.load();
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [file],
    initialProfiles: [relayProfile],
    threadSettings: settings,
    queryFactory: ((params: any) => {
      const stream: any = (async function* () {
        for await (const input of params.prompt)
          yield { type: "result", subtype: "success", is_error: false,
            usage: {}, modelUsage: {}, session_id: input.session_id };
      })();
      stream.close = () => undefined;
      stream.interrupt = async () => undefined;
      return stream;
    }) as any,
  });
  await adapter.startAll();
  await adapter.updateThreadSettings(relayProfile.id, "source", { providerId: relayProfile.id });
  await adapter.sendTurn(relayProfile.id, "source", "continue");
  await waitFor(() => adapter.listThreads().find((item) => item.id === "source")?.claudeConnected === true &&
    adapter.listThreads().find((item) => item.id === "source")?.status === "idle");
  const branch = await adapter.forkThread(relayProfile.id, "source");
  assert.equal(branch.claudeConnected, false);
  assert.equal(branch.controlMode, "history");
  assert.equal(settings.get("claude", branch.id)?.providerId, relayProfile.id);
  assert.equal(adapter.listThreads().find((item) => item.id === "source")?.claudeConnected, true);
  adapter.restart();
});

test("Claude provider choice persists after a session setting change", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deck-claude-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = new ThreadSettingsStore(root);
  await settings.load();
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [],
    initialProfiles: [relayProfile, backupRelayProfile],
    threadSettings: settings,
  });
  await adapter.startAll();
  const thread = await adapter.createThread(relayProfile.id, { cwd: "/work" });
  await adapter.updateThreadSettings(relayProfile.id, thread.id, { providerId: backupRelayProfile.id });
  const restored = new ThreadSettingsStore(root);
  await restored.load();
  assert.equal(restored.get("claude", thread.id)?.providerId, backupRelayProfile.id);
});

test("Claude login failure identifies the selected profile without exposing its secret", async () => {
  const adapter = new ClaudeAdapter({
    claudeHome: "/tmp/claude-auth-test",
    historyFiles: async () => [],
    initialProfiles: [relayProfile],
    queryFactory: mockQuery(async function* (params) {
      yield {
        type: "result", subtype: "error_during_execution", is_error: true,
        errors: ["Not logged in - Please run /login"],
        usage: {}, modelUsage: {}, session_id: params.options.extraArgs["session-id"],
      };
    }, []),
  });
  await adapter.startAll();
  const thread = await adapter.createThread(relayProfile.id, { cwd: "/work" });
  await adapter.sendTurn(thread.providerId, thread.id, "hello");
  await waitFor(() => adapter.listThreads()[0]?.status === "error");
  const error = adapter.listThreads()[0].lastError || "";
  assert.match(error, /配置档「Relay」/);
  assert.match(error, /\/tmp\/claude-auth-test/);
  assert.doesNotMatch(error, /relay-secret/);
});

test("Claude lists skills from disk when the session has no live connection", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deck-claude-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  await mkdir(path.join(cwd, ".claude", "skills", "pdf"), {
    recursive: true,
  });
  await writeFile(
    path.join(cwd, ".claude", "skills", "pdf", "SKILL.md"),
    "---\nname: pdf\ndescription: 处理 PDF 文件\n---\n# PDF\n",
  );
  // 缺 name 时回落到目录名；非 SKILL.md 文件不枚举。
  await mkdir(path.join(home, "skills", "review"), { recursive: true });
  await writeFile(
    path.join(home, "skills", "review", "SKILL.md"),
    "---\ndescription: 代码审查\n---\n",
  );
  await writeFile(path.join(home, "skills", "review", "notes.md"), "x");
  const adapter = new ClaudeAdapter({
    claudeHome: home,
    historyFiles: async () => [],
    initialProfiles: [relayProfile],
  });
  await adapter.startAll();
  const thread = await adapter.createThread(relayProfile.id, { cwd });
  const result = await adapter.listSkills("claude", thread.id);
  assert.deepEqual(result.skills, [
    {
      name: "pdf",
      description: "处理 PDF 文件",
      path: path.join(cwd, ".claude", "skills", "pdf", "SKILL.md"),
      scope: "project",
      enabled: true,
    },
    {
      name: "review",
      description: "代码审查",
      path: path.join(home, "skills", "review", "SKILL.md"),
      scope: "user",
      enabled: true,
    },
  ]);
  assert.equal(adapter.descriptor().capabilities.skills, true);
});

test("Claude lists skills via reload_skills on the live SDK connection", async () => {
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [],
    initialProfiles: [relayProfile],
    queryFactory: ((params: any) => {
      const stream: any = (async function* () {
        for await (const input of params.prompt)
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            usage: {},
            modelUsage: {},
            session_id: input.session_id,
          };
      })();
      stream.close = () => undefined;
      stream.interrupt = async () => undefined;
      stream.reloadSkills = async () => ({
        skills: [
          { name: "pdf", description: "处理 PDF", argumentHint: "<file>" },
          { name: "empty" },
        ],
      });
      return stream;
    }) as any,
  });
  await adapter.startAll();
  const thread = await adapter.createThread(relayProfile.id, { cwd: "/work" });
  await adapter.sendTurn(thread.providerId, thread.id, "hi");
  await waitFor(() => adapter.listThreads()[0]?.status === "idle");
  const result = await adapter.listSkills("claude", thread.id);
  assert.deepEqual(result.skills, [
    {
      name: "pdf",
      description: "处理 PDF",
      scope: "<file>",
      enabled: true,
    },
    { name: "empty", description: "", scope: undefined, enabled: true },
  ]);
});

function mockQuery(
  run: (params: any) => AsyncGenerator<any, void>,
  calls: any[],
) {
  return ((params: any) => {
    calls.push(params);
    const stream: any = (async function* () {
      if (typeof params.prompt !== "string") {
        const first = await params.prompt[Symbol.asyncIterator]().next();
        const blocks = first.value?.message?.content;
        params.prompt = Array.isArray(blocks)
          ? blocks.filter((block: any) => block.type === "text").map((block: any) => block.text).join("")
          : String(blocks || "");
      }
      yield* run(params);
    })();
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
    assert.equal(params.prompt, "ship it");
    yield {
      type: "system",
      subtype: "init",
      model: "claude-sonnet-test",
      cwd: "/work",
      session_id: params.options.extraArgs["session-id"],
    };
    yield {
      type: "stream_event",
      uuid: "stream-wrapper-start",
      session_id: params.options.extraArgs["session-id"],
      event: {
        type: "message_start",
        message: { id: "assistant-response-1" },
      },
    };
    yield {
      type: "stream_event",
      uuid: "stream-wrapper-1",
      session_id: params.options.extraArgs["session-id"],
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Working" },
      },
    };
    yield {
      type: "stream_event",
      uuid: "stream-wrapper-2",
      session_id: params.options.extraArgs["session-id"],
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: " together" },
      },
    };
    yield {
      type: "stream_event",
      uuid: "stream-wrapper-stop",
      session_id: params.options.extraArgs["session-id"],
      event: { type: "content_block_stop", index: 0 },
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
      session_id: params.options.extraArgs["session-id"],
    };
  }, calls);
  const adapter = new ClaudeAdapter({
    queryFactory,
    historyFiles: async () => [],
    initialProfiles: [relayProfile],
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
  const messageEvents = events
    .filter(
      (event) =>
        event.type === "agent.event" &&
        event.data.method === "item/agentMessage/delta",
    )
    .map((event) => event.data);
  assert.deepEqual(
    messageEvents.map((event) => event.params.itemId),
    ["assistant-response-1:0", "assistant-response-1:0"],
  );
  assert.deepEqual(
    messageEvents.map((event) => event.params.delta),
    ["Working", " together"],
  );
});

test("Claude adapter exposes models and persists session model and permissions", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deck-claude-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const history = path.join(root, "session-settings.jsonl");
  await writeFile(
    history,
    [
      {
        type: "user",
        uuid: "u1",
        sessionId: "session-settings",
        cwd: "/work",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "configure me" },
      },
      {
        type: "last-prompt",
        leafUuid: "u1",
        sessionId: "session-settings",
      },
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  const calls: any[] = [];
  const adapter = new ClaudeAdapter({
    initialProfiles: [relayProfile, backupRelayProfile],
    historyFiles: async () => [history],
    queryFactory: mockQuery(async function* () {
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
        session_id: "session-settings",
      };
    }, calls),
  });
  await adapter.startAll();

  assert.deepEqual(
    adapter.listModels("claude-cc-relay").map((model) => model.model),
    ["default", "sonnet", "opus", "haiku"],
  );
  await adapter.updateThreadSettings("claude-cc-relay", "session-settings", {
    providerId: "claude-cc-backup",
    model: "opus",
    permissionMode: "acceptEdits",
  });
  await adapter.sendTurn("claude-cc-relay", "session-settings", "use settings");
  await waitFor(() => adapter.listThreads()[0].status === "idle");
  assert.equal(calls[0].options.model, "opus");
  assert.equal(calls[0].options.permissionMode, "acceptEdits");
  assert.equal(
    calls[0].options.env.ANTHROPIC_BASE_URL,
    backupRelayProfile.env.ANTHROPIC_BASE_URL,
  );
  assert.equal(adapter.listThreads()[0].providerId, "claude-cc-backup");
  await assert.rejects(
    adapter.updateThreadSettings("claude-cc-backup", "session-settings", {
      providerId: "missing-profile",
    }),
    /配置档不存在/,
  );

  await adapter.renameThread(
    "claude-cc-relay",
    "session-settings",
    "Renamed Claude session",
  );
  assert.match(await readFile(history, "utf8"), /Renamed Claude session/);
  await adapter.refreshAll();
  assert.equal(adapter.listThreads()[0].name, "Renamed Claude session");

  await adapter.deleteThread("claude-cc-relay", "session-settings");
  assert.equal(adapter.listThreads().length, 0);
  await assert.rejects(readFile(history, "utf8"), /ENOENT/);
});

test("Claude executable discovery keeps Windows npm launchers", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "claude-launcher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcher = path.join(root, "claude.cmd");
  await writeFile(launcher, "@echo off\r\n");

  assert.equal(findClaudeExecutable(launcher), launcher);
  assert.deepEqual(
    windowsClaudeLaunchSpec(
      {
        command: launcher,
        args: ["--output-format", "stream-json"],
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
        signal: new AbortController().signal,
      },
      "win32",
    ),
    {
      command: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", launcher, "--output-format", "stream-json"],
    },
  );
});

test("Windows discovery ignores npm shims and lets the SDK use its bundled CLI", () => {
  const npm = "C:\\Users\\tester\\AppData\\Roaming\\npm";
  const native = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  const files = new Set([`${npm}\\claude`, `${npm}\\claude.cmd`, native]);
  assert.equal(
    findClaudeExecutable(undefined, "win32", { Path: npm }, (candidate) =>
      files.has(candidate),
    ),
    undefined,
  );
});

test("Windows discovery accepts a standalone native executable", () => {
  const bin = "C:\\Claude";
  const files = new Set([`${bin}\\claude.exe`]);
  assert.equal(
    findClaudeExecutable(undefined, "win32", { PATH: bin }, (candidate) =>
      files.has(candidate),
    ),
    `${bin}\\claude.exe`,
  );
});

test("Linux discovery skips Windows shims mounted into PATH", () => {
  const files = new Set(["/mnt/c/npm/claude", "/usr/local/bin/claude"]);
  assert.equal(
    findClaudeExecutable(
      undefined,
      "linux",
      { PATH: "/mnt/c/npm:/usr/local/bin" },
      (candidate) => files.has(candidate),
    ),
    "/usr/local/bin/claude",
  );
});

test("Claude runtime selection covers native Windows, Windows WSL, and Linux", () => {
  assert.equal(
    claudeRuntimePreference("win32", false, false, "D:\\Code\\deck"),
    "native",
  );
  assert.equal(
    claudeRuntimePreference("win32", true, true, "/home/tester/deck"),
    "wsl",
  );
  assert.equal(
    claudeRuntimePreference("win32", true, false, "/mnt/d/Code/deck"),
    "native",
  );
  assert.equal(
    claudeRuntimePreference("linux", false, false, "/home/tester/deck"),
    "native",
  );
  assert.throws(
    () => claudeRuntimePreference("win32", true, false, "/home/tester/deck"),
    /CLAUDE_WSL_BIN/,
  );
});

test("WSL Claude launch preserves argv and uses the WSL cwd", () => {
  const launch = wslClaudeLaunchSpec(
    {
      command: "claude",
      args: ["--output-format", "stream-json"],
      cwd: "/mnt/d/Code/deck",
      env: { WSL_EXE: "C:\\Windows\\System32\\wsl.exe" },
      signal: new AbortController().signal,
    },
    "claude",
  );
  assert.equal(launch.command, "C:\\Windows\\System32\\wsl.exe");
  assert.deepEqual(launch.args.slice(-5), [
    "claude",
    "/mnt/d/Code/deck",
    "claude",
    "--output-format",
    "stream-json",
  ]);
  assert.equal(launch.args.at(-3), "claude");
});

test("Claude config home follows the host platform", () => {
  assert.equal(
    defaultClaudeHome("win32", "C:\\Users\\tester"),
    "C:\\Users\\tester\\.claude",
  );
  assert.equal(
    defaultClaudeHome("linux", "/home/tester"),
    "/home/tester/.claude",
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
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: "https://relay.example.test",
        ANTHROPIC_AUTH_TOKEN: "super-secret",
      },
    }),
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

test("Claude adapter retries a historical turn by branching its file", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deck-claude-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const history = path.join(root, "session-rw.jsonl");
  const historySource = [
    {
      type: "system",
      subtype: "informational",
      uuid: "sys-1",
      parentUuid: null,
      sessionId: "session-rw",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    {
      type: "user",
      uuid: "u1",
      parentUuid: "sys-1",
      sessionId: "session-rw",
      cwd: "/work",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: { role: "user", content: "first question" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId: "session-rw",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "answer one" }],
      },
    },
    {
      type: "user",
      uuid: "u2",
      parentUuid: "a1",
      sessionId: "session-rw",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "user", content: "second question" },
    },
    {
      type: "assistant",
      uuid: "a2",
      parentUuid: "u2",
      sessionId: "session-rw",
      timestamp: "2026-01-01T00:00:04.000Z",
      message: {
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "answer two" }],
      },
    },
    { type: "last-prompt", leafUuid: "a2", sessionId: "session-rw" },
  ]
    .map(JSON.stringify)
    .join("\n");
  await writeFile(history, historySource);
  const calls: any[] = [];
  const adapter = new ClaudeAdapter({
    queryFactory: mockQuery(async function* (params) {
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
        session_id: params.options.resume || params.options.extraArgs?.["session-id"],
      };
    }, calls),
    historyFiles: async () => [history],
    initialProfiles: [relayProfile],
  });
  await adapter.startAll();
  assert.equal(adapter.descriptor().capabilities.fork, true);

  // 中途编辑：从第二条 prompt(u2) 重试 → 在 a1 处截断出分支再发送。
  const branch: any = await adapter.retryFromTurn(
    "claude-current",
    "session-rw",
    "u2",
    "edited second",
  );
  assert.ok(branch);
  assert.notEqual(branch.id, "session-rw");
  assert.equal(branch.forkedFromId, "session-rw");
  const branchFile = path.join(root, `${branch.id}.jsonl`);
  const branchRows = (await readFile(branchFile, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  // 分支文件只含锚点之前的主链记录（u2/a2 不在其中），sessionId 已重写。
  assert.deepEqual(
    branchRows.map((row) => row.uuid || row.type),
    ["sys-1", "u1", "a1"],
  );
  assert.ok(branchRows.every((row) => row.sessionId === branch.id));
  await waitFor(
    () =>
      adapter.listThreads().find((thread) => thread.id === branch.id)
        ?.status === "idle",
  );
  // 分支上的首个 turn 走 resume 新会话 id——Claude CLI 从 a1 后续聊。
  assert.equal(calls[0].options.resume, branch.id);
  assert.equal(calls[0].prompt, "edited second");
  // 原文件未被改动。
  assert.equal(await readFile(history, "utf8"), historySource);

  // 整会话分支：不截断，复制全部记录。
  const forked: any = await adapter.forkThread(
    "claude-current",
    "session-rw",
    {},
  );
  const forkedRows = (await readFile(
    path.join(root, `${forked.id}.jsonl`),
    "utf8",
  ))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(forkedRows.length, 6);
  assert.equal(forked.forkedFromId, "session-rw");

  // 无效 turnId（不在主链）→ 拒绝且不创建文件。
  await assert.rejects(
    adapter.retryFromTurn(
      "claude-current",
      "session-rw",
      "ghost-turn",
      "again",
    ),
    /找不到这条消息/,
  );
  assert.equal(adapter.listThreads().length, 3);
});

test("Claude adapter refuses to resume a session held by another process", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deck-claude-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claudeHome = path.join(root, "claude-home");
  const sessionsDir = path.join(claudeHome, "sessions");
  const projectDir = path.join(claudeHome, "projects", "-work");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  const history = path.join(projectDir, "locked-session.jsonl");
  await writeFile(
    history,
    [
      {
        type: "user",
        uuid: "u1",
        sessionId: "locked-session",
        cwd: "/work",
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: "held" },
      },
    ]
      .map(JSON.stringify)
      .join("\n"),
  );
  // 活进程占用（用测试进程自己的 pid）。
  await writeFile(
    path.join(sessionsDir, "111.json"),
    JSON.stringify({
      pid: process.pid,
      sessionId: "locked-session",
      name: "bg job",
    }),
  );
  // 残留锁：pid 已死，不应拦截。
  await writeFile(
    path.join(sessionsDir, "222.json"),
    JSON.stringify({ pid: 2 ** 30, sessionId: "other-session" }),
  );
  const calls: any[] = [];
  const adapter = new ClaudeAdapter({
    claudeHome,
    historyFiles: async () => [history],
    initialProfiles: [relayProfile],
    queryFactory: mockQuery(async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {},
        modelUsage: {},
        session_id: "locked-session",
      };
    }, calls),
  });
  await adapter.startAll();
  await assert.rejects(
    adapter.sendTurn("claude-current", "locked-session", "continue"),
    /仍由 Claude 进程/,
  );
  assert.equal(calls.length, 0);

  // 占用进程退出（锁文件消失）后可以正常续聊。
  await rm(path.join(sessionsDir, "111.json"));
  await adapter.sendTurn("claude-current", "locked-session", "continue");
  await waitFor(() => adapter.listThreads()[0].status === "idle");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.resume, "locked-session");
});

test("Claude adapter records spawn errors and can be restarted repeatedly", async () => {
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [],
    initialProfiles: [relayProfile],
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
    initialProfiles: [relayProfile],
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
    initialProfiles: [relayProfile],
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

test("Claude adapter exposes but rejects Claude Official profiles", async () => {
  const officialProfile = {
    ...relayProfile,
    id: "claude-cc-official",
    name: "Claude Official",
    current: true,
    official: true,
    supported: false,
    env: {},
  };
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [],
    initialProfiles: [officialProfile],
  });
  await adapter.startAll();

  // 没有可用中转时「本机 Claude」兜底上线，adapter 不再整体离线。
  assert.equal(adapter.descriptor().online, true);
  assert.equal(adapter.publicProfiles()[0].enabled, false);
  assert.equal(adapter.publicProfiles()[0].official, true);
  const local = adapter
    .publicProfiles()
    .find((profile: any) => profile.id === "claude-local");
  assert.equal(local?.enabled, true);
  assert.equal(local?.current, true);
  await assert.rejects(
    adapter.createThread(officialProfile.id, { cwd: "/work" }),
    /没有独立凭据/,
  );
  const thread: any = await adapter.createThread("claude-current", {
    cwd: "/work",
  });
  assert.equal(thread.providerId, "claude-local");
});

test("Claude adapter local profile passes the ambient environment through", async (t) => {
  const key = "ANTHROPIC_BASE_URL";
  const previous = process.env[key];
  const previousHome = process.env.CLAUDE_CONFIG_DIR;
  process.env[key] = "https://self-host.example.test";
  process.env.CLAUDE_CONFIG_DIR = "/custom/claude-config";
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    if (previousHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousHome;
  });
  const calls: any[] = [];
  const queryFactory = mockQuery(async function* (params) {
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
      session_id: params.options.extraArgs["session-id"],
    };
  }, calls);
  const adapter = new ClaudeAdapter({
    queryFactory,
    historyFiles: async () => [],
  });
  await adapter.startAll();
  assert.equal(adapter.descriptor().online, true);
  const thread: any = await adapter.createThread("claude-current", {
    cwd: "/work",
  });
  assert.equal(thread.providerId, "claude-local");
  await adapter.sendTurn(thread.providerId, thread.id, "hi");
  await waitFor(() => adapter.listThreads()[0].status === "idle");
  assert.equal(
    calls[0].options.env.ANTHROPIC_BASE_URL,
    "https://self-host.example.test",
  );
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, "/custom/claude-config");
});

test("Claude adapter streams only assistant text blocks", async () => {
  const calls: any[] = [];
  const queryFactory = mockQuery(async function* (params) {
    for (const event of [
      { type: "message_start", message: { id: "response-1" } },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "private reasoning" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "Visible answer" },
      },
      { type: "content_block_stop", index: 1 },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "tool-1", name: "Bash" },
      },
      { type: "content_block_stop", index: 2 },
    ])
      yield {
        type: "stream_event",
        uuid: randomUUID(),
        session_id: params.options.extraArgs["session-id"],
        event,
      };
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {},
      modelUsage: {},
      session_id: params.options.extraArgs["session-id"],
    };
  }, calls);
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [],
    initialProfiles: [relayProfile],
    queryFactory,
  });
  const events: any[] = [];
  adapter.on("event", (event) => events.push(event));
  await adapter.startAll();
  const thread: any = await adapter.createThread("claude-current", {
    cwd: "/work",
  });
  await adapter.sendTurn(thread.providerId, thread.id, "hello");
  await waitFor(() => adapter.listThreads()[0].status === "idle");
  const live = events
    .filter((event) => event.type === "agent.event")
    .map((event) => event.data);
  assert.deepEqual(
    live.filter((event) => event.method === "item/agentMessage/delta")
      .map((event) => [event.params.itemId, event.params.delta]),
    [["response-1:1", "Visible answer"]],
  );
  assert.deepEqual(
    live.filter(
      (event) =>
        event.method === "item/completed" &&
        event.params.item?.type === "agentMessage",
    ).map((event) => event.params.item.id),
    ["response-1:1"],
  );
});

test("Claude adapter shows tool calls and their results during a turn", async () => {
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [],
    initialProfiles: [relayProfile],
    queryFactory: mockQuery(async function* (params) {
      yield {
        type: "assistant",
        uuid: "assistant-1",
        message: {
          content: [
            { type: "tool_use", id: "bash-1", name: "Bash", input: { command: "pwd" } },
            { type: "tool_use", id: "edit-1", name: "Edit", input: { file_path: "/work/a.ts" } },
          ],
        },
      };
      yield {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "bash-1", content: "/work" },
            { type: "tool_result", tool_use_id: "edit-1", content: "Done" },
          ],
        },
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {},
        modelUsage: {},
        session_id: params.options.extraArgs["session-id"],
      };
    }, []),
  });
  const events: any[] = [];
  adapter.on("event", (event) => events.push(event));
  await adapter.startAll();
  const thread: any = await adapter.createThread("claude-current", { cwd: "/work" });
  await adapter.sendTurn(thread.providerId, thread.id, "run tools");
  await waitFor(() => adapter.listThreads()[0].status === "idle");
  const items = events
    .filter((event) => event.type === "agent.event")
    .map((event) => event.data)
    .filter((event) => ["item/started", "item/completed"].includes(event.method))
    .map((event) => [event.method, event.params.item]);
  assert.deepEqual(items.map(([method, item]) => [method, item.id, item.type]), [
    ["item/started", "bash-1", "commandExecution"],
    ["item/started", "edit-1", "fileChange"],
    ["item/completed", "bash-1", "commandExecution"],
    ["item/completed", "edit-1", "fileChange"],
  ]);
  assert.equal(items[2][1].aggregatedOutput, "/work");
});

test("Claude adapter rejects simultaneous sends to the same session", async () => {
  let release!: () => void;
  const calls: any[] = [];
  const queryFactory = mockQuery(async function* (params) {
    await new Promise<void>((resolve) => { release = resolve; });
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      usage: {},
      modelUsage: {},
      session_id: params.options.extraArgs["session-id"],
    };
  }, calls);
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [],
    initialProfiles: [relayProfile],
    queryFactory,
  });
  await adapter.startAll();
  const thread: any = await adapter.createThread("claude-current", {
    cwd: "/work",
  });
  const first = adapter.sendTurn(thread.providerId, thread.id, "first");
  await assert.rejects(
    adapter.sendTurn(thread.providerId, thread.id, "second"),
    /正在运行/,
  );
  await first;
  await waitFor(() => Boolean(release));
  assert.equal(calls.length, 1);
  release();
  await waitFor(() => adapter.listThreads()[0].status === "idle");
});

test("Claude adapter can cancel a turn before the SDK query starts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deck-claude-early-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "session-early.jsonl");
  await writeFile(
    file,
    JSON.stringify({
      type: "user",
      uuid: "u1",
      sessionId: "session-early",
      cwd: "/work",
      message: { role: "user", content: "first" },
    }),
  );
  const calls: any[] = [];
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [file],
    initialProfiles: [relayProfile],
    queryFactory: mockQuery(async function* () {}, calls),
  });
  await adapter.startAll();
  const sending = adapter.sendTurn("claude-current", "session-early", "next");
  await adapter.interrupt("claude-current", "session-early", "pending");
  await sending;
  await waitFor(() => adapter.listThreads()[0].status === "idle");
  assert.equal(calls.length, 0);
});

test("Claude default model follows CLI configuration across turns", async () => {
  const calls: any[] = [];
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [],
    initialProfiles: [relayProfile],
    queryFactory: mockQuery(async function* (params) {
      yield {
        type: "system",
        subtype: "init",
        model: "claude-sonnet-current",
        session_id: params.options.extraArgs["session-id"],
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {},
        modelUsage: {},
        session_id: params.options.extraArgs["session-id"],
      };
    }, calls),
  });
  await adapter.startAll();
  const thread: any = await adapter.createThread("claude-current", {
    cwd: "/work",
  });
  await adapter.sendTurn(thread.providerId, thread.id, "one");
  await waitFor(() => adapter.listThreads()[0].status === "idle");
  assert.equal(adapter.listThreads()[0].model, "default");
  assert.equal(adapter.listThreads()[0].resolvedModel, "claude-sonnet-current");
  await adapter.sendTurn(thread.providerId, thread.id, "two");
  await waitFor(() => calls.length === 2 && adapter.listThreads()[0].status === "idle");
  assert.deepEqual(calls.map((call) => call.options.model), [undefined, undefined]);
});

test("Claude question approval returns the answer map expected by AskUserQuestion", async () => {
  let result: any;
  const questions = [
    { question: "Which database?", header: "Database", options: [] },
    { question: "Which region?", header: "Region", options: [] },
  ];
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [],
    initialProfiles: [relayProfile],
    queryFactory: mockQuery(async function* (params) {
      result = await params.options.canUseTool(
        "AskUserQuestion",
        { questions },
        { signal: new AbortController().signal, toolUseID: "question-1" },
      );
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {},
        modelUsage: {},
        session_id: params.options.extraArgs["session-id"],
      };
    }, []),
  });
  await adapter.startAll();
  const thread: any = await adapter.createThread("claude-current", {
    cwd: "/work",
  });
  await adapter.sendTurn(thread.providerId, thread.id, "ask me");
  await waitFor(() => adapter.snapshot().approvals.length === 1);
  const approval: any = adapter.snapshot().approvals[0];
  await assert.rejects(
    adapter.resolveApproval(approval.id, {
      answers: [{ value: "SQLite" }],
    }),
    /所有问题/,
  );
  await adapter.resolveApproval(approval.id, {
    answers: [{ value: "SQLite" }, { value: "Other", other: "Singapore" }],
  });
  await waitFor(() => adapter.listThreads()[0].status === "idle");
  assert.deepEqual(result.updatedInput.answers, {
    "Which database?": "SQLite",
    "Which region?": "Singapore",
  });
});

test("Claude remains waiting until every concurrent permission is resolved", async () => {
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [],
    initialProfiles: [relayProfile],
    queryFactory: mockQuery(async function* (params) {
      await Promise.all([
        params.options.canUseTool("Bash", { command: "first" }, {
          signal: new AbortController().signal,
          toolUseID: "tool-1",
        }),
        params.options.canUseTool("Bash", { command: "second" }, {
          signal: new AbortController().signal,
          toolUseID: "tool-2",
        }),
      ]);
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        usage: {},
        modelUsage: {},
        session_id: params.options.extraArgs["session-id"],
      };
    }, []),
  });
  await adapter.startAll();
  const thread: any = await adapter.createThread("claude-current", {
    cwd: "/work",
  });
  await adapter.sendTurn(thread.providerId, thread.id, "both tools");
  await waitFor(() => adapter.snapshot().approvals.length === 2);
  const [first, second]: any[] = adapter.snapshot().approvals;
  await adapter.resolveApproval(first.id, { decision: "accept" });
  assert.equal(adapter.listThreads()[0].status, "waiting");
  await adapter.resolveApproval(second.id, { decision: "accept" });
  await waitFor(() => adapter.listThreads()[0].status === "idle");
});

test("Claude adapter relay profiles still override ambient credentials", async (t) => {
  const key = "ANTHROPIC_BASE_URL";
  const previous = process.env[key];
  process.env[key] = "https://ambient.example.test";
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
  const calls: any[] = [];
  const queryFactory = mockQuery(async function* (params) {
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
      session_id: params.options.extraArgs["session-id"],
    };
  }, calls);
  const adapter = new ClaudeAdapter({
    queryFactory,
    historyFiles: async () => [],
    initialProfiles: [relayProfile],
  });
  await adapter.startAll();
  const thread: any = await adapter.createThread("claude-current", {
    cwd: "/work",
  });
  assert.equal(thread.providerId, relayProfile.id);
  await adapter.sendTurn(thread.providerId, thread.id, "hi");
  await waitFor(() => adapter.listThreads()[0].status === "idle");
  assert.equal(
    calls[0].options.env.ANTHROPIC_BASE_URL,
    "https://relay.example.test",
  );
});

test("Claude adapter keeps a fresh managed thread across refreshes", async () => {
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [],
    initialProfiles: [relayProfile],
  });
  await adapter.startAll();
  const thread: any = await adapter.createThread("claude-current", {
    cwd: "/work",
  });
  await adapter.refreshAll();
  assert.ok(
    adapter.listThreads().some((item) => item.id === thread.id),
    "refreshAll 不应删掉尚未落盘的新会话",
  );
});

test("Claude applies reasoning effort live and stamps it per turn", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deck-claude-effort-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settings = new ThreadSettingsStore(root);
  await settings.load();
  const calls: any[] = [];
  const pushed: any[] = [];
  const flagSettings: any[] = [];
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [],
    initialProfiles: [relayProfile],
    threadSettings: settings,
    queryFactory: ((params: any) => {
      calls.push(params);
      const stream: any = (async function* () {
        for await (const input of params.prompt) {
          pushed.push(input);
          // init 帧回报「实际下发」的 effort：flag 层改过就回新值。
          yield {
            type: "system",
            subtype: "init",
            model: "claude-sonnet-5",
            cwd: "/work",
            effort: flagSettings.at(-1)?.effortLevel ?? params.options.effort,
            session_id: input.session_id,
          };
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            usage: {},
            modelUsage: {},
            session_id: input.session_id,
          };
        }
      })();
      stream.interrupt = async () => undefined;
      stream.setModel = async () => undefined;
      stream.setPermissionMode = async () => undefined;
      stream.applyFlagSettings = async (next: any) => {
        flagSettings.push(next);
      };
      stream.initializationResult = async () => ({
        models: [
          { value: "default", displayName: "Default" },
          {
            value: "sonnet",
            displayName: "Sonnet",
            supportedEffortLevels: ["low", "medium", "high", "xhigh"],
          },
        ],
      });
      return stream;
    }) as any,
  });
  await adapter.startAll();
  const thread: any = await adapter.createThread("claude-current", {
    cwd: "/work",
    model: "sonnet",
    reasoningEffort: "low",
  });
  assert.equal(thread.reasoningEffort, "low");

  const sent: any = await adapter.sendTurn(thread.providerId, thread.id, "hi");
  await waitFor(() => adapter.listThreads()[0]?.status === "idle");

  // spawn options 带 effort；user 消息 uuid 即 turnId，历史回放能对回快照。
  assert.equal(calls[0].options.effort, "low");
  assert.equal(pushed[0].uuid, sent.turn.id);

  // init 上报的实际 effort + 真实模型校正了发送时记的快照。
  await waitFor(
    () =>
      settings.turnModel("claude", thread.id, sent.turn.id)?.model ===
      "claude-sonnet-5",
  );
  const stamp = settings.turnModel("claude", thread.id, sent.turn.id);
  assert.equal(stamp?.reasoningEffort, "low");

  // SDK 模型目录取代静态别名表，带逐模型 effort 档。
  await waitFor(() =>
    adapter
      .listModels(thread.providerId)
      .some((model) => model.model === "sonnet" && model.supportedReasoningEfforts?.length),
  );
  const sonnet = adapter
    .listModels(thread.providerId)
    .find((model) => model.model === "sonnet");
  assert.deepEqual(
    sonnet?.supportedReasoningEfforts?.map((item) => item.reasoningEffort),
    ["low", "medium", "high", "xhigh"],
  );
  assert.equal(sonnet?.defaultReasoningEffort, "high");

  // 保持连接的会话中途切 effort：flag 层即时生效，不需要重连。
  await adapter.updateThreadSettings(thread.providerId, thread.id, {
    reasoningEffort: "high",
  });
  assert.deepEqual(flagSettings, [{ effortLevel: "high" }]);
  assert.equal(adapter.listThreads()[0].reasoningEffort, "high");
  assert.equal(
    settings.get("claude", thread.id)?.reasoningEffort,
    "high",
  );

  // 目录之外的值直接拒绝，不下发给 CLI。
  await assert.rejects(
    adapter.updateThreadSettings(thread.providerId, thread.id, {
      reasoningEffort: "minimal",
    }),
    /不支持的推理强度/,
  );

  // 再发一回合：新快照是 high，旧回合快照保持 low 不动。
  const second: any = await adapter.sendTurn(
    thread.providerId,
    thread.id,
    "again",
  );
  // 连接复用：第二条经同一队列推进，等它被消费再断言 uuid。
  await waitFor(() => pushed.length === 2);
  await waitFor(() => adapter.listThreads()[0]?.status === "idle");
  await waitFor(
    () =>
      settings.turnModel("claude", thread.id, second.turn.id)
        ?.reasoningEffort === "high",
  );
  assert.equal(pushed[1].uuid, second.turn.id);
  assert.equal(
    settings.turnModel("claude", thread.id, sent.turn.id)?.reasoningEffort,
    "low",
  );
  adapter.restart();
});

test("Claude readThread backfills per-turn effort over the history model", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deck-claude-stamp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "hist-1.jsonl");
  const lines = [
    {
      type: "user",
      uuid: "u-1",
      sessionId: "hist-1",
      cwd: "/work",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "一" },
    },
    {
      type: "assistant",
      uuid: "a-1",
      parentUuid: "u-1",
      sessionId: "hist-1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "答一" }],
      },
    },
    {
      type: "user",
      uuid: "u-2",
      parentUuid: "a-1",
      sessionId: "hist-1",
      cwd: "/work",
      timestamp: "2026-01-01T00:01:00.000Z",
      message: { role: "user", content: "二" },
    },
    {
      type: "assistant",
      uuid: "a-2",
      parentUuid: "u-2",
      sessionId: "hist-1",
      timestamp: "2026-01-01T00:01:01.000Z",
      message: {
        role: "assistant",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "答二" }],
      },
    },
  ];
  await writeFile(file, `${lines.map(JSON.stringify).join("\n")}\n`);
  const settings = new ThreadSettingsStore(root);
  await settings.load();
  // u-2 发出时意图是 opus/xhigh；JSONL 里的真实模型优先，effort 由快照补。
  await settings.recordTurnModel("claude", "hist-1", "u-2", {
    model: "opus",
    reasoningEffort: "xhigh",
  });
  const adapter = new ClaudeAdapter({
    historyFiles: async () => [file],
    initialProfiles: [relayProfile],
    threadSettings: settings,
  });
  await adapter.startAll();
  const full: any = await adapter.readThread("claude-current", "hist-1");
  assert.equal(full.turns.length, 2);
  assert.equal(full.turns[0].model, "claude-sonnet-5");
  assert.equal(full.turns[0].reasoningEffort, undefined);
  assert.equal(full.turns[1].model, "claude-opus-4-7");
  assert.equal(full.turns[1].reasoningEffort, "xhigh");
});

test("Claude 回合进行中刷新历史不会遗留幽灵运行态", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deck-claude-refresh-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files: string[] = [];
  let releaseResult: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  const adapter = new ClaudeAdapter({
    historyFiles: async () => files,
    initialProfiles: [relayProfile],
    queryFactory: ((params: any) => {
      const stream: any = (async function* () {
        for await (const input of params.prompt) {
          yield {
            type: "system",
            subtype: "init",
            model: "claude-sonnet-4-5",
            cwd: "/work",
            session_id: input.session_id,
          };
          await gate;
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            usage: {},
            modelUsage: {},
            session_id: input.session_id,
          };
        }
      })();
      stream.close = () => undefined;
      stream.interrupt = async () => {
        await stream.return();
      };
      return stream;
    }) as any,
  });
  await adapter.startAll();
  const thread = await adapter.createThread(relayProfile.id, { cwd: "/work" });
  // JSONL 记录带同一 sessionId，refreshAll 才能把磁盘历史对回这条会话。
  const file = path.join(root, `${thread.id}.jsonl`);
  await writeFile(
    file,
    `${JSON.stringify({
      type: "user",
      uuid: "h1",
      sessionId: thread.id,
      cwd: "/work",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "历史" },
    })}\n`,
  );
  files.push(file);
  await adapter.sendTurn(thread.providerId, thread.id, "run");
  await waitFor(
    () => adapter.listThreads()[0]?.claudeConnected === true,
  );
  // 回合进行中重建摘要：map 换上新对象，回合闭包的旧引用不许再往里写。
  await adapter.refreshAll();
  const running = adapter.listThreads()[0];
  assert.equal(running?.status, "running");
  assert.ok(running?.activeTurnId);
  releaseResult!();
  await waitFor(() => adapter.listThreads()[0]?.status === "idle");
  const done = adapter.listThreads()[0];
  assert.equal(done?.status, "idle");
  assert.equal(done?.activeTurnId, undefined);
});

test("Claude 历史回填撞上紧接着的新回合不丢 activeTurnId", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "deck-claude-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files: string[] = [];
  let gated = false;
  let openGate: (() => void) | undefined;
  let readStarted: (() => void) | undefined;
  const diskGate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const gatedRead = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const adapter = new ClaudeAdapter({
    historyFiles: async () => files,
    initialProfiles: [relayProfile],
    // 闸门期间挂住读盘：result 触发的 refreshThreadFromDisk 没落地前，
    // 下一回合已经发出——重建必须以活跃回合为准。
    historyReader: async (file: string) => {
      if (!gated) return readClaudeHistory(file);
      readStarted!();
      await diskGate;
      return readClaudeHistory(file);
    },
    queryFactory: ((params: any) => {
      const stream: any = (async function* () {
        for await (const input of params.prompt) {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            usage: {},
            modelUsage: {},
            session_id: input.session_id,
          };
        }
      })();
      stream.close = () => undefined;
      stream.interrupt = async () => {
        await stream.return();
      };
      return stream;
    }) as any,
  });
  await adapter.startAll();
  const thread = await adapter.createThread(relayProfile.id, { cwd: "/work" });
  const file = path.join(root, `${thread.id}.jsonl`);
  await writeFile(
    file,
    `${JSON.stringify({
      type: "user",
      uuid: "h1",
      sessionId: thread.id,
      cwd: "/work",
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { role: "user", content: "历史" },
    })}\n`,
  );
  files.push(file);
  await adapter.refreshAll();
  gated = true;
  await adapter.sendTurn(thread.providerId, thread.id, "one");
  // 第一回合 result 已结算，回填写盘被闸门卡住。
  await Promise.all([
    waitFor(() => adapter.listThreads()[0]?.status === "idle"),
    gatedRead,
  ]);
  await adapter.sendTurn(thread.providerId, thread.id, "two");
  await waitFor(
    () => adapter.listThreads()[0]?.activeTurnId !== undefined,
  );
  openGate!();
  await waitFor(() => adapter.listThreads()[0]?.status === "idle");
  const done = adapter.listThreads()[0];
  assert.equal(done?.status, "idle");
  assert.equal(done?.activeTurnId, undefined);
});
