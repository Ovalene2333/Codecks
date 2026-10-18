import { sessionKey } from "../format";
import { sessionPath } from "../deck-history";
import type { ThreadSummary } from "../types";

export const ASK_STATUS = { creating: "创建中", queued: "等待发送", running: "处理中", answered: "已完成（已回传）", completed: "已完成（未回传）", failed: "失败" };

export function AskNotice({ thread }: { thread: ThreadSummary }) {
  const ask = thread.ask;
  if (!ask) return null;
  const source = sessionKey({ agentId: ask.sourceAgentId, providerId: ask.sourceProviderId || "", id: ask.sourceThreadId });
  const status = ask.status === "completed" && ask.sentCount ? "已完成（已回传）" : ASK_STATUS[ask.status];
  return <div className="ask-notice" role="status">
    <span>Agent 询问，{status}，{ask.returnMode === "interrupt" ? "打断回传" : ask.returnMode === "steer" ? "即时追加回传" : "Queue 回传"}</span>
    {ask.alias && <span>询问别名 @{ask.alias}</span>}
    <span>模型：{thread.model && thread.model !== "default" ? thread.model : "原生默认"}，推理强度：{thread.reasoningEffort || "原生默认"}</span>
    <span>累计提交回传 {ask.sentCount || 0} 条</span>
    <a href={sessionPath(source)}>查看发起会话</a>
    {ask.error && <span className="error-text">{ask.error}</span>}
  </div>;
}
