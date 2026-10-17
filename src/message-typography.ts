export interface MessageTypography {
  font: "sans" | "system" | "serif" | "mono";
  fontSize: number;
  lineHeight: number;
  paragraphGap: number;
  listGap: number;
  headingScale: number;
  headingGap: number;
  codeScale: number;
  contentWidth: number;
  emphasisWeight: number;
  tablePadding: number;
  codeStyle: "subtle" | "plain";
  tableStyle: "grid" | "minimal";
}

export interface MessageTemplate {
  id: string;
  name: string;
  typography: MessageTypography;
}

export const DEFAULT_MESSAGE_TYPOGRAPHY: MessageTypography = {
  font: "sans",
  fontSize: 15,
  lineHeight: 1.55,
  paragraphGap: 0.45,
  listGap: 0.06,
  headingScale: 1.08,
  headingGap: 0.95,
  codeScale: 0.86,
  contentWidth: 0,
  emphasisWeight: 700,
  tablePadding: 6,
  codeStyle: "subtle",
  tableStyle: "grid",
};

export const MESSAGE_PRESETS: readonly MessageTemplate[] = [
  { id: "original", name: "原始", typography: DEFAULT_MESSAGE_TYPOGRAPHY },
  {
    id: "comfortable",
    name: "舒适",
    typography: {
      ...DEFAULT_MESSAGE_TYPOGRAPHY,
      fontSize: 16,
      lineHeight: 1.7,
      paragraphGap: 0.8,
      listGap: 0.35,
      headingScale: 1.18,
      headingGap: 1.3,
      codeScale: 0.93,
      contentWidth: 760,
      emphasisWeight: 600,
      tablePadding: 9,
      tableStyle: "minimal",
    },
  },
  {
    id: "compact",
    name: "紧凑",
    typography: {
      ...DEFAULT_MESSAGE_TYPOGRAPHY,
      fontSize: 14,
      lineHeight: 1.5,
      paragraphGap: 0.4,
      listGap: 0.1,
      headingScale: 1.12,
      headingGap: 0.85,
      codeScale: 0.92,
      contentWidth: 900,
      tablePadding: 5,
    },
  },
];

// 校验与设置控件共用范围；宽度 0 表示铺满。
export const TYPOGRAPHY_RANGES = {
  fontSize: { label: "正文字号", min: 12, max: 22, step: 0.5, unit: "px" },
  lineHeight: { label: "正文行高", min: 1.3, max: 2.2, step: 0.05, unit: "倍" },
  paragraphGap: { label: "段落间距", min: 0, max: 1.6, step: 0.05, unit: "em" },
  listGap: { label: "列表项间距", min: 0, max: 1, step: 0.01, unit: "em" },
  headingScale: { label: "标题大小", min: 1, max: 1.5, step: 0.01, unit: "倍" },
  headingGap: { label: "标题前留白", min: 0.5, max: 2, step: 0.05, unit: "em" },
  codeScale: {
    label: "行内代码大小",
    min: 0.8,
    max: 1.1,
    step: 0.01,
    unit: "倍",
  },
  contentWidth: {
    label: "正文最大宽度",
    min: 0,
    max: 1200,
    step: 20,
    unit: "px",
  },
  emphasisWeight: {
    label: "强调字重",
    min: 500,
    max: 700,
    step: 100,
    unit: "",
  },
  tablePadding: {
    label: "表格单元格留白",
    min: 3,
    max: 14,
    step: 1,
    unit: "px",
  },
} as const;

export function normalizeMessageTypography(value: unknown): MessageTypography {
  const input =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const result = { ...DEFAULT_MESSAGE_TYPOGRAPHY };
  for (const key of Object.keys(
    TYPOGRAPHY_RANGES,
  ) as (keyof typeof TYPOGRAPHY_RANGES)[]) {
    const value = input[key];
    const { min, max } = TYPOGRAPHY_RANGES[key];
    if (typeof value === "number" && Number.isFinite(value))
      result[key] = Math.max(min, Math.min(max, value));
  }
  if (["sans", "system", "serif", "mono"].includes(String(input.font)))
    result.font = input.font as MessageTypography["font"];
  if (input.codeStyle === "plain") result.codeStyle = "plain";
  if (input.tableStyle === "minimal") result.tableStyle = "minimal";
  return result;
}

export function normalizeMessageTemplates(value: unknown): MessageTemplate[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set(MESSAGE_PRESETS.map((preset) => preset.id));
  const result: MessageTemplate[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      !item.name.trim()
    )
      continue;
    const id = item.id.trim().slice(0, 100);
    if (!id || ids.has(id) || id === "custom") continue;
    ids.add(id);
    result.push({
      id,
      name: item.name.trim().slice(0, 30),
      typography: normalizeMessageTypography(item.typography),
    });
    if (result.length === 12) break;
  }
  return result;
}

export function sameTypography(a: MessageTypography, b: MessageTypography) {
  return (
    Object.keys(DEFAULT_MESSAGE_TYPOGRAPHY) as (keyof MessageTypography)[]
  ).every((key) => a[key] === b[key]);
}

const FONTS: Record<MessageTypography["font"], string> = {
  sans: '"Geist", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "WenQuanYi Micro Hei", system-ui, sans-serif',
  system:
    'system-ui, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
  serif: '"Noto Serif CJK SC", "Songti SC", "SimSun", serif',
  mono: 'var(--font-mono), "Noto Sans Mono CJK SC", monospace',
};

export function messageTypographyVariables(
  value: MessageTypography,
): Record<string, string> {
  return {
    "--message-font": FONTS[value.font],
    "--message-size": `${value.fontSize}px`,
    "--message-line-height": String(value.lineHeight),
    "--message-paragraph-gap": `${value.paragraphGap}em`,
    "--message-list-gap": `${value.listGap}em`,
    "--message-heading-scale": String(value.headingScale),
    "--message-heading-gap": `${value.headingGap}em`,
    "--message-code-scale": `${value.codeScale}em`,
    "--message-width": value.contentWidth ? `${value.contentWidth}px` : "100%",
    "--message-emphasis-weight": String(value.emphasisWeight),
    "--message-table-padding": `${value.tablePadding}px`,
    "--message-code-bg":
      value.codeStyle === "plain" ? "transparent" : "var(--surface-muted)",
    "--message-code-padding":
      value.codeStyle === "plain" ? "0" : "0.1em 0.25em",
    "--message-table-border":
      value.tableStyle === "minimal" ? "transparent" : "var(--line)",
    "--message-table-header-bg":
      value.tableStyle === "minimal" ? "var(--surface-muted)" : "transparent",
  };
}
