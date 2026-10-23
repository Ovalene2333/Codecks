import { useEffect, useState } from "react";
import { api, post } from "../api";
import { Button, Section } from "../kit";
import { DeckPresetsSection } from "../settings/DeckPresetsSection";

type Policy = { resultReady: boolean; failure: boolean; waiting: boolean; windowSeconds: number; minIntervalSeconds: number; detachedFailure: boolean };
type Configuration = { providerId?: string; model?: string; reasoningEffort?: string; approvalPolicy?: string; sandbox?: string; permissionMode?: string; allowedPermissions?: Record<string, string[]> };

/** User settings live outside the chat and never send a conversation message. */
export function DeckCommunicationSettings({ agentId, threadId }: { agentId: string; threadId: string }) {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [agents, setAgents] = useState<{ id: string; name: string; configuration: Configuration }[]>([]);
  const [selected, setSelected] = useState("");
  const [configuration, setConfiguration] = useState<Configuration>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState("");
  const endpoint = `/deck/notices/${encodeURIComponent(agentId)}/${encodeURIComponent(threadId)}`;
  useEffect(() => {
    let cancelled = false;
    Promise.all([api<{ policy: Policy; status?: { error?: string; dead: { error?: string }[] } }>(endpoint), api<{ items: typeof agents }>("/deck/agents")]).then(([response, targets]) => {
      if (cancelled) return;
      setPolicy(response.policy); setAgents(targets.items);
      if (response.status?.error) setError(response.status.error);
      else if (response.status?.dead.length) setError(`有 ${response.status.dead.length} 条系统通知投递失败，结果仍可直接查询。`);
      if (targets.items[0]) { setSelected(targets.items[0].id); setConfiguration(targets.items[0].configuration || {}); }
    }).catch((error) => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [endpoint]);
  const save = async (kind: "policy" | "configuration") => {
    setBusy(true); setError(""); setSaved("");
    try {
      if (kind === "policy") await post(endpoint, policy);
      else {
        await post(`/deck/agents/${encodeURIComponent(selected)}/configuration`, configuration);
        setAgents((items) => items.map((item) => item.id === selected ? { ...item, configuration } : item));
      }
      setSaved(kind === "policy" ? "通知订阅已保存" : "创建默认配置已保存");
    } catch (error: any) { setError(error.message || "保存失败"); }
    finally { setBusy(false); }
  };
  return <Section title="通信设置">
    <DeckPresetsSection />
    {error && <p role="alert" className="error-text">{error}</p>}
    {saved && <p role="status" className="form-hint">{saved}</p>}
    {policy && <fieldset disabled={busy} className="deck-communication-fields">
      <legend>本会话的系统通知</legend>
      <p className="form-hint">完成和等待默认不推送；普通任务失败沿用通知，Detached 默认静默。按本订阅执行，Agent 主动发送不受影响。</p>
      {([['resultReady', '结果就绪'], ['failure', '普通任务失败'], ['detachedFailure', 'Detached 任务失败'], ['waiting', '等待或长时间无进展']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={policy[key] === true} onChange={(event) => setPolicy({ ...policy, [key]: event.target.checked })} />{label}</label>)}
      <label>合并窗口（秒）<input className="ui-input" type="number" min={0} max={3600} value={policy.windowSeconds} onChange={(event) => setPolicy({ ...policy, windowSeconds: Number(event.target.value) })} /></label>
      <label>两次通知最短间隔（秒）<input className="ui-input" type="number" min={0} max={86400} value={policy.minIntervalSeconds} onChange={(event) => setPolicy({ ...policy, minIntervalSeconds: Number(event.target.value) })} /></label>
      <Button size="sm" onClick={() => save("policy")}>保存通知订阅</Button>
    </fieldset>}
    {!!agents.length && <fieldset disabled={busy} className="deck-communication-fields">
      <legend>目标 Agent 创建默认配置</legend>
      <label>Agent<select className="ui-input" aria-label="目标 Agent" value={selected} onChange={(event) => { setSelected(event.target.value); setConfiguration(agents.find((item) => item.id === event.target.value)?.configuration || {}); }}>{agents.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      {([['providerId', '供应商 ID'], ['model', '模型'], ['reasoningEffort', '推理强度']] as const).map(([key, label]) => <label key={key}>{label}<input className="ui-input" value={configuration[key] || ""} placeholder="原生默认" onChange={(event) => setConfiguration({ ...configuration, [key]: event.target.value || undefined })} /></label>)}
      {([
        ['approvalPolicy', '审批默认值', ['untrusted', 'on-request', 'never']],
        ['sandbox', '沙箱默认值', ['read-only', 'workspace-write', 'danger-full-access']],
        ['permissionMode', '权限模式默认值', ['plan', 'default', 'acceptEdits', 'dontAsk', 'bypassPermissions']],
      ] as const).map(([key, label, values]) => <div key={key}>
        <label>{label}<select className="ui-input" aria-label={label} value={configuration[key] || ""} onChange={(event) => setConfiguration({ ...configuration, [key]: event.target.value || undefined })}><option value="">原生默认</option>{values.map((value) => <option key={value}>{value}</option>)}</select></label>
        <details><summary>允许 Agent 选择的{label.replace("默认值", "")}</summary>
          {values.map((value) => <label key={value}><input type="checkbox" checked={configuration.allowedPermissions?.[key]?.includes(value) || false} onChange={(event) => {
            const previous = configuration.allowedPermissions?.[key] || [];
            setConfiguration({ ...configuration, allowedPermissions: { ...configuration.allowedPermissions, [key]: event.target.checked ? [...previous, value] : previous.filter((entry) => entry !== value) } });
          }} />{value}</label>)}
        </details>
      </div>)}
      <p className="form-hint">默认值与允许集合相互独立；空集合禁止 Agent 自选权限。默认值留空时使用原生默认。此配置全局作用于该 Agent 之后创建的会话。</p>
      <Button size="sm" onClick={() => save("configuration")}>保存创建默认配置</Button>
    </fieldset>}
  </Section>;
}
