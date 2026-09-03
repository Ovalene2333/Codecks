import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { reasoningEffortLabel } from "./codexLabels";
import type { ModelInfo } from "./types";
import type { AgentId } from "./agents";
import { SearchablePicker, type SearchableOption } from "./SearchablePicker";

const SEARCHABLE_CATALOG = 12;

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
  const selected =
    models.find((item) => item.model === model || item.id === model) ||
    models.find((item) => item.isDefault);

  useEffect(() => {
    if (!providerId) return;
    let cancelled = false;
    setLoading(true);
    const path =
      agentId === "claude" || agentId === "opencode"
        ? `/agents/${agentId}/models?providerId=${encodeURIComponent(providerId)}`
        : `/providers/${providerId}/models`;
    api<ModelInfo[]>(path)
      .then((list) => {
        if (cancelled) return;
        const next = Array.isArray(list) ? list : [];
        setModels(next);
        setManual(!next.length);
        if (!model) {
          const fallback = list.find((item) => item.isDefault) || list[0];
          if (fallback)
            onChange({
              model: fallback.model,
              reasoningEffort:
                reasoningEffort || fallback.defaultReasoningEffort || "",
            });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
          setManual(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, providerId]);

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
        hint: item.id !== item.displayName ? item.id : undefined,
        meta: item.isDefault
          ? "默认"
          : item.supportsImages === false
            ? "无图片"
            : undefined,
      })),
    [models],
  );
  const searchable = !manual && models.length > SEARCHABLE_CATALOG;
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
                (item) =>
                  item.model === next || item.id === next,
              );
              onChange({
                model: next,
                reasoningEffort:
                  nextModel?.defaultReasoningEffort ||
                  nextModel?.supportedReasoningEfforts?.[0]?.reasoningEffort ||
                  "",
              });
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
                reasoningEffort:
                  next?.defaultReasoningEffort ||
                  next?.supportedReasoningEfforts?.[0]?.reasoningEffort ||
                  "",
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
