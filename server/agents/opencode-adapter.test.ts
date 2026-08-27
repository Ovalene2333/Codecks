import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { OpenCodeAdapter } from "./opencode-adapter.js";

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
