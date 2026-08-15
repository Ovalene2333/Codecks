import { sessionKey } from "../format";
import type { Approval, ThreadSummary } from "../types";

export function approvalThreadId(approval: Approval) {
  const params = approval.request.params || {};
  const explicit = params.threadId || params.thread_id;
  if (typeof explicit === "string" && explicit) return explicit;
  const separator = approval.id.indexOf(":");
  return separator > 0 ? approval.id.slice(0, separator) : undefined;
}

export function threadForApproval(
  approval: Approval,
  threads: ThreadSummary[],
) {
  const threadId = approvalThreadId(approval);
  if (!threadId) return undefined;
  return threads.find(
    (thread) =>
      thread.id === threadId &&
      thread.providerId === approval.providerId &&
      (thread.agentId || "codex") === (approval.agentId || "codex"),
  );
}

export function approvalBelongsToThread(
  approval: Approval,
  thread: ThreadSummary,
) {
  const matched = threadForApproval(approval, [thread]);
  return Boolean(matched && sessionKey(matched) === sessionKey(thread));
}

export function approvalPreview(approval: Approval) {
  if (approval.kind === "file") return "请求修改文件";
  if (approval.kind === "permission") return "请求额外权限";
  if (approval.kind === "question") return "需要回答问题";
  if (approval.networkApproval) return "请求网络访问";
  const command = approval.command || approval.request.params?.command;
  if (Array.isArray(command)) return command.join(" ");
  if (typeof command === "string" && command.trim()) return command.trim();
  return "请求执行命令";
}
