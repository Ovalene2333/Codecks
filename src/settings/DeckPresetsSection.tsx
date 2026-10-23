import { useEffect, useState } from "react";
import { api, post } from "../api";
import { ModelPicker } from "../ModelPicker";
import { Button, Section } from "../kit";

type Preset = {
  name: string;
  agentId: string;
  providerId?: string;
  model: string;
  reasoningEffort?: string;
};
const empty: Preset = { name: "", agentId: "", model: "" };

export function DeckPresetsSection() {
  const [items, setItems] = useState<Preset[]>([]);
  const [agents, setAgents] = useState<
    {
      id: string;
      name: string;
      profiles?: { id: string; name: string; current?: boolean }[];
    }[]
  >([]);
  const [selected, setSelected] = useState("");
  const [draft, setDraft] = useState<Preset>(empty);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setError("");
    Promise.all([
      api<{ items: Preset[] }>("/deck/presets"),
      api<{ items: typeof agents }>("/deck/agents"),
    ])
      .then(([presets, targets]) => {
        if (cancelled) return;
        setItems(presets.items);
        setAgents(targets.items);
        setLoaded(true);
        setSelected("");
        setDraft({ ...empty, agentId: targets.items[0]?.id || "" });
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);
  const persist = async (remove = false) => {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const value = {
        ...draft,
        name: draft.name.trim(),
        model: draft.model.trim(),
        providerId: draft.providerId?.trim() || undefined,
        reasoningEffort: draft.reasoningEffort?.trim() || undefined,
      };
      if (
        !remove &&
        items.some((item) => item.name === value.name && item.name !== selected)
      )
        throw new Error("预设名称已存在，请使用其他名称");
      const next = items.filter((item) => item.name !== selected);
      if (!remove) next.push(value);
      const response = await post<{ items: Preset[] }>("/deck/presets", {
        items: next,
      });
      setItems(response.items);
      setSelected(remove ? "" : value.name);
      setDraft(remove ? { ...empty, agentId: agents[0]?.id || "" } : value);
      setSaved(remove ? "预设已删除" : "预设已保存");
    } catch (error: any) {
      setError(error.message || "保存失败");
    } finally {
      setBusy(false);
    }
  };
  const profiles =
    agents.find((agent) => agent.id === draft.agentId)?.profiles || [];
  const providerId =
    draft.providerId ||
    profiles.find((profile) => profile.current)?.id ||
    (profiles.length === 1 ? profiles[0].id : "");
  return (
    <Section
      title="deck-api 创建预设"
      desc="保存 Agent、供应商、模型和 effort 组合，供 deck-api 按名称使用。"
    >
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {saved && (
        <p role="status" className="form-hint">
          {saved}
        </p>
      )}
      {!loaded && (
        <Button size="sm" onClick={() => setReload((value) => value + 1)}>
          重新读取预设
        </Button>
      )}
      <fieldset
        disabled={!loaded || busy}
        className="deck-communication-fields"
      >
        <legend>命名组合</legend>
        <label>
          编辑预设
          <select
            className="ui-input"
            aria-label="编辑预设"
            value={selected}
            onChange={(event) => {
              const name = event.target.value;
              setSelected(name);
              setDraft(
                items.find((item) => item.name === name) || {
                  ...empty,
                  agentId: agents[0]?.id || "",
                },
              );
              setError("");
              setSaved("");
            }}
          >
            <option value="">新增预设</option>
            {items.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          预设名称
          <input
            className="ui-input"
            value={draft.name}
            maxLength={64}
            placeholder="例如 review"
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
        </label>
        <label>
          Agent
          <select
            className="ui-input"
            aria-label="预设 Agent"
            value={draft.agentId}
            onChange={(event) =>
              setDraft({
                ...draft,
                agentId: event.target.value,
                providerId: undefined,
                model: "",
                reasoningEffort: undefined,
              })
            }
          >
            {!agents.some((item) => item.id === draft.agentId) && (
              <option value={draft.agentId}>
                {draft.agentId || "无可用 Agent"}
              </option>
            )}
            {agents.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          供应商
          <select
            className="ui-input"
            aria-label="预设供应商"
            value={draft.providerId || ""}
            onChange={(event) =>
              setDraft({
                ...draft,
                providerId: event.target.value || undefined,
                model: "",
                reasoningEffort: undefined,
              })
            }
          >
            <option value="">Agent 默认供应商</option>
            {draft.providerId &&
              !profiles.some((profile) => profile.id === draft.providerId) && (
                <option value={draft.providerId}>
                  {draft.providerId}（当前不可用）
                </option>
              )}
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        {loaded && draft.agentId && (
          <ModelPicker
            key={`${selected}:${draft.agentId}:${providerId}`}
            agentId={draft.agentId}
            providerId={providerId}
            model={draft.model}
            reasoningEffort={draft.reasoningEffort || ""}
            disabled={busy}
            onChange={(next) => setDraft((value) => ({ ...value, ...next }))}
          />
        )}
        <p className="form-hint">
          名称使用字母、数字、- 或 _。模型必填；OpenCode 使用
          provider/model。effort 留空用原生默认。权限沿用目标 Agent
          的创建默认配置与允许集合。
        </p>
        <p className="form-hint">
          {draft.name.trim() &&
          /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(draft.name.trim())
            ? `deck-api create --preset ${draft.name.trim()} -- '任务'`
            : "deck-api presets 查看已保存的组合"}
        </p>
        <div className="deck-preset-actions">
          <Button
            size="sm"
            disabled={
              !draft.name.trim() || !draft.agentId || !draft.model.trim()
            }
            onClick={() => persist()}
          >
            保存预设
          </Button>
          {selected && (
            <Button size="sm" variant="ghost" onClick={() => persist(true)}>
              删除预设
            </Button>
          )}
        </div>
      </fieldset>
    </Section>
  );
}
