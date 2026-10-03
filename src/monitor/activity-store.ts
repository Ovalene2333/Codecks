import { useSyncExternalStore } from "react";
import type { ActivityUpdate, ThreadActivity } from "../types";

/**
 * 实时活动放在组件树外：步骤切换和心跳都很频繁，走 App 的 snapshot state
 * 会让整棵树跟着重渲染；这里只有订阅了的监控台组件会更新。
 */
type Listener = () => void;

let activities: ReadonlyMap<string, ThreadActivity> = new Map();
const listeners = new Set<Listener>();

export const activityKey = (agentId: string | undefined, threadId: string) =>
  `${agentId || "codex"}:${threadId}`;

function emit() {
  for (const listener of listeners) listener();
}

export function resetActivities(list: ThreadActivity[]) {
  activities = new Map(
    list.map((item) => [activityKey(item.agentId, item.threadId), item]),
  );
  emit();
}

export function applyActivityUpdate(update: ActivityUpdate) {
  const key = activityKey(update.agentId, update.threadId);
  const next = new Map(activities);
  if (update.activity) next.set(key, update.activity);
  else if (!next.delete(key)) return;
  activities = next;
  emit();
}

function subscribe(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useActivities() {
  return useSyncExternalStore(subscribe, () => activities);
}

/** 所有计时器共用一个 1 秒节拍，卡片再多也只有一个 interval。 */
let now = Date.now();
let timer: number | undefined;
const tickListeners = new Set<Listener>();

function subscribeNow(listener: Listener) {
  tickListeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      for (const tick of tickListeners) tick();
    }, 1_000);
  }
  return () => {
    tickListeners.delete(listener);
    if (!tickListeners.size && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
}

/** step 越大重渲染越少：快照按 step 取整，同一档内不会触发更新。 */
export function useNow(step = 1_000) {
  return useSyncExternalStore(subscribeNow, () => Math.floor(now / step) * step);
}
