import { useEffect, useState } from "react";
import { api, post } from "../api";
import type { ModelInfo, ThreadSummary } from "../types";
import { Button } from "../kit";

type Configuration = { providerId?: string; model?: string; reasoningEffort?: string };
type Target = { id: string; name: string; online: boolean; steer?: boolean; configuration: Configuration; profiles: { id: string; name: string; current?: boolean }[] };

type ReturnMode = "queue" | "steer" | "interrupt";

/** 回传接收方（来源）支持 steer 时默认推荐即时追加；用户手动选过则尊重选择。 */
export function resolveReturnMode(current: ReturnMode, touched: boolean, steer?: boolean): ReturnMode {
  if (steer && !touched) return "steer";
  if (!steer && current === "steer") return "queue";
  return current;
}

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
  const [detached, setDetached] = useState(false);
  const [mode, setMode] = useState<ReturnMode>("queue");
  const [modeTouched, setModeTouched] = useState(false);
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
  // 回传方式由来源能力决定，与新建子会话的目标无关。
  useEffect(() => {
    const source = targets.find((item) => item.id === (thread.agentId || "codex"));
    if (!source) return;
    setMode((current) => resolveReturnMode(current, modeTouched, source.steer));
  }, [thread.agentId, targets, modeTouched]);
  if (thread.ask) return null;
  const selectedTarget = targets.find((item) => item.id === target);
  const sourceSteer = targets.find((item) => item.id === (thread.agentId || "codex"))?.steer;
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
          targetAgentId: target, question, returnMode: mode, detached,
          configuration: manual ? configuration : undefined, session: `${thread.agentId || "codex"}:${thread.id}`,
          sessionExplicit: true,
        });
        setResult(detached
          ? `已创建 Detached 询问 ${response.item.id}。可继续自己的工作，稍后在任务回传面板读取结果；完成、失败和中断都不自动通知来源。`
          : `已创建询问 ${response.item.id}。本回合可以结束，不要 sleep 或轮询等待；目标会主动回传，最终回复不会自动转发。`);
        setQuestion(""); onCreated();
      } catch (error: any) { setError(error.message || "询问创建失败"); }
      finally { setBusy(false); }
    }}>
      <p className="form-hint">每次新建独立会话；选择主动回传，或独立执行后自行读取结果。</p>
      <label>协作方式<select aria-label="协作方式" value={detached ? "detached" : "send"} disabled={busy} onChange={(event) => setDetached(event.target.value === "detached")}>
        <option value="send">Send：目标主动回传</option>
        <option value="detached">Detached：独立执行，自行读取结果</option>
      </select></label>
      {detached && <p className="form-hint">最终答复会保存为结果；完成、失败和中断都不自动向来源发消息。目标仍可显式 send 联系来源。</p>}
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
      <label>{detached ? "显式 Send 的投递方式" : "消息回传方式"}<select aria-label="消息回传方式" value={mode} disabled={busy} onChange={(event) => { setMode(event.target.value as typeof mode); setModeTouched(true); }}>
        <option value="queue">Queue：等待当前回合结束</option>
        <option value="steer" disabled={!sourceSteer}>即时追加：来源运行时追加到当前回合，不打断</option>
        <option value="interrupt">打断：停止当前回合后发送</option>
      </select></label>
      {sourceSteer && mode !== "steer" && <p className="form-hint">来源会话支持即时追加：运行时直接追加、不打断；此设置只影响主动 send。</p>}
      {mode === "steer" && <p className="form-hint">运行时直接追加、不打断；空闲时直接发送；对方回合变化时需重试。</p>}
      <label>问题<textarea aria-label="问题" rows={5} maxLength={80_000} value={question} disabled={busy} required onChange={(event) => setQuestion(event.target.value)} /></label>
      {error && <p className="error-text" role="alert">{error}</p>}
      {result && <p className="form-hint" role="status">{result}</p>}
      <Button variant="primary" type="submit" disabled={busy || !target || !question.trim()}>{busy ? "正在创建…" : "发起询问"}</Button>
    </form>
  </details>;
}
