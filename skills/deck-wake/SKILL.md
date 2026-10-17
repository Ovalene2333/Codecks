---
name: deck-wake
description: 旧 deck-wake 调用的兼容入口。统一 Agent 通信与外部任务监督使用 deck-api。
---

# deck-wake 兼容入口

优先读取相邻 `../deck-api/SKILL.md`。本目录脚本经 deck-send 兼容入口转发到 deck-api。
原 watch/poll/send 位置参数保留；新流程使用 `deck-api create/send/wake`。
create 的最终回复不自动转发，目标应通过 `deck-api send` 主动发送有用信息；失败仍自动通知。
