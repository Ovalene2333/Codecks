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
  const env = { ...process.env, CODEX_DECK_HOME: dir, DECK_SEND_URL: `http://127.0.0.1:${address.port}`, DECK_ASK_NO_FORWARD: "1", DECK_SEND_NO_FORWARD: "1", DECK_TOKEN: "", CODEX_DECK_SESSION: "demo:source", CODEX_THREAD_ID: "" };
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
  await run("bash", ["skills/deck-wake/scripts/deck-wake", "send", "--mode", "queue", "demo-code", "done"], { env });
  assert.equal(requests[2].path, "/api/deck/send");
  assert.equal(requests[2].body.text, "done");
  assert.equal(requests[2].body.mode, "queue");
  assert.equal(requests[2].body.code, "demo-code");
  await run("bash", ["skills/deck-send/scripts/deck-send", "_watch", "demo-code", "demo", "40", "--", "printf", "task-done"],
    { env: { ...env, DECK_SEND_MODE: "interrupt", TMPDIR: dir } });
  assert.equal(requests[3].path, "/api/deck/events/demo-code");
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
  await assert.rejects(run("bash", [script, "send", "--code", "demo-code", "--to", "demo:other", "--", "Bad"], { env }));
  assert.equal(requests.length, 3);
  await run("bash", [script, "wake", "--help"], { env }); assert.equal(requests.length, 3);
});

test("deck-api wake watch and poll spawn discovered workers and notify with the chosen mode", { skip: process.platform === "win32" }, async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "deck-api-wake-cli-"));
  const events: any[] = [];
  const pids: number[] = [];
  const waiters: (() => void)[] = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (req.url === "/api/deck/events/demo-code") { events.push(body); waiters.shift()?.(); }
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(req.url === "/api/deck/prepare" ? '{"code":"demo-code","summary":"bound demo session"}' : '{"ok":true}');
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
