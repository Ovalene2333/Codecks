import { useEffect, useState } from "react";
import { api } from "../api";
import type { WakeWatcher } from "../types";

const POLL_MS = 15_000;
const EMPTY: WakeWatcher[] = [];

const sameWatchers = (a: WakeWatcher[], b: WakeWatcher[]) =>
  a.length === b.length && JSON.stringify(a) === JSON.stringify(b);

/**
 * 本机 deck-wake watcher 列表。快照已自带服务端缓存的列表（seed），
 * 首屏零等待；首页可见时每 15 秒拉一次接口——既是兜底，也是驱动
 * 服务端缓存过期重扫的节拍。读失败（旧服务端、网络抖动）就当没有
 * watcher，不打扰首页。
 */
export function useWakeWatchers(seed?: WakeWatcher[]) {
  const [items, setItems] = useState<WakeWatcher[] | undefined>(undefined);
  // 快照推送的 watcher 变化与轮询同源（同一份服务端缓存），随时采纳。
  useEffect(() => {
    if (seed)
      setItems((current) =>
        !current || !sameWatchers(current, seed) ? seed : current,
      );
  }, [seed]);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const data = await api<{ items?: WakeWatcher[] }>("/monitor/watchers");
        if (!stopped) setItems(Array.isArray(data?.items) ? data.items : EMPTY);
      } catch {
        // 读失败不动已展示的数据：items 留空时自动退回快照 seed（旧服务端则天然为空）。
      }
    };
    void load();
    const timer = window.setInterval(load, POLL_MS);
    document.addEventListener("visibilitychange", load);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, []);
  return items ?? seed ?? EMPTY;
}
