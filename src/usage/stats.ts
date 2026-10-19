import { sessionKey, threadUsage } from "../format";
import { mergeProjectGroups, normalizeProjectPath } from "../projects";
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
  /** 被折叠的分支会话数（与父会话合并计费、不重复计数）。 */
  forkCount: number;
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
  // `total` 是 Codex/Claude 的会话累计值；OpenCode 的会话累计改放
  // tokenUsageTotal，所以这里只剩旧的单轮估算会落到下面分支。
  if (usage.total != null) return Math.max(0, usage.total);
  if (usage.used != null) return Math.max(0, usage.used);
  // 缓存输入同样是真实消耗的 token：只加 input+output 时，OpenCode 这类
  // 会话会把 39 万缓存输入漏掉，只剩几百。
  return (
    Math.max(0, usage.input || 0) +
    Math.max(0, usage.cachedInput || 0) +
    Math.max(0, usage.output || 0) +
    Math.max(0, usage.reasoningOutput || 0)
  );
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

/**
 * 分支（fork）会话是从父会话某一时刻复制出来的，原生累计用量本身就
 * 包含复制前那段历史——这部分不是新消耗。
 *
 * 精确口径：fork 时记下父会话当时的累计值（forkUsageBaseline），统计时
 * 用「本会话累计 - 基线」得到这条分支自己新增的消耗，多分支同时活动也
 * 各自累加、互不重复。旧分支没有基线，用家族里最小的累计值当基线
 * （它必然全部来自复制），只能保证不重复计，仍是估算。
 */
function familyKey(thread: ThreadSummary) {
  return `${thread.agentId || ""}|${thread.id}`;
}

function forkRoot(thread: ThreadSummary, byId: Map<string, ThreadSummary>) {
  let current = thread;
  const seen = new Set<string>([familyKey(current)]);
  for (;;) {
    const parentId = current.forkedFromId;
    if (!parentId) return current.id;
    const parent = byId.get(`${current.agentId || ""}|${parentId}`);
    // 父会话已被删除/不在快照里：当前节点就是可见子树的根。
    if (!parent || seen.has(familyKey(parent))) return current.id;
    seen.add(familyKey(parent));
    current = parent;
  }
}

/** 各字段做差，负数按 0 收口（基线缺字段时不会倒扣）。 */
function minusUsage(usage: UsageTotals, baseline?: TokenUsage): UsageTotals {
  if (!baseline) return usage;
  const diff = (value: number, base?: number) =>
    Math.max(0, value - Math.max(0, base || 0));
  return {
    total: diff(usage.total, usageTotal(baseline)),
    input: diff(usage.input, baseline.input),
    cachedInput: diff(usage.cachedInput, baseline.cachedInput),
    output: diff(usage.output, baseline.output),
    reasoningOutput: diff(usage.reasoningOutput, baseline.reasoningOutput),
  };
}

function dedupeForks(threads: ThreadSummary[]) {
  // 分支关系按 agent 隔离：不同供应商可能复用同一个 id。
  const byId = new Map(threads.map((thread) => [familyKey(thread), thread]));
  const families = new Map<string, ThreadSummary[]>();
  for (const thread of threads) {
    const key = `${thread.agentId || ""}|${forkRoot(thread, byId)}`;
    const list = families.get(key);
    if (list) list.push(thread);
    else families.set(key, [thread]);
  }
  const entries: {
    thread: ThreadSummary;
    totals: UsageTotals;
    duplicated: UsageTotals;
  }[] = [];
  for (const list of families.values()) {
    // 家族里最小的累计值：没有基线的旧分支就把它当作复制来的历史。
    const smallest = list.reduce((left, right) =>
      usageTotal(threadUsage(left)) <= usageTotal(threadUsage(right))
        ? left
        : right,
    );
    const fallbackBaseline = usageTotals(threadUsage(smallest));
    // 家族源头（没有 forkedFromId 的那条）的累计值本身就是基线；祖先
    // 已删除时退化为 0，即把它整段算作真实消耗。
    const root = list.find((thread) => !thread.forkedFromId);
    const rootUsage = root ? usageTotals(threadUsage(root)) : undefined;
    let merged: UsageTotals | undefined;
    let exact = true;
    const mergeOwn = (own: UsageTotals) => {
      if (merged) {
        merged.total += own.total;
        merged.input += own.input;
        merged.cachedInput += own.cachedInput;
        merged.output += own.output;
        merged.reasoningOutput += own.reasoningOutput;
      } else {
        merged = { ...own };
      }
    };
    for (const thread of list) {
      const totals = usageTotals(threadUsage(thread));
      const baseline = thread.forkUsageBaseline;
      if (baseline) {
        mergeOwn(minusUsage(totals, baseline));
        continue;
      }
      if (thread.forkedFromId) {
        // 没有基线的旧分支：源头会话还在就用它的累计值当基线；祖先已
        // 删除时无法拆分，退回保守估算（只保留最新一条）。
        if (!rootUsage) {
          exact = false;
          continue;
        }
        mergeOwn(minusUsage(totals, rootUsage));
        continue;
      }
      // 源头会话整体计入（它就是家族的起点）。
      mergeOwn(totals);
    }
    if (merged && exact) {
      // 基线齐全：总量是各分支新增之和，比任何单条分支都大，用它代表
      // 这条线（列表里仍展示最新活动的那个分支）。
      const newest = list.reduce((left, right) =>
        left.updatedAt >= right.updatedAt ? left : right,
      );
      if (list.length === 1) {
        // 单条会话不属于分支家族，直接用它自己的累计值。
        entries.push({
          thread: newest,
          totals: usageTotals(threadUsage(newest)),
          duplicated: emptyTotals(),
        });
        continue;
      }
      // 每个分支累计值里复制来的历史已从 merged 中排除，费用扣减就按
      // 这些基线算；否则合并后的账单会凭空多出几倍。
      // 总量是各分支新增之和（没有重复计入的复制历史），费用无需再扣。
      const duplicated = emptyTotals();
      entries.push({ thread: newest, totals: merged, duplicated });
      continue;
    }
    // 旧分支没有基线：只能保留最新一条，扣掉被复制的那段历史。
    const newest = list.reduce((left, right) =>
      left.updatedAt >= right.updatedAt ? left : right,
    );
    entries.push({
      thread: newest,
      totals: usageTotals(threadUsage(newest)),
      duplicated: list.length > 1 ? fallbackBaseline : emptyTotals(),
    });
  }
  return entries;
}

export function buildUsageStats(
  threads: ThreadSummary[],
  projects: ProjectRecord[] = [],
) {
  const allThreads = dedupeThreads(threads);
  const forks = dedupeForks(allThreads);
  const uniqueThreads = forks.map((entry) => entry.thread);
  const keptKeys = new Set(uniqueThreads.map((thread) => sessionKey(thread)));
  const forkBranches = allThreads.filter(
    (thread) => thread.forkedFromId && !keptKeys.has(sessionKey(thread)),
  );
  const sessions = forks
    .filter((entry) => entry.totals.total > 0)
    .map((entry) => ({
      key: sessionKey(entry.thread),
      thread: entry.thread,
      /** 家族内的真实消耗（有基线时是各分支新增之和）。 */
      totals: entry.totals,
      /**
       * 分支复制来的历史部分：原生累计值里已含这段，费用估算按它扣减，
       * 否则一次分支就让账单凭空翻倍。
       */
      duplicated: entry.duplicated,
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
  // 项目行要保留被折叠的分支（否则项目里看不到「另有 N 个分支」），
  // 但合计只来自 kept 会话。
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
        forkCount: forkBranches.filter(
          (thread) => !keptKeys.has(sessionKey(thread)) &&
            normalizeProjectPath(thread.cwd) === project.key,
        ).length,
      };
    })
    .filter((project) => project.sessionCount > 0)
    .sort((left, right) => right.totals.total - left.totals.total);

  return { totals, projects: projectRows, sessions };
}
