import { monitorEventLoopDelay } from "node:perf_hooks";

/** Bounded diagnostics: do not log requests, conversation content or credentials. */
export function startEventLoopHealth() {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    const maxMs = histogram.max / 1e6;
    if (maxMs >= 500)
      console.warn(
        `[health] HTTP event loop stalled: max=${Math.round(maxMs)}ms p99=${Math.round(histogram.percentile(99) / 1e6)}ms (last 30s)`,
      );
    histogram.reset();
  }, 30_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
