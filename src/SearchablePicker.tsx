import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronDown, Search, Star, X } from "lucide-react";
import {
  FREQUENT_MODEL_GROUP,
  RECENT_MODEL_GROUP,
  STARRED_MODEL_GROUP,
} from "./model-affinity";

export interface SearchableOption {
  value: string;
  label: string;
  group?: string;
  /** Rendered next to the group heading, e.g. a provider connection state. */
  groupMeta?: string;
  hint?: string;
  meta?: string;
  /** 模型偏好：行尾星标是否点亮（见 ModelPicker 的收藏逻辑）。 */
  starred?: boolean;
  /**
   * Marks options backed by a connected provider (OpenCode `/provider`
   * `connected`). Enables the picker's "仅已连接" filter when
   * `connectedToggle` is on.
   */
  connected?: boolean;
}

export function filterSearchableOptions(
  options: SearchableOption[],
  query: string,
): SearchableOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter((option) =>
    [
      option.label,
      option.value,
      option.group,
      option.groupMeta,
      option.hint,
      option.meta,
    ].some((field) => field?.toLowerCase().includes(needle)),
  );
}

export function groupSearchableOptions(options: SearchableOption[]) {
  const plain: SearchableOption[] = [];
  const groups: { name: string; meta?: string; items: SearchableOption[] }[] =
    [];
  for (const option of options) {
    if (!option.group) {
      plain.push(option);
      continue;
    }
    const last = groups.at(-1);
    if (last && last.name === option.group) {
      last.items.push(option);
      if (!last.meta) last.meta = option.groupMeta;
      continue;
    }
    groups.push({
      name: option.group,
      meta: option.groupMeta,
      items: [option],
    });
  }
  return { plain, groups };
}

const SHEET_QUERY = "(max-width: 760px)";

export function SearchablePicker({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder = "搜索选择…",
  emptyText = "没有匹配的选项",
  loadingText,
  loading,
  disabled,
  fallbackLabel,
  connectedToggle,
  onStar,
}: {
  value: string;
  options: SearchableOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  emptyText?: string;
  loadingText?: string;
  loading?: boolean;
  disabled?: boolean;
  fallbackLabel?: string;
  connectedToggle?: boolean;
  /** 行尾星标切换（传了才渲染星标按钮；点击不触发选中）。 */
  onStar?: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia(SHEET_QUERY).matches,
  );
  const [viewport, setViewport] = useState<{
    height: number;
    bottom: number;
  }>();
  const [connectedOnly, setConnectedOnly] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null);
  const showConnectedToggle =
    connectedToggle && options.some((option) => option.connected);
  const filtered = useMemo(() => {
    // 「默认/跟随默认」是功能行（不代表某个可连接的供应商），任何时候都可见。
    // 收藏 / 上次选择 / 常用是用户显式信号，同样不过“仅已连接”过滤：否则
    // connected 一抖（opencode 的 /provider 探测本就不稳定），刚藏的就是
    // 用户收藏的那几行，看起来像收藏掉了。
    const affinityGroup = (group?: string) =>
      group === STARRED_MODEL_GROUP ||
      group === RECENT_MODEL_GROUP ||
      group === FREQUENT_MODEL_GROUP;
    const base =
      showConnectedToggle && connectedOnly && !query.trim()
        ? options.filter(
            (option) =>
              option.connected ||
              !option.group ||
              option.value === "default" ||
              affinityGroup(option.group),
          )
        : options;
    const segments = groupSearchableOptions(
      filterSearchableOptions(base, query),
    );
    return [
      ...segments.plain,
      ...segments.groups.flatMap((group) =>
        group.items.map((option, index) =>
          index === 0 && group.meta
            ? { ...option, groupMeta: group.meta }
            : option,
        ),
      ),
    ];
  }, [options, query, connectedOnly, showConnectedToggle]);
  const values = useMemo(
    () => options.map((option) => option.value),
    [options],
  );
  const filteredValues = useMemo(
    () => filtered.map((option) => option.value),
    [filtered],
  );
  const selected = options.find((option) => option.value === value);
  const virtualized = filtered.length > 100;
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => listElement,
    estimateSize: (index) => {
      const option = filtered[index];
      return (
        (option.hint && option.hint !== option.label ? 52 : 40) +
        (option.group && option.group !== filtered[index - 1]?.group ? 32 : 0)
      );
    },
    getItemKey: (index) => filtered[index].value,
    overscan: 6,
    enabled: open && virtualized,
  });

  useEffect(() => {
    const media = window.matchMedia(SHEET_QUERY);
    const update = () => setSheet(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // Keep the sheet above the software keyboard, including Safari's visual viewport.
  useEffect(() => {
    if (!open || !sheet || !window.visualViewport) return;
    const viewport = window.visualViewport;
    const update = () =>
      setViewport({
        height: viewport.height,
        bottom: Math.max(
          0,
          window.innerHeight - viewport.height - viewport.offsetTop,
        ),
      });
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [open, sheet]);

  // Reopening reveals the selected model, including picks far down a large catalog.
  useLayoutEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const index = filtered.findIndex((option) => option.value === value);
      if (virtualized)
        virtualizer.scrollToIndex(Math.max(0, index), { align: "auto" });
      else
        listElement
          ?.querySelector('[aria-selected="true"]')
          ?.scrollIntoView({ block: "nearest" });
    });
    return () => cancelAnimationFrame(frame);
  }, [
    open,
    query,
    connectedOnly,
    value,
    filtered,
    virtualized,
    virtualizer,
    listElement,
  ]);

  const renderOption = (option: SearchableOption, index: number) => (
    <>
      {option.group && option.group !== filtered[index - 1]?.group && (
        <div className="search-picker-group" role="presentation">
          <span>{option.group}</span>
          {option.groupMeta && <em>{option.groupMeta}</em>}
        </div>
      )}
      <Combobox.Item
        value={option.value}
        index={index}
        className="search-picker-option"
        aria-label={
          option.group ? `${option.label}，${option.group}` : option.label
        }
        title={option.hint || option.label}
      >
        <span className="search-picker-option-main">
          <span className="search-picker-option-label">{option.label}</span>
          {option.hint && option.hint !== option.label && (
            <span className="search-picker-option-hint">{option.hint}</span>
          )}
        </span>
        {option.meta && (
          <span className="search-picker-option-meta">{option.meta}</span>
        )}
        <Combobox.ItemIndicator>
          <Check className="search-picker-check" />
        </Combobox.ItemIndicator>
        {onStar && (
          <button
            type="button"
            className={`search-picker-star${option.starred ? " on" : ""}`}
            aria-pressed={option.starred ? true : undefined}
            aria-label={
              option.starred
                ? `取消收藏 ${option.label}`
                : `收藏 ${option.label}`
            }
            title={
              option.starred
                ? `取消收藏 ${option.label}`
                : `收藏 ${option.label}`
            }
            // 点击星标只做收藏切换：mousedown 不抢焦点、click 不冒泡，
            // Base UI Item 的选中逻辑收不到事件，弹窗也不关闭。
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              onStar(option.value);
            }}
          >
            <Star />
          </button>
        )}
      </Combobox.Item>
    </>
  );

  return (
    <Combobox.Root
      items={values}
      filteredItems={filteredValues}
      filter={null}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      autoHighlight
      virtualized={virtualized}
      modal={sheet}
      disabled={disabled || (loading && !options.length)}
      onItemHighlighted={(next, details) => {
        if (
          virtualized &&
          next !== undefined &&
          details.reason === "keyboard"
        ) {
          const index = filteredValues.indexOf(next);
          if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
        }
      }}
    >
      <span className={`search-picker${open ? " open" : ""}`}>
        <Combobox.Trigger
          className="search-picker-trigger"
          aria-label={ariaLabel}
          onKeyDown={(event) => {
            if (event.key === "Escape" && open) {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <span
            className={`search-picker-label${selected || fallbackLabel ? "" : " is-placeholder"}`}
          >
            {selected?.label || fallbackLabel || placeholder}
          </span>
          <ChevronDown />
        </Combobox.Trigger>
      </span>
      <Combobox.Portal>
        {sheet && <Combobox.Backdrop className="search-picker-backdrop" />}
        <Combobox.Positioner
          className={`search-picker-positioner${sheet ? " sheet" : ""}`}
          sideOffset={6}
          align="start"
          collisionPadding={8}
          style={
            sheet && viewport
              ? ({
                  "--picker-viewport-height": `${viewport.height}px`,
                  "--picker-keyboard-offset": `${viewport.bottom}px`,
                } as React.CSSProperties)
              : undefined
          }
        >
          <Combobox.Popup
            className={`search-picker-panel${sheet ? " sheet" : ""}`}
            initialFocus={sheet ? false : searchRef}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setOpen(false);
              }
            }}
          >
            {sheet && (
              <div className="search-picker-sheet-head">
                <span>{ariaLabel}</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="关闭选择器"
                  onClick={() => setOpen(false)}
                >
                  <X />
                </button>
              </div>
            )}
            <div className="search-picker-search">
              <Search />
              <Combobox.Input
                ref={searchRef}
                placeholder="输入关键字筛选…"
                aria-label={`筛选${ariaLabel}`}
              />
              {showConnectedToggle && (
                <button
                  type="button"
                  className={`search-picker-filter${connectedOnly ? " on" : ""}`}
                  aria-pressed={connectedOnly}
                  onClick={() => setConnectedOnly((current) => !current)}
                >
                  仅已连接
                </button>
              )}
            </div>
            <Combobox.List
              className="search-picker-list"
              ref={setListElement}
              aria-label={ariaLabel}
            >
              {!filtered.length ? (
                <p className="search-picker-empty">
                  {loading ? loadingText || "正在读取…" : emptyText}
                </p>
              ) : virtualized ? (
                <div
                  style={{
                    height: virtualizer.getTotalSize(),
                    position: "relative",
                  }}
                >
                  {virtualizer.getVirtualItems().map((row) => (
                    <div
                      key={row.key}
                      data-index={row.index}
                      ref={virtualizer.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${row.start}px)`,
                      }}
                    >
                      {renderOption(filtered[row.index], row.index)}
                    </div>
                  ))}
                </div>
              ) : (
                filtered.map((option, index) => (
                  <div key={option.value}>{renderOption(option, index)}</div>
                ))
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
