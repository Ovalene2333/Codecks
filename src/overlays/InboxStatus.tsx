import { useEffect, useState } from "react";
import { api, post } from "../api";
import { Button, Section } from "../kit";
import { ConfirmDialog } from "../ui";

type Status = { pending: number; unknown: number; paused: boolean; reason?: string; error?: string;
  uncertain?: { batchId: string; count: number; createdAt: number }[] };

export function InboxStatus({ agentId, threadId }: { agentId: string; threadId: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<{ batchId: string; delivered: boolean } | null>(null);
  const endpoint = `/deck/inbox/${encodeURIComponent(agentId)}/${encodeURIComponent(threadId)}`;
  useEffect(() => {
    let cancelled = false;
    const refresh = () => api<Status>(endpoint).then((value) => {
      if (!cancelled) { setStatus(value); setError(value.error || ""); }
    }).catch((failure: Error) => { if (!cancelled) setError(failure.message); });
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [endpoint]);
  const resume = async () => {
    setBusy(true);
    try { setStatus(await post<Status>(`${endpoint}/resume`, {})); setError(""); }
    catch (failure: any) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const recover = async () => {
    if (!recovery) return;
    setBusy(true);
    try { setStatus(await post<Status>(`${endpoint}/recover`, recovery)); setRecovery(null); setError(""); }
    catch (failure: any) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return <><Section title="Agent 收件箱" actions={status?.paused && <Button busy={busy} onClick={() => void resume()}>继续自动处理</Button>}>
    <p role="status" className="ui-section__desc">
      {status ? `待领取 ${status.pending} 条 · 待核对投递 ${status.unknown} 条` : "正在读取收件箱…"}
      {status?.paused && ` · 自动处理已暂停（${status.reason === "stopped" ? "已停止" : "达到自动回合预算"}）`}
    </p>
    <p className="ui-section__desc">运行中用 receive 取信；空闲时批量继续。查看此面板不会领取消息或标记已读。</p>
    {Boolean(status?.unknown) && <p className="ui-section__desc">部分原生投递受理状态不确定，未自动重发；请核对会话历史与投递回执。</p>}
    {status?.uncertain?.map((batch) => <div key={batch.batchId}>
      <p className="ui-section__desc">待核对批次 · {batch.count} 条 · {new Date(batch.createdAt).toLocaleString()}</p>
      <Button variant="ghost" busy={busy} onClick={() => setRecovery({ batchId: batch.batchId, delivered: true })}>确认已送达</Button>
      <Button variant="ghost" busy={busy} onClick={() => setRecovery({ batchId: batch.batchId, delivered: false })}>确认未送达，重新排队</Button>
    </div>)}
    {error && <p role="alert" className="error-text">{error}</p>}
  </Section>{recovery && <ConfirmDialog title="人工核对投递" body={recovery.delivered
    ? "请先核对原生会话历史。确认已送达后，本批次将不再自动投递；这不表示任务已经完成。"
    : "仅在确认原生会话未受理时继续。重新排队可能重复执行命令或产生额外模型费用。"}
    confirmLabel="确认核对结果" danger={!recovery.delivered} onConfirm={recover} onClose={() => setRecovery(null)} />}</>;
}
