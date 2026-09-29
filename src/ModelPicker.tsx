import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
} from "react";
import { Keyboard, List } from "lucide-react";
import { api } from "./api";
import { FALLBACK_EFFORTS, reasoningEffortLabel } from "./codexLabels";
import type { ModelInfo } from "./types";
import type { AgentId } from "./agents";
import { SearchablePicker, type SearchableOption } from "./SearchablePicker";

/**
 * Model catalogs change rarely but are read every time a picker mounts (new
 * session, session settings, command palette…), and OpenCode's can hold
 * hundreds of entries. Keep the last answer per request path so reopening a
 * picker paints immediately, and refresh in the background once it goes stale.
 */
const CATALOG_TTL = 60_000;
const CATALOG_TIMEOUT_MS = 8_000;
const catalogCache = new Map<string, { at: number; models: ModelInfo[] }>();
const catalogInflight = new Map<string, Promise<ModelInfo[]>>();

function withTimeout<T>(task: Promise<T>, ms: number, path: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`模型目录读取超时：${path}`)),
      ms,
    );
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function loadCatalog(path: string) {
  const running = catalogInflight.get(path);
  if (running) return running;
  const task = withTimeout(api<ModelInfo[]>(path), CATALOG_TIMEOUT_MS, path)
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

/**
 * 手填输入先用本地草稿承接按键：onChange 每次提交都走 PATCH + 快照回包，
 * 受控值要等服务端确认才更新，期间任何重渲染（事件推送、错误提示）都会把
 * 输入回顶成旧值。聚焦期间以草稿为准，停顿或失焦时才真正提交。
 */
function DraftInput({
  value,
  onCommit,
  ...rest
}: Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "onFocus" | "onBlur"
> & {
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const commit = (next: string) => {
    clearTimeout(timer.current);
    if (next !== value) onCommit(next);
  };
  return (
    <input
      {...rest}
      value={draft ?? value}
      onFocus={() => setDraft(value)}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => commit(next), 350);
      }}
      onBlur={() => {
        if (draft !== undefined) commit(draft);
        setDraft(undefined);
      }}
    />
  );
}

export function ModelPicker({
  agentId = "codex",
  providerId,
  cwd,
  model,
  reasoningEffort,
  onChange,
  compact,
  disabled,
}: {
  agentId?: AgentId;
  providerId: string;
  cwd?: string;
  model: string;
  reasoningEffort: string;
  onChange: (next: { model: string; reasoningEffort: string }) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [manual, setManual] = useState(false);
  const [loading, setLoading] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  /* OpenCode model ids already carry their provider (`providerID/modelID`), so
     its catalog is agent-scoped and needs no providerId; every adapter still
     renders the same grouped, searchable picker with a manual-entry escape. */
  const combinedCatalog = agentId === "opencode";
  const effortDatalistId = useId();
  const matched = models.find(
    (item) => item.model === model || item.id === model,
  );
  // 手填了目录里没有的模型时不要回退到默认模型的 effort，否则自定义
  // 供应商的手输模型会显示错的下拉；此时走下面的 fallback 手填入口。
  const selected = matched || (!model ? models.find((item) => item.isDefault) : undefined);

  useEffect(() => {
    if (!providerId && !combinedCatalog) return;
    let cancelled = false;
    const path = combinedCatalog
      ? `/agents/${agentId}/models${cwd ? `?directory=${encodeURIComponent(cwd)}` : ""}`
      : agentId !== "codex"
        ? // claude 的 providerId 是配置档 id，ACP agent 是 `${id}-current` 占位；
          // 两者都查 agent 自己的模型目录。
          `/agents/${agentId}/models?providerId=${encodeURIComponent(providerId)}`
        : `/providers/${providerId}/models`;
    const apply = (next: ModelInfo[]) => {
      if (cancelled) return;
      setModels(next);
      setManual(next.length === 0);
      setCatalogError("");
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
      .catch((error: any) => {
        if (cancelled) return;
        setCatalogError(String(error?.message || "模型目录读取失败"));
        // 卡住/超时时沿用已渲染的旧列表（cached paint），只有真没列表才切手输，
        // 避免把用户已选模型冲掉或被迫提交脏值。
        if (!catalogCache.get(path)?.models.length) {
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
  }, [agentId, providerId, combinedCatalog, cwd]);

  const efforts = selected?.supportedReasoningEfforts || [];
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
  /* Switching models should not silently reset the effort the user picked, so
     keep it whenever the new model offers the same variant. Models without a
     catalog entry (custom providers / manual input) keep the current value;
     the backend forwards it as-is. */
  const effortFor = (next: ModelInfo | undefined) => {
    const list = next?.supportedReasoningEfforts || [];
    if (list.some((item) => item.reasoningEffort === reasoningEffort))
      return reasoningEffort;
    if (list.length === 0) return reasoningEffort;
    return next?.defaultReasoningEffort || list[0]?.reasoningEffort || "";
  };
  // 目录无 effort 声明时补手填入口（自定义模型如
  // dstest/deepseek-v4.1-flash-expires-on-0910 无 variants 元数据）；
  // claude/ACP 在 SDK 目录未加载前同样没有声明，手填透传由后端白名单兜底。
  const showFallbackEffort = efforts.length === 0;
  return (
    <>
      <label className={compact ? "toolbar-select" : undefined}>
        {compact ? <span className="toolbar-field-label">模型</span> : "模型"}
        {/* 所有 adapter 统一用 OpenCode 样式的分组可搜索列表；目录为空或点
            「手动输入」时回退到裸 input 手填模型 ID。 */}
        {manual || !models.length ? (
          <DraftInput
            value={model}
            disabled={disabled}
            aria-label="模型"
            title="模型"
            onCommit={(next) => onChange({ model: next, reasoningEffort })}
            placeholder={loading ? "正在读取模型目录…" : "模型 ID（目录不可用时可手填，留空用供应商默认）"}
          />
        ) : (
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
        )}
        {models.length > 0 && (
          <button
            type="button"
            className={
              compact ? "icon-btn model-manual-toggle" : "model-manual-toggle"
            }
            title={manual ? "从目录选择" : "手动输入模型 ID"}
            aria-label={manual ? "从目录选择" : "手动输入模型 ID"}
            onClick={() => setManual((value) => !value)}
          >
            {compact ? (
              manual ? (
                <List />
              ) : (
                <Keyboard />
              )
            ) : manual ? (
              "从目录选择"
            ) : (
              "手动输入"
            )}
          </button>
        )}
      </label>
      {catalogError && !compact && (
        <small className="toolbar-hint" title={catalogError}>
          模型目录暂不可用，已保留上次结果；可手填或留空用供应商默认
        </small>
      )}
      {efforts.length > 0 ? (
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
            {/* 空值表示「跟随模型/CLI 默认」。claude、opencode 支持随时清除；
                codex/acp 不能中途清空时后端会拒绝或回弹，用户能看到结果。 */}
            <option value="">默认</option>
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
      ) : (
        showFallbackEffort && (
          <label className={compact ? "toolbar-select" : undefined}>
            {compact ? (
              <span className="toolbar-field-label">推理</span>
            ) : (
              "Reasoning effort"
            )}
            <DraftInput
              value={reasoningEffort}
              disabled={disabled}
              aria-label="Reasoning effort"
              title="Reasoning effort（目录无声明时可手填，留空用默认）"
              list={effortDatalistId}
              onCommit={(next) => onChange({ model, reasoningEffort: next })}
              placeholder="留空默认，可填 low/medium/high"
            />
            <datalist id={effortDatalistId}>
              {FALLBACK_EFFORTS.map((value) => (
                <option key={value} value={value}>
                  {reasoningEffortLabel(value)}
                </option>
              ))}
            </datalist>
          </label>
        )
      )}
    </>
  );
}
