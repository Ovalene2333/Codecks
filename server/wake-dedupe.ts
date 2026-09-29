/** Coalesce retries of the same external wake signal, including concurrent POSTs. */
export class WakeDeduper<T> {
  private entries = new Map<string, { expiresAt: number; result: Promise<T> }>();

  constructor(private readonly ttlMs = 5 * 60_000) {}

  run(code: string, prompt: string, send: () => Promise<T>): Promise<T> {
    const now = Date.now();
    for (const [key, entry] of this.entries)
      if (entry.expiresAt <= now) this.entries.delete(key);
    const key = JSON.stringify([code, prompt]);
    const existing = this.entries.get(key);
    if (existing) return existing.result;
    const result = Promise.resolve().then(send);
    this.entries.set(key, { expiresAt: Infinity, result });
    void result.then(
      () => {
        const entry = this.entries.get(key);
        if (entry?.result === result) entry.expiresAt = Date.now() + this.ttlMs;
      },
      () => {
        if (this.entries.get(key)?.result === result) this.entries.delete(key);
      },
    );
    return result;
  }
}
