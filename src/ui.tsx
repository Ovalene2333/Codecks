import { X } from "lucide-react";
import type { ThreadSummary } from "./types";

export function Status({ status }: { status: ThreadSummary["status"] }) {
  const labels = {
    starting: "启动中",
    running: "运行中",
    waiting: "待确认",
    idle: "空闲",
    error: "异常",
    offline: "离线",
  };
  return (
    <span className={`status ${status}`}>
      <i />
      {labels[status]}
    </span>
  );
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal" onMouseDown={(e) => e.stopPropagation()}>
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

export function ActionSheet({
  title,
  actions,
  onClose,
}: {
  title: string;
  actions: {
    label: string;
    danger?: boolean;
    onClick: () => void;
  }[];
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <div className="action-sheet">
        {actions.map((action) => (
          <button
            key={action.label}
            className={action.danger ? "danger" : ""}
            onClick={() => {
              onClose();
              action.onClick();
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}
