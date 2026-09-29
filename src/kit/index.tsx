import {
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";

/**
 * UI 基线组件。样式在 src/kit.css，规范见 docs/ui-baseline.md。
 * 组件只负责结构与无障碍，视觉全部来自 token。
 */

export type Tone = "neutral" | "ok" | "info" | "warn" | "danger" | "accent";

const cx = (...parts: (string | false | undefined | null)[]) =>
  parts.filter(Boolean).join(" ");

const toneClass = (tone: Tone) => (tone === "neutral" ? "" : `ui-tone-${tone}`);

export function Button({
  variant = "default",
  size = "md",
  iconOnly,
  busy,
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "sm" | "md";
  /** 只有图标的方形按钮；必须同时给 aria-label / title。 */
  iconOnly?: boolean;
  /** 进行中：禁止重复点击，光标变成进度态。 */
  busy?: boolean;
}) {
  return (
    <button
      type={type}
      className={cx(
        "ui-btn",
        variant !== "default" && `ui-btn--${variant}`,
        size === "sm" && "ui-btn--sm",
        iconOnly && "ui-btn--icon",
        busy && "is-busy",
        className,
      )}
      aria-busy={busy || undefined}
      {...props}
      disabled={props.disabled || busy}
    />
  );
}

/**
 * 分段控件 / 标签页。方向键、Home/End 在标签间移动，选中即激活；
 * 只有选中项在 Tab 序列里（roving tabindex）。
 */
export function Seg<T extends string>({
  items,
  value,
  onChange,
  label,
  idPrefix,
  className,
}: {
  items: { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  /** 给出后每个标签带 id，面板可用 aria-labelledby 指回来。 */
  idPrefix?: string;
  className?: string;
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = items.findIndex((item) => item.value === value);
    const last = items.length - 1;
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % items.length
        : event.key === "ArrowLeft"
          ? (index - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    if (next < 0) return;
    event.preventDefault();
    onChange(items[next].value);
    (
      event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next] ||
      null
    )?.focus();
  };
  return (
    <div
      className={cx("ui-seg", className)}
      role="tablist"
      aria-label={label}
      onKeyDown={move}
    >
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${item.value}` : undefined}
            aria-selected={active}
            aria-controls={idPrefix ? `${idPrefix}-panel` : undefined}
            tabIndex={active ? 0 : -1}
            className={cx("ui-seg__item", active && "is-active")}
            onClick={() => onChange(item.value)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  busy,
  title,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** 读屏名称，如「启用 Kimi」。 */
  label: string;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled || busy}
      className={cx("ui-switch", busy && "is-busy")}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Badge({
  tone = "neutral",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={cx("ui-badge", toneClass(tone))} title={title}>
      {children}
    </span>
  );
}

export type DotTone = "ok" | "busy" | "warn" | "error" | "off";

/** 与监控台的健康语义一致：ok / busy / warn / error / off。 */
export function Dot({ tone }: { tone: DotTone }) {
  return (
    <i
      className={cx("ui-dot", tone !== "off" && `ui-dot--${tone}`)}
      aria-hidden="true"
    />
  );
}

export function Note({
  tone = "neutral",
  icon,
  title,
  children,
  action,
}: {
  tone?: Tone;
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={cx("ui-note", toneClass(tone))} role="note">
      {icon}
      <div className="ui-note__body">
        {title ? <b>{title}</b> : null}
        {children ? <p>{children}</p> : null}
      </div>
      {action ? <div className="ui-note__action">{action}</div> : null}
    </div>
  );
}

export function Section({
  title,
  desc,
  actions,
  children,
}: {
  title: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="ui-section">
      <header className="ui-section__head">
        <div className="ui-section__text">
          <h3 className="ui-section__title">{title}</h3>
          {desc ? <p className="ui-section__desc">{desc}</p> : null}
        </div>
        {actions ? <div className="ui-section__actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** 一组设置项：圆角卡片，行与行之间用发丝线分隔。`pad` 用于放表单。 */
export function Group({
  pad,
  children,
}: {
  pad?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cx("ui-group", pad && "ui-group--pad")}>{children}</div>
  );
}

export function Row({
  lead,
  leadColor,
  dot,
  title,
  badges,
  desc,
  descTone,
  descTitle,
  side,
  dim,
  stack,
}: {
  /** 前导小方块里的文字（如供应商首字母）。 */
  lead?: string;
  leadColor?: string;
  /** 标题前的状态点，语义同监控台健康列表。 */
  dot?: DotTone;
  title: ReactNode;
  badges?: ReactNode;
  desc?: ReactNode;
  descTone?: "danger" | "faint";
  /** desc 被截断/折叠时悬停可看完整内容。 */
  descTitle?: string;
  side?: ReactNode;
  /** 已停用等弱化状态。 */
  dim?: boolean;
  /** 窄屏时把右侧控件折到下一行（右侧含输入框时用）。 */
  stack?: boolean;
}) {
  return (
    <div className={cx("ui-row", dim && "is-dim", stack && "ui-row--stack")}>
      {lead ? (
        <span
          className="ui-row__lead"
          style={leadColor ? ({ "--lead": leadColor } as never) : undefined}
          aria-hidden="true"
        >
          {lead}
        </span>
      ) : null}
      <div className="ui-row__main">
        <div className="ui-row__title">
          {dot ? <Dot tone={dot} /> : null}
          {title}
          {badges}
        </div>
        {desc ? (
          <p
            className={cx(
              "ui-row__desc",
              descTone === "danger" && "is-danger",
              descTone === "faint" && "is-faint",
            )}
            title={descTitle}
          >
            {desc}
          </p>
        ) : null}
      </div>
      {side ? <div className="ui-row__side">{side}</div> : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="ui-field">
      <span className="ui-field__label">{label}</span>
      {children}
      {hint ? <span className="ui-field__hint">{hint}</span> : null}
    </label>
  );
}
