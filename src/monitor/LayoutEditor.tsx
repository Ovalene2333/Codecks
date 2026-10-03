import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Clock3,
  Gauge,
  GripVertical,
  HeartPulse,
  Inbox,
  Play,
  Radar,
  type LucideIcon,
} from "lucide-react";
import { moveItem, type AsidePanelId, type MainPanelId } from "./layout";

export interface PanelMeta {
  title: string;
  Icon: LucideIcon;
  /** 复用首页面板的色调类（attention / unseen / running / watch）。 */
  tone?: string;
  /** 平时没有内容就不显示的面板，编辑态提示一句，免得找不到它排在哪。 */
  hideWhenEmpty?: boolean;
}

export const MAIN_PANEL_META: Record<MainPanelId, PanelMeta> = {
  attention: { title: "需要处理", Icon: CircleAlert, tone: "attention", hideWhenEmpty: true },
  unseen: { title: "新回复", Icon: Inbox, tone: "unseen", hideWhenEmpty: true },
  running: { title: "运行中", Icon: Play, tone: "running", hideWhenEmpty: true },
  recent: { title: "最近会话", Icon: Clock3, tone: "recent", hideWhenEmpty: true },
  watch: { title: "deck-wake 监督中", Icon: Radar, tone: "watch" },
};

export const ASIDE_PANEL_META: Record<AsidePanelId, PanelMeta> = {
  usage: { title: "用量与额度", Icon: Gauge },
  health: { title: "运行健康", Icon: HeartPulse },
};

interface DragState {
  pointerId: number;
  from: number;
  to: number;
  dy: number;
  startY: number;
  /** 被拖行的高度 + 行距：让位的行要挪这么多。 */
  step: number;
  /** 各行原始中线（视口坐标），用来判定落点。 */
  centers: number[];
  minDy: number;
  maxDy: number;
}

/**
 * 「调整布局」编辑态的一栏：面板折叠成标题条，按住整行拖动排序，
 * 也可以用上移/下移按钮（键盘、读屏可用）。只在本栏内排序。
 *
 * 拖动用 Pointer Events 自己实现：鼠标、触摸、触控笔一套逻辑；
 * 行上 touch-action: none，手机上按住行不会把页面滚走。
 */
export function LayoutEditor<T extends string>({
  label,
  order,
  meta,
  onChange,
}: {
  label: string;
  order: T[];
  meta: Record<T, PanelMeta>;
  onChange: (next: T[]) => void;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [announce, setAnnounce] = useState("");
  // 按钮移动后焦点跟着面板走；挪到头时那一侧按钮会被禁用，改落到另一侧。
  const pendingFocus = useRef<{ id: T; dir: "up" | "down" } | null>(null);

  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || !listRef.current) return;
    pendingFocus.current = null;
    const row = listRef.current.querySelector<HTMLElement>(`[data-layout-id="${pending.id}"]`);
    const preferred = row?.querySelector<HTMLButtonElement>(`button[data-dir="${pending.dir}"]`);
    const other = row?.querySelector<HTMLButtonElement>(
      `button[data-dir="${pending.dir === "up" ? "down" : "up"}"]`,
    );
    (preferred && !preferred.disabled ? preferred : other)?.focus();
  }, [order]);

  const commit = (from: number, to: number) => {
    if (from === to) return;
    const id = order[from];
    onChange(moveItem(order, from, to));
    setAnnounce(`「${meta[id].title}」已移到第 ${to + 1} 位，共 ${order.length} 个`);
  };

  const moveBy = (index: number, delta: -1 | 1) => {
    pendingFocus.current = { id: order[index], dir: delta < 0 ? "up" : "down" };
    commit(index, index + delta);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>, index: number) => {
    if (drag || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
    const rows = Array.from(listRef.current?.children ?? []) as HTMLElement[];
    const rects = rows.map((row) => row.getBoundingClientRect());
    const self = rects[index];
    if (!self) return;
    const gap = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      pointerId: event.pointerId,
      from: index,
      to: index,
      dy: 0,
      startY: event.clientY,
      step: self.height + gap,
      centers: rects.map((rect) => rect.top + rect.height / 2),
      minDy: rects[0].top - self.top,
      maxDy: rects[rects.length - 1].bottom - self.bottom,
    });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const dy = Math.max(drag.minDy, Math.min(drag.maxDy, event.clientY - drag.startY));
    const center = drag.centers[drag.from] + dy;
    // 越过谁的中线就和谁换位；拖到头被夹住时正好压在首/末行中线上，也算越过。
    let to = drag.from;
    drag.centers.forEach((mid, i) => {
      if (i > drag.from && center >= mid) to = i;
      if (i < drag.from && center <= mid) to = Math.min(to, i);
    });
    setDrag({ ...drag, dy, to });
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!cancelled) commit(drag.from, drag.to);
    setDrag(null);
  };

  const offsetOf = (index: number) => {
    if (!drag) return 0;
    if (index === drag.from) return drag.dy;
    if (drag.from < drag.to && index > drag.from && index <= drag.to) return -drag.step;
    if (drag.to < drag.from && index >= drag.to && index < drag.from) return drag.step;
    return 0;
  };

  return (
    <section className="layout-editor" aria-label={label}>
      <h2 className="layout-editor-title">{label}</h2>
      <ol ref={listRef} className={`layout-editor-list${drag ? " is-dragging" : ""}`}>
        {order.map((id, index) => {
          const { title, Icon, tone, hideWhenEmpty } = meta[id];
          const offset = offsetOf(index);
          return (
            <li
              key={id}
              data-layout-id={id}
              className={`layout-row home-panel ${tone || ""}${drag?.from === index ? " is-held" : ""}`}
              style={offset ? { transform: `translateY(${offset}px)` } : undefined}
            >
              <div
                className="layout-row-grab"
                onPointerDown={(event) => onPointerDown(event, index)}
                onPointerMove={onPointerMove}
                onPointerUp={(event) => onPointerEnd(event, false)}
                onPointerCancel={(event) => onPointerEnd(event, true)}
              >
                <GripVertical className="layout-row-grip" aria-hidden="true" />
                <Icon className="layout-row-icon" aria-hidden="true" />
                <b>{title}</b>
                {hideWhenEmpty ? <small>空时不显示</small> : null}
              </div>
              <button
                type="button"
                className="icon-btn"
                data-dir="up"
                disabled={index === 0}
                aria-label={`上移「${title}」`}
                title="上移"
                onClick={() => moveBy(index, -1)}
              >
                <ChevronUp />
              </button>
              <button
                type="button"
                className="icon-btn"
                data-dir="down"
                disabled={index === order.length - 1}
                aria-label={`下移「${title}」`}
                title="下移"
                onClick={() => moveBy(index, 1)}
              >
                <ChevronDown />
              </button>
            </li>
          );
        })}
      </ol>
      <span className="layout-editor-live" role="status" aria-live="polite">
        {announce}
      </span>
    </section>
  );
}
