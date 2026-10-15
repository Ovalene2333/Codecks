/**
 * 应用内品牌标：单色线框，随文字颜色走（深浅主题自动适配）。
 * 彩色版 `assets/logo.svg` 只用于 favicon 与 README。
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 3h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-3.5L12 21l-2.5-3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3Z" />
      <path d="m8 8 3 2.5L8 13" />
      <path d="M13.5 13h3" />
    </svg>
  );
}
