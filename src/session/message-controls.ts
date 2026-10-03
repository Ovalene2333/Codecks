import type { AgentCapabilities, ThreadSummary, MessageDeliveryMode } from "../types";

/** 提示描述服务端已声明的行为；旧服务端只给中性提示，不猜能力。 */
export function messageControls(thread: ThreadSummary, capabilities?: AgentCapabilities, mode?: MessageDeliveryMode) {
  const busy = thread.status === "running" || thread.status === "waiting" || Boolean(thread.activeTurnId);
  const behavior = capabilities?.messages?.busyBehavior;
  if (mode && capabilities?.messages?.deliveryModes?.includes(mode)) {
    return {
      busy, blocked: false, label: mode === "queue" ? "追加" : "即时反馈",
      help: !busy ? "当前没有运行中的任务，两种模式都会直接发送。"
        : mode === "queue" ? "等当前任务完成后，再处理这条消息。"
        : behavior === "steer" ? "直接反馈给当前任务，无需停止。"
        : "会先停止当前任务，确认结束后再发送这条消息。",
      placeholder: thread.compacting ? "正在压缩上下文"
        : !busy ? "发送新指令…"
        : mode === "queue" ? "添加当前任务结束后处理的消息…"
        : behavior === "steer" ? "输入反馈，供当前任务参考…"
        : "输入反馈，将先停止当前任务再发送…",
    };
  }
  const blocked = busy && behavior === "reject";
  const label = !busy ? "发送新指令"
    : behavior === "steer" ? "即时反馈"
    : behavior === "queue" ? "追加"
    : blocked ? "任务结束或停止后可发送"
    : "发送消息";
  return {
    busy,
    blocked,
    label,
    help: behavior === "steer"
      ? "当前会话支持即时反馈，可直接发送，无需停止当前任务。"
      : behavior === "queue"
        ? "当前会话会将新消息追加到后续回合，暂不支持运行中直接反馈。"
        : behavior === "reject"
          ? "当前会话运行中暂不能发送。需要即时反馈时，请先停止，再发送。"
          : "当前会话可发送消息，具体处理时机由智能体决定。",
    placeholder: thread.compacting ? "正在压缩上下文"
      : blocked ? "可先编辑，任务结束或停止后发送…"
      : busy && behavior === "steer" ? "输入反馈，供当前任务参考…"
      : busy && behavior === "queue" ? "添加当前任务结束后处理的消息…"
      : `${label}…`,
  };
}
