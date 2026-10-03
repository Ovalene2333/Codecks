import { useEffect, useState } from "react";
import { House, MessagesSquare, Plus, Settings, Wrench } from "lucide-react";

/** 与各 CSS 文件的移动端断点保持一致。 */
export const MOBILE_QUERY = "(max-width: 760px)";

export function useMobileLayout() {
  const [mobile, setMobile] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return mobile;
}

export type MobileTab = "home" | "sessions";

/**
 * 移动端底栏：总览 / 会话 是两个顶层页面（/、/sessions），
 * 新建 / 工具 / 设置 是就地弹出的动作。只在一级页面显示，进会话后让位给输入框。
 */
export function MobileTabBar({
  active,
  homeBadge,
  sessionsBadge,
  onHome,
  onSessions,
  onNew,
  onTools,
  onSettings,
}: {
  active?: MobileTab;
  /** 总览角标：需要你处理的数量（待确认 + 异常）。 */
  homeBadge?: number;
  /** 会话角标：有新回复的数量。 */
  sessionsBadge?: number;
  onHome: () => void;
  onSessions: () => void;
  onNew: () => void;
  onTools: () => void;
  onSettings: () => void;
}) {
  return (
    <nav className="mobile-tabbar" aria-label="主导航">
      <button
        type="button"
        className={active === "home" ? "on" : undefined}
        aria-current={active === "home" ? "page" : undefined}
        onClick={onHome}
      >
        <House aria-hidden="true" />
        <span>总览</span>
        {homeBadge ? (
          <b className="mobile-tabbar-badge" aria-label={`${homeBadge} 项待处理`}>
            {homeBadge > 99 ? "99+" : homeBadge}
          </b>
        ) : null}
      </button>
      <button
        type="button"
        className={active === "sessions" ? "on" : undefined}
        aria-current={active === "sessions" ? "page" : undefined}
        onClick={onSessions}
      >
        <MessagesSquare aria-hidden="true" />
        <span>会话</span>
        {sessionsBadge ? (
          <i className="mobile-tabbar-dot" aria-label={`${sessionsBadge} 个新回复`} />
        ) : null}
      </button>
      <button
        type="button"
        className="mobile-tabbar-new"
        aria-label="新建会话"
        title="新建会话"
        onClick={onNew}
      >
        <Plus aria-hidden="true" />
      </button>
      <button type="button" onClick={onTools}>
        <Wrench aria-hidden="true" />
        <span>工具</span>
      </button>
      <button type="button" onClick={onSettings}>
        <Settings aria-hidden="true" />
        <span>设置</span>
      </button>
    </nav>
  );
}
