import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ComponentPropsWithoutRef,
  type HTMLAttributes,
} from "react";

function classes(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

/**
 * AI Elements PromptInput 的本地组合原语。
 *
 * 这里只约束输入区的结构与 slot，不接管草稿、附件或发送状态；这些业务
 * 仍由 Composer 持有，因此接入新的 agent transport 时不用绕过现有流程。
 */
export function PromptInput({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="prompt-input"
      className={classes("prompt-input", className)}
      {...props}
    />
  );
}

export function PromptInputHeader({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="prompt-input-header"
      className={classes("prompt-input__header", className)}
      {...props}
    />
  );
}

export const PromptInputTextarea = forwardRef<
  HTMLTextAreaElement,
  ComponentPropsWithoutRef<"textarea">
>(function PromptInputTextarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      data-slot="prompt-input-textarea"
      className={classes("prompt-input__textarea", className)}
      {...props}
    />
  );
});

export function PromptInputFooter({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="prompt-input-footer"
      className={classes("prompt-input__footer", className)}
      {...props}
    />
  );
}

export function PromptInputTools({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="prompt-input-tools"
      className={classes("prompt-input__tools", className)}
      {...props}
    />
  );
}

export const PromptInputButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement>
>(function PromptInputButton({ className, type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      data-slot="prompt-input-button"
      className={classes("prompt-input__button", className)}
      {...props}
    />
  );
});
