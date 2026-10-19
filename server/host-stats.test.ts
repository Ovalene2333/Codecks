import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import {
  CpuSampler,
  availableMemory,
  hostStats,
  parseProcStatCpu,
} from "./host-stats.js";

test("CpuSampler reports busy share between samples", () => {
  const readings = [
    { idle: 100, total: 200 },
    { idle: 150, total: 400 },
    { idle: 150, total: 400 },
  ];
  const sampler = new CpuSampler(() => readings.shift()!);
  assert.equal(sampler.sample(), 75);
  // 两次采样之间没有新 tick：沿用上一次，而不是给出 NaN/0。
  assert.equal(sampler.sample(), 75);
});

test(
  "availableMemory prefers MemAvailable on Linux",
  { skip: process.platform !== "linux" },
  () => {
    assert.equal(
      availableMemory(
        () => "MemTotal: 100 kB\nMemFree: 1 kB\nMemAvailable: 42 kB\n",
      ),
      42 * 1024,
    );
  },
);

test("hostStats includes deck process details", () => {
  const stats = hostStats(new CpuSampler(), 3);
  assert.equal(stats.deck.pid, process.pid);
  assert.equal(stats.deck.clients, 3);
  assert.ok(stats.memTotal > 0);
  assert.ok(stats.cpuCount > 0);
});

test(
  "hostStats reports backend process rss",
  { skip: process.platform === "win32" },
  () => {
    const stats = hostStats(new CpuSampler(), 0, [
      { agentId: "devin", pid: process.pid },
    ]);
    assert.equal(stats.servers?.length, 1);
    assert.ok((stats.servers?.[0].rss ?? 0) > 0);
  },
);

test("Linux CPU counters include iowait as idle without double-counting guest ticks", () => {
  assert.deepEqual(
    parseProcStatCpu(
      "cpu  100 20 30 400 50 6 7 8 90 10\ncpu0 1 2 3 4\ncpu1 1 2 3 4\nintr 100\n",
    ),
    { idle: 450, total: 621, cpuCount: 2 },
  );
  assert.throws(() => parseProcStatCpu("cpu 1 invalid 3 4\n"));
  assert.throws(() => parseProcStatCpu("intr 100\n"));
});

test(
  "Linux host polling does not query per-core CPU metadata",
  { skip: process.platform !== "linux" },
  (t) => {
    t.mock.method(os, "cpus", () => {
      throw new Error(
        "slow per-core metadata must not run on the server thread",
      );
    });
    const sampler = new CpuSampler();
    for (let index = 0; index < 3; index++) {
      const stats = hostStats(sampler, 1);
      assert.ok(stats.cpuCount > 0);
      assert.ok(
        stats.cpuPercent === undefined ||
          (stats.cpuPercent >= 0 && stats.cpuPercent <= 100),
      );
    }
  },
);
