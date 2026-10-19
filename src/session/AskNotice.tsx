import { sessionKey } from "../format";
import { sessionPath } from "../deck-history";
import type { AskSession, ThreadSummary } from "../types";

export const ASK_STATUS = { creating: "创建中", queued: "等待发送", running: "处理中", answered: "已完成（已回传）", completed: "已完成（未回传）", failed: "失败" };

export function askStatusLabel(ask: Pick<AskSession, "status" | "detached" | "resultAvailable" | "sentCount">) {
  if (ask.detached && ["completed", "answered"].includes(ask.status))
    return ask.resultAvailable ? "已完成（结果可读取）" : "已完成（结果待同步）";
  return ask.status === "completed" && ask.sentCount ? ASK_STATUS.answered : ASK_STATUS[ask.status];
}

export function AskNotice({ thread }: { thread: ThreadSummary }) {
  const ask = thread.ask;
  if (!ask) return null;
  const source = sessionKey({ agentId: ask.sourceAgentId, providerId: ask.sourceProviderId || "", id: ask.sourceThreadId });
  const status = askStatusLabel(ask);
  // 会话别名以询问记录里落盘的 targetAlias 为准；thread.alias 可能来自
  // 尚未对齐的增量事件，两者不一致时显示会来回跳。只展示 `s-` 前缀，
  // 避免把询问别名误标成会话别名。
  const sessionAlias =
    [ask.targetAlias, thread.alias].find(
      (value) => typeof value === "string" && value.startsWith("s-"),
    );
  return <div className="ask-notice" role="status">
    <span>Agent 询问，{status}，{ask.detached ? "Detached · 自行读取结果" : ask.returnMode === "interrupt" ? "打断回传" : ask.returnMode === "steer" ? "即时追加回传" : "Queue 回传"}</span>
    {ask.alias && <span>询问别名 @{ask.alias}</span>}
    {sessionAlias && <span>会话别名 @{sessionAlias}</span>}
    <span>模型：{thread.model && thread.model !== "default" ? thread.model : "原生默认"}，推理强度：{thread.reasoningEffort || "原生默认"}</span>
    <span>累计提交回传 {ask.sentCount || 0} 条</span>
    <a href={sessionPath(source)}>查看发起会话</a>
    {ask.error && <span className="error-text">{ask.error}</span>}
  </div>;
}
