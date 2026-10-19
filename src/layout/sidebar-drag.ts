import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * 侧栏项目/会话的拖动排序。
 *
 * 用指针事件而不是 HTML5 drag-and-drop：手机上也能拖，且不用改掉行内的
 * 点击与菜单按钮。拖动时要频繁跟随指针，所以落位线是一条插入列表末尾的
 * 共享浮层，被拖的行只加 class，不触发 React 重渲染。
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
}

const THRESHOLD_PX = 4;

interface ActiveDrag {
  target: SidebarDragTarget;
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  /** 越过 4px 后才真正进入拖动，避免误吞点击。 */
  active: boolean;
  indicator: HTMLDivElement;
  /** 行所在的项目体/行容器：浮层与落位线的定位基准。 */
  container: HTMLElement;
}

export function createSidebarDrag(options: SidebarDragOptions) {
  const doc =
    options.document || (typeof document === "undefined" ? null : document);
  const rows: Record<SidebarDragKind, Map<string, HTMLElement>> = {
    project: new Map(),
    session: new Map(),
  };
  let current: ActiveDrag | null = null;

  const rowIds = (target: SidebarDragTarget) =>
    [...rows[target.kind]]
      .filter(([id]) => id !== target.id)
      .filter(([id]) =>
        target.kind === "project"
          ? true
          : rows.session.get(id)?.dataset.projectKey === target.projectKey,
      );

  const clearMarks = (target: SidebarDragTarget) => {
    for (const [, node] of rowIds(target))
      node.classList.remove("is-drop-before", "is-drop-after");
  };

  /**
   * 指针落在哪一行：上半部分插到它前面，下半部分插到它后面；
   * 落在所有行下方表示移到末尾。
   */
  const locate = (drag: ActiveDrag): string | null => {
    clearMarks(drag.target);
    const items = rowIds(drag.target)
      .map(([id, node]) => ({ id, node, rect: node.getBoundingClientRect() }))
      .filter((item) => item.rect.height > 0);
    const y = drag.lastY;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (y < item.rect.top + item.rect.height / 2) {
        item.node.classList.add("is-drop-before");
        return item.id;
      }
      if (y < item.rect.bottom) {
        item.node.classList.add("is-drop-after");
        return items[index + 1]?.id ?? null;
      }
    }
    return null;
  };

  const paintIndicator = (drag: ActiveDrag) => {
    const mark = drag.container.querySelector<HTMLElement>(
      ".is-drop-before, .is-drop-after",
    );
    if (!mark) {
      drag.indicator.hidden = true;
      return;
    }
    drag.indicator.hidden = false;
    const rect = mark.getBoundingClientRect();
    const base = drag.container.getBoundingClientRect();
    const y =
      mark.classList.contains("is-drop-before") ? rect.top : rect.bottom;
    drag.indicator.style.top = `${Math.round(y - base.top)}px`;
    drag.indicator.style.left = `${Math.round(rect.left - base.left + 8)}px`;
    drag.indicator.style.width = `${Math.max(0, Math.round(rect.width - 8))}px`;
  };

  const cleanup = (drag: ActiveDrag) => {
    clearMarks(drag.target);
    rows[drag.target.kind].get(drag.target.id)?.classList.remove("is-dragging");
    drag.container.classList.remove("is-drag-container");
    drag.indicator.remove();
    if (doc?.body) {
      doc.body.style.userSelect = "";
      doc.body.classList.remove("is-dragging-sidebar");
    }
  };

  const finish = (commit: boolean) => {
    const drag = current;
    if (!drag) return;
    current = null;
    const before = drag.active && commit ? locate(drag) : null;
    cleanup(drag);
    if (!drag.active || !commit) return;
    if (drag.target.kind === "project")
      options.onProjectMove(drag.target.id, before);
    else if (drag.target.projectKey)
      options.onSessionMove(drag.target.projectKey, drag.target.id, before);
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
      drag.container.classList.add("is-drag-container");
      rows[drag.target.kind].get(drag.target.id)?.classList.add("is-dragging");
      drag.container.appendChild(drag.indicator);
      if (doc?.body) {
        doc.body.style.userSelect = "none";
        doc.body.classList.add("is-dragging-sidebar");
      }
    }
    event.preventDefault();
    locate(drag);
    paintIndicator(drag);
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
      const container = node?.parentElement;
      if (!doc || !node || !container) return;
      const indicator = doc.createElement("div");
      indicator.className = "sidebar-drop-indicator";
      indicator.hidden = true;
      current = {
        target,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        active: false,
        indicator,
        container,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
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
