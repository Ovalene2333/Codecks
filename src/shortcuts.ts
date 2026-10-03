/**
 * 全局键盘快捷键（桌面端增强；移动端软键盘不产生这些键）。
 *
 * 当前只有 Esc，语义是“分层退出”——等同逐级点击界面上的关闭/总览入口：
 *
 *   1. 弹层占位在栈顶 → history.back()，复用 useOverlayHistory 的机制
 *      关掉最上层弹层（Modal / Drawer / ActionSheet 由此免费获得 Esc 关闭）。
 *   2. 焦点在 xterm 里 → 不拦截，Esc 属于 shell（vim、fzf、取消行输入）。
 *   3. 焦点在输入控件上 → 先失焦；下一次 Esc 才退出页面。
 *   4. 其余情况 → goHome()，等同「总览」入口（移动端会话列表 /sessions
 *      也是一级页面，由 goHome 负责退回）。
 *
 * 组件自己消费 Esc 的处理器（审批折叠、查找栏、下拉面板等）必须
 * preventDefault()。动作统一放进微任务执行：本监听器注册得比局部
 * 处理器早，但同一轮事件派发在微任务前就跑完了，此时再读
 * event.defaultPrevented 能让任何局部处理器优先拦截。
 */
import { useEffect, useRef } from "react";
import { overlayMarkOf } from "./deck-history";

export type DeckEscapeAction =
  | "overlay" // 关掉最上层弹层
  | "blur" // 输入框失焦
  | "home" // 回总览页
  | "none"; // 不消费：终端放行、已在首页

export function deckEscapeAction(ctx: {
  overlay: number;
  inTerminal: boolean;
  editableFocused: boolean;
  atHome: boolean;
}): DeckEscapeAction {
  if (ctx.overlay > 0) return "overlay";
  if (ctx.inTerminal) return "none";
  if (ctx.editableFocused) return "blur";
  return ctx.atHome ? "none" : "home";
}

/** back() 的提交是异步的：占位条目弹掉前连按 Esc 会重复回退，节流挡一下。 */
const OVERLAY_BACK_THROTTLE_MS = 300;

export function useDeckShortcuts(options: {
  goHome: () => void;
}) {
  const ref = useRef(options);
  ref.current = options;
  useEffect(() => {
    let lastOverlayBack = 0;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      // 输入法组词中：Esc 是撤销候选，不是导航
      if (event.isComposing || event.keyCode === 229) return;
      queueMicrotask(() => {
        if (event.defaultPrevented) return;
        const active = document.activeElement;
        const action = deckEscapeAction({
          overlay: overlayMarkOf(window.history.state),
          inTerminal:
            active instanceof HTMLElement && Boolean(active.closest(".xterm")),
          editableFocused:
            active instanceof HTMLElement &&
            (active.isContentEditable ||
              /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)),
          atHome: location.pathname === "/",
        });
        if (action === "none") return;
        event.preventDefault();
        if (action === "overlay") {
          if (Date.now() - lastOverlayBack >= OVERLAY_BACK_THROTTLE_MS) {
            lastOverlayBack = Date.now();
            window.history.back();
          }
        } else if (action === "blur") {
          (active as HTMLElement).blur();
        } else {
          ref.current.goHome();
        }
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
