import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";

export interface SearchableOption {
  value: string;
  label: string;
  group?: string;
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
    [option.label, option.value, option.group, option.hint, option.meta].some(
      (field) => field?.toLowerCase().includes(needle),
    ),
  );
}

export function groupSearchableOptions(options: SearchableOption[]) {
  const plain: SearchableOption[] = [];
  const groups: { name: string; items: SearchableOption[] }[] = [];
  for (const option of options) {
    if (!option.group) {
      plain.push(option);
      continue;
    }
    const last = groups.at(-1);
    if (last && last.name === option.group) last.items.push(option);
    else groups.push({ name: option.group, items: [option] });
  }
  return { plain, groups };
}

interface PickerAnchor {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
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
    spaceBelow < 240 && spaceAbove > spaceBelow && spaceAbove > 200;
  return preferAbove
    ? { left, width, bottom: window.innerHeight - box.top + 4 }
    : { left, width, top: box.bottom + 4 };
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
  const [anchor, setAnchor] = useState<PickerAnchor>();
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(
    () => filterSearchableOptions(options, query),
    [options, query],
  );
  const segments = useMemo(() => groupSearchableOptions(filtered), [filtered]);
  const selected = options.find((option) => option.value === value);

  const refreshAnchor = () => setAnchor(anchorFor(triggerRef.current));

  const openPanel = () => {
    if (disabled || (loading && !options.length)) return;
    refreshAnchor();
    setQuery("");
    setActive(
      Math.max(0, options.findIndex((option) => option.value === value)),
    );
    setOpen(true);
  };

  const closePanel = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const commit = (option: SearchableOption | undefined) => {
    if (!option) return;
    onChange(option.value);
    closePanel();
  };

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const onDocMouseDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closePanel(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };
    window.addEventListener("resize", refreshAnchor);
    document.addEventListener("scroll", refreshAnchor, true);
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("resize", refreshAnchor);
      document.removeEventListener("scroll", refreshAnchor, true);
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${active}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  useEffect(() => {
    if (open && active >= filtered.length) setActive(0);
  }, [filtered.length, active, open]);

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
  const renderOption = (option: SearchableOption) => {
    flatIndex += 1;
    const index = flatIndex;
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
      {open && (
        <div
          className="search-picker-panel"
          role="listbox"
          aria-label={ariaLabel}
          style={{
            left: anchor?.left,
            width: anchor?.width,
            top: anchor?.top,
            bottom: anchor?.bottom,
          }}
        >
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
              }}
              onKeyDown={onSearchKeyDown}
            />
          </div>
          <div className="search-picker-list" ref={listRef}>
            {loading && !options.length ? (
              <p className="search-picker-empty">
                {loadingText || "正在读取…"}
              </p>
            ) : !filtered.length ? (
              <p className="search-picker-empty">{emptyText}</p>
            ) : (
              <>
                {segments.plain.map(renderOption)}
                {segments.groups.map((group) => (
                  <div key={group.name} className="search-picker-group-wrap">
                    <div className="search-picker-group">{group.name}</div>
                    {group.items.map(renderOption)}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
