import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * 侧栏项目/会话的拖动排序。
 *
 * 用指针事件而不是 HTML5 drag-and-drop：手机上也能拖，且不用改掉行内的
 * 点击与菜单按钮。拖动时被拖的行会抬起成跟随指针的浮层，落位线只在滚动
 * 容器里移动；两者都直接改 DOM，不经过 React，避免每次移动都重渲染列表。
 */

export type SidebarDragKind = "project" | "session";

export interface SidebarDragTarget {
  kind: SidebarDragKind;
  /** 被拖的项目 key / 会话 key。 */
  id: string;
  /** 会话所属项目（仅 kind=session）。 */
  projectKey?: string;
}

export interface SidebarDragOptions {
  onProjectMove: (from: string, before: string | null) => void;
  onSessionMove: (
    projectKey: string,
    from: string,
    before: string | null,
  ) => void;
  /** 测试可注入；默认使用全局 document。 */
  document?: Document;
  /** 显式关闭落位动画；默认跟随界面「减少动态效果」设置。 */
  animate?: boolean;
}

/** 越过这个距离才真正进入拖动，避免误吞点击。 */
const THRESHOLD_PX = 4;
/** 靠近滚动容器上下边缘多少像素开始自动滚动。 */
const AUTOSCROLL_ZONE = 56;
const AUTOSCROLL_MAX = 14;
const FLIP_DURATION = 200;

interface DropSpot {
  /** 插到哪一行之前；null = 列表末尾。 */
  before: string | null;
  anchor: HTMLElement | null;
  /** 落位线画在 anchor 的上沿还是下沿。 */
  after: boolean;
}

interface ActiveDrag {
  target: SidebarDragTarget;
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** 越过 4px 后才真正进入拖动。 */
  active: boolean;
  node: HTMLElement;
  /** 滚动容器（.thread-list）：落位线与自动滚动都以它为准。 */
  scroller: HTMLElement;
  indicator: HTMLDivElement;
  ghost: HTMLElement | null;
  frame: number | null;
  drop: DropSpot | null;
}

export function createSidebarDrag(options: SidebarDragOptions) {
  const doc =
    options.document || (typeof document === "undefined" ? null : document);
  const rows: Record<SidebarDragKind, Map<string, HTMLElement>> = {
    project: new Map(),
    session: new Map(),
  };
  let current: ActiveDrag | null = null;

  const sameGroup = (id: string, target: SidebarDragTarget) =>
    target.kind === "project" ||
    rows.session.get(id)?.dataset.projectKey === target.projectKey;

  /** 同一列里可落位的行（不含被拖行），按视觉顺序排列。 */
  const orderedRows = (target: SidebarDragTarget, includeSelf = false) =>
    [...rows[target.kind]]
      .filter(([id]) => includeSelf || id !== target.id)
      .filter(([id]) => sameGroup(id, target))
      .map(([id, node]) => ({ id, node, rect: node.getBoundingClientRect() }))
      .filter((item) => item.rect.height > 0)
      .sort((a, b) => a.rect.top - b.rect.top);

  /** 项目拖的是整组，高亮要落在 .project-group 上而不是标题行。 */
  const sourceNode = (drag: ActiveDrag) =>
    drag.target.kind === "project"
      ? ((drag.node.closest(".project-group") as HTMLElement | null) ??
        drag.node)
      : drag.node;

  const clearMarks = (target: SidebarDragTarget) => {
    // 会话只动本项目的行，不必每帧遍历整棵侧栏。
    for (const [id, node] of rows[target.kind]) {
      if (sameGroup(id, target))
        node.classList.remove("is-drop-before", "is-drop-after");
    }
  };

  /**
   * 指针落在哪一行：上半部分插到它前面，下半部分插到它后面；
   * 落在所有行下方表示移到末尾。
   */
  const locate = (drag: ActiveDrag): DropSpot | null => {
    clearMarks(drag.target);
    const items = orderedRows(drag.target);
    if (!items.length) return null;
    const y = drag.lastY;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (y < item.rect.top + item.rect.height / 2) {
        item.node.classList.add("is-drop-before");
        return { before: item.id, anchor: item.node, after: false };
      }
      const next = items[index + 1];
      if (!next || y < next.rect.top) {
        item.node.classList.add("is-drop-after");
        return { before: next?.id ?? null, anchor: item.node, after: true };
      }
    }
    return null;
  };

  const paintIndicator = (drag: ActiveDrag) => {
    const drop = drag.drop;
    if (!drop?.anchor) {
      drag.indicator.classList.remove("is-visible");
      return;
    }
    const rect = drop.anchor.getBoundingClientRect();
    const base = drag.scroller.getBoundingClientRect();
    // 落位线是滚动容器的绝对定位子元素：换算成内容坐标，滚动时仍贴着行。
    const top =
      rect.top -
      base.top +
      drag.scroller.scrollTop +
      (drop.after ? rect.height : 0);
    const left = rect.left - base.left + 8;
    drag.indicator.style.transform = `translate3d(${Math.round(left)}px, ${Math.round(top - 1)}px, 0)`;
    drag.indicator.style.width = `${Math.max(0, Math.round(rect.width - 8))}px`;
    drag.indicator.classList.add("is-visible");
  };

  const refresh = (drag: ActiveDrag) => {
    drag.drop = locate(drag);
    paintIndicator(drag);
  };

  const updateGhost = (drag: ActiveDrag) => {
    if (!drag.ghost) return;
    const dx = drag.lastX - drag.startX;
    const dy = drag.lastY - drag.startY;
    drag.ghost.style.transform = `translate3d(${Math.round(dx)}px, ${Math.round(dy)}px, 0)`;
  };

  const createGhost = (drag: ActiveDrag) => {
    if (!doc) return null;
    const rect = drag.node.getBoundingClientRect();
    const ghost = doc.createElement("div");
    ghost.className = "sidebar-drag-ghost";
    ghost.style.width = `${Math.round(rect.width)}px`;
    ghost.style.height = `${Math.round(rect.height)}px`;
    ghost.style.left = `${Math.round(rect.left)}px`;
    ghost.style.top = `${Math.round(rect.top)}px`;
    const inner = doc.createElement("div");
    inner.className = "sidebar-drag-ghost-inner";
    const clone = drag.node.cloneNode(true) as HTMLElement;
    clone.classList.remove("is-dragging", "is-drop-before", "is-drop-after");
    clone.querySelectorAll?.("[id]").forEach((node) => node.removeAttribute("id"));
    inner.appendChild(clone);
    ghost.appendChild(inner);
    doc.body.appendChild(ghost);
    return ghost;
  };

  const autoScroll = () => {
    const drag = current;
    if (!drag?.active) return;
    const base = drag.scroller.getBoundingClientRect();
    const zone = Math.min(AUTOSCROLL_ZONE, base.height / 3);
    let delta = 0;
    if (drag.lastY < base.top + zone)
      delta = -Math.ceil(((base.top + zone - drag.lastY) / zone) * AUTOSCROLL_MAX);
    else if (drag.lastY > base.bottom - zone)
      delta = Math.ceil(
        ((drag.lastY - (base.bottom - zone)) / zone) * AUTOSCROLL_MAX,
      );
    if (delta) {
      const max = drag.scroller.scrollHeight - drag.scroller.clientHeight;
      const next = Math.max(0, Math.min(max, drag.scroller.scrollTop + delta));
      if (next !== drag.scroller.scrollTop) {
        drag.scroller.scrollTop = next;
        refresh(drag);
      }
    }
    drag.frame = requestAnimationFrame(autoScroll);
  };

  const onScroll = () => {
    if (current?.active) refresh(current);
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !current) return;
    event.preventDefault();
    event.stopPropagation();
    finish(false);
  };

  const cleanup = (drag: ActiveDrag) => {
    if (drag.frame !== null) cancelAnimationFrame(drag.frame);
    clearMarks(drag.target);
    sourceNode(drag).classList.remove("is-dragging");
    drag.indicator.remove();
    if (drag.ghost) {
      const ghost = drag.ghost;
      if (motionEnabled()) {
        ghost.classList.add("is-leaving");
        doc?.defaultView?.setTimeout(() => ghost.remove(), 120);
      } else ghost.remove();
    }
    drag.scroller.removeEventListener("scroll", onScroll);
    doc?.removeEventListener("keydown", onKey, true);
    doc?.removeEventListener("pointermove", onMove);
    doc?.removeEventListener("pointerup", onUp);
    doc?.removeEventListener("pointercancel", onCancel);
    if (doc?.body) {
      doc.body.style.userSelect = "";
      doc.body.classList.remove("is-dragging-sidebar");
    }
  };

  const motionEnabled = () => {
    if (options.animate === false) return false;
    const root = doc?.documentElement;
    if (!root) return false;
    if (root.dataset.motion === "off") return false;
    try {
      return !doc?.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)")
        .matches;
    } catch {
      return true;
    }
  };

  /** 落位前记录各行的位置，React 重排后再从旧位置滑到新位置。 */
  const snapshotRows = (kind: SidebarDragKind) => {
    const nodes = [...rows[kind].values()].map((node) =>
      kind === "project"
        ? ((node.closest(".project-group") as HTMLElement | null) ?? node)
        : node,
    );
    return new Map(nodes.map((node) => [node, node.getBoundingClientRect()]));
  };

  const playFlip = (
    before: Map<HTMLElement, DOMRect>,
    attempt = 0,
  ) => {
    if (!motionEnabled()) return;
    // React 的提交可能晚于第一帧；位置没变化时再看一帧，最多两次。
    requestAnimationFrame(() => {
      const moves: { node: HTMLElement; dy: number }[] = [];
      for (const [node, rect] of before) {
        if (!node.isConnected) continue;
        const dy = rect.top - node.getBoundingClientRect().top;
        if (Math.abs(dy) >= 1) moves.push({ node, dy });
      }
      if (!moves.length) {
        if (attempt < 2) playFlip(before, attempt + 1);
        return;
      }
      for (const { node, dy } of moves) {
        node.animate?.(
          [
            { transform: `translateY(${dy}px)` },
            { transform: "translateY(0)" },
          ],
          {
            duration: FLIP_DURATION,
            easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
          },
        );
      }
    });
  };

  /** 落点就是当前位置时不写设置、也不播动画。 */
  const isNoop = (drag: ActiveDrag, before: string | null) => {
    const ids = orderedRows(drag.target, true).map((item) => item.id);
    const index = ids.indexOf(drag.target.id);
    return before === (ids[index + 1] ?? null);
  };

  const finish = (commit: boolean) => {
    const drag = current;
    if (!drag) return;
    current = null;
    const moved = drag.active && commit;
    const drop = moved ? locate(drag) : null;
    const noop = moved ? isNoop(drag, drop?.before ?? null) : true;
    const before = moved && !noop ? snapshotRows(drag.target.kind) : null;
    cleanup(drag);
    if (!moved || noop) return;
    if (drag.target.kind === "project")
      options.onProjectMove(drag.target.id, drop?.before ?? null);
    else if (drag.target.projectKey)
      options.onSessionMove(
        drag.target.projectKey,
        drag.target.id,
        drop?.before ?? null,
      );
    if (before) playFlip(before);
  };

  const onMove = (event: PointerEvent) => {
    const drag = current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    if (!drag.active) {
      if (
        Math.abs(event.clientX - drag.startX) < THRESHOLD_PX &&
        Math.abs(event.clientY - drag.startY) < THRESHOLD_PX
      )
        return;
      drag.active = true;
      sourceNode(drag).classList.add("is-dragging");
      drag.scroller.appendChild(drag.indicator);
      drag.ghost = createGhost(drag);
      updateGhost(drag);
      drag.scroller.addEventListener("scroll", onScroll, { passive: true });
      doc?.addEventListener("keydown", onKey, true);
      if (doc?.body) {
        doc.body.style.userSelect = "none";
        doc.body.classList.add("is-dragging-sidebar");
      }
      drag.frame = requestAnimationFrame(autoScroll);
    }
    event.preventDefault();
    updateGhost(drag);
    refresh(drag);
  };

  const onUp = (event: PointerEvent) => {
    if (current?.pointerId === event.pointerId) finish(true);
  };

  const onCancel = (event: PointerEvent) => {
    if (current?.pointerId === event.pointerId) finish(false);
  };

  return {
    registerRow(kind: SidebarDragKind, id: string, node: HTMLElement) {
      rows[kind].set(id, node);
      return () => {
        if (rows[kind].get(id) === node) rows[kind].delete(id);
      };
    },
    startDrag(
      event: ReactPointerEvent<HTMLElement>,
      target: SidebarDragTarget,
    ) {
      if (current) return;
      if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0))
        return;
      const node = rows[target.kind].get(target.id);
      const scroller = node?.closest<HTMLElement>(".thread-list");
      if (!doc || !node || !scroller) return;
      const indicator = doc.createElement("div");
      indicator.className = "sidebar-drop-indicator";
      current = {
        target,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        active: false,
        node,
        scroller,
        indicator,
        ghost: null,
        frame: null,
        drop: null,
      };
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // 合成事件或指针已释放：没有捕获也能继续用 document 监听拖动。
      }
      doc.addEventListener("pointermove", onMove, { passive: false });
      doc.addEventListener("pointerup", onUp);
      doc.addEventListener("pointercancel", onCancel);
    },
    dispose() {
      finish(false);
      if (!doc) return;
      doc.removeEventListener("pointermove", onMove);
      doc.removeEventListener("pointerup", onUp);
      doc.removeEventListener("pointercancel", onCancel);
    },
    /** 键盘/无障碍操作：直接落位，不走指针。 */
    moveTo(target: SidebarDragTarget, before: string | null) {
      if (target.kind === "project") options.onProjectMove(target.id, before);
      else if (target.projectKey)
        options.onSessionMove(target.projectKey, target.id, before);
    },
  };
}

export type SidebarDragController = ReturnType<typeof createSidebarDrag>;
