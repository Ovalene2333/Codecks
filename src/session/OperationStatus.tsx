import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { usePendingSessionOperations } from "./operations";

/** Keep the clock local: waiting a second must not rerender the chat timeline. */
export function OperationStatus({
  title, name, detail, slowDetail, startedAt, className = "",
}: {
  title: string;
  name?: string;
  detail: string;
  slowDetail?: string;
  startedAt?: number;
  className?: string;
}) {
  const mountedAt = useRef(Date.now());
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - (startedAt ?? mountedAt.current)) / 1_000));
  const elapsed = seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
  return (
    <div className={`operation-status ${className}`} role="status">
      <span className="operation-status-spinner" aria-hidden="true"><LoaderCircle /></span>
      <div className="operation-status-content">
        <div className="operation-status-heading">
          <strong>{title}</strong>
          <span className="operation-status-elapsed" aria-hidden="true">已等待 {elapsed}</span>
        </div>
        {name && <div className="operation-status-name" title={name}>{name}</div>}
        <p>{seconds >= 8 && slowDetail ? slowDetail : detail}</p>
      </div>
    </div>
  );
}

export function SessionOperationList() {
  const operations = usePendingSessionOperations();
  if (!operations.length) return null;
  return (
    <div className="session-operation-list" aria-label="会话操作进度">
      {operations.map((operation) => (
        <OperationStatus
          key={operation.key}
          startedAt={operation.startedAt}
          name={operation.name}
          title={operation.kind === "fork" ? "正在创建分支" : "正在删除会话"}
          detail={operation.kind === "fork"
            ? "正在复制会话历史，你可以继续浏览其他会话。"
            : "确认删除成功后会从列表移除，你可以继续浏览。"}
          slowDetail={operation.kind === "fork"
            ? "历史较多时复制需要更久，完成后会通知你。"
            : "仍在等待删除结果，确认成功前会保留原会话。"}
        />
      ))}
    </div>
  );
}
