import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { openCodePartToItem, OpenCodeAdapter } from "./opencode-adapter.js";

test("OpenCode adapter binds provider models and preserves the completed turn id", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      calls.push({ url: value, init });
      if (value.includes("/config"))
        return Response.json({
          model: { providerID: "openai", modelID: "gpt-5" },
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

test("OpenCode adapter rejects image attachments on text-only models", async () => {
  const messagePosts: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.includes("/message") && init?.method === "POST") {
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
    ["low", "medium", "high"],
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
      if (value.includes("/message") && init?.method === "POST") {
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

  // An effort the model does not advertise is dropped instead of rejected.
  const sent = (adapter as any).threads.get("s1");
  sent.status = "idle";
  sent.activeTurnId = undefined;
  await adapter.updateThreadSettings("openai", "s1", {
    reasoningEffort: "ultra",
  });
  await adapter.sendTurn("openai", "s1", "继续");
  assert.equal(JSON.parse(String(posts.at(-1)?.body)).variant, undefined);
  assert.equal(posts.length, 2);
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
        if (value.includes("/message") && init?.method === "POST") return Response.json({ id: "msg" });
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
  const adapter = new OpenCodeAdapter({
    fetcher: (async (url, init) => {
      const value = String(url);
      if (value.endsWith("/command") && !init?.method)
        return Response.json([
          { name: "init", description: "Setup AGENTS.md" },
          { command: "deploy" },
          "plain",
        ]);
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
  });

  await adapter.compactSession("p", "s1");
  assert.deepEqual(JSON.parse(posts[0].body!), {
    providerID: "openai",
    modelID: "gpt-5",
  });
  assert.equal((adapter.listThreads()[0] as any)?.compacting, undefined);

  (adapter as any).threads.get("s1").status = "running";
  await assert.rejects(adapter.compactSession("p", "s1"), /任务结束后/);
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
