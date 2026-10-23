/** 已删除会话的别名默认保留 2 天，之后释放给新会话使用。 */
export const DEFAULT_SESSION_ALIAS_RETENTION_DAYS = 2;

/** 0 表示不回收；上限一年，避免误填成超大值。 */
export const SESSION_ALIAS_RETENTION_DAYS_MAX = 365;

export function normalizeSessionAliasRetentionDays(value: unknown): number {
  const days =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(days) || days < 0)
    return DEFAULT_SESSION_ALIAS_RETENTION_DAYS;
  return Math.min(SESSION_ALIAS_RETENTION_DAYS_MAX, Math.round(days));
}
