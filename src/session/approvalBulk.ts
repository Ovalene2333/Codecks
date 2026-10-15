import type { Approval } from "../types";

/**
 * 批量通过的目标：只纳权限类请求。问答（要选答案）、ACP 自定义选档、
 * 后端没给会话级选项的一律跳过，留给逐条处理。
 */
export function bulkApprovableApprovals(approvals: Approval[]): Approval[] {
  return approvals.filter((item) => {
    const kind =
      item.kind ||
      (item.request.method?.includes("fileChange") ? "file" : "command");
    if (kind === "question") return false;
    if (String(item.request.method || "").includes("question")) return false;
    const params = item.request.params || {};
    if ((item.questions || params.questions || []).length) return false;
    const options = (params as any)?.options;
    if (Array.isArray(options) && options.length) return false;
    if (
      item.availableDecisions &&
      !item.availableDecisions.includes("acceptForSession")
    )
      return false;
    return true;
  });
}

/** 循环中途目标已消失=已经生效，不算失败（App 侧的原文案）。 */
export function isGoneError(error: unknown): boolean {
  return error instanceof Error && /已不存在/.test(error.message);
}
