import { useSyncExternalStore } from "react";
import {
  DEFAULT_MESSAGE_TYPOGRAPHY,
  messageTypographyVariables,
  normalizeMessageTemplates,
  normalizeMessageTypography,
  type MessageTemplate,
  type MessageTypography,
} from "./message-typography";
import { EMPTY_SIDEBAR_LAYOUT, type SidebarLayout } from "./projects";

/**
 * 本设备偏好（localStorage）：只影响当前浏览器，不进服务端快照。
 * 外观另有 appearance.ts（首屏前由 index.html 内联脚本读取，键名不能动），
 * 这里放其余的界面/输入/通知/工具偏好。
 *
 * 用 useSyncExternalStore 做一个极小的全局 store：设置页改了，Composer、
 * 侧栏工具菜单等深层组件立即同步；另一个标签页改了经 storage 事件同步。
 */

export type SendKey = "enter" | "mod-enter";
export type ReadingSize = "sm" | "md" | "lg";
export type ToolOpenTarget = "tab" | "inline";

export interface DeckLocalSettings {
  /** enter：Enter 发送、Shift+Enter 换行；mod-enter：Ctrl/⌘+Enter 发送、Enter 换行。 */
  sendKey: SendKey;
  /** 旧会话字号，仅用于迁移旧设置；新设置使用 messageTypography。 */
  readingSize: ReadingSize;
  messageTypography: MessageTypography;
  messageTemplates: MessageTemplate[];
  notifyApprovals: boolean;
  notifyReplies: boolean;
  /** 只在页面不在前台时推送系统通知。 */
  notifyOnlyHidden: boolean;
  /** 从工具菜单里隐藏的工具 id。 */
  hiddenTools: string[];
  /** 桌面端打开工具的方式：新标签页 / 当前页。移动端始终在应用内打开。 */
  toolOpenTarget: ToolOpenTarget;
  /** 桌面端侧栏宽度（px）；0 表示跟随界面默认值（可随窗口自适应）。 */
  sidebarWidth: number;
  /** 打开会话时加载的最新轮数（更早的点按钮再加载），本设备偏好。 */
  initialTurns: number;
  /** 侧栏手动排序：项目路径顺序与会话键顺序。 */
  sidebarLayout: SidebarLayout;
}

export const DECK_SETTINGS_KEY = "codex-deck:settings:v1";

export const DEFAULT_DECK_SETTINGS: DeckLocalSettings = {
  sendKey: "enter",
  readingSize: "md",
  messageTypography: DEFAULT_MESSAGE_TYPOGRAPHY,
  messageTemplates: [],
  notifyApprovals: true,
  notifyReplies: true,
  notifyOnlyHidden: false,
  hiddenTools: [],
  toolOpenTarget: "tab",
  sidebarWidth: 0,
  initialTurns: 10,
  sidebarLayout: EMPTY_SIDEBAR_LAYOUT,
};

const oneOf = <T extends string>(value: unknown, options: T[], fallback: T) =>
  options.includes(value as T) ? (value as T) : fallback;
const bool = (value: unknown, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback;

/** 桌面端侧栏宽度的可用区间（px）。 */
export const SIDEBAR_WIDTH_MIN = 240;
export const SIDEBAR_WIDTH_MAX = 480;

/** 打开会话时加载轮数的可用区间：太少没上下文，太多首屏慢。 */
export const INITIAL_TURNS_MIN = 5;
export const INITIAL_TURNS_MAX = 100;

/** 初始加载轮数合法化：非法值回默认 10，其余钳到可用区间。 */
export function normalizeInitialTurns(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    return DEFAULT_DECK_SETTINGS.initialTurns;
  return Math.min(
    INITIAL_TURNS_MAX,
    Math.max(INITIAL_TURNS_MIN, Math.round(value)),
  );
}

/** 侧栏宽度合法化：非正数/非法值回到 0（自动），其余钳到可用区间。 */
export function normalizeSidebarWidth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return 0;
  return Math.min(
    SIDEBAR_WIDTH_MAX,
    Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)),
  );
}

export function normalizeDeckSettings(value: unknown): DeckLocalSettings {
  const input =
    value && typeof value === "object"
      ? (value as Partial<DeckLocalSettings>)
      : {};
  const d = DEFAULT_DECK_SETTINGS;
  return {
    sendKey: oneOf(input.sendKey, ["enter", "mod-enter"], d.sendKey),
    readingSize: oneOf(input.readingSize, ["sm", "md", "lg"], d.readingSize),
    messageTypography: normalizeMessageTypography(
      input.messageTypography ?? {
        fontSize:
          input.readingSize === "sm"
            ? 13.5
            : input.readingSize === "lg"
              ? 17
              : 15,
      },
    ),
    messageTemplates: normalizeMessageTemplates(input.messageTemplates),
    notifyApprovals: bool(input.notifyApprovals, d.notifyApprovals),
    notifyReplies: bool(input.notifyReplies, d.notifyReplies),
    notifyOnlyHidden: bool(input.notifyOnlyHidden, d.notifyOnlyHidden),
    hiddenTools: Array.isArray(input.hiddenTools)
      ? [
          ...new Set(
            input.hiddenTools.filter(
              (item): item is string => typeof item === "string",
            ),
          ),
        ]
      : d.hiddenTools,
    toolOpenTarget: oneOf(
      input.toolOpenTarget,
      ["tab", "inline"],
      d.toolOpenTarget,
    ),
    sidebarWidth: normalizeSidebarWidth(input.sidebarWidth),
    initialTurns: normalizeInitialTurns(input.initialTurns),
    sidebarLayout: normalizeSidebarLayout(input.sidebarLayout),
  };
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string"))]
    : [];
}

/** 手动排序合法化：去掉重复/非字符串；旧设置没有这个字段时为空。 */
export function normalizeSidebarLayout(value: unknown): SidebarLayout {
  const input =
    value && typeof value === "object"
      ? (value as Partial<SidebarLayout>)
      : {};
  const sessions: Record<string, string[]> = {};
  const raw = input.sessions;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [project, keys] of Object.entries(raw)) {
      const list = stringList(keys);
      if (list.length) sessions[project] = list;
    }
  }
  return { projects: stringList(input.projects), sessions };
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function read(): DeckLocalSettings {
  try {
    const raw = storage()?.getItem(DECK_SETTINGS_KEY);
    return raw ? normalizeDeckSettings(JSON.parse(raw)) : DEFAULT_DECK_SETTINGS;
  } catch {
    return DEFAULT_DECK_SETTINGS;
  }
}

let current: DeckLocalSettings | null = null;
const listeners = new Set<() => void>();

function apply(settings: DeckLocalSettings) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.reading = settings.readingSize;
  for (const [key, value] of Object.entries(
    messageTypographyVariables(settings.messageTypography),
  ))
    document.documentElement.style.setProperty(key, value);
}

export function getDeckSettings(): DeckLocalSettings {
  if (!current) current = read();
  return current;
}

function emit() {
  for (const listener of listeners) listener();
}

export function updateDeckSettings(patch: Partial<DeckLocalSettings>) {
  current = normalizeDeckSettings({ ...getDeckSettings(), ...patch });
  apply(current);
  try {
    const store = storage();
    // 全是默认值时不占存储，「恢复默认」也走这里。
    if (JSON.stringify(current) === JSON.stringify(DEFAULT_DECK_SETTINGS))
      store?.removeItem(DECK_SETTINGS_KEY);
    else store?.setItem(DECK_SETTINGS_KEY, JSON.stringify(current));
  } catch {
    // 隐私模式 / 配额满：本次会话内仍然生效
  }
  emit();
}

export function resetDeckSettings() {
  updateDeckSettings(DEFAULT_DECK_SETTINGS);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== DECK_SETTINGS_KEY && event.key !== null) return;
    current = read();
    apply(current);
    emit();
  };
  if (listeners.size === 1 && typeof window !== "undefined")
    window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (!listeners.size && typeof window !== "undefined")
      window.removeEventListener("storage", onStorage);
  };
}

export function initializeDeckSettings() {
  apply(getDeckSettings());
}

export function useDeckSettings() {
  return useSyncExternalStore(subscribe, getDeckSettings, getDeckSettings);
}

/** 当前平台的修饰键写法：Mac 显示 ⌘，其余显示 Ctrl。 */
export function modKeyLabel() {
  if (typeof navigator === "undefined") return "Ctrl";
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent;
  return /mac|iphone|ipad/i.test(platform) ? "⌘" : "Ctrl";
}

/** Composer 的回车判定：返回 "send" 表示这一下应该发送。 */
export function composerEnterAction(
  event: Pick<
    KeyboardEvent,
    "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey"
  >,
  sendKey: SendKey,
): "send" | "newline" | "none" {
  if (event.key !== "Enter") return "none";
  const mod = event.ctrlKey || event.metaKey;
  if (sendKey === "mod-enter") return mod ? "send" : "newline";
  if (event.shiftKey || event.altKey) return "newline";
  return "send";
}
