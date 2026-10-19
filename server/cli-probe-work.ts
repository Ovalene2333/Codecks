/** Version subprocesses stay on the main loop so their timeout/cleanup survives worker restarts. */
let active = 0;
let closed = false;
const queue: { start(): void; cancel(): void }[] = [];
export function cliProbeWork<T>(
  operation: () => Promise<T>,
): Promise<T | undefined> {
  if (closed || queue.length >= 32) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const start = () => {
      active++;
      Promise.resolve()
        .then(operation)
        .then(resolve, reject)
        .finally(() => {
          active--;
          queue.shift()?.start();
        });
    };
    if (active < 4) start();
    else queue.push({ start, cancel: () => resolve(undefined) });
  });
}
export function closeCliProbes() {
  closed = true;
  for (const job of queue.splice(0)) job.cancel();
}
