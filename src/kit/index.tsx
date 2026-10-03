import {
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { ChevronRight } from "lucide-react";
import * as RxSwitch from "@radix-ui/react-switch";
import * as Tabs from "@radix-ui/react-tabs";

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
 * 分段控件 / 标签页。内部用 Radix Tabs：方向键、Home/End 移动并选中
 * （roving tabindex），样式仍是 kit.css 的 .ui-seg。只借行为，不借外观。
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
  return (
    <Tabs.Root
      value={value}
      onValueChange={(next) => onChange(next as T)}
      activationMode="automatic"
      style={{ display: "contents" }}
    >
      <Tabs.List className={cx("ui-seg", className)} aria-label={label}>
        {items.map((item) => (
          <Tabs.Trigger
            key={item.value}
            value={item.value}
            id={idPrefix ? `${idPrefix}-tab-${item.value}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel` : undefined}
            className={cx("ui-seg__item", item.value === value && "is-active")}
          >
            {item.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
    </Tabs.Root>
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
    <RxSwitch.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      title={title}
      disabled={disabled || busy}
      className={cx("ui-switch", busy && "is-busy")}
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
  scope,
  children,
}: {
  title: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  /** 作用范围标注：只标例外——「本设备」（存在浏览器里，换设备不跟随）。 */
  scope?: "device";
  children?: ReactNode;
}) {
  return (
    <section className="ui-section">
      <header className="ui-section__head">
        <div className="ui-section__text">
          <h3 className="ui-section__title">
            {title}
            {scope === "device" ? (
              <Badge title="保存在当前浏览器，换设备或换浏览器不会跟随">
                本设备
              </Badge>
            ) : null}
          </h3>
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
  onOpen,
  openLabel,
}: {
  /**
   * 点进下一级（如 Agent 详情）：标题区变成按钮，行尾加箭头。右侧控件
   * 仍各自独立可点，不嵌套在按钮里。
   */
  onOpen?: () => void;
  /** onOpen 按钮的读屏名称，缺省用 title。 */
  openLabel?: string;
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
  const body = (
    <>
      <div className="ui-row__title">
        {dot ? <Dot tone={dot} /> : null}
        {title}
        {badges}
      </div>
      {desc ? (
        <span
          className={cx(
            "ui-row__desc",
            descTone === "danger" && "is-danger",
            descTone === "faint" && "is-faint",
          )}
          title={descTitle}
        >
          {desc}
        </span>
      ) : null}
    </>
  );
  return (
    <div
      className={cx(
        "ui-row",
        dim && "is-dim",
        stack && "ui-row--stack",
        onOpen && "ui-row--link",
      )}
    >
      {lead ? (
        <span
          className="ui-row__lead"
          style={leadColor ? ({ "--lead": leadColor } as never) : undefined}
          aria-hidden="true"
        >
          {lead}
        </span>
      ) : null}
      {onOpen ? (
        <button
          type="button"
          className="ui-row__main ui-row__open"
          aria-label={openLabel}
          onClick={onOpen}
        >
          {body}
        </button>
      ) : (
        <div className="ui-row__main">{body}</div>
      )}
      {side ? <div className="ui-row__side">{side}</div> : null}
      {onOpen ? (
        <ChevronRight className="ui-row__chevron" aria-hidden="true" />
      ) : null}
    </div>
  );
}

/**
 * 单选分段控件（role=radiogroup）：用于「二选一 / 三选一」的设置值。
 * 与 Seg（标签页）外观相同，语义不同——Seg 切换面板，Choice 改一个值。
 * 方向键在选项间移动并选中（roving tabindex）。
 */
export function Choice<T extends string>({
  items,
  value,
  onChange,
  label,
  disabled,
}: {
  items: { value: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (value: T) => void;
  /** 读屏名称，如「主题」。 */
  label: string;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    items.findIndex((item) => item.value === value),
  );
  const move = (offset: number) => {
    const next = items[(index + offset + items.length) % items.length];
    onChange(next.value);
    // 选中后焦点跟到新项上：下一帧它才拿到 tabIndex=0。
    requestAnimationFrame(() =>
      ref.current
        ?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)
        ?.focus(),
    );
  };
  return (
    <div
      ref={ref}
      className="ui-seg ui-choice"
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {items.map((item, itemIndex) => {
        const checked = itemIndex === index;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={checked}
            data-value={item.value}
            tabIndex={checked ? 0 : -1}
            title={item.title}
            disabled={disabled}
            className={cx("ui-seg__item", checked && "is-active")}
            onClick={() => onChange(item.value)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** 键帽：快捷键说明里的一个键。 */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="ui-kbd">{children}</kbd>;
}

export function Field({
  label,
  hint,
  group,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  /**
   * 控件是一组按钮（Choice 等）时用 div 而不是 label：label 会把点击
   * 转发给第一个按钮，点标签文字就会误改值。
   */
  group?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  if (group)
    return (
      <div className="ui-field" role="group" aria-labelledby={id}>
        <span className="ui-field__label" id={id}>
          {label}
        </span>
        {children}
        {hint ? <span className="ui-field__hint">{hint}</span> : null}
      </div>
    );
  return (
    <label className="ui-field">
      <span className="ui-field__label">{label}</span>
      {children}
      {hint ? <span className="ui-field__hint">{hint}</span> : null}
    </label>
  );
}
