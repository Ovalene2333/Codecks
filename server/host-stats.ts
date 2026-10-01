import { readFileSync } from "node:fs";
import os from "node:os";
import type { HostStats } from "./types.js";

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

export function hostStats(sampler: CpuSampler, clients: number): HostStats {
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
  };
}
