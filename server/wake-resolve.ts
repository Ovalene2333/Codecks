import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentId, ThreadSummary } from "./types.js";

/**
 * deck-wake 的「这条命令来自哪个会话」判定。
 *
 * 只用只读、确定性的线索，不往会话里注入任何内容：
 * 1. agent 自己给 shell 设的会话标识（Codex 的 CODEX_THREAD_ID；Deck 拉起
 *    Claude 会话进程时附带的 CODEX_DECK_SESSION）。
 * 2. 进程树：watcher 脚本的祖先里有哪个 Deck 托管的 agent 后端进程，
 *    就是哪个 agent；再在该 agent 正在跑回合的会话里按工作目录收窄。
 *
 * 线索不足或有歧义时拒绝猜测，把候选交给 agent 去问用户——宁可多问一句，
 * 也不要把唤醒投到别的会话。
 */

export interface WakeResolveInput {
  /** `CODEX_DECK_SESSION`：`<agentId>:<threadId>`。 */
  session?: string;
  /** Codex 给 shell 设的 `CODEX_THREAD_ID`。 */
  codexThread?: string;
  /** 脚本进程自身及其祖先 pid（由近到远）。 */
  ancestors: number[];
  /** 脚本运行时的工作目录。 */
  cwd?: string;
}

export interface WakeResolveContext {
  /** 未归档的会话。 */
  threads: ThreadSummary[];
  /** Deck 托管的 agent 后端进程。 */
  runtimePids: { agentId: AgentId; pid: number }[];
}

export type WakeResolution =
  | {
      ok: true;
      agentId: AgentId;
      threadId: string;
      thread: ThreadSummary;
      /** 判定依据，展示给 agent/用户。 */
      via: string;
      /** 进程树里找到的 agent（可能为空）。 */
      agents: AgentId[];
    }
  | {
      ok: false;
      error: string;
      agents: AgentId[];
      candidates: ThreadSummary[];
    };

const agentOf = (thread: ThreadSummary) => (thread.agentId || "codex") as AgentId;

const busy = (thread: ThreadSummary) =>
  thread.status === "running" || thread.status === "waiting" || Boolean(thread.activeTurnId);

const normalize = (value: string) => {
  const trimmed = value.replace(/[\\/]+$/, "");
  return trimmed || "/";
};

/** dir 是否等于 base 或在 base 之下。 */
export function within(dir: string, base: string) {
  if (!dir || !base) return false;
  const d = normalize(dir);
  const b = normalize(base);
  return d === b || d.startsWith(b === "/" ? "/" : `${b}/`);
}

export function resolveWakeSession(
  input: WakeResolveInput,
  context: WakeResolveContext,
): WakeResolution {
  const ancestors = new Set(input.ancestors);
  const agents = [
    ...new Set(
      context.runtimePids
        .filter((entry) => ancestors.has(entry.pid))
        .map((entry) => entry.agentId),
    ),
  ];
  const find = (agentId: string, threadId: string) =>
    context.threads.find(
      (thread) => agentOf(thread) === agentId && thread.id === threadId,
    );
  // 环境变量会被子进程继承：Deck 本身若是从某个 agent 会话里启动的，
  // 它拉起的其它 agent 也会带着那个会话的变量。进程树明确指向别的
  // agent 时，这类变量不可信。
  const trusted = (agentId: AgentId) => !agents.length || agents.includes(agentId);
  const failure = (error: string, candidates: ThreadSummary[] = []): WakeResolution => ({
    ok: false,
    error,
    agents,
    candidates,
  });

  if (input.session) {
    const at = input.session.indexOf(":");
    if (at > 0) {
      const agentId = input.session.slice(0, at) as AgentId;
      const thread = find(agentId, input.session.slice(at + 1));
      if (thread && trusted(agentId))
        return { ok: true, agentId, threadId: thread.id, thread, via: "CODEX_DECK_SESSION", agents };
    }
  }
  if (input.codexThread) {
    const thread = find("codex", input.codexThread);
    if (thread && trusted("codex"))
      return { ok: true, agentId: "codex", threadId: thread.id, thread, via: "CODEX_THREAD_ID", agents };
  }
  if (!agents.length)
    return failure("无法判断命令来自哪个会话：进程树里没有 Deck 托管的 agent，也没有会话标识环境变量");

  const running = context.threads.filter(
    (thread) => agents.includes(agentOf(thread)) && !thread.archived && busy(thread),
  );
  const pick = (thread: ThreadSummary, how: string): WakeResolution => ({
    ok: true,
    agentId: agentOf(thread),
    threadId: thread.id,
    thread,
    via: how,
    agents,
  });
  if (running.length === 1) return pick(running[0], "进程树 + 唯一运行中的会话");
  if (!running.length) return failure("进程树指向的 agent 当前没有正在运行的会话");
  // 多个会话同时在跑：按工作目录收窄，取目录最深的那一层。
  const cwd = input.cwd || "";
  const matched = running.filter((thread) => within(cwd, thread.cwd));
  const depth = Math.max(-1, ...matched.map((thread) => normalize(thread.cwd).length));
  const deepest = matched.filter((thread) => normalize(thread.cwd).length === depth);
  if (deepest.length === 1) return pick(deepest[0], "进程树 + 工作目录");
  return failure(
    "有多个同时运行的会话都可能发起了这条命令，无法确定是哪一个",
    deepest.length ? deepest : running,
  );
}

/**
 * 显式代号是否与判定出的会话冲突：判定成功且是另一个会话，或进程树
 * 明确指向别的 agent。冲突时返回实际发起的会话（或进程树里的 agent 列表）；
 * 无冲突（含无从判断）返回 undefined。
 */
export function bindingConflict(
  target: { agentId: AgentId; threadId: string },
  resolution: WakeResolution,
): ThreadSummary | AgentId[] | undefined {
  if (resolution.ok)
    return resolution.agentId === target.agentId && resolution.threadId === target.threadId
      ? undefined
      : resolution.thread;
  if (resolution.agents.length && !resolution.agents.includes(target.agentId))
    return resolution.agents;
  return undefined;
}

const execFileAsync = promisify(execFile);
const MAX_DEPTH = 64;

async function parentOf(pid: number): Promise<number | undefined> {
  if (process.platform === "linux") {
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    // comm 可能含空格和括号：从最后一个 ")" 之后数，第 2 个字段是 ppid。
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
  }
  const { stdout } = await execFileAsync("ps", ["-o", "ppid=", "-p", String(pid)]);
  const ppid = Number(stdout.trim());
  return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
}

/** pid 自身及其祖先（由近到远），读不到即止；Windows 返回空。 */
export async function ancestorPids(pid: number): Promise<number[]> {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 1) return [];
  const chain: number[] = [pid];
  let current = pid;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const parent = await parentOf(current).catch(() => undefined);
    if (!parent || parent === current || chain.includes(parent)) break;
    chain.push(parent);
    if (parent === 1) break;
    current = parent;
  }
  return chain;
}

/** 候选会话的一行描述，供错误信息列给 agent。 */
export const describeThread = (thread: ThreadSummary) =>
  `${agentOf(thread)} · ${thread.name || thread.id} · ${thread.cwd ? path.basename(thread.cwd) : "-"}`;
