import { estimateCost } from "../shared/usage-cost.js";
import type { RateLimits, TokenUsage } from "./types.js";

interface Counter {
  tokens: number;
  cost: number;
}
interface Baseline extends Counter {
  percent: number;
  lastPercent: number;
  resetsAt: number;
  duration: number;
}
export interface AccountQuotaSample {
  stageTokens: number;
  stageCost: number;
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

/** Pair live usage with quota observations. History totals must never enter this ledger. */
export class AccountQuotaTracker {
  private counters = new Map<string, Counter>();
  private baselines = new Map<string, Baseline>();
  private current: AccountQuotaSample[] = [];
  private scope = "";

  record(
    providerId: string,
    previous: TokenUsage | undefined,
    next: TokenUsage,
    model?: string,
  ) {
    // An unknown cumulative starting point may contain months of history or a fork.
    if (!previous || previous.total == null || next.total == null) return;
    const tokens = Math.max(0, next.total - previous.total);
    if (!tokens) return;
    const delta = {
      input: Math.max(0, (next.input ?? 0) - (previous.input ?? 0)),
      cachedInput: Math.max(
        0,
        (next.cachedInput ?? 0) - (previous.cachedInput ?? 0),
      ),
      output: Math.max(0, (next.output ?? 0) - (previous.output ?? 0)),
    };
    // No token breakdown means there is no defensible dollar estimate.
    if (!delta.input && !delta.cachedInput && !delta.output) return;
    const counter = this.counters.get(providerId) ?? { tokens: 0, cost: 0 };
    this.counters.set(providerId, {
      tokens: counter.tokens + tokens,
      cost: counter.cost + estimateCost(delta, model),
    });
  }

  observe(
    account: string,
    limits: RateLimits | null | undefined,
    providerIds: ReadonlySet<string>,
    now = Date.now(),
  ) {
    const scope = JSON.stringify([account, [...providerIds].sort()]);
    if (scope !== this.scope) {
      this.baselines.clear();
      this.scope = scope;
    }
    this.current = [];
    const total = { tokens: 0, cost: 0 };
    for (const id of providerIds) {
      const counter = this.counters.get(id);
      if (counter) {
        total.tokens += counter.tokens;
        total.cost += counter.cost;
      }
    }
    for (const [id, window] of Object.entries({
      primary: limits?.primary,
      secondary: limits?.secondary,
    })) {
      const percent = window?.usedPercent;
      const duration = window?.windowDurationMins;
      const resetsAt =
        window?.resetsAt ??
        (window?.resetAfterSeconds != null
          ? now + window.resetAfterSeconds * 1000
          : undefined);
      if (
        percent == null ||
        !Number.isFinite(percent) ||
        percent < 0 ||
        percent > 100 ||
        !duration ||
        !resetsAt ||
        resetsAt <= now
      ) {
        this.baselines.delete(id);
        continue;
      }
      const base = this.baselines.get(id);
      // Reset time changes, percentage drops, and expiry all start a fresh cycle.
      if (
        !base ||
        base.resetsAt <= now ||
        Math.abs(base.resetsAt - resetsAt) > 2000 ||
        base.duration !== duration ||
        percent < base.lastPercent
      ) {
        this.baselines.set(id, {
          ...total,
          percent,
          lastPercent: percent,
          resetsAt,
          duration,
        });
        continue;
      }
      base.lastPercent = percent;
      const stageTokens = total.tokens - base.tokens;
      const stageCost = total.cost - base.cost;
      const usedPercent = percent - base.percent;
      if (stageTokens > 0 && stageCost > 0 && usedPercent > 0) {
        this.current.push({
          stageTokens,
          stageCost,
          usedPercent,
          windowDurationMins: duration,
          resetsAt,
        });
      }
    }
  }

  samples(now = Date.now()) {
    return this.current.filter((sample) => sample.resetsAt > now);
  }
}
