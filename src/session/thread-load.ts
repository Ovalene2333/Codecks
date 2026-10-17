import { rawApi } from "../api";
import { threadPath } from "../agents";
import {
  isPartialThread,
  readCompleteThreadCache,
  readThreadEtag,
  writeThreadEtag,
} from "../cache";
import type { ThreadSummary } from "../types";

export function shouldSurfaceThreadLoadError(full?: {
  turns?: unknown[] | null;
}) {
  return !Array.isArray(full?.turns) || full.turns.length === 0;
}

/**
 * Claude writes its transcript after a turn finishes. Do not replace a usable
 * cached transcript with the temporary empty response returned mid-turn.
 */
export function shouldKeepLoadedThread(
  current?: { turns?: unknown[] | null },
  incoming?: { turns?: unknown[] | null },
) {
  return (
    Array.isArray(current?.turns) &&
    current.turns.length > 0 &&
    Array.isArray(incoming?.turns) &&
    incoming.turns.length === 0
  );
}

/**
 * 条件拉取会话全文：缓存过响应 ETag 时带 If-None-Match，
 * 服务端 304 即复用本地缓存（正文零传输）；200 则落地新 ETag。
 * 只有完整全文才带条件头：落盘副本可能只剩尾部，不能拿来顶替响应体。
 * 分页（turnLimit）只取尾部：不带条件头、不写 ETag，响应自带
 * PARTIAL_KEY 标记，不会被当成全文复用。
 */
export async function fetchThreadFull(
  thread: Pick<ThreadSummary, "id" | "agentId">,
  cacheKey: string,
  options?: { turnLimit?: number },
) {
  const limit = Number(options?.turnLimit);
  const paged = Number.isFinite(limit) && limit > 0;
  const suffix = paged ? `?turnLimit=${Math.floor(limit)}` : "";
  let etag = !paged && readCompleteThreadCache(cacheKey)
    ? readThreadEtag(cacheKey)
    : null;
  for (;;) {
    // fetch 没有内建超时：挂死的请求会随 dedupeThreadLoad 的 inflight 去重
    // 一直被后续打开复用，会话页就永远停在空白。手动 abort 兜底，超时后
    // inflight 条目随拒绝释放，下次打开能重新拉。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);
    try {
      const response = await rawApi(threadPath(thread) + suffix, {
        headers: etag ? { "If-None-Match": etag } : {},
        signal: controller.signal,
      });
      if (response.status === 304) {
        const cached = readCompleteThreadCache(cacheKey);
        if (cached) return cached;
        // ETag 还在但缓存体已被淘汰：去掉条件头重新拉全文。
        etag = null;
        continue;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(data.error || `请求失败 (${response.status})`);
      const next = response.headers.get("ETag");
      if (next && !isPartialThread(data)) writeThreadEtag(cacheKey, next);
      return data;
    } catch (error: any) {
      if (error?.name === "AbortError")
        throw new Error("会话加载超时，请重试");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
