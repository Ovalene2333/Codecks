import assert from "node:assert/strict";
import test from "node:test";
import { CpuSampler, availableMemory, hostStats } from "./host-stats.js";

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

test("availableMemory prefers MemAvailable on Linux", { skip: process.platform !== "linux" }, () => {
  assert.equal(
    availableMemory(() => "MemTotal: 100 kB\nMemFree: 1 kB\nMemAvailable: 42 kB\n"),
    42 * 1024,
  );
});

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
