import {
  Component,
  useEffect,
  useId,
  useRef,
  type ErrorInfo,
  type ReactNode,
} from "react";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import useMediaQuery from "@mui/material/useMediaQuery";
import { X } from "lucide-react";
import { AppButton, AppIconButton } from "./design-system/components";
import type { ThreadSummary } from "./types";

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
  children,
  className,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const fullScreen = useMediaQuery("(max-width: 760px)");
  return (
    <Dialog
      open
      disablePortal={typeof window === "undefined"}
      fullWidth
      fullScreen={fullScreen}
      maxWidth="sm"
      aria-labelledby={titleId}
      onClose={onClose}
      slotProps={{
        backdrop: { className: "modal-backdrop" },
        paper: {
          className: `modal ds-dialog${className ? ` ${className}` : ""}`,
        },
      }}
    >
      <DialogTitle id={titleId}>
        <span>{title}</span>
        <AppIconButton label="关闭" onClick={onClose}>
          <X />
        </AppIconButton>
      </DialogTitle>
      <DialogContent className="ds-dialog-content" sx={{ overflowX: "hidden" }}>
        {children}
      </DialogContent>
    </Dialog>
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
  const titleId = useId();
  return (
    <Dialog
      open
      disablePortal={typeof window === "undefined"}
      fullWidth
      maxWidth="xs"
      aria-labelledby={titleId}
      onClose={onClose}
      slotProps={{ paper: { className: "ds-dialog ds-confirm-dialog" } }}
    >
      <DialogTitle id={titleId}>
        <span>{title}</span>
        <AppIconButton label="关闭" onClick={onClose}>
          <X />
        </AppIconButton>
      </DialogTitle>
      <DialogContent>
        <div className="confirm-body">{body}</div>
      </DialogContent>
      <DialogActions>
        <AppButton type="button" onClick={onClose}>
          取消
        </AppButton>
        <AppButton
          type="button"
          variant="contained"
          color={danger ? "error" : "primary"}
          onClick={onConfirm}
        >
          {confirmLabel}
        </AppButton>
      </DialogActions>
    </Dialog>
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
    danger?: boolean;
    disabled?: boolean;
    onClick: () => void;
  }[];
  onClose: () => void;
  anchor?: { top: number; right: number };
}) {
  const sheetRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const onDoc = (event: MouseEvent) => {
      if (!sheetRef.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
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
          {actions.map((action) => (
            <button
              key={action.label}
              className={action.danger ? "danger" : ""}
              disabled={action.disabled}
              onClick={() => {
                onClose();
                if (!action.disabled) action.onClick();
              }}
            >
              {action.label}
            </button>
          ))}
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
