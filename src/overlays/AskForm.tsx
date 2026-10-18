import { useEffect, useState } from "react";
import { api, post } from "../api";
import type { ModelInfo, ThreadSummary } from "../types";
import { Button } from "../kit";

type Configuration = { providerId?: string; model?: string; reasoningEffort?: string };
type Target = { id: string; name: string; online: boolean; configuration: Configuration; profiles: { id: string; name: string; current?: boolean }[] };

export function AskForm({ thread, onCreated }: { thread: ThreadSummary; onCreated: () => void }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [target, setTarget] = useState("");
  const [provider, setProvider] = useState("");
  const [manual, setManual] = useState(false);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelError, setModelError] = useState("");
  const [question, setQuestion] = useState("");
  const [mode, setMode] = useState<"queue" | "interrupt">("queue");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  useEffect(() => {
    let cancelled = false;
    api<{ items: Target[] }>("/deck/agents").then(({ items }) => {
      if (cancelled) return;
      setTargets(items);
      setTarget(items.find((item) => item.online && item.id !== (thread.agentId || "codex"))?.id || items.find((item) => item.online)?.id || "");
    }).catch((error: Error) => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [thread.agentId]);
  useEffect(() => {
    if (!manual || !target) return;
    let cancelled = false;
    setModels([]); setModelsLoading(true); setModelError("");
    const query = new URLSearchParams({ directory: thread.cwd || "" });
    if (provider) query.set("providerId", provider);
    api<ModelInfo[] | { models: ModelInfo[] }>(`/agents/${encodeURIComponent(target)}/models?${query}`).then((response) => {
      if (!cancelled) setModels(Array.isArray(response) ? response : response.models || []);
    }).catch((error: Error) => { if (!cancelled) setModelError(error.message); })
      .finally(() => { if (!cancelled) setModelsLoading(false); });
    return () => { cancelled = true; };
  }, [manual, target, provider, thread.cwd]);
  if (thread.ask) return null;
  const selectedTarget = targets.find((item) => item.id === target);
  const selectedModel = models.find((item) => model ? item.id === model || item.model === model : item.isDefault);
  const efforts = selectedModel?.supportedReasoningEfforts || [];
  const configuration = { providerId: provider || undefined, model: model || undefined, reasoningEffort: effort || undefined };
  const resetManual = () => { setProvider(""); setModel(""); setEffort(""); setModels([]); };
  const defaults = selectedTarget?.configuration;

  const profiles = targets.find((item) => item.id === target)?.profiles || [];
  return <details className="ask-form">
    <summary>向另一个 Agent 提问</summary>
    <form className="form" onSubmit={async (event) => {
      event.preventDefault();
      if (busy) return;
      setBusy(true); setError(""); setResult("");
      try {
        const response = await post<{ item: { id: string } }>("/deck/create", {
          targetAgentId: target, question, returnMode: mode,
          configuration: manual ? configuration : undefined, session: `${thread.agentId || "codex"}:${thread.id}`,
          sessionExplicit: true,
        });
        setResult(`已创建询问 ${response.item.id}。本回合可以结束，不要 sleep 或轮询等待；目标会主动回传，最终回复不会自动转发。`);
        setQuestion(""); onCreated();
      } catch (error: any) { setError(error.message || "询问创建失败"); }
      finally { setBusy(false); }
    }}>
      <p className="form-hint">每次新建独立会话；目标用 deck-api send 主动回传，最终回复不会自动转发。</p>
      <label>目标 Agent<select aria-label="目标 Agent" value={target} disabled={busy || !targets.length} onChange={(event) => { setTarget(event.target.value); resetManual(); setManual(false); }}>
        {!targets.length && <option value="">正在读取…</option>}
        {targets.map((item) => <option key={item.id} value={item.id} disabled={!item.online}>{item.name}{!item.online ? "（离线）" : ""}</option>)}
      </select></label>
      <label>询问配置<select aria-label="询问配置" value={manual ? "manual" : "default"} disabled={busy} onChange={(event) => { setManual(event.target.value === "manual"); resetManual(); }}>
        <option value="default">使用默认</option><option value="manual">手动指定（仅本次）</option>
      </select></label>
      {!manual && <p className="form-hint">默认：供应商 {profiles.find((item) => item.id === defaults?.providerId)?.name || defaults?.providerId || "跟随目标 Agent"}，模型 {defaults?.model || "原生默认"}，推理强度 {defaults?.reasoningEffort || "原生默认"}</p>}
      {manual && <>
        <label>目标供应商<select aria-label="目标供应商" value={provider} disabled={busy} onChange={(event) => { setProvider(event.target.value); setModel(""); setEffort(""); }}>
          <option value="">跟随目标 Agent 默认</option>
          {profiles.map((item) => <option key={item.id} value={item.id}>{item.name}{item.current ? "（当前）" : ""}</option>)}
        </select></label>
        <label>模型<select aria-label="模型" value={model} disabled={busy || modelsLoading} onChange={(event) => { setModel(event.target.value); setEffort(""); }}>
          <option value="">{modelsLoading ? "正在读取…" : "跟随原生默认"}</option>
          {models.filter((item) => !item.hidden).map((item) => <option key={item.id} value={item.id}>{item.displayName || item.id}</option>)}
        </select></label>
        <label>推理强度<select aria-label="推理强度" value={effort} disabled={busy || modelsLoading || !efforts.length} onChange={(event) => setEffort(event.target.value)}>
          <option value="">跟随原生默认</option>
          {efforts.map((item) => <option key={item.reasoningEffort} value={item.reasoningEffort}>{item.reasoningEffort}</option>)}
        </select></label>
        {modelError && <p className="error-text" role="alert">模型列表读取失败：{modelError}</p>}
        <Button variant="primary" disabled={busy || modelsLoading} onClick={async () => {
          setBusy(true); setError(""); setResult("");
          try {
            await post(`/deck/agents/${encodeURIComponent(target)}/configuration`, configuration);
            setTargets((items) => items.map((item) => item.id === target ? { ...item, configuration } : item));
            setManual(false); setResult("已保存为此 Agent 的询问默认配置。");
          } catch (error: any) { setError(error.message); }
          finally { setBusy(false); }
        }}>保存为此 Agent 的询问默认</Button>
        <p className="form-hint">空项交给目标 Agent 的原生默认处理。切换模型会清空推理强度；保存默认会应用到之后的询问。</p>
      </>}
      <label>消息回传方式<select aria-label="消息回传方式" value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as typeof mode)}>
        <option value="queue">Queue：等待当前回合结束</option>
        <option value="interrupt">打断：停止当前回合后发送</option>
      </select></label>
      <label>问题<textarea aria-label="问题" rows={5} maxLength={80_000} value={question} disabled={busy} required onChange={(event) => setQuestion(event.target.value)} /></label>
      {error && <p className="error-text" role="alert">{error}</p>}
      {result && <p className="form-hint" role="status">{result}</p>}
      <Button variant="primary" type="submit" disabled={busy || !target || !question.trim()}>{busy ? "正在创建…" : "发起询问"}</Button>
    </form>
  </details>;
}
