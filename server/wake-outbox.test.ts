import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WakeOutbox, retryDelayMs } from "./wake-outbox.js";
import type { AgentId } from "./types.js";

interface Harness {
  outbox: WakeOutbox;
  file: string;
  setNow: (value: number) => void;
  advance: (ms: number) => void;
}

/**
 * timer:false 的测试装配：真实 setTimeout 会被 now 的假时钟搅乱，
 * 改为手动 tick 驱动投递。
 */
function harness(
  send: (agentId: AgentId, threadId: string, prompt: string) => Promise<unknown> = async () =>
    ({}),
  resolve?: (code: string) => { agentId: AgentId; threadId: string } | undefined,
): Harness {
  let now = 1_000_000_000;
  const dir = mkdtempSync(path.join(tmpdir(), "wake-outbox-"));
  const outbox = new WakeOutbox({
    file: path.join(dir, "wake-outbox.json"),
    resolve:
      resolve ??
      ((code) =>
        code === "gone"
          ? undefined
          : { agentId: "codex", threadId: `t-${code}` }),
    send,
    now: () => now,
    timer: false,
  });
  return {
    outbox,
    file: path.join(dir, "wake-outbox.json"),
    setNow: (value) => {
      now = value;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

const enqueue = (outbox: WakeOutbox, code = "abc", prompt = `[wake:${code}] done`) =>
  outbox.enqueue({ code, prompt, agentId: "codex", threadId: `t-${code}` });

test("enqueue 落盘后 tick 投递一次即 delivered", async () => {
  let calls = 0;
  const { outbox } = harness(async () => {
    calls += 1;
  });
  const item = await enqueue(outbox);
  assert.equal(item.status, "pending");
  await outbox.tick();
  assert.equal(calls, 1);
  const [stored] = outbox.list();
  assert.equal(stored.status, "delivered");
  assert.equal(stored.attempts, 0);
});

test("同代号+同内容的重复 POST 去重为同一条", async () => {
  let calls = 0;
  const { outbox } = harness(async () => {
    calls += 1;
  });
  const first = await enqueue(outbox);
  const second = await enqueue(outbox);
  assert.equal(first.id, second.id);
  assert.equal(outbox.list().length, 1);
  await outbox.tick();
  assert.equal(calls, 1);
  // 已投递但未过去重窗口：再次重复仍返回同一条，不重发。
  const third = await enqueue(outbox);
  assert.equal(third.id, first.id);
  assert.equal(third.status, "delivered");
  await outbox.tick();
  assert.equal(calls, 1);
});

test("delivered 过了去重窗口后，同内容按新条目再发", async () => {
  let calls = 0;
  const { outbox, advance } = harness(async () => {
    calls += 1;
  });
  const first = await enqueue(outbox);
  await outbox.tick();
  advance(6 * 60_000);
  const second = await enqueue(outbox);
  assert.notEqual(second.id, first.id);
  await outbox.tick();
  assert.equal(calls, 2);
});

test("暂态失败按指数退避重试，直至成功", async () => {
  let calls = 0;
  const { outbox, advance, setNow } = harness(async () => {
    calls += 1;
    if (calls < 3) throw new Error("连接闪断");
  });
  const created = 1_000_000_000;
  setNow(created);
  await enqueue(outbox);
  await outbox.tick();
  let [item] = outbox.list();
  assert.equal(item.status, "pending");
  assert.equal(item.attempts, 1);
  assert.equal(item.nextAttemptAt, created + retryDelayMs(1));
  // 未到 nextAttemptAt 时 tick 不重发。
  await outbox.tick();
  assert.equal(calls, 1);
  advance(retryDelayMs(1));
  await outbox.tick();
  [item] = outbox.list();
  assert.equal(item.attempts, 2);
  assert.equal(item.nextAttemptAt, created + retryDelayMs(1) + retryDelayMs(2));
  advance(retryDelayMs(2));
  await outbox.tick();
  [item] = outbox.list();
  assert.equal(item.status, "delivered");
  assert.equal(calls, 3);
});

test("永久错误一次即 dead，不再重试", async () => {
  const { outbox } = harness(async () => {
    throw new Error("会话已归档，请先恢复再发送");
  });
  await enqueue(outbox);
  await outbox.tick();
  const [item] = outbox.list();
  assert.equal(item.status, "dead");
  assert.equal(item.attempts, 1);
});

test("代号已解绑直接 dead", async () => {
  const { outbox } = harness(async () => {
    throw new Error("不应被调用");
  });
  await outbox.enqueue({
    code: "gone",
    prompt: "[wake:gone] done",
    agentId: "codex",
    threadId: "t-gone",
  });
  await outbox.tick();
  assert.equal(outbox.list()[0].status, "dead");
});

test("超过最长重试期转 dead", async () => {
  const { outbox, advance } = harness(async () => {
    throw new Error("连接闪断");
  });
  await enqueue(outbox);
  await outbox.tick();
  advance(24 * 3_600_000 + 1);
  await outbox.tick();
  assert.equal(outbox.list()[0].status, "dead");
});

test("dead 条目被同内容 POST 复活重投", async () => {
  let calls = 0;
  const { outbox } = harness(async () => {
    calls += 1;
    if (calls === 1) throw new Error("会话已归档，请先恢复再发送");
  });
  const first = await enqueue(outbox);
  await outbox.tick();
  assert.equal(outbox.list()[0].status, "dead");
  const revived = await enqueue(outbox);
  assert.equal(revived.id, first.id);
  assert.equal(revived.status, "pending");
  await outbox.tick();
  assert.equal(calls, 2);
  assert.equal(outbox.list()[0].status, "delivered");
});

test("retry/dismiss 手动操作", async () => {
  const { outbox } = harness(async () => {
    throw new Error("会话已归档，请先恢复再发送");
  });
  const item = await enqueue(outbox);
  await outbox.tick();
  assert.equal(outbox.list()[0].status, "dead");
  const revived = await outbox.retry(item.id);
  assert.equal(revived.status, "pending");
  await outbox.dismiss(item.id);
  assert.equal(outbox.list().length, 0);
  await assert.rejects(outbox.retry("missing"), /不存在/);
});

test("重启后从磁盘恢复 pending 并继续投递", async () => {
  let calls = 0;
  const send = async () => {
    calls += 1;
  };
  const first = harness(send);
  await enqueue(first.outbox, "abc");
  // 不 tick 直接“重启”：新实例读同一文件。
  const second = new WakeOutbox({
    file: first.file,
    resolve: (code) => ({ agentId: "codex", threadId: `t-${code}` }),
    send,
    timer: false,
  });
  await second.load();
  const [item] = second.list();
  assert.equal(item.status, "pending");
  await second.tick();
  assert.equal(calls, 1);
});

test("delivered 条目过窗口后从文件里剪掉", async () => {
  const { outbox, file, advance } = harness();
  await enqueue(outbox);
  await outbox.tick();
  advance(6 * 60_000);
  // 触发一次写盘让剪枝生效（再入队一条别的）。
  await enqueue(outbox, "def", "[wake:def] other");
  const revived = new WakeOutbox({
    file,
    resolve: () => undefined,
    send: async () => {},
    timer: false,
  });
  await revived.load();
  assert.deepEqual(
    revived.list().map((item) => item.code),
    ["def"],
  );
});

test("view 不带完整 prompt，只下发截断 preview", async () => {
  const { outbox } = harness();
  const long = `[wake:abc] ${"x".repeat(1_000)}`;
  const item = await enqueue(outbox, "abc", long);
  assert.equal("prompt" in item, false);
  assert.equal(item.preview.length, 300);
  assert.equal(item.preview.startsWith("x"), true);
});
