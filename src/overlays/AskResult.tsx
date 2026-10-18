import { useState } from "react";
import { api } from "../api";
import type { AskSession } from "../types";
import { askStatusLabel } from "../session/AskNotice";
import { Button } from "../kit";

type ResultResponse = {
  item: AskSession;
  result: { turnId: string; text: string; completedAt: number; truncated: boolean } | null;
  pending: boolean;
};

/** 用户按需读取，不向来源会话注入消息，也不后台轮询交付正文。 */
export function AskResult({ reference }: { reference: string }) {
  const [data, setData] = useState<ResultResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <div className="ask-result">
    <Button variant="ghost" size="sm" disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { setData(await api<ResultResponse>(`/deck/sessions/${encodeURIComponent(reference)}/result`)); }
      catch (error: any) { setError(error.message || "结果读取失败"); }
      finally { setBusy(false); }
    }}>{busy ? "正在读取…" : data ? "刷新结果" : "读取结果"}</Button>
    {error && <p className="error-text" role="alert">{error}</p>}
    {data && <div role="status">
      <p className="form-hint">{askStatusLabel(data.item)}{data.pending ? "，原生历史尚未同步，请稍后刷新。" : ""}</p>
      {data.item.error && <p className="error-text">{data.item.error}</p>}
      {data.result ? <>
        <pre>{data.result.text || "本回合未生成文本答复，请打开子会话查看产物。"}</pre>
        {data.result.truncated && <p className="form-hint">结果较长，当前仅展示前 80000 字符；全文请打开子会话。</p>}
      </> : !data.pending && data.item.status !== "failed" && <p className="form-hint">尚无本回合的最终结果，可打开子会话查看执行过程。</p>}
    </div>}
  </div>;
}
