import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { createServer } from "node:http";
import { BackgroundPool } from "./background-work.js";

function worker() {
  return new Worker(
    `const { parentPort } = require('node:worker_threads');
    parentPort.on('message', ({id, args}) => {
      parentPort.postMessage({started: true});
      if (args[0] === 'crash') process.exit(1);
      if (args[0] === 'block') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      if (args[0] === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
      parentPort.postMessage({id, value: args[0], error: args[0] === 'error' ? {message: 'demo failure'} : undefined});
    });`,
    { eval: true },
  );
}

test("a synchronous background stall does not stall HTTP responses", async (t) => {
  const child = worker();
  const pool = new BackgroundPool(() => child);
  t.after(() => pool.close());
  const server = createServer((_req, res) => res.end("ready"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const started = once(child, "message");
  let completed = false;
  const work = pool.run("host", ["block"]).then(() => {
    completed = true;
  });
  await started;
  const address = server.address() as { port: number };
  assert.equal(
    await (await fetch(`http://127.0.0.1:${address.port}`)).text(),
    "ready",
  );
  assert.equal(
    completed,
    false,
    "HTTP must respond while worker is still synchronously blocked",
  );
  await work;
});

test("bounded lanes serialize jobs and reject excess work", async (t) => {
  const pool = new BackgroundPool(worker, 2);
  t.after(() => pool.close());
  const first = pool.run("host", ["block"]);
  const second = pool.run("host", ["second"]);
  await assert.rejects(pool.run("host", ["third"]), /queue is full/);
  assert.deepEqual(await Promise.all([first, second]), ["block", "second"]);
});

test("deadline rejects all affected callers and next request creates a healthy worker", async (t) => {
  const pool = new BackgroundPool(worker, 4, 1_000);
  t.after(() => pool.close());
  await Promise.all([
    assert.rejects(pool.run("host", ["hang"]), /timed out/),
    assert.rejects(pool.run("host", ["queued"]), /timed out/),
  ]);
  assert.equal(await pool.run("host", ["recovered"]), "recovered");
});

test("crashes, job errors, clone errors and shutdown settle promises", async () => {
  const pool = new BackgroundPool(worker);
  await assert.rejects(pool.run("host", ["crash"]), /exited/);
  await assert.rejects(pool.run("host", ["error"]), /demo failure/);
  assert.equal(await pool.run("host", ["next"]), "next");
  await assert.rejects(pool.run("host", [() => {}]), /transferred/);
  const pending = pool.run("host", ["hang"]);
  const rejected = assert.rejects(pending, /closing/);
  pool.close();
  pool.close();
  await rejected;
  await assert.rejects(pool.run("host", []), /closing/);
});
