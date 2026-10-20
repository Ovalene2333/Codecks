# deck-api 协作实例

这一页不是手写的“示例故事”。Deck 会读取本机询问台账（`ask-sessions.json`）、
消息投递记录（`message-deliveries.json`）和会话摘要（`thread-summaries.json`），
把一次真实询问还原成泳道：谁发起、目标回了什么、来源补充了什么、哪些唤醒进入
了队列、最终状态是什么。

- Deck 内打开 **工具 → 协作泳道**，或访问 `/deck-api`，默认实时解析本机台账；右上角可刷新。
- 「指定会话」支持询问别名、`@s-…` 会话别名和 `agent:threadId`；URL 里写 `/deck-api?q=@s-…` 可直接分享/收藏某个案例。
- 页面失败或后端不可用时退回 `shared/deck-api-swimlane-example.json` 的脱敏快照。
- 静态图 [deck-api-swimlane.svg](deck-api-swimlane.svg) 来自真实询问 `f59a3b17`
  （deck-api 设计评审，detached），已脱敏；它不是虚构案例。
- 别的完整案例留在本机：`npm run lanes:sync` 输出到 `.data/`，不会写进仓库。

![deck-api 协作泳道](./deck-api-swimlane.svg)

## 解析规则

| 泳道事件 | 来源 |
| --- | --- |
| 发起询问 | `ask-sessions.json` 的 `question` 与 `createdAt` |
| 来源补充 | 目标线程收到、但不属于该询问回传的 `message-deliveries` 记录 |
| 唤醒通知 | 目标线程收到的 `[wake:<代号>]` 投递；同一代号聚合成一条，保留次数和时间范围 |
| 目标回传 | `ask.sentMessages`，时间从对应投递记录补齐；缺失时标 `estimated` |
| 台账收口 | `ask.status`、`executionCompletion`、`error`、detached 标记 |

页面不会把 `list()` 裁掉的正文另存一份，也不会为泳道创建新台账；它只读已有记录。
`npm run lanes:sync` 导出的快照会把绝对路径、URL、IP、Bearer 和常见密钥替换成
`<path>` / `<url>` / `<ip>` / `<token>`。

## 从本机会话解析出的案例

以下是 2026-10-19 至 10-20 在 `traceroute` 工作区实际发生的询问。数字来自解析结果，
不是设计目标：

| 询问 | 来源 → 目标 | 时间 | 回传 | 来源/唤醒补充 | 实际走向 |
| --- | --- | --- | --- | --- | --- |
| `f2a5df3b` | OpenCode 主研究会话 → Codex | 10-19 02:19–14:27 | 25 | 18（其中 15 条唤醒） | 排障 → 修复 → 隔离坏读出 → 稳定交接 → 多次 watcher 唤醒后续接新任务 |
| `2c9ea503` | 同一来源 → Codex | 10-19 15:12–18:10 | 19 | 16 | 任务包 → M1 → 设计冲突使原条件不可行 → 改条件 → M2 稳定 → 层映射/文本替换 |
| `894b5eb4` | 同一来源 → Codex | 10-20 04:15–13:15 | 18 | 15 | 开工核查 → 官方源不通 → 放行镜像 → 50 题计时 → OOM/缓存 bug → 全量稳定 → 让卡补跑 |
| `2ebaa3c8` | 同一来源 → Codex | 10-20 16:07–17:37 | 13 | 12 | schema/抽样 → 下载 → 依赖崩溃 → 空音频源 → 毒单元定位 → 封档 |
| `fdc194e1` | 同一来源 → Codex | 10-19 21:07–10-20 02:17 | 12 | 10 | 断点假设与代码冲突 → 批量生成 → 永久否决旧路径 → T2 启动 |
| `f59a3b17` | OpenCode 测试会话 → OpenCode | 10-19 22:33–22:47 | 8 | 7 | detached 设计评审：首轮观点 → 拆层 → 主从结构 → 收束；不推送完成通知 |

这些案例暴露的共同点：

- **一次询问里可能有多条来源补充**。上表里的 5 个 send 模式案例都有 10–16 条来源侧
  投递，和目标回传交错发生；只画“来源一次提问、目标一次回答”会失真。
- **唤醒会和询问消息共用目标队列**。`f2a5df3b` 期间有 15 条 `[wake:]` 进入目标线程，
  页面按代号聚合成一条，否则会把泳道淹没。
- **回传正文和时间要分别取**。正文在 `ask.sentMessages`，时间在投递记录的 `createdAt`；
  偶尔有 6/137 条历史回传找不到投递记录，页面会用估算时间并标记。
- **detached 只落台账**。`f59a3b17` 有 8 条主动回传，但结束时不推送 `[done:]`；
  来源要自己 `result` / `tasks` 查询。
- **本次 traceroute 样本里 0 条投递失败**，所以泳道没有红色失败点。历史记录中确实出现过
  `feedback` 投递失败；这类事件会在页面里标成失败，不能只看 202。

## 复现

```bash
# 解析本机全部询问，写到 .data/deck-api-swimlanes.json（含正文，仅本机）
npm run lanes:sync

# 收窄到一个工作区
npm run lanes:sync -- --project traceroute --limit 10

# 只导出一个询问
npm run lanes:sync -- --ask f59a3b17 --limit 1 --output /tmp/lanes.json

# 按会话别名 / thread id 解析
npm run lanes:sync -- --session @s-0485dda --output /tmp/lanes.json

# 生成静态 SVG（默认读 .data 的完整解析结果）
npm run swimlane

# 重新生成仓库里的脱敏示例和文档图
npm run swimlane:example
```

对应 HTTP 接口：

```bash
curl -H "Authorization: Bearer $(cat ~/.codex-deck/token)" \
  "$(cat ~/.codex-deck/url)/api/deck/lanes?limit=8&project=traceroute"

# 只看某个会话或询问
curl -H "Authorization: Bearer $(cat ~/.codex-deck/token)" \
  "$(cat ~/.codex-deck/url)/api/deck/lanes?q=@s-0485dda"
```

返回字段与页面一致：`scenarios[]`、每组 `lanes[]`、`steps[]`、`rules[]` 和 `meta`。
`steps[].estimated=true` 表示该条回传没有找到投递记录，时间按台账顺序估算。
