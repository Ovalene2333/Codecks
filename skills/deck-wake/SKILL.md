---
name: deck-wake
description: 旧 deck-wake 调用的兼容入口。统一 Agent 通信与外部任务监督使用 deck-api。
---

# deck-wake 兼容入口

优先读取相邻 `../deck-api/SKILL.md`。本目录脚本经 deck-send 兼容入口转发到 deck-api。
原 watch/poll/send 位置参数保留；新流程使用 `deck-api create/send/wake`。
create 的最终回复不自动转发，目标应通过 `deck-api send` 主动发送有用信息；默认 send 模式失败仍自动通知；detached 完成/失败不推送，状态与正文用 `result` / `tasks` 查询。
send 与 wake 已分离：send 直接进会话消息队列（`[ask]`/`[send]`），不创建唤醒代号；只有 wake 事件才使用代号和 `[wake:<code>]`。
回复子会话优先用 `deck-api send --to @<alias> -- '…'`，不需要复制完整 thread ID。
发往主会话的 send/wake 不会 steer/interrupt 当前回合：空闲时正常送达，运行中排队等空闲。
