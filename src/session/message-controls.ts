import type { AgentCapabilities, ThreadSummary, MessageDeliveryMode } from "../types";

/** 输入框发送方式：排队走消息队列；即时追加直接发往当前回合（message-api mode=append）。 */
export type ComposerSendMode = MessageDeliveryMode | "append";

/** 提示描述服务端已声明的行为；旧服务端只给中性提示，不猜能力。 */
export function messageControls(thread: ThreadSummary, capabilities?: AgentCapabilities, mode?: ComposerSendMode) {
  const busy = thread.status === "running" || thread.status === "waiting" || Boolean(thread.activeTurnId);
  const behavior = capabilities?.messages?.busyBehavior;
  if (mode === "append") {
    if (!busy)
      return {
        busy, blocked: false, label: "发送新指令",
        help: "当前没有运行中的任务，直接发送。",
        placeholder: thread.compacting ? "正在压缩上下文" : "发送消息…",
      };
    if (behavior === "steer")
      return {
        busy, blocked: false, label: "即时追加",
        help: "直接追加到当前回合，不打断；对方在下个工具调用前就能看到。",
        placeholder: thread.compacting ? "正在压缩上下文" : "追加到当前任务…",
      };
    return {
      busy, blocked: true, label: "即时追加",
      help: "当前会话不支持转向追加（仅 codex 这类可转向会话支持）；可排队等它结束。",
      placeholder: thread.compacting ? "正在压缩上下文" : "当前会话不支持即时追加…",
    };
  }
  if (mode && capabilities?.messages?.deliveryModes?.includes(mode)) {
    return {
      busy, blocked: false, label: mode === "queue" ? "排队" : "即时反馈",
      help: !busy ? "当前没有运行中的任务，两种模式都会直接发送。"
        : mode === "queue" ? "等当前任务完成后，再处理这条消息。"
        : behavior === "steer" ? "直接反馈给当前任务，无需停止。"
        : "会先停止当前任务，确认结束后再发送这条消息。",
      placeholder: thread.compacting ? "正在压缩上下文"
        : !busy ? "发送消息…"
        : mode === "queue" ? "添加指令…"
        : behavior === "steer" ? "输入反馈，供当前任务参考…"
        : "输入反馈，将先停止当前任务再发送…",
    };
  }
  const blocked = busy && behavior === "reject";
  const label = !busy ? "发送新指令"
    : behavior === "steer" ? "即时反馈"
    : behavior === "queue" ? "排队"
    : blocked ? "任务结束或停止后可发送"
    : "发送消息";
  return {
    busy,
    blocked,
    label,
    help: behavior === "steer"
      ? "当前会话支持即时反馈，可直接发送，无需停止当前任务。点击发送按钮选择“即时”或“队列”。"
      : behavior === "queue"
        ? "当前会话会将新消息排队到后续回合，暂不支持运行中直接反馈。"
        : behavior === "reject"
          ? "当前会话运行中暂不能发送。需要即时反馈时，请先停止，再发送。"
          : "当前会话可发送消息，具体处理时机由智能体决定。",
    placeholder: thread.compacting ? "正在压缩上下文"
      : blocked ? "可先编辑，任务结束或停止后发送…"
      : busy && behavior === "steer" ? "输入反馈，供当前任务参考…"
      : busy && behavior === "queue" ? "添加指令…"
      : "发送消息…",
  };
}
