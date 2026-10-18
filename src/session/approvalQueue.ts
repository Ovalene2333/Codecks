import { useEffect, useRef, useState } from "react";
import type { Approval, ApprovalResolveBody } from "../types";
import type { ApprovalDraft } from "./ApprovalCard";
import { bulkApprovableApprovals, isGoneError } from "./approvalBulk";

/**
 * 审批队列的公共状态：一次处理一条，翻页、处理中锁、错误、草稿与
 * 「全部允许」。全局浮窗与会话页输入框上方的审批条共用；处理完停在
 * 同一位置，下一条自动顶上来。
 */
export function useApprovalQueue(
  approvals: Approval[],
  onResolve: (id: string, body: ApprovalResolveBody) => void | Promise<void>,
) {
  const [activeId, setActiveId] = useState<string>();
  const [resolvingId, setResolvingId] = useState<string>();
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState("");
  const [resolveError, setResolveError] = useState<{
    id: string;
    message: string;
  }>();
  const [drafts, setDrafts] = useState<Record<string, ApprovalDraft>>({});
  const resolvingRef = useRef(false);
  const lastIndex = useRef(0);
  const found = approvals.findIndex((approval) => approval.id === activeId);
  const activeIndex =
    found >= 0 ? found : Math.min(lastIndex.current, approvals.length - 1);
  const active = approvals[activeIndex];

  useEffect(() => {
    if (!active) return;
    lastIndex.current = activeIndex;
    if (active.id !== activeId) setActiveId(active.id);
  }, [active, activeId, activeIndex]);

  // 已处理/已消失的条目清掉草稿，避免 id 复用时串内容。
  useEffect(() => {
    const pending = new Set(approvals.map((approval) => approval.id));
    setDrafts((current) => {
      if (Object.keys(current).every((id) => pending.has(id))) return current;
      return Object.fromEntries(
        Object.entries(current).filter(([id]) => pending.has(id)),
      );
    });
  }, [approvals]);

  const move = (offset: number) => {
    if (resolvingRef.current || !approvals.length) return;
    const index = (activeIndex + offset + approvals.length) % approvals.length;
    lastIndex.current = index;
    setActiveId(approvals[index].id);
  };

  const resolve = async (id: string, body: ApprovalResolveBody) => {
    if (resolvingRef.current || bulkBusy) return;
    resolvingRef.current = true;
    setResolvingId(id);
    setResolveError(undefined);
    try {
      await onResolve(id, body);
    } catch (error) {
      setResolveError({
        id,
        message: error instanceof Error ? error.message : "审批处理失败，请重试",
      });
    } finally {
      resolvingRef.current = false;
      setResolvingId(undefined);
    }
  };

  const bulkTargets = bulkApprovableApprovals(approvals);
  const resolveAll = async () => {
    if (bulkBusy || resolvingRef.current || !bulkTargets.length) return;
    setBulkBusy(true);
    setBulkError("");
    setResolveError(undefined);
    let failed = 0;
    for (const item of bulkTargets) {
      try {
        await onResolve(item.id, { decision: "acceptForSession" });
      } catch (error) {
        if (!isGoneError(error)) failed += 1;
      }
    }
    setBulkBusy(false);
    if (failed) setBulkError(`${failed} 条未能通过，请逐条处理`);
  };

  return {
    active,
    activeIndex,
    move,
    resolve,
    resolvingId,
    busy: Boolean(resolvingId) || bulkBusy,
    errorFor: (id: string) =>
      resolveError?.id === id ? resolveError.message : undefined,
    draftFor: (id: string) => drafts[id],
    setDraft: (id: string, draft: ApprovalDraft) =>
      setDrafts((current) => ({ ...current, [id]: draft })),
    bulkTargets,
    bulkBusy,
    bulkError,
    resolveAll,
  };
}
