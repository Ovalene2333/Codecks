import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search, X } from "lucide-react";

export interface SearchableOption {
  value: string;
  label: string;
  group?: string;
  /** Rendered next to the group heading, e.g. a provider connection state. */
  groupMeta?: string;
  hint?: string;
  meta?: string;
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

interface PickerAnchor {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/* Narrow screens get a bottom sheet: a fixed dropdown next to the trigger is
   cramped under the thumb and gets clipped by scrollable modal bodies. */
const SHEET_QUERY = "(max-width: 760px)";
const DROPDOWN_MIN_SPACE = 240;
/** Rows rendered per chunk; long catalogs grow on scroll instead of up front. */
const ROW_CHUNK = 60;

function isSheetLayout() {
  return (
    typeof window !== "undefined" && window.matchMedia(SHEET_QUERY).matches
  );
}

function anchorFor(trigger: HTMLElement | null): PickerAnchor | undefined {
  if (!trigger) return undefined;
  const box = trigger.getBoundingClientRect();
  const margin = 8;
  const width = Math.min(
    Math.max(box.width, 260),
    window.innerWidth - margin * 2,
  );
  const left = Math.min(
    Math.max(margin, box.left),
    window.innerWidth - margin - width,
  );
  const spaceBelow = window.innerHeight - box.bottom;
  const spaceAbove = box.top;
  const preferAbove =
    spaceBelow < DROPDOWN_MIN_SPACE && spaceAbove > spaceBelow;
  return preferAbove
    ? {
        left,
        width,
        bottom: window.innerHeight - box.top + 4,
        maxHeight: Math.max(0, spaceAbove - margin - 4),
      }
    : {
        left,
        width,
        top: box.bottom + 4,
        maxHeight: Math.max(0, spaceBelow - margin - 4),
      };
}

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
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [limit, setLimit] = useState(ROW_CHUNK);
  const [anchor, setAnchor] = useState<PickerAnchor>();
  const [sheet, setSheet] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => filterSearchableOptions(options, query),
    [options, query],
  );
  const segments = useMemo(() => groupSearchableOptions(filtered), [filtered]);
  const selected = options.find((option) => option.value === value);

  /* Long catalogs (OpenCode lists hundreds of models) only need the rows the
     user can actually see; the rest arrive as they scroll. */
  const showMore = () => setLimit((current) => current + ROW_CHUNK);
  const resetLimit = (atLeast = 0) =>
    setLimit(Math.max(ROW_CHUNK, atLeast + ROW_CHUNK));

  const refreshAnchor = () => {
    if (isSheetLayout()) {
      setSheet(true);
      setAnchor(undefined);
      return;
    }
    setSheet(false);
    setAnchor(anchorFor(triggerRef.current));
  };

  const openPanel = () => {
    if (disabled || (loading && !options.length)) return;
    refreshAnchor();
    setQuery("");
    const selectedIndex = Math.max(
      0,
      options.findIndex((option) => option.value === value),
    );
    setActive(selectedIndex);
    // Render far enough to show the current pick when the panel opens.
    resetLimit(selectedIndex);
    setOpen(true);
  };

  const closePanel = (refocus = true) => {
    setOpen(false);
    setQuery("");
    setLimit(ROW_CHUNK);
    if (refocus) triggerRef.current?.focus();
  };

  const commit = (option: SearchableOption | undefined) => {
    if (!option) return;
    onChange(option.value);
    closePanel();
  };

  useEffect(() => {
    if (!open) return;
    /* On the sheet layout the keyboard would cover the list, so only focus the
       filter box when a physical pointer is in use. */
    if (!sheet) searchRef.current?.focus();
    const onDocPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      closePanel(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };
    window.addEventListener("resize", refreshAnchor);
    document.addEventListener("scroll", refreshAnchor, true);
    document.addEventListener("pointerdown", onDocPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", refreshAnchor);
      document.removeEventListener("scroll", refreshAnchor, true);
      document.removeEventListener("pointerdown", onDocPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, sheet]);

  useLayoutEffect(() => {
    if (!open) return;
    const list = listRef.current;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${active}"]`,
    );
    if (!list || !row) return;
    const top =
      row.getBoundingClientRect().top -
      list.getBoundingClientRect().top +
      list.scrollTop;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top + row.offsetHeight - list.clientHeight;
    }
  }, [active, open]);

  useEffect(() => {
    if (open && active >= filtered.length) setActive(0);
  }, [filtered.length, active, open]);

  // Keyboard navigation can walk past the rows rendered so far.
  useEffect(() => {
    if (open && active >= limit) resetLimit(active);
  }, [active, limit, open]);

  const onSearchKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, filtered.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (event.key === "End") {
      event.preventDefault();
      setActive(Math.max(0, filtered.length - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      commit(filtered[active]);
    } else if (event.key === "Tab") {
      closePanel(false);
    }
  };

  let flatIndex = -1;
  let budget = limit;
  const renderOption = (option: SearchableOption) => {
    flatIndex += 1;
    const index = flatIndex;
    if (budget <= 0) return null;
    budget -= 1;
    return (
      <button
        type="button"
        key={option.value}
        role="option"
        aria-selected={option.value === value}
        className={`search-picker-option${index === active ? " active" : ""}${
          option.value === value ? " selected" : ""
        }`}
        data-idx={index}
        title={option.hint || option.label}
        onMouseEnter={() => setActive(index)}
        onClick={() => commit(option)}
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
        {option.value === value && <Check className="search-picker-check" />}
      </button>
    );
  };

  return (
    <span ref={rootRef} className={`search-picker${open ? " open" : ""}`}>
      <button
        type="button"
        ref={triggerRef}
        className="search-picker-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? closePanel() : openPanel())}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openPanel();
          }
        }}
      >
        <span
          className={`search-picker-label${
            selected || fallbackLabel ? "" : " is-placeholder"
          }`}
        >
          {selected?.label || fallbackLabel || placeholder}
        </span>
        <ChevronDown />
      </button>
      {open &&
        createPortal(
          <>
            {sheet && <div className="search-picker-backdrop" />}
            <div
              ref={panelRef}
              className={`search-picker-panel${sheet ? " sheet" : ""}`}
              role="listbox"
              aria-label={ariaLabel}
              style={{
                left: anchor?.left,
                width: anchor?.width,
                top: anchor?.top,
                bottom: anchor?.bottom,
                maxHeight: anchor?.maxHeight,
              }}
            >
              {sheet && (
                <div className="search-picker-sheet-head">
                  <span>{ariaLabel}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="关闭"
                    onClick={() => closePanel()}
                  >
                    <X />
                  </button>
                </div>
              )}
              <div className="search-picker-search">
                <Search />
                <input
                  ref={searchRef}
                  value={query}
                  placeholder="输入关键字筛选…"
                  aria-label={`筛选${ariaLabel}`}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                    setLimit(ROW_CHUNK);
                  }}
                  onKeyDown={onSearchKeyDown}
                />
              </div>
              <div
                className="search-picker-list"
                ref={listRef}
                onScroll={(event) => {
                  const list = event.currentTarget;
                  if (
                    list.scrollTop + list.clientHeight >=
                    list.scrollHeight - 240
                  )
                    showMore();
                }}
              >
                {loading && !options.length ? (
                  <p className="search-picker-empty">
                    {loadingText || "正在读取…"}
                  </p>
                ) : !filtered.length ? (
                  <p className="search-picker-empty">{emptyText}</p>
                ) : (
                  <>
                    {segments.plain.map(renderOption)}
                    {segments.groups.map(
                      (group) =>
                        // Group headings only appear while rows are still left.
                        budget > 0 && (
                          <div
                            key={group.name}
                            className="search-picker-group-wrap"
                          >
                            <div className="search-picker-group">
                              <span>{group.name}</span>
                              {group.meta && <em>{group.meta}</em>}
                            </div>
                            {group.items.map(renderOption)}
                          </div>
                        ),
                    )}
                    {filtered.length > limit && (
                      <p className="search-picker-more">
                        继续滚动查看剩余 {filtered.length - limit}{" "}
                        项，或输入关键字筛选
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </>,
          document.body,
        )}
    </span>
  );
}
