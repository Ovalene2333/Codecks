import { useCallback, useState } from "react";

/**
 * 首页面板顺序（每台设备单独保存）。主栏与右栏各自排序，面板不跨栏；
 * 审批卡片固定在主栏最上方，不参与排序。
 */
export const MAIN_PANELS = ["attention", "unseen", "running", "recent", "watch"] as const;
export const ASIDE_PANELS = ["usage", "health"] as const;

export type MainPanelId = (typeof MAIN_PANELS)[number];
export type AsidePanelId = (typeof ASIDE_PANELS)[number];

export interface MonitorLayout {
  main: MainPanelId[];
  aside: AsidePanelId[];
}

export const LAYOUT_STORAGE_KEY = "codex-deck:monitor-layout:v1";

export const DEFAULT_LAYOUT: MonitorLayout = {
  main: [...MAIN_PANELS],
  aside: [...ASIDE_PANELS],
};

/**
 * 按保存的顺序排已知面板：未知/重复的丢掉，保存里缺的（新版本新增的面板）
 * 追加到末尾。存储内容损坏时退回默认顺序。
 */
export function normalizeOrder<T extends string>(saved: unknown, defaults: readonly T[]): T[] {
  const known = new Set<string>(defaults);
  const order: T[] = [];
  if (Array.isArray(saved)) {
    for (const id of saved) {
      if (typeof id === "string" && known.has(id) && !order.includes(id as T)) order.push(id as T);
    }
  }
  for (const id of defaults) if (!order.includes(id)) order.push(id);
  return order;
}

/** 把 from 位置的元素挪到 to（两者都按挪动前的下标），越界时夹到两端。 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  if (from < 0 || from >= next.length) return next;
  const target = Math.max(0, Math.min(next.length - 1, to));
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

export function parseLayout(raw: string | null): MonitorLayout {
  let data: { main?: unknown; aside?: unknown } = {};
  try {
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === "object") data = parsed;
  } catch {
    // 损坏的存储按默认处理。
  }
  return {
    main: normalizeOrder(data.main, MAIN_PANELS),
    aside: normalizeOrder(data.aside, ASIDE_PANELS),
  };
}

export const isDefaultLayout = (layout: MonitorLayout) =>
  layout.main.join() === DEFAULT_LAYOUT.main.join() &&
  layout.aside.join() === DEFAULT_LAYOUT.aside.join();

function readLayout(): MonitorLayout {
  try {
    return parseLayout(window.localStorage.getItem(LAYOUT_STORAGE_KEY));
  } catch {
    return parseLayout(null);
  }
}

/** 读写本机的首页面板顺序；localStorage 同步读取，首屏不会先闪默认顺序。 */
export function useMonitorLayout() {
  const [layout, setLayoutState] = useState(readLayout);
  const setLayout = useCallback((next: MonitorLayout) => {
    setLayoutState(next);
    try {
      if (isDefaultLayout(next)) window.localStorage.removeItem(LAYOUT_STORAGE_KEY);
      else window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // 隐私模式等写不进去时，本次会话内仍然生效。
    }
  }, []);
  return [layout, setLayout] as const;
}
