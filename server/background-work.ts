import { Worker } from "node:worker_threads";

export type BackgroundTask = "host" | "cc" | "history" | "codexBins" | "agentBins";
interface Pending { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }
const lanes = new Map<string, { worker: Worker; pending: Map<number, Pending> }>();
let sequence = 0;

/** Separate bounded lanes keep slow disk/OS work off the HTTP event loop. */
export function backgroundWork<T>(task: BackgroundTask, args: unknown[]): Promise<T> {
  const key = task === "agentBins" ? "codexBins" : task;
  let lane = lanes.get(key);
  if (!lane) {
    const entry = new URL("./background-worker.js", import.meta.url);
    // tsx's loader must be registered inside worker threads in source mode.
    if (import.meta.url.endsWith(".ts")) entry.pathname = entry.pathname.replace(/\.js$/, ".ts");
    const worker = new Worker(`const { workerData } = require('node:worker_threads');
      (async () => { if (workerData.endsWith('.ts')) {
        const { tsImport } = await import('tsx/esm/api');
        await tsImport(workerData, require('node:url').pathToFileURL(__filename).href);
      } else { await import(workerData); } })().catch(e => { throw e; });`,
      { eval: true, workerData: entry.href });
    const current = { worker, pending: new Map<number, Pending>() };
    lane = current;
    lanes.set(key, current);
    const fail = (error: Error) => {
      if (lanes.get(key) === current) lanes.delete(key);
      for (const item of current.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      current.pending.clear();
      void worker.terminate();
    };
    worker.on("error", fail);
    worker.on("exit", () => fail(new Error("Background worker exited")));
    worker.on("message", ({ id, value, error }) => {
      const item = current.pending.get(id);
      if (!item) return;
      current.pending.delete(id);
      clearTimeout(item.timer);
      if (error) item.reject(new Error(error)); else item.resolve(value);
      if (!current.pending.size) worker.unref();
    });
    worker.unref();
  }
  if (lane.pending.size >= 32) return Promise.reject(new Error("Background work queue is full"));
  const current = lane;
  return new Promise<T>((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      // Terminate the lane: a synchronous OS call cannot be cancelled individually.
      for (const item of current.pending.values()) { clearTimeout(item.timer); item.reject(new Error("Background work timed out")); }
      current.pending.clear();
      if (lanes.get(key) === current) lanes.delete(key);
      void current.worker.terminate();
    }, 30_000);
    current.pending.set(id, { resolve, reject, timer });
    current.worker.ref();
    current.worker.postMessage({ id, task, args });
  });
}
