export type Clock = {
  now: () => number;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
};

export type LineStream = {
  write: (chunk: string) => unknown;
  isTTY?: boolean;
};

const defaultClock: Clock = {
  now: Date.now,
  setInterval,
  clearInterval,
};

export function writeLine(stream: LineStream, message: string) {
  stream.write(`${message}\n`);
}

export function formatElapsed(ms: number) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

export function startPhase(
  message: string,
  options: {
    stream?: LineStream;
    waitingLabel?: string;
    intervalMs?: number;
    clock?: Clock;
  } = {},
) {
  const stream = options.stream ?? process.stdout;
  const waitingLabel = options.waitingLabel ?? "仍在等待";
  const clock = options.clock ?? defaultClock;
  const tty = Boolean(stream.isTTY);
  const intervalMs = options.intervalMs ?? (tty ? 200 : 3_000);
  const started = clock.now();
  writeLine(stream, message);

  const renderWait = () => {
    const elapsed = clock.now() - started;
    if (tty) {
      stream.write(`\r${waitingLabel}… ${formatElapsed(elapsed)}   `);
      return;
    }
    stream.write(
      `${waitingLabel}… ${Math.max(1, Math.round(elapsed / 1000))}s\n`,
    );
  };

  const timer = clock.setInterval(renderWait, intervalMs);
  if (typeof timer === "object" && timer && "unref" in timer) timer.unref();

  const finish = (detail: string) => {
    clock.clearInterval(timer);
    if (tty) stream.write("\r\x1b[K");
    writeLine(stream, `${detail}（${formatElapsed(clock.now() - started)}）`);
    return clock.now() - started;
  };

  return {
    done: finish,
    fail: finish,
  };
}
