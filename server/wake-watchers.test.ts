import assert from "node:assert/strict";
import test from "node:test";
import {
  parseEtime,
  parseLogState,
  parseWatcherArgv,
  pickLog,
  WakeWatcherCache,
} from "./wake-watchers.js";
import type { WakeWatcher } from "./types.js";

const RE = "^(COMPLETED|FAILED|DONE|GONE)";

test("poll and watch argv follow the deck-wake script contract", () => {
  assert.deepEqual(
    parseWatcherArgv([
      "bash", "/home/u/proj/.agents/skills/deck-wake/scripts/deck-wake",
      "_poll", "f61d9535", "report-heads", "300", RE, "0",
      "--", "ssh", "-o", "BatchMode=yes", "hlt", "sacct -j 1",
    ]),
    {
      code: "f61d9535",
      mode: "poll",
      label: "report-heads",
      intervalSec: 300,
      command: "ssh -o BatchMode=yes hlt sacct -j 1",
    },
  );
  assert.deepEqual(
    parseWatcherArgv(["bash", "deck-wake", "_watch", "gpu-a", "train", "40", "--", "ssh", "box", "wait"]),
    { code: "gpu-a", mode: "watch", label: "train", command: "ssh box wait" },
  );
});

test("other processes and malformed argv are ignored", () => {
  assert.equal(parseWatcherArgv(["bash", "deck-wake", "ps"]), undefined);
  assert.equal(parseWatcherArgv(["vim", "deck-wake"]), undefined);
  assert.equal(parseWatcherArgv(["bash", "other", "_poll", "a1", "l", "60", RE, "0", "--", "x"]), undefined);
  // 代号不合法、缺少 -- 分隔
  assert.equal(parseWatcherArgv(["bash", "deck-wake", "_poll", "Bad!", "l", "60", RE, "0", "--", "x"]), undefined);
  assert.equal(parseWatcherArgv(["bash", "deck-wake", "_watch", "a1", "l", "40", "x"]), undefined);
});

test("ps etime becomes milliseconds", () => {
  assert.equal(parseEtime("05:07"), (5 * 60 + 7) * 1_000);
  assert.equal(parseEtime("12:40:46"), ((12 * 60 + 40) * 60 + 46) * 1_000);
  assert.equal(parseEtime("2-01:00:00"), 49 * 3_600_000);
  assert.equal(parseEtime("abc"), undefined);
});

test("the log whose name matches the watcher start is picked", () => {
  const startedAt = new Date(2026, 8, 29, 12, 8, 8, 500).getTime();
  const names = [
    "f61d9535-20260928-211306.log",
    "f61d9535-20260929-120808.log",
    "f61d9535-x-20260929-120808.log",
    "other-20260929-120808.log",
  ];
  assert.equal(pickLog(names, "f61d9535", startedAt), "f61d9535-20260929-120808.log");
  // 代号本身带连字符也要精确匹配前缀
  assert.equal(pickLog(["test-deck-20260929-120808.log"], "test-deck", startedAt), "test-deck-20260929-120808.log");
  assert.equal(pickLog(names, "f61d9535", startedAt + 3_600_000), undefined);
});

test("log tail yields the latest poll state and ongoing connection failures", () => {
  const log = [
    "2026-09-29 12:08:08 开始轮询（300s）：ssh hlt check",
    "2026-09-29 12:08:08 状态：（初始） -> RUNNING",
    "2026-09-29 13:00:00 连接失败（1/10）",
    "2026-09-29 13:05:00 连接失败（2/10）",
  ].join("\n");
  assert.deepEqual(parseLogState(log), {
    state: "RUNNING",
    stateAt: new Date(2026, 8, 29, 12, 8, 8).getTime(),
    failures: 2,
    failedAt: new Date(2026, 8, 29, 13, 5, 0).getTime(),
  });
  // 恢复后出现新状态，失败计数随之清零
  assert.deepEqual(parseLogState(`${log}\n2026-09-29 13:10:00 状态：RUNNING -> PENDING`), {
    state: "PENDING",
    stateAt: new Date(2026, 8, 29, 13, 10, 0).getTime(),
  });
  assert.deepEqual(parseLogState("deck-wake: 无法连接 Deck"), {});
});

const watcher = (pid: number, extra: Partial<WakeWatcher> = {}): WakeWatcher => ({
  pid,
  code: "c1",
  mode: "watch",
  label: `w${pid}`,
  command: "true",
  startedAt: 1,
  ...extra,
});

test("watcher cache serves stale results instantly and reports changes", async () => {
  let list = [watcher(1)];
  let scans = 0;
  const changes: WakeWatcher[][] = [];
  const cache = new WakeWatcherCache(async () => (scans++, list), {
    ttlMs: 10,
    onChange: (items) => changes.push(items),
  });
  // current() 在首轮扫描落地前返回空、不阻塞；ready() 等待首轮结果。
  assert.deepEqual(cache.current(), []);
  assert.deepEqual(await cache.ready(), [watcher(1)]);
  assert.equal(scans, 1);
  assert.equal(changes.length, 1);
  // TTL 内重复读取不重扫、不重复回调。
  assert.deepEqual(cache.current(), [watcher(1)]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(scans, 1);
  // 过期后 current() 先回旧值、后台重扫；onChange 通知到下一轮快照广播。
  list = [watcher(1), watcher(2)];
  assert.deepEqual(cache.current(), [watcher(1)]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(cache.current(), [watcher(1), watcher(2)]);
  assert.equal(changes.length, 2);
});

test("watcher cache keeps serving the old list when a scan fails", async () => {
  let fail = false;
  const cache = new WakeWatcherCache(
    async () => {
      if (fail) throw new Error("scan boom");
      return [watcher(1)];
    },
    { ttlMs: 10 },
  );
  assert.deepEqual(await cache.ready(), [watcher(1)]);
  fail = true;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(await cache.ready(), [watcher(1)]);
});
