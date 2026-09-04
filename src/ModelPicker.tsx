import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { reasoningEffortLabel } from "./codexLabels";
import type { ModelInfo } from "./types";
import type { AgentId } from "./agents";
import { SearchablePicker, type SearchableOption } from "./SearchablePicker";

const SEARCHABLE_CATALOG = 12;

/**
 * Model catalogs change rarely but are read every time a picker mounts (new
 * session, session settings, command palette…), and OpenCode's can hold
 * hundreds of entries. Keep the last answer per request path so reopening a
 * picker paints immediately, and refresh in the background once it goes stale.
 */
const CATALOG_TTL = 60_000;
const catalogCache = new Map<string, { at: number; models: ModelInfo[] }>();
const catalogInflight = new Map<string, Promise<ModelInfo[]>>();

function loadCatalog(path: string) {
  const running = catalogInflight.get(path);
  if (running) return running;
  const task = api<ModelInfo[]>(path)
    .then((list) => {
      const models = Array.isArray(list) ? list : [];
      catalogCache.set(path, { at: Date.now(), models });
      return models;
    })
    .finally(() => {
      catalogInflight.delete(path);
    });
  catalogInflight.set(path, task);
  return task;
}

function modelLabel(item: ModelInfo) {
  const suffix =
    item.isDefault && item.model !== "default"
      ? "（默认）"
      : item.supportsImages === false
        ? "（不支持图片）"
        : "";
  return `${item.displayName}${suffix}`;
}

export function ModelPicker({
  agentId = "codex",
  providerId,
  model,
  reasoningEffort,
  onChange,
  compact,
  disabled,
}: {
  agentId?: AgentId;
  providerId: string;
  model: string;
  reasoningEffort: string;
  onChange: (next: { model: string; reasoningEffort: string }) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [manual, setManual] = useState(false);
  const [loading, setLoading] = useState(false);
  /* OpenCode model ids already carry their provider (`providerID/modelID`), so
     picking a model is picking a provider too: every surface shows the whole
     catalog as one grouped, searchable list instead of a provider step first. */
  const combinedCatalog = agentId === "opencode";
  const selected =
    models.find((item) => item.model === model || item.id === model) ||
    models.find((item) => item.isDefault);

  useEffect(() => {
    if (!providerId && !combinedCatalog) return;
    let cancelled = false;
    const path = combinedCatalog
      ? `/agents/${agentId}/models`
      : agentId === "claude"
        ? `/agents/${agentId}/models?providerId=${encodeURIComponent(providerId)}`
        : `/providers/${providerId}/models`;
    const apply = (next: ModelInfo[]) => {
      if (cancelled) return;
      setModels(next);
      setManual(!next.length);
      if (!model) {
        const fallback = next.find((item) => item.isDefault) || next[0];
        if (fallback)
          onChange({
            model: fallback.model,
            reasoningEffort:
              reasoningEffort || fallback.defaultReasoningEffort || "",
          });
      }
    };
    const cached = catalogCache.get(path);
    if (cached) {
      apply(cached.models);
      if (Date.now() - cached.at < CATALOG_TTL) {
        setLoading(false);
        return;
      }
    }
    setLoading(true);
    loadCatalog(path)
      .then(apply)
      .catch(() => {
        if (cancelled) return;
        setModels([]);
        setManual(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, providerId, combinedCatalog]);

  const efforts = selected?.supportedReasoningEfforts || [];
  const segments = useMemo(() => {
    const plain: ModelInfo[] = [];
    const groups: { name: string; items: ModelInfo[] }[] = [];
    for (const item of models) {
      if (!item.groupName) {
        plain.push(item);
        continue;
      }
      const last = groups.at(-1);
      if (last && last.name === item.groupName) last.items.push(item);
      else groups.push({ name: item.groupName, items: [item] });
    }
    return { plain, groups };
  }, [models]);
  const searchOptions = useMemo<SearchableOption[]>(
    () =>
      models.map((item) => ({
        value: item.model,
        label: item.displayName,
        group: item.groupName,
        ...(item.connected ? { groupMeta: "已连接" } : {}),
        hint: item.id !== item.displayName ? item.id : undefined,
        meta: item.isDefault
          ? "默认"
          : item.supportsImages === false
            ? "无图片"
            : undefined,
      })),
    [models],
  );
  const searchable = combinedCatalog
    ? !manual && models.length > 1
    : !manual && models.length > SEARCHABLE_CATALOG;
  /* Switching models should not silently reset the effort the user picked, so
     keep it whenever the new model offers the same variant. */
  const effortFor = (next: ModelInfo | undefined) => {
    const efforts = next?.supportedReasoningEfforts || [];
    if (efforts.some((item) => item.reasoningEffort === reasoningEffort))
      return reasoningEffort;
    return (
      next?.defaultReasoningEffort || efforts[0]?.reasoningEffort || ""
    );
  };
  return (
    <>
      <label className={compact ? "toolbar-select" : undefined}>
        {compact ? <span className="toolbar-field-label">模型</span> : "模型"}
        {manual || !models.length ? (
          <input
            value={model}
            disabled={disabled}
            aria-label="模型"
            title="模型"
            onChange={(e) =>
              onChange({ model: e.target.value, reasoningEffort })
            }
            placeholder={loading ? "正在读取模型目录…" : "模型 ID"}
          />
        ) : searchable ? (
          <SearchablePicker
            ariaLabel="模型"
            value={model}
            options={searchOptions}
            disabled={disabled}
            loading={loading}
            placeholder="选择模型"
            emptyText="没有匹配的模型"
            fallbackLabel={model || undefined}
            onChange={(next) => {
              const nextModel = models.find(
                (item) => item.model === next || item.id === next,
              );
              onChange({ model: next, reasoningEffort: effortFor(nextModel) });
            }}
          />
        ) : (
          <select
            value={model}
            disabled={disabled}
            aria-label="模型"
            title="模型"
              onChange={(e) => {
                const next = models.find(
                  (item) =>
                    item.model === e.target.value || item.id === e.target.value,
                );
                onChange({
                  model: e.target.value,
                  reasoningEffort: effortFor(next),
                });
              }}
          >
            {!model && <option value="">选择模型</option>}
            {segments.plain.map((item) => (
              <option
                key={item.id || item.model}
                value={item.model}
                title={item.id}
              >
                {modelLabel(item)}
              </option>
            ))}
            {segments.groups.map((group) => (
              <optgroup key={group.name} label={group.name}>
                {group.items.map((item) => (
                  <option
                    key={item.id || item.model}
                    value={item.model}
                    title={item.id}
                  >
                    {modelLabel(item)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        )}
        {models.length > 0 && !compact && (
          <button
            type="button"
            className="text-btn"
            onClick={() => setManual((value) => !value)}
          >
            {manual ? "从目录选择" : "手动输入"}
          </button>
        )}
      </label>
      {efforts.length > 0 && (
        <label className={compact ? "toolbar-select" : undefined}>
          {compact ? (
            <span className="toolbar-field-label">推理</span>
          ) : (
            "Reasoning effort"
          )}
          <select
            value={reasoningEffort}
            disabled={disabled}
            aria-label="Reasoning effort"
            title="Reasoning effort"
            onChange={(e) =>
              onChange({ model, reasoningEffort: e.target.value })
            }
          >
            {efforts.map((item) => (
              <option
                key={item.reasoningEffort}
                value={item.reasoningEffort}
                title={item.description || undefined}
              >
                {reasoningEffortLabel(item.reasoningEffort)}
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}
