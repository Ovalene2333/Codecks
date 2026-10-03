import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyWatcherExit, WakeWatcherLedger } from "./wake-ledger.js";
import type { WakeWatcher } from "./types.js";

test("watcher exits are classified by the last timestamped log line", () => {
  assert.deepEqual(
    classifyWatcherExit("2026-09-30 06:50:18 状态：RUNNING -> DONE\n2026-09-30 06:50:18 已唤醒 657a315d\n"),
    { kind: "woke" },
  );
  // 旧脚本退出时的 trap 报错不带时间戳，不影响判定。
  assert.deepEqual(
    classifyWatcherExit("2026-09-28 20:53:55 已唤醒 test-deck\n…/deck-wake: line 1: tmp: unbound variable\n"),
    { kind: "woke" },
  );
  assert.deepEqual(
    classifyWatcherExit("2026-09-30 01:00:00 已停止（手动），不再唤醒\n"),
    { kind: "stopped" },
  );
  const killed = classifyWatcherExit("2026-09-30 14:36:33 状态：（初始） -> RUNNING\n");
  assert.equal(killed.kind, "lost");
  assert.equal(killed.kind === "lost" && killed.lastLine, "状态：（初始） -> RUNNING");
  const term = classifyWatcherExit("2026-09-30 14:36:33 收到 TERM，watcher 退出（未唤醒）\n");
  assert.match(term.kind === "lost" ? term.reason : "", /外部终止/);
  const failed = classifyWatcherExit("2026-09-29 04:44:51 唤醒失败，放弃\n");
  assert.match(failed.kind === "lost" ? failed.reason : "", /没能送到/);
  assert.equal(classifyWatcherExit(undefined).kind, "lost");
  assert.equal(classifyWatcherExit("").kind, "lost");
});

const watcher = (pid: number, log: string, extra: Partial<WakeWatcher> = {}): WakeWatcher => ({
  pid,
  code: "abc1",
  mode: "poll",
  label: `job-${pid}`,
  command: `ssh box check ${pid}`,
  startedAt: 1_000,
  log,
  agentId: "codex",
  threadId: "t1",
  ...extra,
});

test("watchers that vanish without waking become lost, persist, and can be dismissed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wake-ledger-"));
  try {
    const file = path.join(dir, "wake-watchers.json");
    const logs: Record<string, string> = {
      a: "2026-09-30 10:00:00 状态：RUNNING -> DONE\n2026-09-30 10:00:00 已唤醒 abc1\n",
      b: "2026-09-30 10:00:00 状态：（初始） -> RUNNING\n",
      c: "2026-09-30 10:00:00 状态：（初始） -> RUNNING\n",
    };
    let changes = 0;
    const make = () =>
      new WakeWatcherLedger({
        file,
        readLog: async (name) => logs[name],
        now: () => 5_000,
        onChanged: () => changes++,
      });
    const ledger = make();
    await ledger.load();
    const [a, b, c] = [watcher(1, "a"), watcher(2, "b"), watcher(3, "c")];
    await ledger.observe([a, b, c]);
    assert.equal(changes, 1);
    // 未变化的扫描不写盘也不通知。
    await ledger.observe([a, b, c]);
    assert.equal(changes, 1);

    // c 由 Deck 主动停止：消失时不算失联。
    ledger.markStopping(c);
    await ledger.observe([]);
    const lost = ledger.lost();
    assert.deepEqual(lost.map((item) => item.pid), [2]);
    assert.equal(lost[0].threadId, "t1");
    assert.equal(lost[0].endedAt, 5_000);

    // 重启后台账仍在。
    const reloaded = make();
    await reloaded.load();
    assert.deepEqual(reloaded.lost().map((item) => item.id), [lost[0].id]);
    await reloaded.dismiss(lost[0].id);
    assert.deepEqual(reloaded.lost(), []);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")).lost, []);
    await assert.rejects(reloaded.dismiss("nope"), /不存在/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("watchers seen before a Deck restart are reconciled on the next scan", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wake-ledger-"));
  try {
    const file = path.join(dir, "wake-watchers.json");
    const first = new WakeWatcherLedger({ file, readLog: async () => undefined });
    await first.load();
    await first.observe([watcher(7, "gone")]);
    // Deck 停机期间机器重启：watcher 没了，日志也找不到。
    const second = new WakeWatcherLedger({ file, readLog: async () => undefined });
    await second.load();
    await second.observe([]);
    assert.deepEqual(second.lost().map((item) => item.pid), [7]);
    assert.match(second.lost()[0].reason, /找不到它的日志/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
