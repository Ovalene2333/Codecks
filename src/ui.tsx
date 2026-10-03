import {
  Component,
  useEffect,
  useRef,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import type { ThreadSummary } from "./types";
import { overlayMarkOf } from "./deck-history";

// —— 弹层历史标记 ————————————————————————————————————————————————
// Modal / Drawer / ActionSheet 打开时压入一条只带 overlay 序号的占位
// 条目（URL 不变），让浏览器/系统返回先关掉最上层弹层而不是退出页面。
// 弹层经 UI 关闭时再把占位弹出；占位若被其他导航压在下面（例如在弹层
// 里又打开了新页面），等它浮到栈顶时自动跳过，不留死档。
// 关闭回调返回 false 表示「拒绝关闭」（如有未保存修改、先弹确认）：
// 此时把被返回键弹掉的占位重新压回去，弹层与历史栈保持一致。
const overlayClosers = new Map<number, () => void | boolean>();
let overlaySeq = 0;
let overlayHooked = false;

function hookOverlayPop() {
  if (overlayHooked || typeof window === "undefined") return;
  overlayHooked = true;
  window.addEventListener("popstate", () => {
    const top = overlayMarkOf(window.history.state);
    // 占位被弹掉的弹层（标记序号大于新栈顶）逐一关闭
    for (const [id, close] of [...overlayClosers]) {
      if (top >= id) continue;
      if (close() === false)
        window.history.pushState(
          {
            ...(window.history.state && typeof window.history.state === "object"
              ? window.history.state
              : {}),
            overlay: id,
          },
          "",
        );
    }
    // 栈顶是无主的死占位（所属弹层已被别的导航关闭）：再退一层跳过
    if (top && !overlayClosers.has(top)) window.history.back();
  });
}

export function useOverlayHistory(onClose: () => void | boolean) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    hookOverlayPop();
    const id = ++overlaySeq;
    overlayClosers.set(id, () => closeRef.current());
    window.history.pushState(
      {
        ...(window.history.state && typeof window.history.state === "object"
          ? window.history.state
          : {}),
        overlay: id,
      },
      "",
    );
    return () => {
      overlayClosers.delete(id);
      // 占位还在栈顶才需要回退；放到微任务里，避开 StrictMode 双挂载
      // 与同一事务内压入的新页面条目。
      queueMicrotask(() => {
        if (overlayMarkOf(window.history.state) === id) window.history.back();
      });
    };
  }, []);
}

export class RenderErrorBoundary extends Component<
  { resetKey?: string; fallback: ReactNode; children: ReactNode },
  { error?: Error; key?: string }
> {
  state: { error?: Error; key?: string } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { error?: Error; key?: string },
  ) {
    if (props.resetKey !== state.key)
      return { error: undefined, key: props.resetKey };
    return null;
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("session render failed", error, info.componentStack);
  }

  render() {
    if (this.state.error) return this.props.fallback;
    return this.props.children;
  }
}

export function Status({
  status,
  compact,
  unseen,
  label,
}: {
  status: ThreadSummary["status"];
  compact?: boolean;
  unseen?: boolean;
  label?: string;
}) {
  const labels = {
    starting: "启动中",
    running: "运行中",
    waiting: "待确认",
    idle: "空闲",
    error: "异常",
    offline: "离线",
  };
  const showUnseen = Boolean(unseen && status === "idle");
  return (
    <span
      className={`status ${showUnseen ? "unseen" : status} ${compact ? "compact" : ""}`}
    >
      <i />
      <em>{showUnseen ? "有新回复" : label || labels[status]}</em>
    </span>
  );
}

export function Modal({
  title,
  leading,
  children,
  className,
  onClose,
}: {
  title: string;
  /** 标题前的控件（如二级页的返回按钮）。 */
  leading?: ReactNode;
  children: React.ReactNode;
  className?: string;
  /** 返回 false 表示拒绝关闭（调用方自己弹确认）。 */
  onClose: () => void | boolean;
}) {
  useOverlayHistory(onClose);
  return (
    <div className="modal-backdrop" onMouseDown={() => onClose()}>
      <section
        className={`modal${className ? ` ${className}` : ""}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          {leading}
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭"
            title="关闭"
            onClick={() => onClose()}
          >
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = "确定",
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="confirm-body">{body}</div>
      <div className="confirm-actions">
        <button type="button" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className={danger ? "danger-btn" : "primary"}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function ToastStack({
  toasts,
}: {
  toasts: { id: number; message: string }[];
}) {
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" role="status">
      {toasts.map((toast) => (
        <div className="toast" key={toast.id}>
          {toast.message}
        </div>
      ))}
    </div>
  );
}

export function ActionSheet({
  title,
  actions,
  onClose,
  anchor,
}: {
  title: string;
  actions: {
    label: string;
    /** 同名条目（如重名项目）时用来区分 React key。 */
    key?: string;
    /** 可选图标与副标题：有任一时按「图标 + 两行文字」排版。 */
    icon?: ReactNode;
    detail?: string;
    danger?: boolean;
    disabled?: boolean;
    onClick: () => void;
  }[];
  onClose: () => void;
  anchor?: { top: number; right: number };
}) {
  const sheetRef = useRef<HTMLElement>(null);
  useOverlayHistory(onClose);
  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (!sheetRef.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop action-sheet-backdrop" onMouseDown={onClose}>
      <section
        ref={sheetRef}
        className={`modal action-sheet-modal ${anchor ? "anchored" : ""}`}
        style={
          anchor
            ? {
                top: anchor.top,
                right: anchor.right,
                left: "auto",
                bottom: "auto",
              }
            : undefined
        }
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="action-sheet">
          {actions.map((action) => {
            const rich = Boolean(action.icon || action.detail);
            return (
              <button
                key={action.key ?? action.label}
                className={
                  [action.danger ? "danger" : "", rich ? "rich" : ""]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                disabled={action.disabled}
                onClick={() => {
                  onClose();
                  if (!action.disabled) action.onClick();
                }}
              >
                {rich ? (
                  <>
                    {action.icon}
                    <span>
                      <b>{action.label}</b>
                      {action.detail ? <small>{action.detail}</small> : null}
                    </span>
                  </>
                ) : (
                  action.label
                )}
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export function Drawer({
  title,
  children,
  className,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  onClose: () => void;
}) {
  useOverlayHistory(onClose);
  return (
    <div className="drawer-backdrop" onMouseDown={onClose}>
      <section
        className={`usage-drawer${className ? ` ${className}` : ""}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose}>
            <X />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
