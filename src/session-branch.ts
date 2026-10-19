import { sessionKey } from "./format";
import type { ThreadSummary } from "./types";

/** 一条会话在分支树里的位置。key 是 sessionKey，跨库可用。 */
export interface SessionBranchRelation {
  /** 直接父会话的 sessionKey；根会话没有。 */
  parent?: string;
  /** 直接父会话的 id，用于在当前库里定位。 */
  parentId?: string;
  /** 直接子分支的 sessionKey，按最近活动排序。 */
  children: string[];
  /** 从根算起的层级，根为 0。 */
  depth: number;
}

/**
 * 从会话列表推导分支关系。只依赖 `forkedFromId`，所以刷新、重启和
 * 归档库都能用同一份结果；父会话不在当前列表（被删或不在本库）时，
 * 该会话就是可见子树的根。
 */
export function branchRelations(
  threads: ThreadSummary[],
): Map<string, SessionBranchRelation> {
  const byId = new Map<string, ThreadSummary[]>();
  for (const thread of threads) {
    const list = byId.get(thread.id) || [];
    list.push(thread);
    byId.set(thread.id, list);
  }
  // 只按 id 找父：fork 关系是同一 agent 内的，跨 agent 同名 id 不作为父。
  const parentKey = (thread: ThreadSummary): string | undefined => {
    const parentId = thread.forkedFromId;
    if (!parentId) return undefined;
    const candidates = (byId.get(parentId) || []).filter(
      (item) => (item.agentId || "codex") === (thread.agentId || "codex"),
    );
    if (!candidates.length) return undefined;
    // 同一 id 在 active/archived 各一份时，取最近更新的那条，保持稳定。
    const parent = candidates.reduce((best, item) =>
      item.updatedAt > best.updatedAt ? item : best,
    );
    return sessionKey(parent);
  };

  const relations = new Map<string, SessionBranchRelation>();
  for (const thread of threads) {
    const key = sessionKey(thread);
    if (relations.has(key)) continue;
    relations.set(key, {
      parent: parentKey(thread),
      parentId: thread.forkedFromId,
      children: [],
      depth: 0,
    });
  }

  const ordered = [...threads].sort((left, right) => right.updatedAt - left.updatedAt);
  for (const thread of ordered) {
    const relation = relations.get(sessionKey(thread));
    if (!relation?.parent) continue;
    const parent = relations.get(relation.parent);
    if (!parent || parent.children.includes(sessionKey(thread))) continue;
    parent.children.push(sessionKey(thread));
  }

  // 深度要沿父链走；父链也许跨出当前列表（父缺失时当前节点按根算），
  // 加环保护防止手工/异常数据把递归卡死。
  const depthOf = (key: string, seen = new Set<string>()): number => {
    const relation = relations.get(key);
    if (!relation?.parent || seen.has(key)) return 0;
    seen.add(key);
    return depthOf(relation.parent, seen) + 1;
  };
  for (const [key, relation] of relations) relation.depth = depthOf(key);
  return relations;
}

/** 取会话的分支关系；rootDepth 表示它自己是第几层分支（0=根）。 */
export function branchInfo(
  key: string,
  relations: ReadonlyMap<string, SessionBranchRelation>,
) {
  const relation = relations.get(key);
  return {
    // 父会话已删除时没有 parent 键，但它本身仍是一次分支，只是可见子树的根。
    isBranch: Boolean(relation?.parent || relation?.parentId),
    depth: relation?.depth ?? 0,
    childCount: relation?.children.length ?? 0,
  };
}
