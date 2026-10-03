/**
 * 各家 agent 会把系统上下文/控制信息写进 user 角色消息：Claude 的
 * <system-reminder>、IDE 附加上下文（<ide_xxx>）、hook 回执（xxx-hook）、
 * 任务通知（<task-notification>）、本地命令标签（command-xxx、
 * local-command-xxx、bash-xxx），Codex 的 <environment_context>/<user_instructions>/
 * <recommended_plugins> 与 "# AGENTS.md instructions for …" 注入块，以及
 * Esc 中断的 "[Request interrupted by user…]" 回显。它们是给模型看的
 * 上下文而非用户输入——渲染、预览、turn 边界判定一律用剥离后的文本。
 * 客户端 src/session/user-message.ts 里有一份同步副本。
 */
export const CONTEXT_BLOCK_PATTERN =
  /<(system-reminder|task-notification|ide_[a-z_]+|[a-z]+(?:-[a-z]+)*-hook|command-name|command-message|command-args|local-command-[a-z]+|bash-(?:input|stdout|stderr)|environment_context|user_instructions|recommended_plugins)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi;

export const AGENTS_INSTRUCTIONS_PATTERN =
  /#\s*AGENTS\.md instructions for [^\n]*\s*<INSTRUCTIONS>[\s\S]*?<\/\s*INSTRUCTIONS\s*>/gi;

export const INTERRUPT_ECHO_PATTERN =
  /^\[request interrupted by user[^\]]*\]$/i;

/** 剥离注入块后的可见用户文本；整条全是注入内容/中断回显时返回 ""。 */
export function visibleUserText(text: string) {
  const stripped = text
    .replace(AGENTS_INSTRUCTIONS_PATTERN, "")
    .replace(CONTEXT_BLOCK_PATTERN, "")
    .trim();
  return INTERRUPT_ECHO_PATTERN.test(stripped) ? "" : stripped;
}
