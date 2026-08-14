export type ThreadStoreErrorKind =
  | "unmaterialized"
  | "notInRuntime"
  | "locked"
  | "other";

export function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error ?? "");
}

export function classifyThreadStoreError(error: unknown): ThreadStoreErrorKind {
  const message = errorMessage(error);
  if (
    /is not materialized yet/i.test(message) ||
    /rollout\b[\s\S]*\bis empty\b/i.test(message) ||
    /failed to read session metadata/i.test(message) ||
    /no rollout found/i.test(message)
  )
    return "unmaterialized";
  if (/thread not found/i.test(message) || /invalid thread id/i.test(message))
    return "notInRuntime";
  if (
    /failed to acquire thread writer/i.test(message) ||
    (/thread writer/i.test(message) && /lock/i.test(message))
  )
    return "locked";
  return "other";
}

export function isMissingRolloutError(error: unknown) {
  return classifyThreadStoreError(error) === "unmaterialized";
}

export function threadStoreUserMessage(
  kind: ThreadStoreErrorKind,
  fallback?: string,
) {
  if (kind === "notInRuntime")
    return "当前 Runtime 里没有这条会话。可能被另一个 Deck 或 Codex 占用，请先只留一个实例再重试";
  if (kind === "locked")
    return "会话正被另一个 Codex 进程写入，请先结束旧的 Deck / Codex 再重试";
  if (kind === "unmaterialized")
    return "会话记录尚未写入磁盘，请稍后再打开或新开一个会话";
  return fallback || "会话操作失败";
}

export function explainThreadStoreError(
  error: unknown,
  kind = classifyThreadStoreError(error),
) {
  if (kind === "other")
    return error instanceof Error ? error : new Error(errorMessage(error));
  return new Error(threadStoreUserMessage(kind));
}
