import { rawApi } from "../api";
import { threadPath } from "../agents";
import {
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
 */
export async function fetchThreadFull(
  thread: Pick<ThreadSummary, "id" | "agentId">,
  cacheKey: string,
) {
  let etag = readCompleteThreadCache(cacheKey)
    ? readThreadEtag(cacheKey)
    : null;
  for (;;) {
    const response = await rawApi(threadPath(thread), {
      headers: etag ? { "If-None-Match": etag } : {},
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
    if (next) writeThreadEtag(cacheKey, next);
    return data;
  }
}
