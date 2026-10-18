import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentRegistry } from "./registry.js";
import { MessageDeliveryQueue } from "../message-delivery.js";
import { openCodePartToItem, OpenCodeAdapter } from "./opencode-adapter.js";

test("OpenCode adapter binds provider models and preserves the completed turn id", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new OpenCodeAdapter({
    idleGraceMs: 0,
    fetcher: (async (url, init) => {
      const value = String(url);
      calls.push({ url: value, init });
      if (value.includes("/config"))
        return Response.json({
          model: "openai/gpt-5",
        });
      if (value.includes("/provider"))
        return Response.json({
          all: {
            openai: {
              name: "OpenAI",
              models: {
                "gpt-5": { name: "GPT-5", attachment: false },
                "gpt-5v": { name: "GPT-5V", modalities: { input: ["text", "image"] } },
              },
            },
          },
        });
      if (value.includes("/session") && init?.method === "POST")
        return Response.json({ id: "new-session", directory: "/work" });
      return Response.json([
        {
          id: "existing-session",
          directory: "/work",
          title: "Existing session",
          time: { updated: 1 },
        },
      ]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";

  await adapter.refreshAll();
  assert.deepEqual(adapter.publicProfiles(), [
    {
      id: "openai",
      agentId: "opencode",
      name: "OpenAI",
      enabled: true,
      online: false,
      current: true,
    },
  ]);
  const models = adapter.listModels("openai");
  assert.deepEqual(
    models.map((model) => [model.model, model.isDefault === true]),
    [
      ["default", false],
      ["openai/gpt-5", true],
      ["openai/gpt-5v", false],
    ],
  );
  assert.equal(models[1].groupName, "OpenAI");
  assert.equal(models[1].supportsImages, false);
  assert.equal(models[2].supportsImages, true);

  // 显式 provider 在目录里不存在：只给 default 占位，不回退全量目录。
  const missed = adapter.listModels("no-such-provider");
  assert.deepEqual(
    (missed as any[]).map((model: any) => model.model),
    ["default"],
  );

  const created: any = await adapter.createThread("openai", {
    cwd: "/work",
    model: "openai/gpt-5",
  });
  assert.equal(created.providerId, "openai");

  const events: any[] = [];
  adapter.on("event", (event) => events.push(event));
  const existing: any = adapter
    .listThreads()
    .find((thread) => thread.id === "existing-session");
  existing.activeTurnId = "turn-123";
  (adapter as any).onEvent({
    type: "session.status",
    properties: { sessionID: "existing-session", status: { type: "idle" } },
  });
  assert.equal(existing.activeTurnId, undefined);
  assert.deepEqual(events.at(-1)?.data?.params?.turn, {
    id: "turn-123",
    status: "completed",
  });
  assert.ok(calls.some((call) => call.url.includes("/session")));
});

test("OpenCode adapter reload disposes directory instances and re-reads providers", async () => {
  const disposeCalls: string[] = [];
  let providerVersion = 0;
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/instance/dispose") && init?.method === "POST") {
        disposeCalls.push(value);
        providerVersion = 1;
        return Response.json(true);
      }
      if (value.includes("/provider"))
        return Response.json({
          all: {
            openai: {
              name: "OpenAI",
              models: { "gpt-5": { name: "GPT-5" } },
            },
            ...(providerVersion
              ? {
                  "new-provider": {
                    name: "New",
                    models: { "new-model": { name: "New Model" } },
                  },
                }
              : {}),
          },
          connected: providerVersion
            ? ["openai", "new-provider"]
            : ["openai"],
        });
      return Response.json([
        { id: "existing-session", directory: "/work", time: { updated: 1 } },
      ]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).online = true;

  await adapter.refreshAll();
  assert.equal(
    adapter.listModels().some((model: any) => model.id === "new-provider/new-model"),
    false,
  );

  await adapter.reload();
  assert.ok(
    disposeCalls.some((url) => url.includes("directory=%2Fwork")),
    "reload must dispose each known project directory",
  );
  assert.ok(
    disposeCalls.some((url) => !url.includes("directory=")),
    "reload must also dispose the default instance",
  );
  assert.ok(
    adapter
      .listModels()
      .some((model: any) => model.id === "new-provider/new-model"),
    "reload must surface providers added after the server started",
  );
});

test("OpenCode adapter restarts when the global config is newer than the serve process", async () => {  const dir = await mkdtemp(path.join(tmpdir(), "deck-opencode-global-"));
  const configFile = path.join(dir, "opencode.jsonc");
  await writeFile(configFile, "{}");
  let disposeCalls = 0;
  let spawned = 0;
  const child = new EventEmitter() as any;
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const adapter = new OpenCodeAdapter({
    openCodeConfigDir: dir,
    spawnProcess: () => {
      spawned += 1;
      return child;
    },
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/instance/dispose") && init?.method === "POST") {
        disposeCalls += 1;
        return Response.json(true);
      }
      if (value.includes("/global/health"))
        return Response.json({ healthy: true });
      if (value.includes("/provider"))
        return Response.json({
          all: {
            openai: { name: "OpenAI", models: { "gpt-5": {} } },
          },
        });
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).online = true;
  // 模拟进程先于配置文件修改启动：全局配置按进程缓存，只能重启。
  (adapter as any).processStartedAt = Date.now() - 60_000;

  await adapter.reload();
  assert.equal(disposeCalls, 0, "stale global config must restart, not dispose");
  assert.equal(spawned, 1, "reload should respawn the serve process");

  // 配置文件比进程旧：走 dispose 轻量重载即可。
  const stale = new Date(Date.now() - 120_000);
  await utimes(configFile, stale, stale);
  (adapter as any).processStartedAt = Date.now();
  await adapter.reload();
  assert.ok(disposeCalls > 0, "fresh global config allows lightweight dispose");
  adapter.restart();
});

test("OpenCode adapter escalation: dispose cannot fix an empty provider catalog", async () => {
  let spawned = 0;
  const child = new EventEmitter() as any;
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const adapter = new OpenCodeAdapter({
    spawnProcess: () => {
      spawned += 1;
      return child;
    },
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/instance/dispose") && init?.method === "POST")
        return Response.json(true);
      if (value.includes("/global/health"))
        return Response.json({ healthy: true });
      if (value.includes("/provider")) {
        // dispose 后新实例重建目录，但进程级 models.dev 注册表已坏，
        // 目录仍然为空；只有重启后的新进程才按当前文件恢复供应商。
        return spawned > 0
          ? Response.json({
              all: {
                "opencode-go": {
                  name: "OpenCode Go",
                  models: { "glm-5.3-flash": { name: "GLM" } },
                },
              },
            })
          : Response.json({ all: {} });
      }
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).online = true;

  const mode = await adapter.reload();
  assert.equal(mode, "process", "empty catalog after dispose must restart");
  assert.equal(spawned, 1, "escalation should respawn the serve once");
  assert.ok(
    adapter
      .listModels()
      .some((model: any) => model.id === "opencode-go/glm-5.3-flash"),
    "escalated reload must restore the provider catalog",
  );
  adapter.restart();
});

test("OpenCode adapter drops a directory catalog on server.instance.disposed", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/provider"))
        return Response.json({
          all: {
            "dir-provider": { name: "Dir", models: { m: { name: "M" } } },
          },
        });
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";

  await adapter.listModels(undefined, "/work");
  const catalogs = (adapter as any).projectCatalogs as Map<string, unknown>;
  assert.ok(catalogs.has("/work"));
  (adapter as any).onEvent({
    payload: {
      type: "server.instance.disposed",
      properties: { directory: "/work" },
    },
  });
  assert.equal(
    catalogs.has("/work"),
    false,
    "disposed directory must drop its cached catalog",
  );
});

test("OpenCode adapter rejects image attachments on text-only models", async () => {
  const messagePosts: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/prompt_async") && init?.method === "POST") {
        messagePosts.push({ url: value, init });
        return Response.json({ id: "msg" });
      }
      if (value.includes("/session") && init?.method === "POST")
        return Response.json({ id: "new-session", directory: "/work" });
      if (value.includes("/provider"))
        return Response.json({
          all: {
            openai: {
              name: "OpenAI",
              models: {
                "gpt-5": { name: "GPT-5", attachment: false },
                "gpt-5v": {
                  name: "GPT-5V",
                  modalities: { input: ["text", "image"] },
                },
              },
            },
          },
        });
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();
  await adapter.createThread("openai", { cwd: "/work", model: "openai/gpt-5" });
  const image = { url: "data:image/png;base64,x", name: "image.png" };

  await assert.rejects(
    adapter.sendTurn("openai", "new-session", "看看这张图", [image]),
    /不支持图片输入/,
  );
  assert.equal(
    (adapter.listThreads()[0] as any).status !== "running",
    true,
    "失败的发送不应把会话标记为运行中",
  );

  await adapter.updateThreadSettings("openai", "new-session", {
    model: "openai/gpt-5v",
  });
  await adapter.sendTurn("openai", "new-session", "看看这张图", [image]);
  assert.equal(messagePosts.length, 1);
  assert.deepEqual(JSON.parse(String(messagePosts[0].init?.body)).model, {
    providerID: "openai",
    modelID: "gpt-5v",
  });
});

test("OpenCode keeps the created model, hides subagent sessions and drops replayed user parts", async () => {
  const saved = new Map<string, any>();
  const threadSettings = {
    get: (_agent: string, id: string) => saved.get(id),
    update: async (_agent: string, id: string, next: any) => {
      const merged = { ...(saved.get(id) || {}), ...next };
      saved.set(id, merged);
      return merged;
    },
  };
  let sessions: any[] = [];
  const adapter = new OpenCodeAdapter({
    threadSettings: threadSettings as any,
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/session") && init?.method === "POST")
        return Response.json({ id: "new-session", directory: "/work" });
      if (value.includes("/provider")) return Response.json({ all: {} });
      if (value.includes("/config")) return Response.json({});
      return Response.json(sessions);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();
  await adapter.createThread("openai", {
    cwd: "/work",
    model: "openai/gpt-5",
  });
  assert.deepEqual(saved.get("new-session"), { model: "openai/gpt-5" });

  const events: any[] = [];
  adapter.on("event", (event) => events.push(event));
  // A late session.updated must not downgrade the model picked at creation.
  (adapter as any).onEvent({
    type: "session.updated",
    properties: {
      info: {
        id: "new-session",
        directory: "/work",
        title: "Renamed by OpenCode",
        time: { updated: 2 },
      },
    },
  });
  const thread: any = adapter
    .listThreads()
    .find((item) => item.id === "new-session");
  assert.equal(thread.model, "openai/gpt-5");
  assert.equal(thread.name, "Renamed by OpenCode");

  // Subagent sessions are children of a Deck thread and must stay hidden.
  (adapter as any).onEvent({
    type: "session.created",
    properties: {
      info: { id: "child", parentID: "new-session", directory: "/work" },
    },
  });
  sessions = [
    { id: "new-session", directory: "/work", time: { updated: 3 } },
    { id: "child", parentID: "new-session", directory: "/work" },
  ];
  await adapter.refreshAll();
  assert.deepEqual(
    adapter.listThreads().map((item) => item.id),
    ["new-session"],
  );

  // User parts are replayed over SSE; only assistant parts become items.
  (adapter as any).onEvent({
    type: "message.updated",
    properties: {
      sessionID: "new-session",
      info: { id: "msg-user", role: "user" },
    },
  });
  (adapter as any).onEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "new-session",
      part: {
        id: "part-user",
        sessionID: "new-session",
        messageID: "msg-user",
        type: "text",
        text: "hello",
      },
    },
  });
  (adapter as any).onEvent({
    type: "message.updated",
    properties: {
      sessionID: "new-session",
      info: { id: "msg-assistant", role: "assistant" },
    },
  });
  (adapter as any).onEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "new-session",
      part: {
        id: "part-assistant",
        sessionID: "new-session",
        messageID: "msg-assistant",
        type: "text",
        text: "hi",
      },
    },
  });
  const items = events.filter(
    (event) => event.type === "agent.event" && event.data.method === "item/updated",
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].data.params.item.id, "part-assistant");
  (adapter as any).onEvent({
    type: "message.part.delta",
    properties: {
      sessionID: "new-session", messageID: "msg-user",
      partID: "part-user", field: "text", delta: " again",
    },
  });
  (adapter as any).onEvent({
    type: "message.part.delta",
    properties: {
      sessionID: "new-session", messageID: "msg-assistant",
      partID: "part-assistant", field: "text", delta: " there",
    },
  });
  const deltas = events.filter(
    (event) => event.type === "agent.event" &&
      event.data.method === "item/agentMessage/delta",
  );
  assert.deepEqual(deltas.map((event) => event.data.params), [{
    threadId: "new-session", turnId: undefined,
    itemId: "part-assistant", delta: " there",
  }]);
});

test("OpenCode replays subagent activity onto the parent task card", async () => {
  let sessions: any[] = [{ id: "parent", directory: "/work" }];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/provider")) return Response.json({ all: {} });
      if (value.includes("/config")) return Response.json({});
      return Response.json(sessions);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();

  const events: any[] = [];
  adapter.on("event", (event) => events.push(event));

  // Child sessions stay hidden as threads but register their parent link.
  (adapter as any).onEvent({
    type: "session.created",
    properties: {
      info: { id: "child", parentID: "parent", directory: "/work" },
    },
  });
  assert.deepEqual(
    adapter.listThreads().map((item) => item.id),
    ["parent"],
  );

  // Child activity arriving before the task part is buffered.
  (adapter as any).onEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "child",
      part: {
        id: "child-part-1",
        sessionID: "child",
        messageID: "child-msg",
        type: "text",
        text: "正在读取 src 目录",
      },
    },
  });
  assert.equal(
    events.filter((event) => event.type === "agent.event").length,
    0,
  );

  // …then flushed once the parent's task part carries the child sessionId.
  (adapter as any).onEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "parent",
      part: {
        id: "part-task",
        sessionID: "parent",
        messageID: "msg-1",
        type: "tool",
        tool: "task",
        state: {
          status: "running",
          input: { description: "探索代码库", subagent_type: "explore" },
          metadata: { sessionId: "child" },
        },
      },
    },
  });
  const forwarded = events.filter(
    (event) =>
      event.type === "agent.event" && event.data.method === "item/updated",
  );
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].data.params.item.id, "part-task");
  assert.equal(
    forwarded[0].data.params.item.state.metadata.deckActivity,
    "正在读取 src 目录",
  );

  // Later child events replay onto the same parent item as live activity.
  (adapter as any).onEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "child",
      part: {
        id: "child-part-2",
        sessionID: "child",
        messageID: "child-msg-2",
        type: "tool",
        tool: "read",
        state: { status: "completed", title: "Read src/main.ts" },
      },
    },
  });
  const replayed = events.filter(
    (event) =>
      event.type === "agent.event" && event.data.method === "item/updated",
  );
  assert.equal(replayed.length, 2);
  assert.equal(replayed[1].data.params.item.id, "part-task");
  assert.equal(
    replayed[1].data.params.item.state.metadata.deckActivity,
    "Read src/main.ts",
  );

  // The forwarded part converts to the shared subagent card shape.
  const converted = openCodePartToItem(replayed[1].data.params.item);
  assert.equal(converted.type, "subagent");
  assert.equal(converted.title, "探索代码库");
  assert.equal(converted.agent, "explore");
  assert.equal(converted.status, "inProgress");
  assert.equal(converted.activity, "Read src/main.ts");
  assert.equal(converted.childSessionId, "child");
});

test("OpenCode adapter launches the Windows npm shim through cmd", async () => {
  const calls: Array<{ command: string; args: string[]; options: any }> = [];
  const child = new EventEmitter() as any;
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const adapter = new OpenCodeAdapter({
    platform: "win32",
    port: 4096,
    spawnProcess: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
    fetcher: (async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/global/health")
        return Response.json({ healthy: true });
      if (pathname === "/session") return Response.json([]);
      if (pathname === "/provider") return Response.json({ all: {} });
      return new Response("");
    }) as typeof fetch,
  });

  await adapter.startAll();
  assert.match(calls[0].command.toLowerCase(), /cmd\.exe$/);
  assert.deepEqual(calls[0].args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(calls[0].args[3], /"opencode\.cmd" "serve"/);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.equal(adapter.descriptor().online, true);
  adapter.restart();
});

test("OpenCode adapter reports stderr and stops a failed startup", async () => {
  const child = new EventEmitter() as any;
  child.stderr = new EventEmitter();
  let killed = false;
  child.kill = () => {
    killed = true;
    return true;
  };
  const adapter = new OpenCodeAdapter({
    port: 4096,
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.emit("data", "configuration is invalid");
        child.emit("exit", 1, null);
      });
      return child;
    },
    fetcher: (() => new Promise(() => undefined)) as typeof fetch,
  });

  await assert.rejects(adapter.startAll(), /configuration is invalid/);
  assert.equal(killed, true);
  assert.match(adapter.descriptor().error || "", /configuration is invalid/);
});

test("OpenCode ranks connected providers ahead of the rest of the catalog", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/config"))
        return Response.json({ model: { providerID: "mistral", modelID: "large" } });
      if (value.includes("/provider"))
        return Response.json({
          all: {
            openai: { name: "OpenAI", models: { "gpt-5": { name: "GPT-5" } } },
            mistral: { name: "Mistral", models: { large: { name: "Large" } } },
            anthropic: {
              name: "Anthropic",
              models: { sonnet: { name: "Sonnet" } },
            },
          },
          connected: ["anthropic", "mistral"],
        });
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();

  // Mistral is the configured default, so it leads the connected block; the
  // never-connected OpenAI provider falls behind both of them.
  assert.deepEqual(
    adapter.publicProfiles().map((profile) => [profile.id, profile.connected === true]),
    [
      ["mistral", true],
      ["anthropic", true],
      ["openai", false],
    ],
  );
  assert.deepEqual(
    adapter
      .listModels()
      .filter((model) => model.model !== "default")
      .map((model) => [model.model, model.connected === true]),
    [
      ["mistral/large", true],
      ["anthropic/sonnet", true],
      ["openai/gpt-5", false],
    ],
  );
});

test("OpenCode cached connected snapshot only serves loaded data", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async () =>
      Response.json({ all: {}, connected: ["acme"] })) as typeof fetch,
  });
  // 离线：未知。
  assert.equal(adapter.cachedConnectedProviders(), undefined);
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).online = true;
  // 在线但没拉过目录：未知，且不发 HTTP（纯读缓存）。
  assert.equal(adapter.cachedConnectedProviders(), undefined);
  assert.equal(adapter.cachedConnectedProviders("/proj"), undefined);
  await adapter.refreshAll();
  assert.deepEqual([...adapter.cachedConnectedProviders()!], ["acme"]);
  // 项目目录没有缓存就是未知；走一次模型目录后才有。
  assert.equal(adapter.cachedConnectedProviders("/proj"), undefined);
  await adapter.listModels(undefined, "/proj");
  assert.deepEqual([...adapter.cachedConnectedProviders("/proj")!], ["acme"]);
});

test("OpenCode probe reports runtime-connected providers and stays unknown when offline", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async () =>
      Response.json({ all: {}, connected: ["acme"] })) as typeof fetch,
  });
  // 离线：未知（undefined），不能被当成“无 Key”。
  assert.equal(await adapter.probeConnectedProviders(), undefined);
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).online = true;
  assert.deepEqual([...(await adapter.probeConnectedProviders())!], ["acme"]);
});

test("OpenCode model catalog uses the selected project's provider and default model", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.searchParams.get("directory"), "/project");
      if (parsed.pathname === "/provider")
        return Response.json({
          all: { local: { id: "local", name: "Local", models: {
            custom: { name: "Custom", limit: { context: 300_000 } },
          } } },
          connected: ["local"],
        });
      if (parsed.pathname === "/config")
        return Response.json({ model: "local/custom" });
      if (parsed.pathname === "/session/s1/message")
        return Response.json([
          { info: { id: "u1", role: "user" }, parts: [{ id: "p1", type: "text", text: "hello" }] },
          { info: {
            id: "a1", role: "assistant", providerID: "local", modelID: "custom",
            tokens: { input: 9_000, output: 1_000 },
          }, parts: [{ id: "p2", type: "text", text: "hi" }] },
        ]);
      if (parsed.pathname === "/session/s1")
        return Response.json({ id: "s1", directory: "/project" });
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  const models = await adapter.listModels(undefined, "/project");
  assert.equal(models.find((item) => item.model === "local/custom")?.isDefault, true);
  assert.equal(models.find((item) => item.model === "local/custom")?.connected, true);
  (adapter as any).threads.set("s1", {
    agentId: "opencode", id: "s1", providerId: "p", name: "s1",
    preview: "s1", cwd: "/project", model: "default", status: "idle", updatedAt: 1,
  });
  const loaded: any = await adapter.readThread("p", "s1");
  assert.equal(loaded.tokenUsage.limit, 300_000);
  assert.equal(loaded.resolvedModel, "local/custom");
});

test("OpenCode resolves the concrete model id and context usage from the last reply", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/config")) return Response.json({});
      if (value.includes("/provider"))
        return Response.json({
          all: {
            anthropic: {
              name: "Anthropic",
              models: {
                "claude-sonnet-4-5": {
                  name: "Claude Sonnet 4.5",
                  limit: { context: 200_000 },
                },
              },
            },
          },
          connected: ["anthropic"],
        });
      if (value.includes("/message"))
        return Response.json([
          {
            info: { id: "m1", role: "user", time: { created: 1 } },
            parts: [{ id: "p1", type: "text", text: "继续" }],
          },
          {
            info: {
              id: "m2",
              role: "assistant",
              providerID: "anthropic",
              modelID: "claude-sonnet-4-5",
              tokens: {
                input: 1_200,
                output: 300,
                reasoning: 50,
                cache: { read: 7_000, write: 0 },
              },
            },
            parts: [{ id: "p2", type: "text", text: "好" }],
          },
        ]);
      return Response.json([{ id: "s1", directory: "/work" }]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();

  const loaded: any = await adapter.readThread("p", "s1");
  assert.equal(loaded.resolvedModel, "anthropic/claude-sonnet-4-5");
  assert.deepEqual(loaded.tokenUsage, {
    input: 1_200,
    cachedInput: 7_000,
    output: 300,
    reasoningOutput: 50,
    used: 8_550,
    limit: 200_000,
  });
  // `default` stays the setting; the resolved id is display only.
  assert.equal(loaded.model, "default");
  const thread: any = adapter.listThreads().find((item) => item.id === "s1");
  assert.equal(thread.resolvedModel, "anthropic/claude-sonnet-4-5");
  assert.equal(thread.tokenUsage.used, 8_550);
});

test("OpenCode context usage skips aborted replies with zero tokens", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/config")) return Response.json({});
      if (value.includes("/provider"))
        return Response.json({
          all: {
            anthropic: {
              name: "Anthropic",
              models: {
                "claude-sonnet-4-5": {
                  name: "Claude Sonnet 4.5",
                  limit: { context: 200_000 },
                },
              },
            },
          },
          connected: ["anthropic"],
        });
      if (value.includes("/message"))
        return Response.json([
          {
            info: { id: "m1", role: "user", time: { created: 1 } },
            parts: [{ id: "p1", type: "text", text: "继续" }],
          },
          {
            info: {
              id: "m2",
              role: "assistant",
              providerID: "anthropic",
              modelID: "claude-sonnet-4-5",
              tokens: {
                input: 1_200,
                output: 300,
                reasoning: 0,
                cache: { read: 7_000, write: 0 },
              },
            },
            parts: [{ id: "p2", type: "text", text: "好" }],
          },
          // Aborted turn: assistant message with no token counts. This used
          // to render as a bogus "0/200k" context chip.
          {
            info: {
              id: "m3",
              role: "assistant",
              providerID: "anthropic",
              modelID: "claude-sonnet-4-5",
              tokens: {},
            },
            parts: [],
          },
        ]);
      return Response.json([{ id: "s1", directory: "/work" }]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();
  const loaded: any = await adapter.readThread("p", "s1");
  assert.equal(loaded.resolvedModel, "anthropic/claude-sonnet-4-5");
  assert.deepEqual(loaded.tokenUsage, {
    input: 1_200,
    cachedInput: 7_000,
    output: 300,
    reasoningOutput: 0,
    used: 8_500,
    limit: 200_000,
  });
});

test("OpenCode sessions without any token records show no context usage", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/config")) return Response.json({});
      if (value.includes("/provider"))
        return Response.json({
          all: {
            anthropic: {
              name: "Anthropic",
              models: {
                "claude-sonnet-4-5": { limit: { context: 200_000 } },
              },
            },
          },
          connected: ["anthropic"],
        });
      if (value.includes("/message"))
        return Response.json([
          {
            info: { id: "m1", role: "user", time: { created: 1 } },
            parts: [{ id: "p1", type: "text", text: "你好" }],
          },
          {
            info: {
              id: "m2",
              role: "assistant",
              providerID: "anthropic",
              modelID: "claude-sonnet-4-5",
              tokens: {},
            },
            parts: [],
          },
        ]);
      return Response.json([{ id: "s1", directory: "/work" }]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  // 模拟旧版缓存里残留的 used=0 用量，刷新后必须被清掉。
  (adapter as any).threads.set("s1", {
    id: "s1",
    providerId: "anthropic",
    name: "s",
    preview: "s",
    cwd: "/work",
    model: "default",
    status: "idle",
    updatedAt: 1,
    tokenUsage: { used: 0, limit: 200_000 },
  } as any);
  await adapter.refreshAll();
  const thread: any = adapter.listThreads().find((item) => item.id === "s1");
  // 旧缓存里的 used=0 残留被刷新清掉。
  assert.equal(thread.tokenUsage, undefined);
  const loaded: any = await adapter.readThread("p", "s1");
  // 最新 assistant 消息没有任何 token 记录：不生成 0/xxx 用量。
  assert.equal(loaded.resolvedModel, "anthropic/claude-sonnet-4-5");
  assert.equal(loaded.tokenUsage, undefined);
});

test("OpenCode compaction renders one marker and waits for a new reply before reporting context", async () => {
  const records: any[] = [
    {
      info: { id: "m1", role: "user", time: { created: 1 } },
      parts: [{ id: "p1", type: "text", text: "继续" }],
    },
    {
      info: {
        id: "m2", role: "assistant", providerID: "acme", modelID: "opus",
        tokens: { input: 17_000, output: 600, cache: { read: 340_000 } },
      },
      parts: [{ id: "p2", type: "text", text: "压缩前的回复" }],
    },
  ];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/config")) return Response.json({});
      if (value.includes("/provider")) return Response.json({ all: {} });
      if (value.includes("/message")) return Response.json(records);
      if (value.includes("/session/s1"))
        return Response.json({ id: "s1", directory: "/work" });
      return Response.json([{ id: "s1", directory: "/work" }]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();
  assert.equal((await adapter.readThread("p", "s1") as any).tokenUsage.used, 357_600);

  records.push(
    {
      info: { id: "m3", role: "user", time: { created: 3 } },
      parts: [{ id: "p3", type: "compaction", auto: false }],
    },
    {
      info: {
        id: "m4", role: "assistant", providerID: "acme", modelID: "opus",
        summary: true,
        tokens: { input: 64_000, output: 1_800, cache: { read: 190_000 } },
      },
      parts: [{ id: "p4", type: "text", text: "压缩后的摘要" }],
    },
  );
  const compacted: any = await adapter.readThread("p", "s1");
  assert.equal(compacted.tokenUsage, undefined);
  assert.deepEqual(compacted.turns.at(-1).items, [{
    id: "p3", type: "contextCompaction", text: "压缩后的摘要",
  }]);
  assert.equal(adapter.listThreads()[0]?.tokenUsage, undefined);

  records.push(
    {
      info: { id: "m5", role: "user", time: { created: 5 } },
      parts: [{ id: "p5", type: "text", text: "下一步" }],
    },
    {
      info: {
        id: "m6", role: "assistant", providerID: "acme", modelID: "opus",
        tokens: { input: 10_000, output: 500, cache: { read: 1_500 } },
      },
      parts: [{ id: "p6", type: "text", text: "正常回复" }],
    },
  );
  assert.equal((await adapter.readThread("p", "s1") as any).tokenUsage.used, 12_000);
});

test("OpenCode history keeps synthetic parts out of the user bubble", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/config")) return Response.json({});
      if (value.includes("/provider")) return Response.json({ all: {} });
      if (value.includes("/message"))
        return Response.json([
          {
            info: { id: "m1", role: "user", time: { created: 1 } },
            parts: [
              { id: "p1", type: "text", text: "真实提问" },
              {
                id: "p2",
                type: "text",
                text: "继续，如果还有下一步",
                synthetic: true,
              },
            ],
          },
          {
            info: { id: "m2", role: "user", time: { created: 2 } },
            parts: [
              {
                id: "p3",
                type: "text",
                text: "整理一下摘要",
                synthetic: true,
              },
            ],
          },
          {
            info: { id: "m3", role: "assistant" },
            parts: [{ id: "p4", type: "text", text: "回复" }],
          },
        ]);
      return Response.json([{ id: "s1", directory: "/work" }]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();
  const loaded: any = await adapter.readThread("p", "s1");
  const texts = loaded.turns.flatMap((turn: any) =>
    turn.items.flatMap((item: any) =>
      item.type === "userMessage"
        ? item.content.map((part: any) => part.text)
        : [],
    ),
  );
  assert.deepEqual(texts, ["真实提问"]);
});

test("OpenCode history stamps each turn with the model that answered it", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/config")) return Response.json({});
      if (value.includes("/provider"))
        return Response.json({ all: {}, connected: [] });
      if (value.includes("/message"))
        return Response.json([
          {
            info: { id: "m1", role: "user", time: { created: 1 } },
            parts: [{ id: "p1", type: "text", text: "先问" }],
          },
          {
            info: {
              id: "m2",
              role: "assistant",
              providerID: "anthropic",
              modelID: "claude-sonnet-4-5",
            },
            parts: [{ id: "p2", type: "text", text: "答一" }],
          },
          {
            info: { id: "m3", role: "user", time: { created: 2 } },
            parts: [{ id: "p3", type: "text", text: "再问" }],
          },
          {
            info: {
              id: "m4",
              role: "assistant",
              providerID: "openai",
              modelID: "gpt-5",
              variant: "high",
            },
            parts: [{ id: "p4", type: "text", text: "答二" }],
          },
        ]);
      return Response.json([{ id: "s1", directory: "/work" }]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();

  const loaded: any = await adapter.readThread("p", "s1");
  assert.equal(loaded.turns[0].model, "anthropic/claude-sonnet-4-5");
  assert.equal(loaded.turns[0].reasoningEffort, undefined);
  assert.equal(loaded.turns[1].model, "openai/gpt-5");
  assert.equal(loaded.turns[1].reasoningEffort, "high");
});

test("OpenCode sessions fall back to the generated slug and expose effort variants", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/config")) return Response.json({});
      if (value.includes("/provider"))
        return Response.json({
          all: {
            openai: {
              name: "OpenAI",
              models: {
                "gpt-5": {
                  name: "GPT-5",
                  limit: { context: 400_000 },
                  variants: { low: {}, medium: {}, high: {} },
                  capabilities: { input: { image: false } },
                },
                "gpt-5v": {
                  name: "GPT-5V",
                  capabilities: { input: { image: true } },
                },
              },
            },
          },
          connected: ["openai"],
        });
      if (value.includes("/session"))
        return Response.json([
          {
            id: "s1",
            directory: "/work",
            // OpenCode fills `slug`, not `title`, until someone renames it.
            slug: "witty-comet",
            title: "",
            model: { id: "gpt-5", providerID: "openai", variant: "high" },
            time: { updated: 5 },
          },
        ]);
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();

  const thread = adapter.listThreads().find((item) => item.id === "s1");
  assert.equal(thread?.name, "witty-comet");
  assert.equal(thread?.preview, "witty-comet");
  assert.equal(thread?.reasoningEffort, "high");

  const models = adapter.listModels();
  const gpt5 = models.find((model) => model.model === "openai/gpt-5");
  assert.deepEqual(
    gpt5?.supportedReasoningEfforts?.map((item) => item.reasoningEffort),
    ["high", "medium", "low"],
  );
  assert.equal(gpt5?.supportsImages, false);
  assert.equal(
    models.find((model) => model.model === "openai/gpt-5v")?.supportsImages,
    true,
  );
});

test("OpenCode sends the picked effort as a variant the model advertises", async () => {
  const saved = new Map<string, any>();
  const posts: Array<{ body?: string }> = [];
  const adapter = new OpenCodeAdapter({
    threadSettings: {
      get: (_agent: string, id: string) => saved.get(id),
      update: async (_agent: string, id: string, next: any) => {
        const merged = { ...(saved.get(id) || {}), ...next };
        saved.set(id, merged);
        return merged;
      },
    } as any,
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/prompt_async") && init?.method === "POST") {
        posts.push({ body: init.body ? String(init.body) : undefined });
        return Response.json({ id: "msg" });
      }
      if (value.includes("/session") && init?.method === "POST")
        return Response.json({ id: "s1", directory: "/work" });
      if (value.includes("/provider"))
        return Response.json({
          all: {
            openai: {
              name: "OpenAI",
              models: { "gpt-5": { name: "GPT-5", variants: { low: {}, high: {} } } },
            },
          },
          connected: ["openai"],
        });
      if (value.includes("/config")) return Response.json({});
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();
  await adapter.createThread("openai", { cwd: "/work", model: "openai/gpt-5" });

  await adapter.updateThreadSettings("openai", "s1", {
    model: "openai/gpt-5",
    reasoningEffort: "high",
  });
  assert.equal(saved.get("s1")?.reasoningEffort, "high");
  await adapter.sendTurn("openai", "s1", "继续");
  assert.deepEqual(JSON.parse(String(posts.at(-1)?.body)).variant, "high");

  // 模型明确不支持的档位：写入时即拒绝，不留到发送时静默按默认档位跑。
  const sent = (adapter as any).threads.get("s1");
  sent.status = "idle";
  sent.activeTurnId = undefined;
  await assert.rejects(
    adapter.updateThreadSettings("openai", "s1", { reasoningEffort: "ultra" }),
    /不支持推理强度 ultra/,
  );
  assert.equal((adapter as any).threads.get("s1").reasoningEffort, "high");
  await adapter.sendTurn("openai", "s1", "继续");
  assert.deepEqual(JSON.parse(String(posts.at(-1)?.body)).variant, "high");
  assert.equal(posts.length, 2);

  // 历史脏档位（写入校验之前存下的）：发送时大声失败，一轮也不发。
  sent.status = "idle";
  sent.activeTurnId = undefined;
  sent.reasoningEffort = "ultra";
  await assert.rejects(adapter.sendTurn("openai", "s1", "继续"), /不支持推理强度 ultra/);
  assert.equal(posts.length, 2);

  // 清空模型即回到“跟随默认”，不再把旧值写回去。
  await adapter.updateThreadSettings("openai", "s1", { model: "" });
  assert.equal((adapter as any).threads.get("s1").model, "default");
  assert.equal(saved.get("s1")?.model, "default");
});

test("OpenCode refuses an effort when the model declares no variants", async () => {
  const posts: Array<{ body?: string }> = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/prompt_async") && init?.method === "POST") {
        posts.push({ body: init.body ? String(init.body) : undefined });
        return Response.json({ id: "msg" });
      }
      if (value.includes("/session") && init?.method === "POST")
        return Response.json({ id: "s1", directory: "/work" });
      if (value.includes("/provider"))
        return Response.json({
          all: {
            acme: {
              name: "Acme",
              models: { "custom-model": { name: "Custom" } },
            },
          },
          connected: ["acme"],
        });
      if (value.includes("/config")) return Response.json({});
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();
  await adapter.createThread("acme", {
    cwd: "/work",
    model: "acme/custom-model",
  });

  // 写入时即拒绝：模型未声明 variants，任何档位都不收。
  await assert.rejects(
    adapter.updateThreadSettings("acme", "s1", {
      model: "acme/custom-model",
      reasoningEffort: "medium",
    }),
    /未配置推理强度档位/,
  );
  assert.equal((adapter as any).threads.get("s1").reasoningEffort, undefined);

  // 历史脏档位（写入校验之前存下的）：发送与命令同样大声失败，一次也不发。
  // OpenCode answers such a prompt with "Variant unavailable", so Deck fails
  // fast and points at the missing config instead of sending it.
  (adapter as any).threads.get("s1").reasoningEffort = "medium";
  await assert.rejects(adapter.sendTurn("acme", "s1", "继续"), /未配置推理强度档位/);
  await assert.rejects(
    adapter.runSessionCommand("acme", "s1", "/init"),
    /声明 variants/,
  );
  assert.equal(posts.length, 0);
  assert.equal(
    (adapter.listThreads()[0] as any).status !== "running",
    true,
    "被拒绝的发送不应把会话标记为运行中",
  );
});

test("OpenCode concurrent sends on one thread are serialized and the displaced turn is closed", async () => {
  const posts: string[] = [];
  const events: Array<{ type: string; data: any }> = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/prompt_async") && init?.method === "POST") {
        posts.push(value);
        // 第一轮受理故意慢半拍，放大并发受理的交错窗口。
        await new Promise((resolve) => setTimeout(resolve, 20));
        return Response.json({ id: "msg" });
      }
      if (value.includes("/session") && init?.method === "POST")
        return Response.json({ id: "s1", directory: "/work" });
      if (value.includes("/provider"))
        return Response.json({ all: {}, connected: [] });
      if (value.includes("/config")) return Response.json({});
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  adapter.on("event", (event: any) => events.push(event));
  await adapter.refreshAll();
  await adapter.createThread("openai", { cwd: "/work", model: "default" });

  // 同一会话并发两轮：受理串行，两轮都发出，第二轮接管第一轮。
  const [first, second] = await Promise.all([
    adapter.sendTurn("openai", "s1", "第一轮"),
    adapter.sendTurn("openai", "s1", "第二轮"),
  ]);
  assert.equal(posts.length, 2);
  assert.notEqual(first.turn.id, second.turn.id);
  assert.equal((adapter as any).threads.get("s1").activeTurnId, second.turn.id);

  // 被顶掉的第一轮必须收到 interrupted 闭环，不能在前端一直转圈。
  const completed = events.filter((event) => event.type === "agent.event" && event.data?.method === "turn/completed");
  assert.ok(
    completed.some((event) => event.data?.params?.turn?.id === first.turn.id &&
      event.data?.params?.turn?.status === "interrupted"),
    "被接管的旧轮应补发 turn/completed interrupted",
  );
});

test("OpenCode rejects malformed model settings instead of silently running the wrong model", async () => {
  const posts: Array<{ url: string; body?: string }> = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/prompt_async") && init?.method === "POST") {
        posts.push({ url: value, body: init.body ? String(init.body) : undefined });
        return Response.json({ id: "msg" });
      }
      if (value.includes("/session") && init?.method === "POST") {
        posts.push({ url: value });
        return Response.json({ id: "s1", directory: "/work" });
      }
      if (value.includes("/provider"))
        return Response.json({ all: {}, connected: [] });
      if (value.includes("/config")) return Response.json({});
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();

  // 写入路径：半截模型直接拒绝，不创建原生会话、不落盘。
  await assert.rejects(
    adapter.createThread("openai", { cwd: "/work", model: "openai/" }),
    /模型格式无效/,
  );
  assert.ok(
    !posts.some((call) => call.url.endsWith("/session")),
    "脏模型不应创建原生会话",
  );
  await adapter.createThread("openai", { cwd: "/work", model: "openai/gpt-5" });
  // 分段空格归一化入库，多余斜杠直接拒绝。
  await adapter.createThread("openai", { cwd: "/work", model: "  openai / gpt-5 " });
  assert.equal((adapter as any).threads.get("s1").model, "openai/gpt-5");
  await assert.rejects(
    adapter.updateThreadSettings("openai", "s1", { model: "openai/gpt-5/extra" }),
    /模型格式无效/,
  );
  await assert.rejects(
    adapter.updateThreadSettings("openai", "s1", { model: "openai/" }),
    /模型格式无效/,
  );
  assert.equal((adapter as any).threads.get("s1").model, "openai/gpt-5");

  // 发送路径：历史脏数据（如已落盘的 `openai/`）大声失败，一次也不发，
  // 绝不带着空 modelID 让 serve 静默回退到默认模型。
  (adapter as any).threads.get("s1").model = "openai/";
  await assert.rejects(adapter.sendTurn("openai", "s1", "继续"), /无效/);
  assert.ok(
    !posts.some((call) => call.url.includes("/prompt_async")),
    "脏模型不应发送任何回合",
  );
});

test("OpenCode normalization keeps todo tool payloads and hides step metadata", () => {
  const todo = openCodePartToItem({
    id: "prt-1",
    type: "tool",
    tool: "todowrite",
    state: {
      status: "completed",
      title: "Update todos",
      input: { todos: [{ content: "ship", status: "in_progress" }] },
      metadata: { todos: [{ content: "ship", status: "in_progress" }] },
      output: "saved",
    },
  });
  assert.equal(todo.type, "commandExecution");
  assert.equal(todo.tool, "todowrite");
  assert.deepEqual(todo.todos, [{ content: "ship", status: "in_progress" }]);

  assert.equal(openCodePartToItem({ id: "prt-2", type: "patch" }), undefined);
  const unknown = openCodePartToItem({ id: "prt-3", type: "choice" });
  assert.equal(unknown.type, "extension");
  assert.equal(unknown.kind, "choice");
});

test("OpenCode history binds the latest turn to the active Deck turn", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      if (!String(url).includes("/message")) return Response.json({ id: "s1" });
      assert.match(String(url), /\/message/);
      return Response.json([
        {
          info: { id: "user-message", role: "user", time: { created: 1 } },
          parts: [{ id: "user-part", type: "text", text: "继续" }],
        },
        {
          info: { id: "assistant-message", role: "assistant" },
          parts: [{ id: "answer-part", type: "text", text: "处理中" }],
        },
      ]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode",
    id: "s1",
    providerId: "p",
    name: "n",
    preview: "",
    cwd: "/work",
    model: "default",
    status: "running",
    activeTurnId: "deck-turn",
    updatedAt: 1,
  });

  const loaded: any = await adapter.readThread("p", "s1");
  assert.equal(loaded.turns.at(-1).id, "deck-turn");
  assert.equal(loaded.turns.at(-1).status, "inProgress");
});

test("OpenCode native questions surface as answerable approval cards", async () => {
  const posts: Array<{ url: string; body?: string }> = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      if (init?.method === "POST")
        posts.push({ url: String(url), body: init.body ? String(init.body) : undefined });
      return Response.json(true);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode",
    id: "s1",
    providerId: "p",
    name: "n",
    preview: "",
    cwd: "/w",
    model: "m",
    status: "running",
    updatedAt: 1,
  });

  (adapter as any).onEvent({
    type: "question.asked",
    properties: {
      id: "que_1",
      sessionID: "s1",
      questions: [
        {
          header: "实现方案",
          question: "用哪种持久化？",
          multiple: true,
          options: [
            { label: "SQLite", description: "嵌入式" },
            { label: "JSON 文件", description: "简单" },
          ],
        },
      ],
      tool: { messageID: "msg-1", callID: "call-1" },
    },
  });

  const approval: any = adapter.snapshot().approvals[0];
  assert.equal(approval.kind, "question");
  assert.equal(approval.multiple, true);
  assert.equal(approval.questions[0].prompt, "用哪种持久化？");
  assert.deepEqual(
    approval.questions[0].options.map((option: any) => option.label),
    ["SQLite", "JSON 文件"],
  );
  assert.equal(approval.questions[0].options[0].description, "嵌入式");
  assert.equal(adapter.listThreads()[0].status, "waiting");

  await adapter.resolveApproval(approval.id, {
    answers: [{ value: "SQLite, JSON 文件", values: ["SQLite", "JSON 文件"] }],
  });
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/question\/que_1\/reply/);
  assert.deepEqual(JSON.parse(posts[0].body!), {
    answers: [["SQLite", "JSON 文件"]],
  });
  assert.equal(adapter.snapshot().approvals.length, 0);

  (adapter as any).onEvent({
    type: "question.asked",
    properties: { id: "que_2", sessionID: "s1", questions: [] },
  });
  const second: any = adapter.snapshot().approvals[0];
  await adapter.resolveApproval(second.id, { decision: "decline" });
  assert.match(posts[1].url, /\/question\/que_2\/reject/);
});

test("OpenCode recovers pending questions after an event stream reconnect", async () => {
  let pending: any[] = [{
    id: "que_1", sessionID: "s1",
    questions: [{ question: "继续吗？", options: [{ label: "继续" }] }],
  }];
  const adapter = new OpenCodeAdapter({
    idleGraceMs: 0,
    fetcher: (async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/question") return Response.json(pending);
      if (path === "/permission") return Response.json([]);
      if (path === "/session/status") return Response.json({ s1: { type: "idle" } });
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode", id: "s1", providerId: "p", name: "n",
    preview: "", cwd: "/work", model: "default", status: "running", updatedAt: 1,
  });
  await (adapter as any).syncPendingPermissions();
  assert.equal(adapter.snapshot().approvals[0]?.request?.method, "opencode/question");
  assert.equal(adapter.listThreads()[0].status, "waiting");
  pending = [];
  await (adapter as any).syncPendingPermissions();
  assert.equal(adapter.snapshot().approvals.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(adapter.listThreads()[0].status, "idle");
});

test("OpenCode keeps a native question available when its reply fails", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) =>
      String(url).includes("/question/") && init?.method === "POST"
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : Response.json([])) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode", id: "s1", providerId: "p", name: "n",
    preview: "", cwd: "/work", model: "default", status: "running", updatedAt: 1,
  });
  (adapter as any).onEvent({
    type: "question.asked",
    properties: { id: "que_1", sessionID: "s1", questions: [{ question: "继续吗？" }] },
  });
  await assert.rejects(
    adapter.resolveApproval("s1:que_1", { answers: [{ value: "继续" }] }),
    /OpenCode API 503/,
  );
  assert.equal(adapter.snapshot().approvals.length, 1);
  assert.equal(adapter.listThreads()[0].status, "waiting");
});

test("OpenCode permission.asked can be answered through the current permission API", async () => {
  const posts: Array<{ url: string; body: unknown }> = [];
  let pending: any[] = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/permission/") && init?.method === "POST") {
        posts.push({ url: value, body: JSON.parse(String(init.body)) });
        return Response.json(true);
      }
      if (value.includes("/permission")) return Response.json(pending);
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode", id: "s1", providerId: "p", name: "n",
    preview: "", cwd: "/work", model: "default", status: "running", updatedAt: 1,
  });
  const request = {
    id: "per_1", sessionID: "s1", permission: "bash",
    patterns: ["mkdir -p ~/learn"], metadata: { command: "mkdir -p ~/learn" },
    always: ["mkdir -p ~/learn"],
  };
  (adapter as any).onEvent({ type: "permission.asked", properties: request });
  const approval: any = adapter.snapshot().approvals[0];
  assert.equal(approval.request.method, "opencode/permission.v2");
  assert.equal(approval.command, "mkdir -p ~/learn");
  assert.equal(adapter.listThreads()[0].status, "waiting");

  await adapter.resolveApproval(approval.id, { decision: "acceptForSession" });
  assert.match(posts[0].url, /\/permission\/per_1\/reply/);
  assert.deepEqual(posts[0].body, { reply: "always" });
  assert.equal(adapter.snapshot().approvals.length, 0);

  pending = [request];
  await (adapter as any).syncPendingPermissions();
  assert.equal(adapter.snapshot().approvals.length, 1);
  pending = [];
  await (adapter as any).syncPendingPermissions();
  assert.equal(adapter.snapshot().approvals.length, 0);
  (adapter as any).onEvent({ type: "permission.asked", properties: request });
  (adapter as any).onEvent({
    type: "permission.replied",
    properties: { sessionID: "s1", requestID: "per_1", reply: "reject" },
  });
  assert.equal(adapter.snapshot().approvals.length, 0);
});

test("OpenCode project external-directory approval writes native project config", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "deck-opencode-approval-"));
  const replies: unknown[] = [];
  const patches: unknown[] = [];
  const disposes: string[] = [];
  const adapter = new OpenCodeAdapter({ fetcher: (async (url, init) => {
    if (String(url).includes("/config") && init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      return Response.json(true);
    }
    if (String(url).includes("/instance/dispose") && init?.method === "POST") {
      disposes.push(String(url));
      return Response.json(true);
    }
    if (String(url).includes("/permission/") && init?.method === "POST") {
      replies.push(JSON.parse(String(init.body)));
      return Response.json(true);
    }
    return Response.json([]);
  }) as typeof fetch });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).online = true;
  (adapter as any).threads.set("s1", {
    agentId: "opencode", id: "s1", providerId: "p", name: "n", preview: "", cwd,
    model: "default", status: "running", updatedAt: 1,
  });
  (adapter as any).onEvent({ type: "permission.asked", properties: {
    id: "per_1", sessionID: "s1", permission: "external_directory",
    patterns: ["/opt/demo/assets/*"], always: ["/opt/demo/assets/*"], metadata: {},
  } });
  const approval: any = adapter.snapshot().approvals[0];
  assert.ok(approval.availableDecisions.includes("allowForProject"));
  await adapter.resolveApproval(approval.id, { decision: "allowForProject" });
  assert.deepEqual(replies, [{ reply: "always" }]);
  // PATCH /config 会 dispose 该目录实例、丢掉挂起的权限和在途回合，
  // 持久授权只能落盘，绝不顺带热应用。
  assert.deepEqual(patches, []);
  const saved = JSON.parse(await readFile(path.join(cwd, "opencode.json"), "utf8"));
  assert.deepEqual(saved.permission.external_directory, { "/opt/demo/assets/*": "allow" });
  assert.equal(adapter.snapshot().approvals.length, 0);
  // 规则对新会话生效要等实例重建；排期的 dispose 必须在该项目空闲后才发生。
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(disposes.length, 1, "idle project must dispose its instance");
  assert.match(disposes[0], /directory=/);
});

test("OpenCode project external-directory approval keeps the turn while the project is busy", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "deck-opencode-approval-busy-"));
  const replies: unknown[] = [];
  const disposes: string[] = [];
  const adapter = new OpenCodeAdapter({ fetcher: (async (url, init) => {
    if (String(url).includes("/instance/dispose") && init?.method === "POST") {
      disposes.push(String(url));
      return Response.json(true);
    }
    if (String(url).includes("/permission/") && init?.method === "POST") {
      replies.push(JSON.parse(String(init.body)));
      return Response.json(true);
    }
    if (String(url).includes("/session/status"))
      return Response.json({ s1: { type: "busy" } });
    return Response.json([]);
  }) as typeof fetch });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).online = true;
  (adapter as any).threads.set("s1", {
    agentId: "opencode", id: "s1", providerId: "p", name: "n", preview: "", cwd,
    model: "default", status: "running", updatedAt: 1,
  });
  (adapter as any).onEvent({ type: "permission.asked", properties: {
    id: "per_1", sessionID: "s1", permission: "external_directory",
    patterns: ["/opt/demo/assets/*"], always: ["/opt/demo/assets/*"], metadata: {},
  } });
  await adapter.resolveApproval("s1:per_1", { decision: "allowForProject" });
  assert.deepEqual(replies, [{ reply: "always" }]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(disposes, [], "busy project must not dispose its instance");
});

test("OpenCode restart kills the Windows process tree, not just cmd", async () => {
  const treeKilled: number[] = [];
  let directKilled = false;
  const child = new EventEmitter() as any;
  child.pid = 4242;
  child.stderr = new EventEmitter();
  child.kill = () => {
    directKilled = true;
    return true;
  };
  const adapter = new OpenCodeAdapter({
    platform: "win32",
    port: 4096,
    killProcessTree: (pid: number) => {
      treeKilled.push(pid);
    },
    spawnProcess: () => child,
    fetcher: (async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/global/health")
        return Response.json({ healthy: true });
      if (pathname === "/session") return Response.json([]);
      if (pathname === "/provider") return Response.json({ all: {} });
      return new Response("");
    }) as typeof fetch,
  });

  await adapter.startAll();
  adapter.restart();
  assert.deepEqual(treeKilled, [4242]);
  assert.equal(directKilled, true);
  assert.equal(adapter.descriptor().online, false);
});

test("OpenCode failed startup kills the process tree", async () => {
  const treeKilled: number[] = [];
  let directKilled = false;
  const child = new EventEmitter() as any;
  child.pid = 7777;
  child.stderr = new EventEmitter();
  child.kill = () => {
    directKilled = true;
    return true;
  };
  const adapter = new OpenCodeAdapter({
    port: 4096,
    killProcessTree: (pid: number) => {
      treeKilled.push(pid);
    },
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.emit("data", "boom");
        child.emit("exit", 1, null);
      });
      return child;
    },
    fetcher: (() => new Promise(() => undefined)) as typeof fetch,
  });

  await assert.rejects(adapter.startAll(), /boom/);
  assert.deepEqual(treeKilled, [7777]);
  assert.equal(directKilled, true);
});

test("OpenCode startAll reuses a healthy server instead of spawning again", async () => {
  let spawns = 0;
  const child = new EventEmitter() as any;
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const adapter = new OpenCodeAdapter({
    port: 4096,
    spawnProcess: () => {
      spawns += 1;
      return child;
    },
    fetcher: (async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/global/health")
        return Response.json({ healthy: true });
      if (pathname === "/session") return Response.json([]);
      if (pathname === "/provider") return Response.json({ all: {} });
      return new Response("");
    }) as typeof fetch,
  });

  await adapter.startAll();
  assert.equal(spawns, 1);
  await adapter.startAll();
  assert.equal(spawns, 1);
  assert.equal(adapter.descriptor().online, true);
  adapter.restart();
});

test("OpenCode crash does not taskkill a reused Windows PID", async () => {
  const treeKilled: number[] = [];
  const child = new EventEmitter() as any;
  child.pid = 5050;
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = new EventEmitter();
  child.kill = () => true;
  const adapter = new OpenCodeAdapter({
    platform: "win32",
    port: 4096,
    spawnProcess: () => child,
    killProcessTree: (pid: number) => treeKilled.push(pid),
    fetcher: (async (url) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/global/health") return Response.json({ healthy: true });
      if (pathname === "/session") return Response.json([]);
      if (pathname === "/provider") return Response.json({ all: {} });
      return new Response("");
    }) as typeof fetch,
  });

  await adapter.startAll();
  child.exitCode = 1;
  child.emit("exit", 1, null);

  assert.equal(adapter.descriptor().online, false);
  assert.deepEqual(treeKilled, []);
  adapter.restart();
});

test("OpenCode replied/rejected events clear stale question cards", () => {
  const adapter = new OpenCodeAdapter({ fetcher: (async () => Response.json(true)) as typeof fetch });
  adapter.on("event", () => undefined);
  (adapter as any).threads.set("s1", {
    agentId: "opencode",
    id: "s1",
    providerId: "p",
    name: "n",
    preview: "",
    cwd: "/w",
    model: "m",
    status: "waiting",
    updatedAt: 1,
  });
  (adapter as any).approvals.set("s1:que_x", { id: "s1:que_x" });

  (adapter as any).onEvent({
    type: "question.rejected",
    properties: { sessionID: "s1", requestID: "que_x" },
  });
  assert.equal(adapter.snapshot().approvals.length, 0);
});

test("OpenCode forceStop resets a stuck running thread without waiting for the backend", async () => {
  const aborts: string[] = [];
  const adapter = new OpenCodeAdapter({
    idleGraceMs: 0,
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/abort") && init?.method === "POST") {
        aborts.push(value);
        throw new Error("fetch failed");
      }
      if (value.includes("/provider")) return Response.json({ all: {} });
      if (value.includes("/session"))
        return Response.json([{ id: "s1", directory: "/work", title: "n" }]);
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();
  const thread: any = adapter.listThreads().find((item) => item.id === "s1");
  thread.status = "running";
  thread.activeTurnId = "turn-9";
  adapter.on("event", () => undefined);
  (adapter as any).runningTurns.set("s1", {
    turnId: "turn-9",
    startedAt: 1,
    outputs: new Map(),
    lastEmitAt: 0,
  });

  const result = await adapter.forceStop("p", "s1");
  assert.deepEqual(result, { ok: true });
  assert.ok(aborts.some((value) => value.includes("/session/s1/abort")));
  assert.equal(
    adapter.listThreads().find((item) => item.id === "s1")?.status,
    "idle",
  );
  assert.equal(
    adapter.listThreads().find((item) => item.id === "s1")?.activeTurnId,
    undefined,
  );

  // 卡在等待确认时同样要撤掉挂起的审批。
  thread.status = "waiting";
  (adapter as any).threads.get("s1").status = "waiting";
  (adapter as any).approvals.set("s1:que_x", { id: "s1:que_x", sessionID: "s1" });
  await adapter.forceStop("p", "s1");
  assert.equal(adapter.snapshot().approvals.length, 0);
  assert.equal(
    adapter.listThreads().find((item) => item.id === "s1")?.status,
    "idle",
  );
  await assert.rejects(() => adapter.forceStop("p", "missing"));
});

test("OpenCode new threads hide the random slug until the first message", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      if (String(url).includes("/session") && init?.method === "POST")
        return Response.json({ id: "s1", directory: "/work", slug: "curious-comet", title: "" });
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  const created: any = await adapter.createThread("p", { cwd: "/work" });
  assert.equal(created.name, "新 OpenCode 会话");
  assert.equal(created.preview, "新 OpenCode 会话");
});

test("OpenCode uses the first user message as title when OpenCode left title empty", async () => {
  const message = (text: string) => [
    {
      info: { id: "m1", role: "user", time: { created: 1 } },
      parts: [{ id: "p1", type: "text", text }],
    },
  ];
  const makeAdapter = (session: any) =>
    new OpenCodeAdapter({
      fetcher: (async (url) => {
        const value = String(url);
        if (value.includes("/message")) return Response.json(message("修复登录闪退问题，点按钮没反应"));
        if (value.includes("/provider")) return Response.json({ all: {} });
        if (value.includes("/config")) return Response.json({});
        if (value.includes("/session")) return Response.json([session]);
        return Response.json([]);
      }) as typeof fetch,
    });

  const untitled = makeAdapter({ id: "s1", directory: "/work", slug: "curious-comet", title: "" });
  (untitled as any).baseUrl = "http://127.0.0.1:4096";
  await untitled.refreshAll();
  assert.equal(untitled.listThreads()[0].name, "curious-comet");
  const originalUpdatedAt = untitled.listThreads()[0].updatedAt;
  await untitled.readThread("p", "s1");
  const renamed: any = untitled.listThreads().find((item) => item.id === "s1");
  assert.equal(renamed.preview, "修复登录闪退问题，点按钮没反应");
  assert.equal(renamed.name, "修复登录闪退问题，点按钮没反应".slice(0, 42));
  assert.equal(renamed.updatedAt, originalUpdatedAt);

  const titled = makeAdapter({ id: "s1", directory: "/work", slug: "curious-comet", title: "手动标题" });
  (titled as any).baseUrl = "http://127.0.0.1:4096";
  await titled.refreshAll();
  await titled.readThread("p", "s1");
  assert.equal(titled.listThreads()[0].name, "手动标题");
});

test("OpenCode refresh keeps cached sessions when the list is partial", async () => {
  let response: unknown = [
    { id: "s1", directory: "D:/Code/HIT/RL", time: { updated: 10 } },
    { id: "s2", directory: "D:/Code/HIT/Other", time: { updated: 20 } },
  ];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/provider")) return Response.json([]);
      if (value.includes("/config")) return Response.json({});
      return Response.json(response);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";

  await adapter.refreshAll();
  response = [{ id: "s1", directory: "D:/Code/HIT/RL", time: { updated: 11 } }];
  await adapter.refreshAll();

  assert.deepEqual(adapter.listThreads().map((item) => item.id), ["s2", "s1"]);
  assert.equal(adapter.listThreads().find((item) => item.id === "s2")?.updatedAt, 20);
});

test("OpenCode sendTurn names slug threads optimistically but keeps manual renames", async () => {
  const makeAdapter = () =>
    new OpenCodeAdapter({
      fetcher: (async (url, init) => {
        const value = String(url);
        if (value.includes("/prompt_async") && init?.method === "POST") return new Response(null, { status: 204 });
        if (value.includes("/provider")) return Response.json({ all: {} });
        if (value.includes("/config")) return Response.json({});
        if (value.includes("/session"))
          return Response.json([{ id: "s1", directory: "/work", slug: "neon-lagoon", title: "" }]);
        return Response.json([]);
      }) as typeof fetch,
    });
  const adapter = makeAdapter();
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();
  await adapter.sendTurn("p", "s1", "帮我看看为什么构建这么慢");
  assert.equal(
    adapter.listThreads().find((item) => item.id === "s1")?.name,
    "帮我看看为什么构建这么慢".slice(0, 42),
  );

  const manual = makeAdapter();
  (manual as any).baseUrl = "http://127.0.0.1:4096";
  await manual.refreshAll();
  await manual.renameThread("p", "s1", "我的构建优化");
  await manual.sendTurn("p", "s1", "换个话题聊聊别的");
  assert.equal(manual.listThreads().find((item) => item.id === "s1")?.name, "我的构建优化");
});

test("OpenCode archive moves sessions to the archived bucket and persists it", async () => {
  const saved = new Map<string, any>();
  const store = {
    get: (_agent: string, id: string) => saved.get(id),
    update: async (_agent: string, id: string, next: any) => {
      const merged = { ...(saved.get(id) || {}), ...next };
      if (next.archived === null || next.archived === false)
        delete merged.archived;
      saved.set(id, merged);
      return merged;
    },
  };
  const adapter = new OpenCodeAdapter({
    threadSettings: store,
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/provider")) return Response.json({ all: {} });
      if (value.includes("/config")) return Response.json({});
      if (value.includes("/session"))
        return Response.json([
          { id: "s1", directory: "/work", slug: "neon-lagoon", title: "" },
        ]);
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();

  assert.equal(adapter.descriptor().capabilities.archive, true);
  await adapter.archiveThread("p", "s1");
  assert.equal(adapter.listThreads().length, 0);
  assert.equal(adapter.snapshot().archivedThreads?.[0]?.id, "s1");
  assert.equal(saved.get("s1")?.archived, true);

  // 服务端仍然列出该会话时，刷新不得把它复活回现有库。
  await adapter.refreshAll();
  assert.equal(adapter.listThreads().length, 0);
  assert.equal(adapter.snapshot().archivedThreads?.[0]?.id, "s1");

  await adapter.unarchiveThread("p", "s1");
  assert.equal(adapter.listThreads()[0]?.id, "s1");
  assert.equal(adapter.snapshot().archivedThreads?.length, 0);
  assert.equal(saved.get("s1")?.archived, undefined);
});

test("OpenCode archive refuses running sessions and archived sessions refuse new turns", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async () => Response.json([])) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("busy", {
    agentId: "opencode",
    id: "busy",
    providerId: "p",
    name: "busy",
    preview: "busy",
    cwd: "/work",
    model: "default",
    status: "running",
    updatedAt: 1,
  });
  (adapter as any).threads.set("done", {
    agentId: "opencode",
    id: "done",
    providerId: "p",
    name: "done",
    preview: "done",
    cwd: "/work",
    model: "default",
    status: "idle",
    updatedAt: 1,
  });

  await assert.rejects(adapter.archiveThread("p", "busy"), /不能归档/);
  await adapter.archiveThread("p", "done");
  await assert.rejects(adapter.sendTurn("p", "done", "hi"), /已归档/);
  await assert.rejects(adapter.interrupt("p", "done", "t"), /已归档/);
  // 归档会话仍然可以读历史和删除。
  (adapter as any).fetcher = (async () => Response.json([])) as typeof fetch;
  await adapter.unarchiveThread("p", "done");
  assert.equal(adapter.listThreads()[0]?.id, "done");
});

test("OpenCode lists server commands and runs one with the session model", async () => {
  const posts: Array<{ url: string; body?: string }> = [];
  const lists: string[] = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/command") && !init?.method) {
        lists.push(value);
        return Response.json([
          { name: "init", description: "Setup AGENTS.md" },
          { command: "deploy" },
          "plain",
        ]);
      }
      if (value.includes("/command") && init?.method === "POST") {
        posts.push({ url: value, body: init.body ? String(init.body) : undefined });
        return Response.json({ info: { id: "m1" }, parts: [] });
      }
      if (value.includes("/provider")) return Response.json({ all: {} });
      if (value.includes("/config")) return Response.json({});
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode",
    id: "s1",
    providerId: "p",
    name: "s1",
    preview: "s1",
    cwd: "/work",
    model: "openai/gpt-5",
    reasoningEffort: "high",
    status: "idle",
    updatedAt: 1,
  });
  // variant 不在模型目录里时不发送，避免被服务端拒绝。
  assert.deepEqual(await adapter.listSessionCommands("p", "s1"), [
    { name: "deploy" },
    { name: "init", description: "Setup AGENTS.md" },
    { name: "plain" },
  ]);
  assert.match(lists[0], /[?&]directory=%2Fwork/);

  await adapter.runSessionCommand("p", "s1", "/init", "AGENTS.md");
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /\/session\/s1\/command/);
  assert.deepEqual(JSON.parse(posts[0].body!), {
    command: "init",
    arguments: "AGENTS.md",
    model: { providerID: "openai", modelID: "gpt-5" },
  });
  assert.equal(
    (adapter.listThreads().find((item) => item.id === "s1") as any)?.status,
    "running",
  );
});

test("OpenCode long-running command returns immediately and reports a later API error", async () => {
  let rejectCommand!: (error: Error) => void;
  const adapter = new OpenCodeAdapter({
    fetcher: (async (_url, init) => {
      if (init?.method === "POST")
        return new Promise<Response>((_resolve, reject) => {
          rejectCommand = reject;
        });
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode", id: "s1", providerId: "p", name: "s1",
    preview: "s1", cwd: "/work", model: "default", status: "idle", updatedAt: 1,
  });
  const result = await Promise.race([
    adapter.runSessionCommand("p", "s1", "deploy"),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("command blocked Deck")), 100)),
  ]);
  assert.equal(result.turn.status, "inProgress");
  rejectCommand(new Error("server failed"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(adapter.listThreads()[0].status, "error");
});

test("OpenCode lists skills from GET /skill and marks project scope", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (/\/skill(\?|$)/.test(value))
        return Response.json([
          {
            name: "release",
            description: "发版流程",
            location: "/work/.opencode/skills/release/SKILL.md",
          },
          {
            name: "team",
            location: "/home/u/.config/opencode/skills/team/SKILL.md",
          },
          { id: "legacy" },
        ]);
      if (value.includes("/provider")) return Response.json({ all: {} });
      if (value.includes("/config")) return Response.json({});
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode",
    id: "s1",
    providerId: "p",
    name: "s1",
    preview: "s1",
    cwd: "/work",
    model: "default",
    status: "idle",
    updatedAt: 1,
  });
  const result = await adapter.listSkills("p", "s1");
  assert.deepEqual(result.skills, [
    {
      name: "legacy",
      description: undefined,
      path: undefined,
      scope: "global",
      enabled: true,
    },
    {
      name: "release",
      description: "发版流程",
      path: "/work/.opencode/skills/release/SKILL.md",
      scope: "project",
      enabled: true,
    },
    {
      name: "team",
      description: undefined,
      path: "/home/u/.config/opencode/skills/team/SKILL.md",
      scope: "global",
      enabled: true,
    },
  ]);
  assert.equal(adapter.descriptor().capabilities.skills, true);
});

test("OpenCode compact resolves the model and clears the compacting flag", async () => {
  const posts: Array<{ body?: string }> = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/summarize") && init?.method === "POST") {
        posts.push({ body: init.body ? String(init.body) : undefined });
        return Response.json(true);
      }
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).configDefault = { providerID: "openai", modelID: "gpt-5" };
  (adapter as any).threads.set("s1", {
    agentId: "opencode",
    id: "s1",
    providerId: "p",
    name: "s1",
    preview: "s1",
    cwd: "/work",
    model: "default",
    status: "idle",
    updatedAt: 1,
    tokenUsage: { used: 357_600 },
  });

  await adapter.compactSession("p", "s1");
  assert.deepEqual(JSON.parse(posts[0].body!), {
    providerID: "openai",
    modelID: "gpt-5",
  });
  assert.equal((adapter.listThreads()[0] as any)?.compacting, undefined);
  assert.equal(adapter.listThreads()[0]?.tokenUsage, undefined);

  (adapter as any).threads.get("s1").status = "running";
  await assert.rejects(adapter.compactSession("p", "s1"), /任务结束后/);
});

test("OpenCode compact clears compacting on the live object when events swap it mid-request", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/summarize") && init?.method === "POST") {
        // summarize 期间 OpenCode 会推 session.updated，mergeThread 生成新
        // 对象并把 compacting 拷过去；清理写在旧引用上会让标记永久残留。
        (adapter as any).onEvent({
          type: "session.updated",
          properties: {
            info: {
              id: "s1",
              directory: "/work",
              title: "s1",
              time: { updated: 2 },
            },
          },
        });
        return Response.json(true);
      }
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).configDefault = { providerID: "openai", modelID: "gpt-5" };
  (adapter as any).threads.set("s1", {
    agentId: "opencode",
    id: "s1",
    providerId: "p",
    name: "s1",
    preview: "s1",
    cwd: "/work",
    model: "default",
    status: "idle",
    updatedAt: 1,
  });

  await adapter.compactSession("p", "s1");
  const thread: any = adapter.listThreads()[0];
  assert.equal(thread.compacting, undefined);
  assert.equal(thread.status, "idle");
});

test("OpenCode revert targets the last user message and reports the file summary", async () => {
  const posts: Array<{ url: string; body?: string }> = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/message") && !init?.method)
        return Response.json([
          {
            info: { id: "m1", role: "user", time: { created: 1 } },
            parts: [{ id: "p1", type: "text", text: "第一轮" }],
          },
          {
            info: { id: "m2", role: "assistant" },
            parts: [{ id: "p2", type: "text", text: "好" }],
          },
          {
            info: { id: "m3", role: "user", time: { created: 2 } },
            parts: [{ id: "p3", type: "text", text: "第二轮" }],
          },
        ]);
      if (value.includes("/revert") && init?.method === "POST") {
        posts.push({ url: value, body: init.body ? String(init.body) : undefined });
        return Response.json(true);
      }
      if (value.includes("/session/s1") && !init?.method)
        return Response.json({
          id: "s1",
          revert: { messageID: "m3" },
          summary: { files: 2, additions: 10, deletions: 3 },
        });
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode",
    id: "s1",
    providerId: "p",
    name: "s1",
    preview: "s1",
    cwd: "/work",
    model: "default",
    status: "idle",
    updatedAt: 1,
  });

  // 不带 messageID 时以后端最后一条 user 消息为边界。
  const summary = await adapter.revertSession("p", "s1");
  assert.deepEqual(JSON.parse(posts[0].body!), { messageID: "m3" });
  assert.deepEqual(summary, {
    messageID: "m3",
    files: 2,
    additions: 10,
    deletions: 3,
  });

  // 按条撤回直接透传调用方传入的 turn.id。
  await adapter.revertSession("p", "s1", "m1");
  assert.deepEqual(JSON.parse(posts[1].body!), { messageID: "m1" });

  (adapter as any).threads.get("s1").status = "waiting";
  await assert.rejects(adapter.revertSession("p", "s1"), /运行中/);
  (adapter as any).threads.get("s1").status = "idle";
  (adapter as any).threads.get("s1").archived = true;
  await assert.rejects(adapter.revertSession("p", "s1"), /归档/);
});

test("OpenCode history hides reverted turns until unrevert", async () => {
  let reverted = "m2";
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/message"))
        return Response.json([
          { info: { id: "m1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "第一轮" }] },
          { info: { id: "m2", role: "user", time: { created: 2 } }, parts: [{ type: "text", text: "已撤回" }] },
        ]);
      if (value.includes("/session/s1"))
        return Response.json({ id: "s1", revert: reverted ? { messageID: reverted } : undefined });
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode", id: "s1", providerId: "p", name: "s1",
    preview: "s1", cwd: "/work", model: "default", status: "idle", updatedAt: 1,
  });

  assert.deepEqual((await adapter.readThread("p", "s1")).turns.map((turn: any) => turn.id), ["m1"]);
  reverted = "m1";
  assert.deepEqual((await adapter.readThread("p", "s1")).turns, []);
  reverted = "";
  assert.deepEqual((await adapter.readThread("p", "s1")).turns.map((turn: any) => turn.id), ["m1", "m2"]);
});

test("OpenCode unrevert posts once and refuses busy sessions", async () => {
  const posts: string[] = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      if (String(url).includes("/unrevert") && init?.method === "POST") {
        posts.push(String(url));
        return Response.json(true);
      }
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode",
    id: "s1",
    providerId: "p",
    name: "s1",
    preview: "s1",
    cwd: "/work",
    model: "default",
    status: "idle",
    updatedAt: 1,
  });

  assert.deepEqual(await adapter.unrevertSession("p", "s1"), { ok: true });
  assert.equal(posts.length, 1);

  (adapter as any).threads.get("s1").status = "running";
  await assert.rejects(adapter.unrevertSession("p", "s1"), /运行中/);
});

test("OpenCode fork 能力已开启：原生 fork 接口，非破坏性分支", async () => {
  const adapter = new OpenCodeAdapter({ fetcher: (async () =>
    Response.json([])) as typeof fetch });
  assert.equal(adapter.descriptor().capabilities.fork, true);
});

test("OpenCode forkThread 调原生 fork 接口并记录 forkedFromId", async () => {
  const posts: Array<{ url: string; body?: string }> = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/fork") && init?.method === "POST") {
        posts.push({ url: value, body: init.body ? String(init.body) : undefined });
        return Response.json({ id: "branch1", directory: "/work" });
      }
      if (value.includes("/session/branch1") && init?.method === "PATCH")
        return Response.json({ id: "branch1" });
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode",
    id: "s1",
    providerId: "p",
    name: "原会话",
    preview: "原会话",
    cwd: "/work",
    model: "default",
    status: "idle",
    updatedAt: 1,
  });

  const branch: any = await adapter.forkThread("p", "s1", { messageID: "m1" });
  assert.deepEqual(JSON.parse(posts[0].body!), { messageID: "m1" });
  assert.equal(branch.id, "branch1");
  assert.equal(branch.forkedFromId, "s1");
  assert.match(branch.name, /分支/);
  // 原会话原样保留。
  assert.equal((adapter as any).threads.get("s1").name, "原会话");

  (adapter as any).threads.get("s1").status = "running";
  await assert.rejects(adapter.forkThread("p", "s1"), /运行/);
});

test("OpenCode fork after a turn uses the next user message as the exclusive boundary", async () => {
  const bodies: unknown[] = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/message") && !init?.method)
        return Response.json([
          { info: { id: "m1", role: "user" }, parts: [] },
          { info: { id: "a1", role: "assistant" }, parts: [] },
          { info: { id: "m2", role: "user" }, parts: [] },
        ]);
      if (value.includes("/fork") && init?.method === "POST") {
        bodies.push(init.body ? JSON.parse(String(init.body)) : undefined);
        return Response.json({ id: `branch${bodies.length}`, directory: "/work" });
      }
      return Response.json({ id: "ok" });
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode", id: "s1", providerId: "p", name: "s1",
    preview: "s1", cwd: "/work", model: "default", status: "idle", updatedAt: 1,
  });

  await adapter.forkThread("p", "s1", { lastTurnId: "m1" });
  await adapter.forkThread("p", "s1", { lastTurnId: "m2" });
  assert.deepEqual(bodies, [{ messageID: "m2" }, undefined]);
  await assert.rejects(adapter.forkThread("p", "s1", { lastTurnId: "missing" }), /找不到/);
});

test("OpenCode retryFromTurn excludes the selected user message", async () => {
  const posts: Array<{ url: string; body?: string }> = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/message") && !init?.method)
        return Response.json([
          {
            info: { id: "m1", role: "user", time: { created: 1 } },
            parts: [{ id: "p1", type: "text", text: "第一轮" }],
          },
          {
            info: { id: "m2", role: "user", time: { created: 2 } },
            parts: [{ id: "p2", type: "text", text: "第二轮" }],
          },
        ]);
      if (value.includes("/fork") && init?.method === "POST") {
        posts.push({ url: value, body: init.body ? String(init.body) : undefined });
        return Response.json({ id: "branch2", directory: "/work" });
      }
      if (value.includes("/session/branch2") && init?.method === "PATCH")
        return Response.json({ id: "branch2" });
      if (value.includes("/session/branch2/prompt_async") && init?.method === "POST") {
        posts.push({ url: value, body: init.body ? String(init.body) : undefined });
        return Response.json({ info: { id: "m3", role: "user" }, parts: [] });
      }
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode",
    id: "s1",
    providerId: "p",
    name: "原会话",
    preview: "原会话",
    cwd: "/work",
    model: "default",
    status: "idle",
    updatedAt: 1,
  });

  // OpenCode fork 的 messageID 是排除边界；替换 m2 就要传 m2 自身。
  const branch: any = await adapter.retryFromTurn("p", "s1", "m2", "改后的问法");
  assert.deepEqual(JSON.parse(posts[0].body!), { messageID: "m2" });
  assert.match(posts[1].body!, /改后的问法/);
  assert.equal(branch.forkedFromId, "s1");

  await assert.rejects(adapter.retryFromTurn("p", "s1", "mx", "x"), /找不到/);
});

test("OpenCode 首轮重试走空分支，不 revert、不碰原历史", async () => {
  const posts: string[] = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/message") && !init?.method)
        return Response.json([
          {
            info: { id: "m1", role: "user", time: { created: 1 } },
            parts: [{ id: "p1", type: "text", text: "第一轮" }],
          },
        ]);
      if (value.includes("/revert")) {
        posts.push(`revert:${value}`);
        return Response.json(true);
      }
      // 空分支：POST /session（无 fork/message 后缀；注意带 ?directory 查询参数）。
      if (
        /\/session(\?|$)/.test(value) &&
        !value.includes("/fork") &&
        !value.includes("/message") &&
        init?.method === "POST"
      ) {
        posts.push("create-empty-branch");
        return Response.json({ id: "branch3", directory: "/work" });
      }
      if (value.includes("/fork") && init?.method === "POST") {
        posts.push(`fork:${value}`);
        return Response.json({ id: "should-not-happen", directory: "/work" });
      }
      if (value.includes("/prompt_async") && init?.method === "POST")
        return Response.json({ info: { id: "m9", role: "user" }, parts: [] });
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode",
    id: "s1",
    providerId: "p",
    name: "原会话",
    preview: "原会话",
    cwd: "/work",
    model: "default",
    status: "idle",
    updatedAt: 1,
  });

  const branch: any = await adapter.retryFromTurn("p", "s1", "m1", "重问");
  assert.ok(posts.includes("create-empty-branch"));
  assert.ok(!posts.some((item) => item.startsWith("revert:")));
  assert.ok(!posts.some((item) => item.startsWith("fork:")));
  assert.equal(branch.forkedFromId, "s1");
});

test("OpenCode fork 子会话保持可见，subagent 子会话仍隐藏", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/provider") || value.includes("/config"))
        return Response.json([]);
      return Response.json([
        { id: "s1", directory: "/work", title: "原会话", time: { updated: 2 } },
        {
          id: "fork1",
          directory: "/work",
          title: "原会话 · 分支",
          parentID: "s1",
          fork: { sessionID: "s1" },
          time: { updated: 3 },
        },
        {
          id: "child1",
          directory: "/work",
          parentID: "s1",
          time: { updated: 3 },
        },
      ]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";

  await adapter.refreshAll();
  const ids = adapter.listThreads().map((thread) => thread.id);
  assert.ok(ids.includes("s1"));
  assert.ok(ids.includes("fork1"));
  assert.ok(!ids.includes("child1"));
});

test("OpenCode session.status idle 防抖：步骤间隙不闪断运行态", async () => {
  const adapter = new OpenCodeAdapter({
    idleGraceMs: 60_000,
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/provider") || value.includes("/config"))
        return Response.json([]);
      return Response.json([
        { id: "s1", directory: "/work", title: "t", time: { updated: 1 } },
      ]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();
  const thread: any = adapter.listThreads().find((item) => item.id === "s1");
  const events: any[] = [];
  adapter.on("event", (event) => events.push(event));

  (adapter as any).onEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });
  assert.equal(thread.status, "running");
  (adapter as any).onEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "retry", attempt: 1 } },
  });
  assert.equal(thread.status, "running");
  const turnId = thread.activeTurnId;
  assert.ok(turnId);

  // 步骤间隙的单个 idle 不得直接翻成 idle / 发 turn/completed。
  const before = events.length;
  (adapter as any).onEvent({
    type: "session.idle",
    properties: { sessionID: "s1" },
  });
  assert.equal(thread.status, "running");
  assert.equal(thread.activeTurnId, turnId);
  assert.equal(events.length, before);

  // 紧接着的 busy / 消息活动会取消待定的 idle。
  (adapter as any).onEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "busy" } },
  });
  assert.equal(thread.status, "running");

  // 真正结束时手动落盘，才允许 idle + turn/completed。
  (adapter as any).onEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "idle" } },
  });
  (adapter as any).flushIdleTimers();
  assert.equal(thread.status, "idle");
  assert.equal(thread.activeTurnId, undefined);
  assert.deepEqual(events.at(-1)?.data?.params?.turn, {
    id: turnId,
    status: "completed",
  });
});

test("OpenCode session.error finishes the turn and removes its pending approval", () => {
  const adapter = new OpenCodeAdapter({ idleGraceMs: 0 });
  (adapter as any).threads.set("s1", {
    agentId: "opencode", id: "s1", providerId: "p", name: "s1",
    preview: "s1", cwd: "/work", model: "default",
    status: "running", activeTurnId: "turn-1", updatedAt: 1,
  });
  const events: any[] = [];
  adapter.on("event", (event) => events.push(event));
  (adapter as any).onEvent({
    type: "permission.asked",
    properties: {
      id: "per_1", sessionID: "s1", permission: "bash",
      patterns: ["mkdir ~/learn"], metadata: {}, always: [],
    },
  });
  (adapter as any).onEvent({
    type: "session.error",
    properties: { sessionID: "s1", error: { message: "stopped" } },
  });
  assert.equal(adapter.snapshot().approvals.length, 0);
  assert.equal(adapter.listThreads()[0].status, "error");
  assert.deepEqual(events.at(-1)?.data?.params?.turn, {
    id: "turn-1", status: "failed", error: { message: "stopped" },
  });
});

test("OpenCode session.error 的 abort 按中断处理，不算失败", () => {
  const adapter = new OpenCodeAdapter({ idleGraceMs: 0 });
  (adapter as any).threads.set("s1", {
    agentId: "opencode", id: "s1", providerId: "p", name: "s1",
    preview: "s1", cwd: "/work", model: "default",
    status: "running", activeTurnId: "turn-1", updatedAt: 1,
  });
  const events: any[] = [];
  adapter.on("event", (event) => events.push(event));
  (adapter as any).onEvent({
    type: "permission.asked",
    properties: {
      id: "per_1", sessionID: "s1", permission: "bash",
      patterns: ["mkdir ~/learn"], metadata: {}, always: [],
    },
  });
  (adapter as any).onEvent({
    type: "session.error",
    properties: {
      sessionID: "s1",
      error: { name: "MessageAbortedError", data: { message: "Aborted" } },
    },
  });
  const thread = adapter.listThreads()[0];
  assert.equal(thread.status, "idle");
  assert.equal(thread.activeTurnId, undefined);
  assert.equal(thread.lastError, undefined);
  assert.equal(adapter.snapshot().approvals.length, 0);
  assert.deepEqual(events.at(-1)?.data?.params?.turn, {
    id: "turn-1", status: "interrupted",
  });
});

test("OpenCode idle 不覆盖 waiting，消息活动取消待定 idle", async () => {
  const adapter = new OpenCodeAdapter({
    idleGraceMs: 60_000,
    fetcher: (async () => Response.json([])) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode",
    id: "s1",
    providerId: "opencode:/work",
    name: "t",
    preview: "t",
    cwd: "/work",
    model: "default",
    status: "running",
    updatedAt: 1,
    activeTurnId: "turn-1",
  });
  const thread: any = (adapter as any).threads.get("s1");

  (adapter as any).onEvent({
    type: "permission.updated",
    properties: { sessionID: "s1", id: "p1", type: "edit", title: "改文件？" },
  });
  assert.equal(thread.status, "waiting");

  (adapter as any).onEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "idle" } },
  });
  assert.equal(thread.status, "waiting");

  thread.status = "running";
  (adapter as any).onEvent({
    type: "session.status",
    properties: { sessionID: "s1", status: { type: "idle" } },
  });
  assert.equal(thread.status, "running");
  (adapter as any).onEvent({
    type: "message.part.updated",
    properties: {
      sessionID: "s1",
      part: { id: "part-1", sessionID: "s1", type: "text", text: "hi" },
    },
  });
  (adapter as any).flushIdleTimers();
  // part ���ȡ�� idle��flush ���Ա��������С�
  assert.equal(thread.status, "running");
});

test("OpenCode GET retries transient fetch failures and then succeeds", async () => {
  let sessionCalls = 0;
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (new URL(value).pathname === "/session" && !init?.method) {
        sessionCalls += 1;
        if (sessionCalls <= 2) {
          const error = new TypeError("fetch failed") as any;
          error.cause = { code: "ECONNRESET", message: "socket hang up" };
          throw error;
        }
        return Response.json([{ id: "s1", directory: "/work" }]);
      }
      if (value.includes("/provider")) return Response.json({ all: {} });
      if (value.includes("/config")) return Response.json({});
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";

  await adapter.refreshAll();
  assert.equal(sessionCalls, 3);
  assert.equal(
    adapter.listThreads().find((item) => item.id === "s1")?.id,
    "s1",
  );
});

test("OpenCode GET gives up with a readable error after repeated failures", async () => {
  let sessionCalls = 0;
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (new URL(value).pathname === "/session" && !init?.method) {
        sessionCalls += 1;
        throw new TypeError("fetch failed");
      }
      if (value.includes("/provider")) return Response.json({ all: {} });
      if (value.includes("/config")) return Response.json({});
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";

  await assert.rejects(adapter.refreshAll(), /连接闪断/);
  assert.equal(sessionCalls, 3);
});

test("OpenCode POST is never retried so turns cannot be sent twice", async () => {
  let posts = 0;
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      if (String(url).includes("/prompt_async") && init?.method === "POST") {
        posts += 1;
        throw new TypeError("fetch failed");
      }
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode",
    id: "s1",
    providerId: "p",
    name: "s1",
    preview: "s1",
    cwd: "/work",
    model: "default",
    status: "idle",
    updatedAt: 1,
  });

  await assert.rejects(adapter.sendTurn("p", "s1", "hi"), /连接闪断/);
  assert.equal(posts, 1);
});

test("OpenCode HTTP status errors are not retried", async () => {
  let sessionCalls = 0;
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (new URL(value).pathname === "/session" && !init?.method) {
        sessionCalls += 1;
        return new Response("boom", { status: 500 });
      }
      if (value.includes("/provider")) return Response.json({ all: {} });
      if (value.includes("/config")) return Response.json({});
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";

  await assert.rejects(adapter.refreshAll(), /OpenCode API 500/);
  assert.equal(sessionCalls, 1);
});

test("OpenCode request aborts a hung connection instead of waiting forever", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: ((url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("The operation was aborted", "AbortError")),
        );
      })) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";

  await assert.rejects(
    (adapter as any).request("/session", { retry: false, timeoutMs: 20 }),
    /连接闪断/,
  );
});


test("OpenCode crash recovery releases queued messages on the original session exactly once", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-serve-recovery-"));
  const children: any[] = [];
  const prompts: any[] = [];
  const adapter = new OpenCodeAdapter({
    port: 4096,
    spawnProcess: () => {
      const child = new EventEmitter() as any;
      child.stderr = new EventEmitter();
      child.kill = () => true;
      children.push(child);
      return child;
    },
    fetcher: (async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/global/health") return Response.json({ healthy: true });
      if (pathname === "/session") return Response.json([
        { id: "recovery-session", directory: "/work", title: "Recovery", time: { updated: 1 } },
      ]);
      if (pathname === "/provider") return Response.json({ all: {} });
      if (pathname.endsWith("/prompt_async")) {
        prompts.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 204 });
      }
      return Response.json({});
    }) as typeof fetch,
  });
  const registry = new AgentRegistry([adapter]);
  const queue = new MessageDeliveryQueue({ file: path.join(dir, "messages.json"), agents: registry, timer: false });
  t.after(async () => {
    queue.close();
    adapter.restart();
    await rm(dir, { recursive: true, force: true });
  });
  await queue.load();
  await adapter.startAll();
  await queue.enqueue("opencode", "recovery-session", "queue", { text: "original request" });
  await queue.tick();
  assert.equal(prompts.length, 1);
  // Simulate a process dying during a turn, including stale compaction state.
  const thread = adapter.listThreads()[0];
  thread.compacting = true;
  children[0].emit("exit", null, "SIGTERM");
  assert.equal(thread.status, "offline");
  assert.equal(thread.activeTurnId, undefined);
  await queue.enqueue("opencode", thread.id, "queue", { text: "continue after checking files" });
  await queue.tick();
  assert.equal(queue.list()[1].status, "queued");
  assert.equal(prompts.length, 1);

  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(children.length, 2, "unexpected exit must restart serve");
  assert.equal(adapter.descriptor().online, true);
  assert.equal(registry.messageState("opencode", thread.id).ready, true);
  await queue.tick();
  assert.equal(queue.list()[1].status, "delivered");
  assert.equal(queue.list()[1].disposition, "started");
  assert.equal(prompts.length, 2, "old accepted request must not be replayed");
  assert.equal(prompts[1].parts[0].text, "continue after checking files");
  await queue.tick();
  assert.equal(prompts.length, 2, "queued request must only be sent once");
});

test("OpenCode explicit shutdown cancels crash recovery", async (t) => {
  const adapter = new OpenCodeAdapter();
  t.after(() => adapter.restart());
  let starts = 0;
  adapter.startAll = async () => { starts++; };
  (adapter as any).scheduleRecovery();
  adapter.restart();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(starts, 0);
});


test("OpenCode automatic recovery stops after three failed attempts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = new OpenCodeAdapter();
  t.after(() => adapter.restart());
  let starts = 0;
  adapter.startAll = async () => { starts++; throw new Error("demo unavailable"); };
  (adapter as any).scheduleRecovery();
  for (const delay of [1_000, 2_000, 4_000]) {
    t.mock.timers.tick(delay - 1);
    assert.equal(starts, [1_000, 2_000, 4_000].indexOf(delay));
    t.mock.timers.tick(1);
    await Promise.resolve();
    await Promise.resolve();
  }
  t.mock.timers.tick(60_000);
  assert.equal(starts, 3);
});


test("OpenCode shutdown during a failed recovery does not schedule another restart", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const adapter = new OpenCodeAdapter();
  t.after(() => adapter.restart());
  let starts = 0;
  let rejectStart!: (error: Error) => void;
  adapter.startAll = () => {
    starts++;
    return new Promise<void>((_resolve, reject) => { rejectStart = reject; });
  };
  (adapter as any).scheduleRecovery();
  t.mock.timers.tick(1_000);
  adapter.restart();
  rejectStart(new Error("demo unavailable"));
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(60_000);
  assert.equal(starts, 1);
});

test("OpenCode stamps tool timings and per-turn stats with TPS", async () => {
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/config")) return Response.json({});
      if (value.includes("/provider"))
        return Response.json({ all: {}, connected: [] });
      if (value.includes("/message"))
        return Response.json([
          {
            info: { id: "m1", role: "user", time: { created: 1_000 } },
            parts: [{ id: "p1", type: "text", text: "做点事" }],
          },
          {
            info: {
              id: "m2",
              role: "assistant",
              providerID: "a",
              modelID: "m",
              time: { created: 1_100, completed: 3_100 },
              tokens: {
                input: 100,
                output: 80,
                reasoning: 20,
                cache: { read: 0, write: 0 },
              },
            },
            parts: [
              {
                id: "r1",
                type: "reasoning",
                text: "先看一眼",
                time: { start: 1_100, end: 1_900 },
              },
              {
                id: "t1",
                type: "tool",
                tool: "bash",
                state: {
                  status: "completed",
                  input: { command: "ls" },
                  output: "ok",
                  time: { start: 1_200, end: 2_000 },
                },
              },
              {
                id: "p2",
                type: "text",
                text: "done",
                time: { start: 2_100, end: 3_000 },
              },
            ],
          },
        ]);
      return Response.json([{ id: "s1", directory: "/work" }]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();

  const loaded: any = await adapter.readThread("p", "s1");
  assert.equal(loaded.turns.length, 1);
  const turn = loaded.turns[0];
  assert.deepEqual(turn.stats, {
    startedAt: 1_000,
    endedAt: 3_100,
    durationMs: 2_100,
    outputTokens: 100,
    tps: 47.6,
  });
  const tool = turn.items.find((item: any) => item.id === "t1");
  assert.equal(tool.startedAt, 1_200);
  assert.equal(tool.endedAt, 2_000);
  const text = turn.items.find((item: any) => item.id === "p2");
  assert.equal(text.startedAt, 2_100);
  assert.equal(text.endedAt, 3_000);
  // per-part stats：reasoning 认领 tokens.reasoning，text 认领 tokens.output。
  const reasoning = turn.items.find((item: any) => item.id === "r1");
  assert.deepEqual(reasoning.stats, {
    durationMs: 800,
    outputTokens: 20,
    tps: 25,
  });
  assert.deepEqual(text.stats, {
    durationMs: 900,
    outputTokens: 80,
    tps: 88.9,
  });

});

test("OpenCode emits throttled turn/progress while the turn runs", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/config")) return Response.json({});
      if (value.includes("/provider"))
        return Response.json({ all: {}, connected: [] });
      return Response.json([{ id: "s1", directory: "/work" }]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();
  const thread: any = adapter.listThreads().find((item) => item.id === "s1");
  thread.status = "running";
  thread.activeTurnId = "turn-1";

  const events: any[] = [];
  adapter.on("event", (event) => events.push(event));
  const updated = (id: string, output: number) =>
    (adapter as any).onEvent({
      type: "message.updated",
      properties: {
        sessionID: "s1",
        info: { id, sessionID: "s1", role: "assistant", tokens: { output, reasoning: 0 } },
      },
    });
  const progress = () =>
    events.filter((event) => event?.data?.method === "turn/progress");
  // mock 时钟可能从 0 起跳：先走 2 秒，保证首样本越过 1 秒节流窗。
  t.mock.timers.tick(2_000);
  updated("a1", 10);
  updated("a1", 25);
  updated("a2", 5);
  // 首个样本立即推送，1 秒内后续样本被节流。
  assert.equal(progress().length, 1);
  assert.equal(progress()[0].data.params.outputTokens, 10);
  // 1 秒后按 messageId 去重累计再推一次。
  t.mock.timers.tick(1_500);
  updated("a2", 7);
  assert.equal(progress().length, 2);
  const second = progress()[1].data.params;
  assert.equal(second.threadId, "s1");
  assert.equal(second.turnId, "turn-1");
  assert.equal(second.outputTokens, 32);
  assert.equal(second.elapsedMs, 1_500);
});

test("OpenCode forwards per-part stats when a reasoning/text part completes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url) => {
      const value = String(url);
      if (value.includes("/config")) return Response.json({});
      if (value.includes("/provider"))
        return Response.json({ all: {}, connected: [] });
      return Response.json([{ id: "s1", directory: "/work" }]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await adapter.refreshAll();
  const thread: any = adapter.listThreads().find((item) => item.id === "s1");
  thread.status = "running";
  thread.activeTurnId = "turn-1";

  const events: any[] = [];
  adapter.on("event", (event) => events.push(event));
  const partUpdated = (part: any) =>
    (adapter as any).onEvent({
      type: "message.part.updated",
      properties: { sessionID: "s1", part },
    });
  const itemUpdates = () =>
    events
      .filter((event) => event?.data?.method === "item/updated")
      .map((event) => event.data.params.item);
  t.mock.timers.tick(2_000);

  // usage 落在 part 完成之前：message.updated 已送出 tokens。
  (adapter as any).onEvent({
    type: "message.updated",
    properties: {
      sessionID: "s1",
      info: { id: "m1", sessionID: "s1", role: "assistant", tokens: { output: 300, reasoning: 100 } },
    },
  });
  partUpdated({
    id: "r1",
    type: "reasoning",
    messageID: "m1",
    text: "想一下",
    time: { start: 1_000, end: 1_500 },
  });
  assert.deepEqual(itemUpdates()[0]?.stats, {
    durationMs: 500,
    outputTokens: 100,
    tps: 200,
  });
  partUpdated({
    id: "p1",
    type: "text",
    messageID: "m1",
    text: "回话",
    time: { start: 1_600, end: 3_100 },
  });
  assert.deepEqual(itemUpdates()[1]?.stats, {
    durationMs: 1_500,
    outputTokens: 300,
    tps: 200,
  });
  // 没 tokens（无法认领）时保持原样，不编造 stats。
  partUpdated({
    id: "p2",
    type: "text",
    messageID: "mX",
    text: "unknown",
    time: { start: 1_000, end: 2_000 },
  });
  assert.equal(itemUpdates()[2]?.stats, undefined);
});

test("OpenCode interrupt validates the turn and fails fast with a retryable error", async () => {
  const calls: string[] = [];
  let failAbort = false;
  const adapter = new OpenCodeAdapter({
    initialThreads: [{
      id: "t", agentId: "opencode", providerId: "p", name: "test",
      preview: "", cwd: "/tmp", model: "default",
      status: "running", activeTurnId: "turn-1", updatedAt: 1,
    }],
    fetcher: (async (url) => {
      calls.push(String(url));
      if (String(url).includes("/abort") && failAbort)
        return Response.json({ error: "down" }, { status: 500 });
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";

  // 打错轮：直接拒绝，一次 abort 都不发，避免误杀新轮。
  await assert.rejects(adapter.interrupt("p", "t", "stale-turn"), /被新轮接管/);
  assert.equal(calls.length, 0);

  // abort 发不出去：抛可重试的明确错误，本地 running 原样保留等事件纠正。
  failAbort = true;
  await assert.rejects(adapter.interrupt("p", "t", "turn-1"), /停止请求发送失败/);
  assert.equal((adapter as any).threads.get("t").status, "running");
  assert.equal((adapter as any).threads.get("t").activeTurnId, "turn-1");

  // 正常打断：一次 abort 即返回。
  failAbort = false;
  await adapter.interrupt("p", "t", "turn-1");
  assert.equal(calls.filter((url) => url.includes("/abort")).length, 2);
});

test("OpenCode watchdog reconciles a silent running thread", async () => {
  const events: Array<{ type: string; data: any }> = [];
  const states: Record<string, { type: string }> = {
    t: { type: "idle" },
    t2: { type: "busy" },
  };
  const thread = (id: string) => ({
    id, agentId: "opencode", providerId: "p", name: "test",
    preview: "", cwd: "/tmp", model: "default",
    status: "running", activeTurnId: "turn-1", updatedAt: 1,
  });
  const adapter = new OpenCodeAdapter({
    initialThreads: [thread("t"), thread("t2")],
    fetcher: (async (url) => {
      if (String(url).includes("/session/status")) return Response.json(states);
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  adapter.on("event", (event: any) => events.push(event));
  const stale = () => Date.now() - 61_000;
  (adapter as any).beginRunningTurn((adapter as any).threads.get("t"), "turn-1");
  (adapter as any).runningTurns.get("t").lastEventAt = stale();
  (adapter as any).beginRunningTurn((adapter as any).threads.get("t2"), "turn-1");
  (adapter as any).runningTurns.get("t2").lastEventAt = stale();

  await (adapter as any).watchRunningTurns();

  // serve 明确 idle：本地归位，旧轮闭环。
  assert.equal((adapter as any).threads.get("t").status, "idle");
  assert.ok(events.some((event) => event.type === "agent.event" &&
    event.data?.method === "turn/completed" &&
    event.data?.params?.turn?.id === "turn-1"),
    "看门狗归位必须补发 turn/completed");
  // serve 还在跑：只续命，不碰状态。
  assert.equal((adapter as any).threads.get("t2").status, "running");
  assert.ok((adapter as any).runningTurns.get("t2").lastEventAt > stale());
});

test("OpenCode session.error clears turn tracking", async () => {
  const adapter = new OpenCodeAdapter({
    initialThreads: [{
      id: "t", agentId: "opencode", providerId: "p", name: "test",
      preview: "", cwd: "/tmp", model: "default",
      status: "running", activeTurnId: "turn-1", updatedAt: 1,
    }],
    fetcher: (async () => new Response(null, { status: 204 })) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).runningTurns.set("t", { turnId: "turn-1", startedAt: 1, lastEventAt: 1, outputs: new Map(), lastEmitAt: 0 });

  (adapter as any).onEvent({ payload: { type: "session.error", properties: { sessionID: "t", error: { message: "boom" } } } });

  assert.equal((adapter as any).threads.get("t").status, "error");
  assert.equal((adapter as any).runningTurns.has("t"), false);
});

test("OpenCode session.deleted purges approvals and turn tracking", async () => {
  const events: Array<{ type: string; data: any }> = [];
  const adapter = new OpenCodeAdapter({
    initialThreads: [{
      id: "t", agentId: "opencode", providerId: "p", name: "test",
      preview: "", cwd: "/tmp", model: "default",
      status: "waiting", activeTurnId: "turn-1", updatedAt: 1,
    }],
    fetcher: (async () => new Response(null, { status: 204 })) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  adapter.on("event", (event: any) => events.push(event));
  // 挂起审批 + 在途 turn 跟踪：删除前故意残留。
  (adapter as any).approvals.set("a1", { id: "a1", sessionID: "t", requestId: "r1", cwd: "/tmp" });
  (adapter as any).runningTurns.set("t", { turnId: "turn-1", startedAt: 1, lastEventAt: 1, outputs: new Map(), lastEmitAt: 0 });

  (adapter as any).onEvent({ payload: { type: "session.deleted", properties: { sessionID: "t" } } });

  assert.equal((adapter as any).threads.has("t"), false);
  assert.equal((adapter as any).approvals.size, 0);
  assert.equal((adapter as any).runningTurns.has("t"), false);
  assert.ok(events.some((event) => event.type === "approval.resolved"),
    "挂起审批必须撤掉并广播 approval.resolved，否则审批卡片永远消不掉");
  assert.ok(events.some((event) => event.type === "thread.deleted"),
    "会话删除必须广播 thread.deleted");
});

function forkFixture(options: { failPersist?: boolean } = {}) {
  const saved = new Map<string, any>();
  const calls: Array<{ method: string; url: string }> = [];
  const sessions = [
    { id: "s1", directory: "/work", title: "parent" },
    // 子会话：旧版 serve 不带 fork 字段，只有 parentID。
    { id: "b1", directory: "/work", title: "parent · 分支", parentID: "s1" },
  ];
  const adapter = new OpenCodeAdapter({
    threadSettings: {
      get: (agent: string, id: string) => saved.get(`${agent}:${id}`),
      update: async (agent: string, id: string, next: any) => {
        if (options.failPersist) throw new Error("disk full");
        const key = `${agent}:${id}`;
        const merged = { ...(saved.get(key) || {}), ...next };
        saved.set(key, merged);
        return merged;
      },
    } as any,
    fetcher: (async (url, init) => {
      const value = String(url);
      const method = init?.method || "GET";
      calls.push({ method, url: value });
      if (value.includes("/session/s1/fork") && method === "POST")
        return Response.json({ id: "b1", directory: "/work" });
      if (value.includes("/session/b1") && (method === "PATCH" || method === "DELETE"))
        return Response.json({});
      if (value.includes("/message")) return Response.json([]);
      if (value.includes("/session") && method === "GET") return Response.json(sessions);
      if (value.includes("/provider")) return Response.json({ all: {}, connected: [] });
      if (value.includes("/config")) return Response.json({});
      return Response.json([]);
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  (adapter as any).threads.set("s1", {
    agentId: "opencode", id: "s1", providerId: "p", name: "parent",
    preview: "parent", cwd: "/work", model: "openai/gpt-5",
    reasoningEffort: "high", status: "idle", updatedAt: 1,
  });
  return { adapter, saved, calls };
}

test("OpenCode fork persists the branch relation and survives a restart", async () => {
  const { adapter, saved } = forkFixture();
  const branch: any = await adapter.forkThread("p", "s1", {});
  assert.equal(branch.id, "b1");
  assert.equal(branch.model, "openai/gpt-5");
  assert.equal(branch.forkedFromId, "s1");
  assert.equal(saved.get("opencode:b1")?.forkedFromId, "s1");
  assert.equal(saved.get("opencode:b1")?.model, "openai/gpt-5");

  // 模拟重启：内存全清，仅凭 serve 列表（无 fork 字段）+ 落盘关系恢复。
  (adapter as any).threads.clear();
  (adapter as any).forkChildren.clear();
  await adapter.refreshAll();
  const ids = adapter.listThreads().map((thread) => thread.id);
  assert.ok(ids.includes("s1") && ids.includes("b1"),
    "重启后分支必须仍可见，不能被当 subagent 隐藏");
  assert.equal(
    (adapter.listThreads().find((thread) => thread.id === "b1") as any)?.forkedFromId,
    "s1",
  );
});

test("OpenCode fork rolls back the native branch when persistence fails", async () => {
  const { adapter, calls } = forkFixture({ failPersist: true });
  await assert.rejects(adapter.forkThread("p", "s1", {}), /本地保存失败/);
  assert.equal((adapter as any).threads.has("b1"), false);
  assert.equal((adapter as any).forkChildren.has("b1"), false);
  assert.ok(
    calls.some((call) => call.method === "DELETE" && call.url.includes("/session/b1")),
    "落盘失败必须删除原生分支，否则重试越堆越多",
  );
});
test("OpenCode body consumption stays within the request deadline", async () => {
  let attempts = 0;
  const adapter = new OpenCodeAdapter({
    fetcher: (async (_url, init) => {
      attempts++;
      return {
        ok: true, status: 200,
        json: () => new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
      } as Response;
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  await assert.rejects(
    (adapter as any).request("/session/demo/message", { retry: false, timeoutMs: 20 }),
    /连接闪断/,
  );
  assert.equal(attempts, 1);
});

test("OpenCode retries interrupted bodies, not just connection failures", async () => {
  let attempts = 0;
  const adapter = new OpenCodeAdapter({
    fetcher: (async () => {
      attempts++;
      if (attempts === 1) return {
        ok: true, status: 200,
        json: async () => { throw new TypeError("terminated"); },
      } as unknown as Response;
      return Response.json({ ok: true });
    }) as typeof fetch,
  });
  (adapter as any).baseUrl = "http://127.0.0.1:4096";
  assert.deepEqual(await (adapter as any).request("/session/demo/message"), { ok: true });
  assert.equal(attempts, 2);
});

test("OpenCode shares concurrent message reads and releases them after success or failure", async () => {
  let resolve!: (response: Response) => void;
  let calls = 0;
  const adapter = new OpenCodeAdapter({
    fetcher: (() => {
      calls++;
      return new Promise<Response>((done) => { resolve = done; });
    }) as typeof fetch,
  });
  const internal = adapter as any;
  internal.baseUrl = "http://127.0.0.1:4096";
  const thread = { id: "demo", cwd: "/work" };
  const first = internal.readMessages(thread);
  const second = internal.readMessages(thread);
  assert.equal(calls, 1);
  resolve(Response.json([]));
  assert.deepEqual(await first, await second);
  const third = internal.readMessages(thread);
  assert.equal(calls, 2);
  resolve(new Response("unavailable", { status: 400 }));
  await assert.rejects(third, /400/);
  const fourth = internal.readMessages(thread);
  assert.equal(calls, 3);
  resolve(Response.json([]));
  await fourth;
});

test("OpenCode fork reuses validated boundaries and refetches changed native history", async () => {
  let updated = 10;
  let messageReads = 0;
  let boundary = "";
  const records = ["u1", "u2"].map((id) => ({ info: { id, role: "user" }, parts: [] }));
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("/message")) {
        messageReads++;
        return Response.json(records);
      }
      if (pathname.endsWith("/fork")) {
        boundary = JSON.parse(String(init?.body)).messageID;
        return Response.json({ id: "branch", directory: "/work" });
      }
      return Response.json({ id: "demo", directory: "/work", time: { updated } });
    }) as typeof fetch,
  });
  const internal = adapter as any;
  internal.baseUrl = "http://127.0.0.1:4096";
  internal.threads.set("demo", {
    id: "demo", agentId: "opencode", cwd: "/work", name: "demo",
    providerId: "acme", model: "default", status: "idle", updatedAt: 1,
  });
  internal.projectCatalogs.set("/work", { profiles: [], connected: new Set() });
  await adapter.readThread("acme", "demo");
  await adapter.forkThread("acme", "demo", { lastTurnId: "u1" });
  assert.equal(messageReads, 1, "unchanged history must not be downloaded again");
  assert.equal(boundary, "u2");
  updated++;
  records.splice(1, 0, { info: { id: "inserted", role: "user" }, parts: [] });
  await adapter.forkThread("acme", "demo", { lastTurnId: "u1" });
  assert.equal(messageReads, 2);
  assert.equal(boundary, "inserted", "changed native history must define the boundary");
});

test("OpenCode events invalidate in-flight reads and cached fork boundaries", async () => {
  const resolvers: Array<(response: Response) => void> = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (() => new Promise<Response>((resolve) => resolvers.push(resolve))) as typeof fetch,
  });
  const internal = adapter as any;
  internal.baseUrl = "http://127.0.0.1:4096";
  const thread = { id: "demo", cwd: "/work" };
  internal.historyBoundaries.set("demo", { userIds: ["old"] });
  const old = internal.readMessages(thread);
  internal.onEvent({ type: "message.removed", properties: { sessionID: "demo" } });
  assert.equal(internal.historyBoundaries.size, 0);
  const fresh = internal.readMessages(thread);
  assert.equal(resolvers.length, 2);
  resolvers[0](Response.json(["old"]));
  await old;
  assert.equal(internal.messageReads.size, 1, "old completion must not clear the fresh read");
  resolvers[1](Response.json(["fresh"]));
  assert.deepEqual(await fresh, ["fresh"]);
  assert.equal(internal.messageReads.size, 0);
});

test("OpenCode successful fork survives a stalled auxiliary title update", async () => {
  let renameAborted = false;
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      if (init?.method === "PATCH")
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            renameAborted = true;
            reject(new DOMException("aborted", "AbortError"));
          }, { once: true });
        });
      return Response.json({ id: "branch", directory: "/work" });
    }) as typeof fetch,
  });
  const internal = adapter as any;
  internal.baseUrl = "http://127.0.0.1:4096";
  internal.threads.set("demo", {
    id: "demo", agentId: "opencode", cwd: "/work", name: "demo",
    providerId: "acme", model: "default", status: "idle", updatedAt: 1,
  });
  const branch = await adapter.forkThread("acme", "demo");
  assert.equal(renameAborted, true);
  assert.equal(branch.id, "branch");
  assert.equal(branch.forkedFromId, "demo");
  assert.equal(branch.name, "demo · 分支");
});

function pagedFixture() {
  const records: any[] = [];
  for (let turn = 0; turn < 16; turn++) {
    records.push({ info: { id: `u${turn}`, role: "user" }, parts: [{ type: "text", text: `request ${turn}` }] });
    const steps = turn === 15 ? 80 : 6;
    for (let step = 0; step < steps; step++) records.push({
      info: { id: `a${turn}-${step}`, role: "assistant", providerID: "acme", modelID: "demo" },
      parts: [{ id: `p${turn}-${step}`, type: "text", text: `reply ${turn}-${step}` }],
    });
  }
  return records;
}

function pagedAdapter(records: any[], queries: number[], revert?: string) {
  const adapter = new OpenCodeAdapter({ fetcher: (async (url) => {
    const request = new URL(String(url));
    if (request.pathname.endsWith("/message")) {
      const limit = Number(request.searchParams.get("limit"));
      queries.push(limit);
      return Response.json(limit ? records.slice(-limit) : records);
    }
    return Response.json({ id: "demo", directory: "/work", time: { updated: 10 },
      ...(revert ? { revert: { messageID: revert } } : {}),
    });
  }) as typeof fetch });
  const internal = adapter as any;
  internal.baseUrl = "http://127.0.0.1:4096";
  internal.threads.set("demo", {
    id: "demo", agentId: "opencode", cwd: "/work", name: "original name",
    providerId: "acme", model: "default", status: "idle", updatedAt: 1,
  });
  internal.projectCatalogs.set("/work", { profiles: [], connected: new Set() });
  return adapter;
}

test("OpenCode native tail pagination retains complete turns with many assistant steps", async () => {
  const queries: number[] = [];
  const adapter = pagedAdapter(pagedFixture(), queries);
  const full: any = await adapter.readThread("acme", "demo", { turnLimit: 2 });
  assert.deepEqual(queries, [32, 64, 128]);
  assert.deepEqual(full.turns.map((turn: any) => turn.id), ["u14", "u15"]);
  assert.equal(full.turns[1].items.length, 81, "the latest turn must include all assistant steps");
  assert.equal(full.hasMoreTurns, true);
  assert.equal(full.__cachedTailOmitted, 1);
  assert.equal(full.totalTurns, undefined, "do not invent the number of unseen turns");
  assert.equal((adapter as any).threads.get("demo").name, "original name");
});

test("OpenCode full reads remain complete for search and reverted histories bypass native tail limits", async () => {
  const records = pagedFixture();
  const fullQueries: number[] = [];
  const full: any = await pagedAdapter(records, fullQueries).readThread("acme", "demo");
  assert.deepEqual(fullQueries, [0]);
  assert.equal(full.turns.length, 16);
  const revertQueries: number[] = [];
  const reverted: any = await pagedAdapter(records, revertQueries, "u14")
    .readThread("acme", "demo", { turnLimit: 2 });
  assert.deepEqual(revertQueries, [0]);
  assert.equal(reverted.turns.length, 14);
  assert.equal(reverted.turns.at(-1).id, "u13");
});

test("OpenCode single-turn detail reads avoid downloading unrelated old history", async () => {
  const queries: number[] = [];
  const adapter = pagedAdapter(pagedFixture(), queries);
  const turn: any = await adapter.readTurn("acme", "demo", "u15");
  assert.deepEqual(queries, [32, 64, 128]);
  assert.equal(turn.id, "u15");
  assert.equal(turn.items.length, 81);
  await assert.rejects(adapter.readTurn("acme", "demo", "missing"), /找不到/);
});

test("OpenCode duplicate delete requests share one native mutation", async () => {
  let resolve!: (response: Response) => void;
  let calls = 0;
  const adapter = pagedAdapter([], []);
  (adapter as any).fetcher = (() => {
    calls++;
    return new Promise<Response>((done) => { resolve = done; });
  }) as typeof fetch;
  const first = adapter.deleteThread("acme", "demo");
  const second = adapter.deleteThread("acme", "demo");
  assert.equal(first, second);
  assert.equal(calls, 1);
  await assert.rejects(adapter.forkThread("acme", "demo"), /正在删除/);
  resolve(Response.json(true));
  await first;
  assert.equal((adapter as any).threads.has("demo"), false);
});

test("OpenCode duplicate forks share one native branch and reject conflicting boundaries", async () => {
  const adapter = pagedAdapter([], []);
  let resolve!: (response: Response) => void;
  let forks = 0;
  (adapter as any).fetcher = (async (_url: any, init: RequestInit) => {
    if (init?.method === "POST") {
      forks++;
      return new Promise<Response>((done) => { resolve = done; });
    }
    return Response.json({ id: "branch", directory: "/work" });
  }) as typeof fetch;
  const first = adapter.forkThread("acme", "demo", { messageID: "u2" });
  const second = adapter.forkThread("acme", "demo", { messageID: "u2" });
  assert.equal(first, second);
  await assert.rejects(adapter.forkThread("acme", "demo", { messageID: "u3" }), /正在创建分支/);
  assert.equal(forks, 1);
  await assert.rejects(adapter.deleteThread("acme", "demo"), /正在创建分支/);
  resolve(Response.json({ id: "branch", directory: "/work" }));
  assert.equal((await first).id, "branch");
});

test("OpenCode cursor pages do not download overlapping tool history", async () => {
  const records = pagedFixture();
  const queries: string[] = [];
  let transferred = 0;
  const adapter = pagedAdapter(records, []);
  (adapter as any).fetcher = (async (url: any) => {
    const request = new URL(String(url));
    if (!request.pathname.endsWith("/message")) return Response.json({ id: "demo", time: { updated: 10 } });
    queries.push(request.search);
    const end = Number(request.searchParams.get("before")) || records.length;
    const limit = Number(request.searchParams.get("limit"));
    const start = Math.max(0, end - limit);
    const page = records.slice(start, end);
    transferred += page.length;
    return Response.json(page, { headers: start ? { "x-next-cursor": String(start) } : {} });
  }) as typeof fetch;
  const full: any = await adapter.readThread("acme", "demo", { turnLimit: 2 });
  assert.equal(queries.length, 3);
  assert.equal(transferred, 96, "three pages must transfer each message only once");
  assert.ok(queries[1].includes("before="));
  assert.deepEqual(full.turns.map((turn: any) => turn.id), ["u14", "u15"]);
  assert.equal(full.turns[1].items.length, 81);
});

test("OpenCode cold model catalogs never block the transcript", async () => {
  const adapter = pagedAdapter(pagedFixture(), []);
  const internal = adapter as any;
  internal.projectCatalogs.clear();
  const fetcher = internal.fetcher;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  internal.fetcher = async (url: any, init: any) => {
    if (/\/(provider|config)(\?|$)/.test(String(url))) {
      await gate;
      return Response.json({});
    }
    return fetcher(url, init);
  };
  const read = adapter.readThread("acme", "demo", { turnLimit: 2 });
  try {
    const settled = await Promise.race([
      read.then(() => true), new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
    assert.equal(settled, true, "catalog resolution must not participate in the read barrier");
  } finally { release(); await read; }
});


test("OpenCode cold fork boundaries use bounded native history and preserve the next user boundary", async () => {
  const queries: number[] = [];
  const records = Array.from({ length: 1000 }, (_, i) => ({
    info: { id: `u${i}`, role: "user" }, parts: [],
  }));
  const adapter = pagedAdapter(records, queries);
  const internal = adapter as any;
  const ids = await internal.forkUserIds(internal.threads.get("demo"), "u990");
  assert.deepEqual(queries, [32]);
  assert.equal(ids[ids.indexOf("u990") + 1], "u991");
  assert.equal(ids.at(-1), "u999");
  assert.equal(ids.length, 32, "do not download the entire cold history for a recent fork");
});


test("OpenCode fork replay coalesces copied history without forwarding old assistant bodies", async () => {
  const adapter = pagedAdapter([], []);
  const internal = adapter as any;
  const events: any[] = [];
  adapter.on("event", (event) => events.push(event));
  internal.onEvent({ type: "session.created", properties: { info: {
    id: "demo", directory: "/work", time: { created: 2000, updated: 2000 },
  } } });
  events.length = 0;
  for (let i = 0; i < 1000; i++) {
    internal.onEvent({ type: "message.updated", properties: { sessionID: "demo",
      info: { id: `copied${i}`, role: "assistant", time: { created: 1000 } },
    } });
    internal.onEvent({ type: "message.part.updated", properties: { sessionID: "demo",
      part: { id: `p${i}`, messageID: `copied${i}`, type: "text", text: "x".repeat(8192) },
    } });
  }
  assert.equal(events.length, 0, "copied bodies must not be broadcast as live output");
  assert.equal(internal.copiedHistoryTimers.size, 1);
  assert.ok(internal.copiedMessages.size <= 400);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(events.length, 1);
  assert.equal(events[0].data.method, "thread/historyUpdated");
  assert.deepEqual(events[0].data.params, { threadId: "demo" });
  assert.ok(JSON.stringify(events).length < 300);
  // A new assistant message in the same branch is still delivered normally.
  internal.onEvent({ type: "message.updated", properties: { sessionID: "demo",
    info: { id: "new", role: "assistant", time: { created: 2001 } },
  } });
  internal.onEvent({ type: "message.part.updated", properties: { sessionID: "demo",
    part: { id: "new-part", messageID: "new", type: "text", text: "new reply" },
  } });
  assert.equal(events.at(-1).data.method, "item/updated");
  assert.equal(events.at(-1).data.params.item.text, "new reply");
  // A running turn must retain live updates even with an old timestamp.
  internal.threads.get("demo").activeTurnId = "active";
  internal.onEvent({ type: "message.updated", properties: { sessionID: "demo",
    info: { id: "running", role: "assistant", time: { created: 1000 } },
  } });
  internal.onEvent({ type: "message.part.updated", properties: { sessionID: "demo",
    part: { id: "running-part", messageID: "running", type: "text", text: "live reply" },
  } });
  assert.equal(events.at(-1).data.params.item.text, "live reply");
  internal.endRunningTurn("demo");
});

test("OpenCode deleting a copied branch cancels its deferred history notification", async () => {
  const adapter = pagedAdapter([], []);
  const internal = adapter as any;
  const events: any[] = [];
  adapter.on("event", (event) => events.push(event));
  internal.onEvent({ type: "session.created", properties: { info: {
    id: "demo", directory: "/work", time: { created: 2000 },
  } } });
  internal.onEvent({ type: "message.updated", properties: { sessionID: "demo",
    info: { id: "old", role: "assistant", time: { created: 1000 } },
  } });
  internal.onEvent({ type: "session.deleted", properties: { sessionID: "demo" } });
  assert.equal(internal.copiedHistoryTimers.size, 0);
  assert.equal(internal.copiedMessages.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(events.some((event) => event.data?.method === "thread/historyUpdated"), false);
});
