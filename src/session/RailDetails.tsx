import type { ComponentProps } from "react";
import { ChevronUp } from "lucide-react";
import { Button } from "../kit";

/** 工具轨道的折叠容器：长输出末尾也能收起，并把键盘焦点交回标题。 */
export function RailDetails({ children, ...props }: ComponentProps<"details">) {
  return (
    <details {...props}>
      {children}
      <Button
        className="rail-details-collapse"
        variant="ghost"
        size="sm"
        onClick={(event) => {
          event.stopPropagation();
          const details = event.currentTarget.parentElement;
          if (!(details instanceof HTMLDetailsElement)) return;
          details.open = false;
          const summary =
            details.querySelector<HTMLElement>(":scope > summary");
          summary?.focus({ preventScroll: true });
          summary?.scrollIntoView({ block: "nearest", behavior: "instant" });
        }}
      >
        <ChevronUp aria-hidden="true" />
        <span>收起</span>
      </Button>
    </details>
  );
}
