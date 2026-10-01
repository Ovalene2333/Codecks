import assert from "node:assert/strict";
import test from "node:test";
import { WakeDeduper } from "./wake-dedupe.js";

test("wake retries share one send, while different signals still send", async () => {
  const deduper = new WakeDeduper<number>();
  let calls = 0;
  let release!: (value: number) => void;
  const first = deduper.run("code", "[wake:code] done", () => {
    calls += 1;
    return new Promise<number>((resolve) => { release = resolve; });
  });
  const retry = deduper.run("code", "[wake:code] done", () => {
    calls += 1;
    return Promise.resolve(2);
  });
  await Promise.resolve();
  assert.equal(calls, 1);
  release(1);
  assert.deepEqual(await Promise.all([first, retry]), [1, 1]);
  assert.equal(await deduper.run("code", "[wake:code] done", async () => 2), 1);
  assert.equal(await deduper.run("code", "[wake:code] next", async () => ++calls), 2);
});

test("failed wake submissions can be retried", async () => {
  const deduper = new WakeDeduper<number>();
  await assert.rejects(deduper.run("code", "signal", async () => { throw new Error("offline"); }));
  assert.equal(await deduper.run("code", "signal", async () => 1), 1);
});
