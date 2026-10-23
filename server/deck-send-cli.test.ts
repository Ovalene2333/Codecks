import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

test("every endpoint referenced by the deck-api script exists on the server", async () => {
  // CLI 的接口路径与服务端路由各自演进时曾静默脱节（sessions 打到不存在的
  // /api/deck/creates）：这里把脚本里出现的每个 /api 路径对到服务端源码。
  const script = await readFile("skills/deck-api/scripts/deck-api", "utf8");
  const server = await readFile("server/index.ts", "utf8");
  const paths = [...new Set(script.match(/\/api\/[a-z0-9/-]+/g) ?? [])];
  assert.ok(paths.length >= 5, `意外地没解析到接口路径：${paths}`);
  for (const endpoint of paths)
    assert.ok(server.includes(`"${endpoint}`), `服务端缺少脚本引用的接口：${endpoint}`);
});

test("deck-send unifies multiline ask, event delivery and legacy CLI aliases", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-ask-cli-"));
  const requests: { path: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
    res.writeHead(202, { "Content-Type": "application/json" }); res.end('{"item":{"id":"demo-ask"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  const address = server.address() as { port: number };
  const env = { ...process.env, CODEX_DECK_HOME: dir, DECK_API_URL: `http://127.0.0.1:${address.port}`, DECK_ASK_NO_FORWARD: "1", DECK_SEND_NO_FORWARD: "1", DECK_TOKEN: "", CODEX_DECK_SESSION: "demo:source", CODEX_THREAD_ID: "" };
  const question = 'Review "demo"\n路径 \\ example\tend';
  const file = path.join(dir, "question.txt"); await writeFile(file, question);
  await run("bash", ["skills/deck-send/scripts/deck-send", "ask", "demo-review", "--mode", "interrupt", "--file", file], { env });
  assert.equal(requests[0].path, "/api/deck/create");
  assert.equal(requests[0].body.question, question);
  assert.equal(requests[0].body.returnMode, "interrupt");
  assert.equal(requests[0].body.session, "demo:source");
  await run("bash", ["skills/deck-wake/scripts/deck-wake", "ask", "demo-review", "--", "second opinion"], { env });
  assert.equal(requests[1].path, "/api/deck/create");
  assert.equal(requests[1].body.returnMode, "queue");
  assert.equal(requests[1].body.question, "second opinion");
  await run("bash", ["skills/deck-wake/scripts/deck-wake", "send", "--mode", "queue", "s-abc1234", "done"], { env });
  assert.equal(requests[2].path, "/api/deck/send");
  assert.equal(requests[2].body.text, "done");
  assert.equal(requests[2].body.mode, "queue");
  assert.equal(requests[2].body.to, "@s-abc1234");
  await run("bash", ["skills/deck-send/scripts/deck-send", "_watch", "s-abc1234", "demo", "40", "--", "printf", "task-done"],
    { env: { ...env, DECK_SEND_MODE: "interrupt", TMPDIR: dir } });
  assert.equal(requests[3].path, "/api/deck/events/s-abc1234");
  assert.equal(requests[3].body.mode, "interrupt");
  assert.match(requests[3].body.text, /task-done/);
});


test("deck-api create and send preserve caller, default mode and explicit destinations", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-api-cli-"));
  const requests: { path: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
    res.writeHead(202, { "Content-Type": "application/json" }); res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, CODEX_DECK_HOME: dir, DECK_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, DECK_API_NO_FORWARD: "1", DECK_TOKEN: "", CODEX_DECK_SESSION: "demo:child" };
  const script = "skills/deck-api/scripts/deck-api";
  const help = await run("bash", [script, "help", "send"], { env });
  assert.match(help.stdout, /--to agent:thread/); assert.equal(requests.length, 0);
  await run("bash", [script, "create", "demo-review", "--effort", "high", "--model", "demo-model", "--", "A question"], { env });
  assert.equal(requests[0].path, "/api/deck/create"); assert.equal(requests[0].body.reasoningEffort, "high");
  const text = 'Concise "result"\nwith path \\demo';
  const file = path.join(dir, "result.txt"); await writeFile(file, text);
  await run("bash", [script, "send", "--request-id", "demo-result", "--file", file], { env });
  assert.equal(requests[1].path, "/api/deck/send"); assert.equal(requests[1].body.text, text);
  assert.equal(requests[1].body.session, "demo:child"); assert.equal(requests[1].body.mode, undefined);
  assert.equal(requests[1].body.requestId, "demo-result"); assert.equal(requests[1].body.to, undefined);
  await run("bash", [script, "send", "--to", "demo:other", "--mode", "interrupt", "--", "Follow up"], { env });
  assert.equal(requests[2].body.to, "demo:other"); assert.equal(requests[2].body.mode, "interrupt");
  await run("bash", [script, "send", "--to", "@s-abc1234", "--mode", "steer", "--", "Hot update"], { env });
  assert.equal(requests[3].body.to, "@s-abc1234"); assert.equal(requests[3].body.mode, "steer");
  await assert.rejects(run("bash", [script, "send", "--code", "s-abc1234", "--mode", "bogus", "--", "Bad"], { env }));
  await assert.rejects(run("bash", [script, "send", "--code", "s-abc1234", "--to", "demo:other", "--", "Bad"], { env }));
  assert.equal(requests.length, 4);
  await run("bash", [script, "wake", "--help"], { env }); assert.equal(requests.length, 4);
});

test("deck-api detached creation and read-only result/inspect commands preserve their contract", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-detached-cli-"));
  const requests: { method?: string; path: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString() || "{}") });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"item":{"alias":"abcd1234"},"result":{"text":"Demo result"},"pending":false}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, CODEX_DECK_HOME: dir, DECK_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, DECK_API_NO_FORWARD: "1", DECK_TOKEN: "" };
  const script = "skills/deck-api/scripts/deck-api";
  const { stdout } = await run("bash", [script, "create", "demo-review", "--detached", "--session", "demo:source", "--", "Do independent work"], { env });
  assert.equal(requests[0].body.detached, true);
  assert.equal(requests[0].body.sessionExplicit, true);
  assert.equal(requests[0].body.returnMode, "queue");
  assert.match(stdout, /完成\/失败\/中断不会推送通知，只能主动查询/);
  assert.doesNotMatch(stdout, /本回合到此结束/);
  await run("bash", [script, "result", "@abcd1234"], { env });
  await run("bash", [script, "inspect", "@abcd1234", "--tail", "30"], { env });
  await run("bash", [script, "tasks"], { env });
  await run("bash", [script, "stop", "@abcd1234", "--after-turn"], { env });
  await run("bash", [script, "kill", "@abcd1234", "--force"], { env });
  await run("bash", [script, "archive", "@abcd1234"], { env });
  await run("bash", [script, "unarchive", "@abcd1234"], { env });
  await run("bash", [script, "delete", "@abcd1234", "--keep-worktree", "--session", "demo:source"], { env });
  assert.deepEqual(requests.slice(1).map(({ method, path }) => ({ method, path })), [
    { method: "GET", path: "/api/deck/sessions/abcd1234/result" },
    { method: "GET", path: "/api/deck/sessions/abcd1234/inspect?tail=30" },
    { method: "GET", path: "/api/deck/sessions" },
    { method: "POST", path: "/api/deck/sessions/abcd1234/stop" },
    { method: "POST", path: "/api/deck/sessions/abcd1234/stop" },
    { method: "POST", path: "/api/deck/sessions/abcd1234/archive" },
    { method: "POST", path: "/api/deck/sessions/abcd1234/unarchive" },
    { method: "DELETE", path: "/api/deck/sessions/abcd1234" },
  ]);
  assert.equal(requests[4].body.mode, "after-turn");
  assert.equal(requests[5].body.mode, "now");
  assert.equal(requests[5].body.force, true);
  assert.equal(requests[8].body.keepWorktree, true);
  assert.equal(requests[8].body.session, "demo:source");
  for (const args of [["result", "../../other"], ["inspect", "@abcd1234", "--tail", "0"],
    ["inspect", "@abcd1234", "--tail", "201"], ["result", "@abcd1234", "--tail", "3"]])
    await assert.rejects(run("bash", [script, ...args], { env }));
  assert.equal(requests.length, 9);
});

test("deck-api wake watch and poll spawn discovered workers and notify with the chosen mode", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-api-wake-cli-"));
  const events: any[] = [];
  const pids: number[] = [];
  const waiters: (() => void)[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (req.url === "/api/deck/events/s-abc1234") { events.push(body); waiters.shift()?.(); }
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(req.url === "/api/deck/prepare" ? '{"code":"s-abc1234","summary":"bound demo session"}' : '{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const pid of pids) { try { process.kill(pid, "SIGUSR1"); } catch {} }
    server.close(); await rm(dir, { recursive: true, force: true });
  });
  const env = { ...process.env, CODEX_DECK_HOME: dir, DECK_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, DECK_API_NO_FORWARD: "1", DECK_TOKEN: "", CODEX_DECK_SESSION: "demo:source" };
  for (const mode of ["watch", "poll"]) {
    let timer: ReturnType<typeof setTimeout>;
    const event = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("watcher did not notify")), 5000);
      waiters.push(() => { clearTimeout(timer); resolve(); });
    });
    const { stdout } = await run("bash", ["skills/deck-api/scripts/deck-api", "wake", mode, "--mode", "interrupt", "--", "printf", mode === "watch" ? "demo-done" : "DONE"], { env });
    const pid = Number(stdout.match(/pid (\d+)/)?.[1]); assert.ok(pid); pids.push(pid);
    await event;
    assert.equal(events.at(-1).mode, "interrupt");
    assert.match(events.at(-1).text, mode === "watch" ? /demo-done/ : /DONE/);
  }
});

test("deck-api send preserves nasty characters identically via args and --file", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-api-nasty-"));
  const bodies: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks).toString() || "{}").text);
    res.writeHead(202, { "Content-Type": "application/json" }); res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, CODEX_DECK_HOME: dir, DECK_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, DECK_API_NO_FORWARD: "1", DECK_TOKEN: "" };
  const script = "skills/deck-api/scripts/deck-api";
  const text = '引号"反斜杠\\换行\n回车\r制表\t美元$反引`感叹!单引\'星*问?中括号[x]';
  const file = path.join(dir, "nasty.txt"); await writeFile(file, text);
  await run("bash", [script, "send", "--to", "demo:other", "--", text], { env });
  await run("bash", [script, "send", "--to", "demo:other", "--file", file], { env });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], text);
  assert.equal(bodies[1], text, "--file 与直接参数必须逐字节一致");
});

test("deck-api enforces the 80k contract and rejects empty input on both ends", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-api-limits-"));
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    // 模拟服务端 zod 上限：超限/空消息 400，脚本必须原样透出失败，绝不静默截断。
    const text = body.text ?? body.question ?? "";
    if (!String(text).trim() || String(text).length > 80_000) {
      res.writeHead(400, { "Content-Type": "application/json" }); res.end('{"error":"消息须为 1 至 80000 字符"}');
      return;
    }
    requests.push(req.url!);
    res.writeHead(202, { "Content-Type": "application/json" }); res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, CODEX_DECK_HOME: dir, DECK_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, DECK_API_NO_FORWARD: "1", DECK_TOKEN: "" };
  const script = "skills/deck-api/scripts/deck-api";
  await run("bash", [script, "send", "--to", "demo:other", "--", "x".repeat(80_000)], { env });
  await assert.rejects(run("bash", [script, "send", "--to", "demo:other", "--", "x".repeat(80_001)], { env }));
  await assert.rejects(run("bash", [script, "send", "--to", "demo:other", "--", "   "], { env }));
  await assert.rejects(run("bash", [script, "send", "--to", "demo:other", "--", ""], { env }), /缺少消息内容/);
  await assert.rejects(run("bash", [script, "create", "demo-review", "--", "y".repeat(80_001)], { env }));
  assert.equal(requests.length, 1, "只有恰好 80000 字符的那条到达服务端");
});

test("deck-api result resolves @s- aliases and refuses sessions without asks", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-api-alias-"));
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(req.url === "/api/deck/sessions"
      ? '{"items":[{"id":"q1abcdef-1234-5678-90ab-cdef12345678","alias":"q1abcdef","targetAlias":"s-abc1234"}]}'
      : '{"item":{"alias":"q1abcdef"},"result":null,"pending":false}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, CODEX_DECK_HOME: dir, DECK_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, DECK_API_NO_FORWARD: "1", DECK_TOKEN: "" };
  const script = "skills/deck-api/scripts/deck-api";
  await run("bash", [script, "result", "@s-abc1234"], { env });
  assert.deepEqual(requests, ["GET /api/deck/sessions", "GET /api/deck/sessions/q1abcdef-1234-5678-90ab-cdef12345678/result"]);
  // execFile 的 rejection 不带文本：改从 stderr 断言。
  const err = await run("bash", [script, "result", "@s-zzz9999"], { env }).then(
    () => { throw new Error("should have failed"); }, (error: any) => error);
  assert.match(String(err.stderr || ""), /没有关联的询问记录/);
  assert.deepEqual(requests, ["GET /api/deck/sessions", "GET /api/deck/sessions/q1abcdef-1234-5678-90ab-cdef12345678/result", "GET /api/deck/sessions"],
    "无关联询问时只查列表，不再取 result");
});

test("deck-api validates wake/send/create arguments client-side without requests", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-api-argv-"));
  let count = 0;
  const server = createServer(async (_req, res) => {
    count++;
    res.writeHead(202, { "Content-Type": "application/json" }); res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, CODEX_DECK_HOME: dir, DECK_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, DECK_API_NO_FORWARD: "1", DECK_TOKEN: "" };
  const script = "skills/deck-api/scripts/deck-api";
  for (const args of [
    ["wake", "-i", "4", "--", "true"],
    ["wake", "badcode!", "--", "true"],
    ["wake", "--mode", "bogus", "--", "true"],
    ["create", "demo-review", "--mode", "bogus", "--", "q"],
    ["create", "demo-review", "--"],
    ["create", "demo-review", "--file", path.join(dir, "missing.txt"), "--", "q"],
    ["send", "--mode", "bogus", "--to", "demo:x", "--", "q"],
    ["send", "--to", "demo:x", "--code", "wake1", "--", "q"],
    ["send", "--to", "@s-bad", "--", "q"],
    ["inspect", "@abcd1234", "--tail", "abc"],
  ])
    await assert.rejects(run("bash", [script, ...args], { env }), undefined, args.join(" "));
  assert.equal(count, 0, "参数校验失败时一次请求都不该发");
});

test("deck-api surfaces recipient resolution errors instead of exiting silently", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-api-404-"));
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "会话别名 s-abc1234 不存在", code: "UNKNOWN_ALIAS" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, CODEX_DECK_HOME: dir, DECK_API_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`, DECK_API_NO_FORWARD: "1", DECK_TOKEN: "" };
  const script = "skills/deck-api/scripts/deck-api";
  let error: { code?: number; stderr?: string } | undefined;
  try {
    await run("bash", [script, "send", "--to", "@s-abc1234", "--", "demo"], { env });
  } catch (caught) {
    error = caught as { code?: number; stderr?: string };
  }
  assert.equal(error?.code, 1);
  assert.match(error?.stderr ?? "", /会话别名 s-abc1234 不存在/);
});

test("instance discovery ignores stale URLs, rejects ambiguity, and verifies identity", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-discovery-"));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(dir, "instances"));
  const received: string[] = [];
  const servers: ReturnType<typeof createServer>[] = [];
  const register = async (id: string, caller: boolean, reportedId = id) => {
    const server = createServer(async (req, res) => {
      for await (const _ of req) { /* consume request */ }
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/deck/discover") {
        assert.equal(req.headers.authorization, `Bearer demo-${id}`);
        res.end(JSON.stringify({ instanceId: reportedId, caller }));
      } else { received.push(id); res.end('{"items":[]}'); }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await writeFile(path.join(dir, "instances", `${id}.json`), JSON.stringify({ instanceId: id, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: `demo-${id}` }));
    return server;
  };
  t.after(async () => { for (const server of servers) server.close(); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, CODEX_DECK_HOME: dir, DECK_API_NO_FORWARD: "1", DECK_API_URL: "", DECK_INSTANCE_ID: "", CODEX_THREAD_ID: "", CODEX_DECK_SESSION: "" };
  delete (env as Record<string, unknown>).DECK_TOKEN;
  await writeFile(path.join(dir, "url"), "http://127.0.0.1:1");
  await writeFile(path.join(dir, "instances", "stale.json"), JSON.stringify({ instanceId: "stale", url: "http://127.0.0.1:1", token: "" }));
  await register("wrong", false, "different-instance");
  const first = await register("first", false);
  const script = "skills/deck-api/scripts/deck-api";
  await run("bash", [script, "agents"], { env });
  assert.deepEqual(received, ["first"]);
  await register("second", false);
  await assert.rejects(run("bash", [script, "agents"], { env }), /多个 Deck 实例/);
  assert.equal(received.length, 1);
  await register("owner", true);
  await run("bash", [script, "agents"], { env });
  assert.equal(received.at(-1), "owner");
  await run("bash", [script, "agents"], { env: { ...env, DECK_INSTANCE_ID: "first" } });
  assert.equal(received.at(-1), "first");
  await new Promise<void>((resolve) => first.close(() => resolve()));
  await register("first", false);
  await run("bash", [script, "agents"], { env: { ...env, DECK_INSTANCE_ID: "first" } });
  assert.equal(received.at(-1), "first");
});
