import { Worker } from "node:worker_threads";

export type BackgroundTask =
  | "host"
  | "cc"
  | "history"
  | "historyBranch"
  | "codexBins"
  | "agentBins"
  | "search";
export class BackgroundWorkError extends Error {
  constructor(
    message: string,
    readonly statusCode = 503,
  ) {
    super(message);
  }
}
interface Job {
  id: number;
  task: BackgroundTask;
  args: unknown[];
  resolve(value: any): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}
interface Lane {
  worker: Worker;
  jobs: Job[];
  active?: Job;
  stopped: boolean;
}

function createWorker() {
  const entry = new URL("./background-worker.js", import.meta.url);
  if (import.meta.url.endsWith(".ts"))
    entry.pathname = entry.pathname.replace(/\.js$/, ".ts");
  return new Worker(
    `const { workerData } = require('node:worker_threads');
    (async () => { if (workerData.endsWith('.ts')) {
      const { tsImport } = await import('tsx/esm/api');
      await tsImport(workerData, require('node:url').pathToFileURL(__filename).href);
    } else { await import(workerData); } })().catch(e => { throw e; });`,
    {
      eval: true,
      workerData: entry.href,
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    },
  );
}

/** One active job per lane. Limits include queued time; failures never run work on the HTTP thread. */
export class BackgroundPool {
  private lanes = new Map<string, Lane>();
  private sequence = 0;
  private retiring = new Map<Worker, Promise<unknown>>();
  private closed = false;
  constructor(
    private factory = createWorker,
    private capacity = 16,
    private timeoutMs = 30_000,
  ) {}

  run<T>(task: BackgroundTask, args: unknown[]): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new BackgroundWorkError("Background service is closing"),
      );
    const key =
      task === "agentBins"
        ? "codexBins"
        : task === "historyBranch"
          ? "history"
          : task;
    let lane = this.lanes.get(key);
    if (!lane) {
      if (this.lanes.size + this.retiring.size >= 8)
        return Promise.reject(
          new BackgroundWorkError("Background worker capacity exhausted"),
        );
      try {
        const worker = this.factory();
        lane = { worker, jobs: [], stopped: false };
        const current = lane;
        this.lanes.set(key, lane);
        worker.on("error", () =>
          this.fail(
            key,
            current,
            new BackgroundWorkError("Background worker failed"),
          ),
        );
        worker.on("exit", () =>
          this.fail(
            key,
            current,
            new BackgroundWorkError("Background worker exited"),
          ),
        );
        worker.on("message", ({ id, value, error }) => {
          const job = current.active;
          if (!job || job.id !== id || current.stopped) return;
          current.active = undefined;
          clearTimeout(job.timer);
          if (error) {
            const failure = new BackgroundWorkError(
              error.message || "Background task failed",
              error.statusCode || 503,
            );
            Object.assign(failure, { code: error.code });
            job.reject(failure);
          } else job.resolve(value);
          this.dispatch(key, current);
        });
        worker.unref();
      } catch {
        return Promise.reject(
          new BackgroundWorkError("Background worker could not start"),
        );
      }
    }
    if (lane.jobs.length + Number(Boolean(lane.active)) >= this.capacity)
      return Promise.reject(
        new BackgroundWorkError("Background work queue is full; retry later"),
      );
    const current = lane;
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        id: ++this.sequence,
        task,
        args,
        resolve,
        reject,
        timer: setTimeout(() => {
          const error = new BackgroundWorkError(
            "Background work timed out",
            504,
          );
          if (current.active === job) this.fail(key, current, error);
          else {
            current.jobs = current.jobs.filter((item) => item !== job);
            reject(error);
          }
        }, this.timeoutMs),
      };
      current.jobs.push(job);
      this.dispatch(key, current);
    });
  }

  private dispatch(key: string, lane: Lane) {
    if (lane.stopped || lane.active) return;
    const job = lane.jobs.shift();
    if (!job) {
      lane.worker.unref();
      return;
    }
    lane.active = job;
    lane.worker.ref();
    try {
      lane.worker.postMessage({ id: job.id, task: job.task, args: job.args });
    } catch {
      this.fail(
        key,
        lane,
        new BackgroundWorkError("Background task could not be transferred"),
      );
    }
  }

  private fail(key: string, lane: Lane, error: Error) {
    if (lane.stopped) return;
    lane.stopped = true;
    if (this.lanes.get(key) === lane) this.lanes.delete(key);
    for (const job of [...(lane.active ? [lane.active] : []), ...lane.jobs]) {
      clearTimeout(job.timer);
      job.reject(error);
    }
    lane.jobs = [];
    lane.active = undefined;
    const termination = lane.worker.terminate().catch(() => {});
    this.retiring.set(lane.worker, termination);
    void termination.finally(() => this.retiring.delete(lane.worker));
  }

  close() {
    this.closed = true;
    for (const [key, lane] of this.lanes)
      this.fail(
        key,
        lane,
        new BackgroundWorkError("Background service is closing"),
      );
    return Promise.allSettled(this.retiring.values()).then(() => {});
  }
}
const pool = new BackgroundPool();
export const backgroundWork = <T>(task: BackgroundTask, args: unknown[]) =>
  pool.run<T>(task, args);
export const closeBackgroundWork = () => pool.close();
