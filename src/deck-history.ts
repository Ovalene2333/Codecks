/**
 * Deck 顶层导航模型：URL 是唯一真源。
 *
 *   /              总览首页（待你处理 / 新回复 / 运行中 / 最近会话）
 *   /session/<key> 会话视图（移动端整屏覆盖，桌面端为右栏）
 *   /sessions      会话列表（移动端底栏「会话」页；桌面端侧栏常驻，等同首页）
 *   /<toolId>      工具页（terminal、git、text-files…）
 *
 * /monitor 是总览并入首页前的旧地址，启动时归一化为 /。
 *
 * history.state 记录条目归属（__codexDeck）、页面种类、会话视图、
 * 页面级导航深度 depth、以及弹层占位标记 overlay。
 *
 * 返回语义：depth > 1 的条目说明栈里有本应用压入的上级页面，应用内
 * “返回”统一走 history.back()；否则（直接进入/刷新/外部进入）
 * replaceState 回工作区——避免“返回”反而向前压栈留下死记录。
 */

export type DeckPage = "workspace" | "tools";
export type DeckView = "workspace" | "session" | "sessions";

export type DeckHistoryState = {
  __codexDeck?: true;
  page?: DeckPage;
  view?: DeckView;
  session?: string;
  depth?: number;
  overlay?: number;
};

export type DeckRoute = {
  page: DeckPage;
  view: DeckView;
  session?: string;
};

const SESSION_PREFIX = "/session/";
export const SESSIONS_PATH = "/sessions";
const LEGACY_HOME_PATHS = new Set(["/monitor"]);

/** 旧地址归一化（工具页别名另由 toolPath 处理）。 */
export function canonicalDeckPath(pathname: string): string {
  return LEGACY_HOME_PATHS.has(pathname) ? "/" : pathname;
}

export function sessionKeyFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith(SESSION_PREFIX)) return undefined;
  const raw = pathname.slice(SESSION_PREFIX.length);
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw) || undefined;
  } catch {
    return undefined;
  }
}

export function sessionPath(key: string): string {
  return `${SESSION_PREFIX}${encodeURIComponent(key)}`;
}

export function routeForPath(
  pathname: string,
  isToolPath: (pathname: string) => boolean,
): DeckRoute {
  const session = sessionKeyFromPath(pathname);
  if (session) return { page: "workspace", view: "session", session };
  if (pathname === SESSIONS_PATH) return { page: "workspace", view: "sessions" };
  return {
    page: isToolPath(pathname) ? "tools" : "workspace",
    view: "workspace",
  };
}

export function readDeckState(state: unknown): DeckHistoryState | undefined {
  return state && typeof state === "object"
    ? (state as DeckHistoryState)
    : undefined;
}

/** 本应用条目的页面级深度；弹层占位与外来条目不算一级页面。 */
export function deckDepth(state: DeckHistoryState | undefined): number {
  if (!state?.__codexDeck) return 0;
  return typeof state.depth === "number" ? state.depth : 1;
}

/** 新压入的页面级条目：depth 递进，且不继承 overlay 占位标记。 */
export function deckEntry(
  previous: DeckHistoryState | undefined,
  route: DeckRoute,
): DeckHistoryState {
  return {
    __codexDeck: true,
    page: route.page,
    view: route.view,
    session: route.session,
    depth: deckDepth(previous) + 1,
  };
}

/**
 * 原地重写当前条目（别名归一化、会话 key 漂移、程序性关闭）。
 * 保留 depth 与 overlay：弹层占位是栈顶条目的一部分，重写路由字段
 * 不能把它抹掉，否则系统返回不再关弹层。
 */
export function deckRewrite(
  previous: DeckHistoryState | undefined,
  route: DeckRoute,
): DeckHistoryState {
  return {
    __codexDeck: true,
    page: route.page,
    view: route.view,
    session: route.session,
    depth: deckDepth(previous) || 1,
    overlay: previous?.overlay,
  };
}

/** 栈顶条目的弹层占位标记 id（0 = 无）。 */
export function overlayMarkOf(state: unknown): number {
  const overlay = readDeckState(state)?.overlay;
  return typeof overlay === "number" ? overlay : 0;
}
