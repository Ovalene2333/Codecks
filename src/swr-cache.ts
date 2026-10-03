import { useEffect, useRef, useState } from "react";
import { getCacheStore } from "./cache";

/**
 * 小数据的“先给上次的值，后台再刷新”缓存（stale-while-revalidate）。
 *
 * 用在模型目录、命令列表、工具结果这类打开就要、变化不频繁、体积不大的
 * 数据上：再次打开立刻有内容，同时后台拉最新值替换。每个实例都有条数
 * 上限（按最近使用淘汰）；落盘是可选的，单条太大的只留在内存里。
 */

const PREFIX = "codex-deck:swr:v1:";

export interface SwrEntry<T> {
  at: number;
  value: T;
}

export interface SwrOptions {
  /** 落盘键名；不给就只留在内存（刷新页面即失效）。 */
  persist?: string;
  /** 多久之内算新鲜：新鲜的直接用，不再请求。 */
  ttlMs: number;
  /** 最多留几条，超出时淘汰最久没用的。 */
  maxEntries: number;
  /** 单条序列化后超过这个长度就不落盘（仍留在内存）。 */
  maxPersistChars?: number;
}

export class SwrCache<T> {
  /** Map 插入顺序即 LRU 顺序。 */
  private entries = new Map<string, SwrEntry<T>>();
  /** 已序列化的落盘行，避免每次写盘都把所有条目重新 stringify。 */
  private rows = new Map<string, string>();
  private inflight = new Map<string, Promise<T>>();
  private hydrated = false;

  constructor(private readonly options: SwrOptions) {}

  private hydrate() {
    if (this.hydrated) return;
    this.hydrated = true;
    if (!this.options.persist) return;
    try {
      const raw = getCacheStore()?.getItem(PREFIX + this.options.persist);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      for (const row of parsed) {
        if (!Array.isArray(row) || typeof row[0] !== "string") continue;
        const [key, entry] = row as [string, SwrEntry<T>];
        if (!entry || typeof entry.at !== "number" || this.entries.has(key))
          continue;
        this.entries.set(key, entry);
        this.rows.set(key, JSON.stringify(row));
      }
      this.evict();
    } catch {
      // 坏数据当没有缓存
    }
  }

  private evict() {
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.options.maxEntries) break;
      this.entries.delete(key);
      this.rows.delete(key);
    }
  }

  private save() {
    if (!this.options.persist) return;
    const store = getCacheStore();
    if (!store) return;
    try {
      store.setItem(
        PREFIX + this.options.persist,
        `[${[...this.rows.values()].join(",")}]`,
      );
    } catch {
      // 配额不足：本次只留在内存
    }
  }

  peek(key: string): SwrEntry<T> | undefined {
    this.hydrate();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    // 挪到末尾 = 最近使用
    this.entries.delete(key);
    this.entries.set(key, entry);
    const row = this.rows.get(key);
    if (row !== undefined) {
      this.rows.delete(key);
      this.rows.set(key, row);
    }
    return entry;
  }

  isFresh(entry: SwrEntry<T> | undefined) {
    return Boolean(entry && Date.now() - entry.at < this.options.ttlMs);
  }

  set(key: string, value: T) {
    this.hydrate();
    const entry = { at: Date.now(), value };
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.rows.delete(key);
    if (this.options.persist) {
      try {
        const row = JSON.stringify([key, entry]);
        // 太大的不落盘，也不在内存里多留一份字符串副本。
        if (row.length <= (this.options.maxPersistChars ?? 100_000))
          this.rows.set(key, row);
      } catch {
        // 不可序列化：只留内存
      }
    }
    this.evict();
    this.save();
  }

  delete(key: string) {
    this.hydrate();
    if (!this.entries.delete(key)) return;
    this.rows.delete(key);
    this.save();
  }

  /** 同一 key 的并发请求合并成一个；成功后写入缓存。 */
  load(key: string, fetcher: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running;
    const task = fetcher()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, task);
    return task;
  }

  /** 单测用：清空内存，下次访问重新从存储读。 */
  resetForTests() {
    this.entries.clear();
    this.rows.clear();
    this.inflight.clear();
    this.hydrated = false;
  }
}

export interface SwrState<T> {
  data?: T;
  /** 没有任何可展示的数据、正在等第一次结果。 */
  loading: boolean;
  /** 只在没有旧数据可展示时才给出错误；有旧数据就安静地继续用旧的。 */
  error: string;
}

/**
 * 组件里读 SwrCache：有缓存先给缓存（不再显示“正在读取”），过期才后台刷新；
 * key 为空表示不需要数据。delayMs 用于搜索框这类边输入边查的场景。
 */
export function useSwr<T>(
  cache: SwrCache<T>,
  key: string | undefined,
  fetcher: () => Promise<T>,
  options: {
    delayMs?: number;
    /** 换 key 且新 key 没缓存时，先继续显示上一个 key 的结果（搜索框边输边查）。 */
    keepPrevious?: boolean;
  } = {},
): SwrState<T> {
  const keepPrevious = Boolean(options.keepPrevious);
  const initial = (previous?: T): SwrState<T> & { key?: string } => {
    const entry = key ? cache.peek(key) : undefined;
    return {
      key,
      data: entry ? entry.value : keepPrevious ? previous : undefined,
      loading: Boolean(key) && !entry,
      error: "",
    };
  };
  const [state, setState] = useState(initial);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const delayMs = options.delayMs ?? 0;

  useEffect(() => {
    if (!key) {
      setState({ key, data: undefined, loading: false, error: "" });
      return;
    }
    let cancelled = false;
    const entry = cache.peek(key);
    setState((current) => ({
      key,
      data: entry ? entry.value : keepPrevious ? current.data : undefined,
      loading: !entry,
      error: "",
    }));
    if (cache.isFresh(entry)) return;
    const timer = setTimeout(() => {
      cache
        .load(key, () => fetcherRef.current())
        .then((data) => {
          if (!cancelled) setState({ key, data, loading: false, error: "" });
        })
        .catch((error: any) => {
          if (cancelled) return;
          // 这个 key 有旧值就安静地继续用；没有才报错（上一个 key 的结果不算）。
          const stale = cache.peek(key);
          setState({
            key,
            data: stale?.value,
            loading: false,
            error: stale ? "" : String(error?.message || "读取失败"),
          });
        });
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [cache, key, delayMs, keepPrevious]);

  // key 刚变、effect 还没跑的那一帧：不要把上一个 key 的数据当成这个 key 的。
  if (state.key !== key) {
    const { key: _ignored, ...next } = initial(state.data);
    return next;
  }
  return { data: state.data, loading: state.loading, error: state.error };
}
