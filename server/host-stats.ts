import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import type { AgentId, HostStats } from "./types.js";

interface CpuTimes {
  idle: number;
  total: number;
}

function cpuTimes(cpus: os.CpuInfo[] = os.cpus()): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const { user, nice, sys, irq, idle: free } = cpu.times;
    idle += free;
    total += user + nice + sys + irq + free;
  }
  return { idle, total };
}

/** 两次调用之间的整机 CPU 占用；间隔太短（无新 tick）时沿用上一次结果。 */
export class CpuSampler {
  private last: CpuTimes;
  private percent?: number;

  constructor(private read: () => CpuTimes = () => cpuTimes()) {
    this.last = read();
  }

  sample() {
    const next = this.read();
    const total = next.total - this.last.total;
    const idle = next.idle - this.last.idle;
    if (total > 0) {
      this.percent = Math.max(0, Math.min(100, (1 - idle / total) * 100));
      this.last = next;
    }
    return this.percent;
  }
}

/** os.freemem() 在 Linux 不含可回收的页缓存，会把内存占用夸大到接近满载。 */
export function availableMemory(
  meminfo = () => readFileSync("/proc/meminfo", "utf8"),
) {
  if (process.platform === "linux") {
    try {
      const match = meminfo().match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (match) return Number(match[1]) * 1024;
    } catch {
      // /proc 不可读（容器限制等）时回落到 freemem。
    }
  }
  return os.freemem();
}

/**
 * 单个进程的常驻内存（字节）。Linux 读 /proc/<pid>/status；其余 unix 走
 * `ps`；Windows 没有廉价途径，返回 undefined（前端不显示这一行）。
 */
export function processRssBytes(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const match = readFileSync(`/proc/${pid}/status`, "utf8").match(
        /^VmRSS:\s+(\d+)\s+kB/m,
      );
      if (match) return Number(match[1]) * 1024;
    } catch {
      // 进程刚退出或 /proc 不可读。
    }
    return undefined;
  }
  if (process.platform === "win32") return undefined;
  try {
    const out = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
    });
    const kb = Number(String(out.stdout || "").trim());
    if (Number.isFinite(kb) && kb > 0) return kb * 1024;
  } catch {
    // ps 不可用或进程已退出。
  }
  return undefined;
}

export function hostStats(
  sampler: CpuSampler,
  clients: number,
  servers: { agentId: AgentId; pid: number }[] = [],
): HostStats {
  const memory = process.memoryUsage();
  return {
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.cpus().length,
    cpuPercent: sampler.sample(),
    loadavg: os.loadavg(),
    memTotal: os.totalmem(),
    memAvailable: availableMemory(),
    uptimeSec: Math.round(os.uptime()),
    deck: {
      pid: process.pid,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      clients,
    },
    servers: servers.map((entry) => ({
      agentId: entry.agentId,
      pid: entry.pid,
      rss: processRssBytes(entry.pid),
    })),
  };
}
