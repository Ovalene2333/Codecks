---
name: deck-send
description: 旧 deck-send 调用的兼容入口。创建 Agent 会话、主动发消息和外部任务监督统一使用 deck-api。
---

# deck-send 兼容入口

优先读取相邻 `../deck-api/SKILL.md`。新命令是 `deck-api help/create/send/wake`。
本目录脚本转发到 deck-api：旧 `ask` 等价于 `create`，旧 `watch/poll` 等价于 `wake watch/poll`；旧 `send <code> <消息>` 保留显式代号语法。
行为已更新：目标使用 `deck-api send -- '<有用的消息>'` 主动回传，不再自动转发最终回复。未发送就结束时只通知结束，启动或执行失败自动通知。
默认配置由用户与 Deck 决定，Agent 不主动获取/选择模型、供应商或 effort。
