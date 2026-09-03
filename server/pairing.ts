import { createHmac } from "node:crypto";

/**
 * Rotating 6-digit pairing codes. The code is derived from the session
 * secret plus a time window, so a fresh browser can log in by typing what the
 * terminal shows instead of copying the long token. The previous window stays
 * valid so typing across a boundary does not fail.
 */
export class Pairing {
  readonly secret: string;
  readonly windowMs: number;
  private timer?: NodeJS.Timeout;

  constructor(secret: string, windowMs = 60_000) {
    this.secret = secret;
    this.windowMs = windowMs;
  }

  current() {
    return codeFor(Math.floor(Date.now() / this.windowMs), this.secret);
  }

  verify(code: string) {
    const clean = code.trim();
    if (!/^\d{6}$/.test(clean)) return false;
    const epoch = Math.floor(Date.now() / this.windowMs);
    return (
      clean === codeFor(epoch, this.secret) ||
      clean === codeFor(epoch - 1, this.secret)
    );
  }

  start(onPrint: (code: string) => void) {
    onPrint(this.current());
    this.timer = setInterval(() => onPrint(this.current()), this.windowMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

export function codeFor(epoch: number, secret: string) {
  const digest = createHmac("sha256", secret)
    .update(String(epoch))
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export class PairRateLimiter {
  private attempts = new Map<string, { failures: number; lockedUntil: number }>();

  allowed(ip: string) {
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry) return true;
    if (entry.lockedUntil > now) return false;
    if (entry.failures >= 5) {
      entry.failures = 0;
      entry.lockedUntil = now + 30_000;
      return false;
    }
    return true;
  }

  failed(ip: string) {
    const now = Date.now();
    const entry = this.attempts.get(ip) || { failures: 0, lockedUntil: 0 };
    entry.failures += 1;
    if (entry.failures >= 5) entry.lockedUntil = now + 30_000;
    this.attempts.set(ip, entry);
  }

  ok(ip: string) {
    this.attempts.delete(ip);
  }
}
