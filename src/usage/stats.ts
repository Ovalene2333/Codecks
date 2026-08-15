import { sessionKey } from "../format";
import { mergeProjectGroups } from "../projects";
import type { ProjectRecord, ThreadSummary, TokenUsage } from "../types";

export interface UsageTotals {
  total: number;
  input: number;
  cachedInput: number;
  output: number;
  reasoningOutput: number;
}

export interface SessionUsageRow {
  key: string;
  thread: ThreadSummary;
  totals: UsageTotals;
}

export interface ProjectUsageRow {
  key: string;
  name: string;
  cwd: string;
  sessionCount: number;
  totals: UsageTotals;
}

const emptyTotals = (): UsageTotals => ({
  total: 0,
  input: 0,
  cachedInput: 0,
  output: 0,
  reasoningOutput: 0,
});

export function usageTotal(usage?: TokenUsage) {
  if (!usage) return 0;
  if (usage.total != null) return Math.max(0, usage.total);
  if (usage.used != null) return Math.max(0, usage.used);
  return Math.max(0, usage.input || 0) + Math.max(0, usage.output || 0);
}

export function usageTotals(usage?: TokenUsage): UsageTotals {
  return {
    total: usageTotal(usage),
    input: Math.max(0, usage?.input || 0),
    cachedInput: Math.max(0, usage?.cachedInput || 0),
    output: Math.max(0, usage?.output || 0),
    reasoningOutput: Math.max(0, usage?.reasoningOutput || 0),
  };
}

function addUsage(target: UsageTotals, source: UsageTotals) {
  target.total += source.total;
  target.input += source.input;
  target.cachedInput += source.cachedInput;
  target.output += source.output;
  target.reasoningOutput += source.reasoningOutput;
  return target;
}

export function dedupeThreads(threads: ThreadSummary[]) {
  const unique = new Map<string, ThreadSummary>();
  for (const thread of threads) {
    const key = sessionKey(thread);
    const previous = unique.get(key);
    if (!previous || thread.updatedAt > previous.updatedAt)
      unique.set(key, thread);
  }
  return [...unique.values()];
}

export function buildUsageStats(
  threads: ThreadSummary[],
  projects: ProjectRecord[] = [],
) {
  const uniqueThreads = dedupeThreads(threads);
  const sessions = uniqueThreads
    .filter((thread) => usageTotal(thread.tokenUsage) > 0)
    .map((thread) => ({
      key: sessionKey(thread),
      thread,
      totals: usageTotals(thread.tokenUsage),
    }))
    .sort(
      (left, right) =>
        right.totals.total - left.totals.total ||
        right.thread.updatedAt - left.thread.updatedAt,
    );
  const totals = sessions.reduce(
    (sum, row) => addUsage(sum, row.totals),
    emptyTotals(),
  );
  const totalsBySession = new Map(sessions.map((row) => [row.key, row.totals]));
  const projectRows = mergeProjectGroups(projects, uniqueThreads)
    .map((project) => {
      const projectTotals = project.sessions.reduce((sum, thread) => {
        const usage = totalsBySession.get(sessionKey(thread));
        return usage ? addUsage(sum, usage) : sum;
      }, emptyTotals());
      return {
        key: project.key,
        name: project.name,
        cwd: project.cwd,
        sessionCount: project.sessions.filter((thread) =>
          totalsBySession.has(sessionKey(thread)),
        ).length,
        totals: projectTotals,
      };
    })
    .filter((project) => project.sessionCount > 0)
    .sort((left, right) => right.totals.total - left.totals.total);

  return { totals, projects: projectRows, sessions };
}
