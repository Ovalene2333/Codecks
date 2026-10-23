import { sessionKey } from "../format";
import type { Approval, ThreadActivity, ThreadSummary } from "../types";
import { stalledFor, threadIsActive, turnStartedAt } from "./activity";
import { activityKey } from "./activity-store";

/** ok 完成 / fail 失败 / stop 被中断 */
export type TurnTone = "ok" | "fail" | "stop";

export function turnTone(status: string): TurnTone {
  if (status === "failed" || status === "error") return "fail";
  if (status === "interrupted" || status === "cancelled") return "stop";
  return "ok";
}

export interface HomeItem {
  key: string;
  thread: ThreadSummary;
  activity?: ThreadActivity;
}

export interface RunningItem extends HomeItem {
  startedAt: number;
  /** 运行中却长时间没有事件：已安静的毫秒数。 */
  stalled?: number;
}

export interface HomeBoard {
  /** 等你输入 / 失败。有审批的会话由审批卡片承接，不在这里重复。 */
  attention: HomeItem[];
  /** 结束了但你还没看的会话，最新在前。 */
  unseen: HomeItem[];
  /** 疑似卡住的在前，其余跑得最久的在前（顺序稳定，不随秒表跳动）。 */
  running: RunningItem[];
  /** 所有状态的会话，按最近活动排序。 */
  recent: HomeItem[];
}

/** 这一轮什么时候结束的：追踪器没记到（Deck 重启过）时退回 updatedAt。 */
export const finishedAt = (item: HomeItem) =>
  item.activity?.lastTurn?.endedAt ?? item.thread.updatedAt;

/** 元数据可能滞后于实时活动，排序和显示使用同一时间。 */
export const recentActivityAt = (item: HomeItem) => Math.max(
  item.thread.updatedAt,
  item.activity?.lastEventAt ?? 0,
  item.activity?.turnStartedAt ?? 0,
  item.activity?.lastTurn?.endedAt ?? 0,
);

/** 状态分组互斥；最近会话独立收录所有状态。 */
export function buildHomeBoard({
  threads,
  activities,
  pendingOf,
  unseenSessions,
  now,
  recentLimit,
}: {
  threads: ThreadSummary[];
  activities: ReadonlyMap<string, ThreadActivity>;
  pendingOf: (thread: ThreadSummary) => Approval[] | undefined;
  unseenSessions: ReadonlySet<string>;
  now: number;
  recentLimit: number;
}): HomeBoard {
  const board: HomeBoard = { attention: [], unseen: [], running: [], recent: [] };
  for (const thread of threads) {
    const key = sessionKey(thread);
    const agentKey = activityKey(thread.agentId, thread.id);
    const activity = activities.get(agentKey);
    const item = { key, thread, activity };
    board.recent.push(item);
    if (pendingOf(thread)?.length) continue;
    if (thread.status === "waiting" || thread.status === "error")
      board.attention.push(item);
    else if (threadIsActive(thread))
      board.running.push({
        ...item,
        startedAt: turnStartedAt(thread, activity) ?? thread.updatedAt,
        stalled: stalledFor(thread, activity, now),
      });
    else if (thread.ask) continue;
    else if (unseenSessions.has(key)) board.unseen.push(item);
  }
  const byKey = (a: HomeItem, b: HomeItem) => (a.key < b.key ? -1 : 1);
  board.attention.sort(
    (a, b) =>
      Number(a.thread.status === "error") - Number(b.thread.status === "error") ||
      b.thread.updatedAt - a.thread.updatedAt ||
      byKey(a, b),
  );
  board.unseen.sort((a, b) => finishedAt(b) - finishedAt(a) || byKey(a, b));
  board.running.sort(
    (a, b) =>
      Number(b.stalled != null) - Number(a.stalled != null) ||
      a.startedAt - b.startedAt ||
      byKey(a, b),
  );
  board.recent = board.recent
    .sort((a, b) => recentActivityAt(b) - recentActivityAt(a) || byKey(a, b))
    .slice(0, recentLimit);
  return board;
}

/** 回复开头的纯文本预览：去掉代码块与常见 Markdown 记号，压成一段。 */
export function replyPreview(text?: string) {
  if (!text) return "";
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
