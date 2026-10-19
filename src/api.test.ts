import assert from "node:assert/strict";
import test from "node:test";
import { getSnapshot } from "./api";

const snapshot = { threads: [], providers: [], approvals: [] };

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
  });
}

test("snapshot deadline covers both connecting and reading the response body", async (t) => {
  for (const stage of ["headers", "body"]) {
    await t.test(stage, async (t) => {
      t.mock.method(
        globalThis,
        "fetch",
        async (_url: string, init: RequestInit) => {
          const signal = init.signal!;
          if (stage === "headers") return untilAborted(signal);
          return { ok: true, json: () => untilAborted(signal) };
        },
      );
      await assert.rejects(getSnapshot(20), /会话同步超时/);
    });
  }
});

test("snapshot errors remain visible and invalid success responses are rejected", async (t) => {
  for (const [body, status, expected] of [
    [{ error: "demo unavailable" }, 503, /demo unavailable/],
    [{}, 200, /有效会话快照/],
  ] as const) {
    await t.test(String(status), async (t) => {
      t.mock.method(
        globalThis,
        "fetch",
        async () => new Response(JSON.stringify(body), { status }),
      );
      await assert.rejects(getSnapshot(), expected);
    });
  }
});

test("a valid empty snapshot finishes successfully without waiting for the deadline", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify(snapshot)),
  );
  assert.deepEqual(await getSnapshot(), snapshot);
});
