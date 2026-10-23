# deck-api 使用说明

## 当前默认：create / send / receive / del

新创建的任务使用协议 2。Agent 日常只需四个操作：

```bash
DA="${CODEX_DECK_HOME:-$HOME/.codex-deck}/bin/deck-api"
bash "$DA" create demo-agent -- '自包含的任务、背景与交付要求'
bash "$DA" send --to @s-xxxxxxx -- '补充约束或问题'
bash "$DA" receive --wait 30
bash "$DA" del @s-xxxxxxx
```

| 操作 | 当前语义 |
| --- | --- |
| create | 创建独立原生会话，返回稳定 `ref` 与请求回执。来源可以继续当前回合，不必立即结束 |
| send | 写入目标持久 inbox；子会话省略 --to 时发给绑定来源。成功仅表示已持久受理 |
| receive | 批量领取当前会话新消息，默认不等待；可等待 0–60 秒。不会启动或打断回合 |
| del | 删除有权管理的目标，默认忙时报 BUSY；force 只表示停止后删除，不绕过所有权或清除 dirty worktree |

### 收信与自动继续

- 目标运行、审批、压缩或后端未就绪时只存消息，不 steer/interrupt。模型可以在当前回合调用 receive 获取进度、问题或结果。
- 目标空闲时，500ms 内的消息合为一批，以 start 开启新回合；每批最多 20 条、80,000 字符正文，剩余消息留待后续领取。显式 receive 等待者优先。
- receive 和自动继续共用同一消息状态；已领取的消息不再触发新回合。尚未发送的自动队列批次可以安全交给 receive，sending/受理未知的批次不可抢走。
- 新任务最终答复和执行失败自动成为来源 inbox 消息，不需要另发 send。send 只用于独立的进度、问题或沟通，不根据正文猜测是否“最终”。
- 只有创建任务和绑定来源发起的工作回合自动交付；人在子会话直接聊天、第三方来信和纯结果/系统消息处理不会自动反向回传。
- `--detached` 仍可用：结果进入 inbox，但不单独触发来源执行。升级前的 detached 不补发历史完成消息。
- 自动继续可能消耗模型额度。每会话默认最多连续 10 个自动回合、每小时 30 个；达到预算后暂停自动调度，send/receive 仍可用。会话雷达面板可查看数量、暂停原因并由用户继续。
- 父会话的人工输入会重置其管理子任务的连续预算，但不会恢复已 stop 的子任务；小时预算不会被清零。显式给子任务发新工作、在该子会话输入或点击继续，才会解除停止暂停。

### 重试与丢失边界

create/send/receive 都支持 `requestId`，CLI 自动生成并在 stderr 显示；同一次网络重试沿用，不能换参数。创建在原生后端受理与回执持久化之间重启时，返回 `REQUEST_UNCERTAIN`，不会自动重复创建，需用任务列表/原生历史核对。

receive 是领取，不是只读查询。相同 requestId 在至少 7 天内重放原批次；`receive --replay` 列出最近 20 个批次，`receive --replay <requestId>` 只读恢复。工具被杀、stdout/stderr 都丢失时，可从批次列表找回；这不保证模型一定读取了输出，也不提供端到端 exactly-once。

原生投递中断且受理未知时不会自动重发。雷达面板显示待核对批次；用户核对原生历史后，可确认已送达，或在明确未受理时重新排队。后者可能重复执行或产生额外费用，必须显式确认。

### HTTP 与兼容

新增 `POST /api/deck/receive`，请求带当前调用者身份、requestId、wait，可选 replay；返回 messages、batchId、hasMore、timedOut。新 create/send 回执带持久受理身份；`GET /api/deck/sessions/:reference/result?turn=<turnId>` 可辅助定位历史结果。

直接调用 HTTP 的新客户端须在 create/send 请求中传 `protocol: 2`；新版 CLI 已自动携带。create 省略版本仍建立历史关系，避免旧脚本静默改变行为。send 尊重已有关系版本，涉及旧关系时保持旧队列链路；新关系不会因旧客户端省略版本退回旁路投递。无绑定的外部显式 send 使用 `deck:external` 身份，不冒充任何会话。

新数据位于现有 DATA_DIR 的 `deck-inbox.json` 和 `deck-requests.json`，不复制原生 Agent 数据。损坏台账会暂停对应写入并保留原文件。旧关系仍走原队列/通知链路，不全量迁移、不重新唤醒历史任务；网页普通聊天 queue/feedback 不变。

del 会持久保存原生删除检查点和资源清理状态。原生删除之后清理失败，可重复 del 继续处理；已完成的删除不重复调用原生后端。dirty worktree 与明确要求保留的资源不会被强制清除，回执返回保留原因或清理警告。

更新后需由用户重启 Deck，让服务和安装脚本使用同一版本；旧安装脚本不认识 receive 时不能用 collect 代替。新协议不把显式 steer/interrupt 当默认通信能力；旧显式模式仅保留兼容路径。不要直接用旧版本服务写新台账，降级前备份并停止新协议写入。

---

## 历史协议与辅助管理参考

**以下章节主要描述升级前关系和仍保留的辅助接口。** 其中“普通任务必须 send”“创建后结束回合”“detached 只可 result 查询”等约定不适用于上述新协议；新任务优先使用四操作。

`deck-api` 是 Deck 的本地 Agent 通信入口，提供以下能力：

- `create`：创建一个独立的 Agent 原生会话，并把它和发起会话绑定。
- `send`：向已知会话主动发送消息，或让子会话向来源回传结论、进度和问题。
- `create --detached` + `result` / `inspect`：独立执行，由来源按需领取交付、查看执行输出。
- `stop` / `delete` / `archive`：停止、删除或归档子任务会话，补齐生命周期管理。
- `wake`：监督 SSH / GPU / Slurm 等外部长任务，任务结束后唤醒对应会话。

它不是另一个 Agent 框架，也不负责替 Agent 做计划。Deck 只提供**会话隔离、可靠投递和可观测性**，什么时候委派、什么时候回传由 Agent 决定。

## 两条独立链路：send 与 wake

`send` 和 `wake` 共享底层会话消息队列，但入口、路由和语义彼此隔离：

| | `send` | `wake` |
| --- | --- | --- |
| 入口 | `create` 的绑定关系、`--to`、`@s-…`、`@alias` | `wake watch/poll`、外部 HTTP |
| 持久层 | 会话消息队列 | 唤醒 outbox |
| 消息头 | `[ask:<alias>]`、`[send:<session 别名或 id>]` | `[wake:<会话别名>]` |
| 失败展示 | 会话的待发送列表 | 总览「需要处理」 |
| 典型用途 | Agent 回传、补充上下文 | 长任务结束后继续处理 |

关键区别：

- 新的 `send` 路径（绑定来源、`--to`、`@alias`）使用默认会话别名。
- `wake` 只负责“某个外部任务结束了”这一类事件，使用会话别名解析目标会话，并保留独立的重试和失联判定。
- 每个会话默认可使用 deck-api；不存在独立的唤醒开关。

消息头只携带定位这条消息所需的最少信息：

```text
[deck-api:create:7f3a2c] 来自发起会话的询问。
[ask:7f3a2c] [查看完整会话](/s/7f3a2c)
结论：建议方案 B。
[send:1a2b3c4d] 补充上下文……
[wake:s-0e67727] 任务结束 exit=0
```

完整 ask ID、message ID 和 session key 保存在服务端台账和 UI 里，不会反复注入会话上下文。

## 会话别名与询问引用

| 标识 | 形如 | 指什么 | 什么时候有 |
| --- | --- | --- | --- |
| 会话别名 | `s-3f9kq2pz` | 一个会话本身 | 会话创建时默认分配，所有会话都有 |
| 询问别名 | `7f3a2c90` | 一次 `create` 产生的询问关系 | `create` 后才有 |

`result` / `inspect @s-…` 会先找到该会话对应的询问回执再查询，所以会话别名也能直接领取 detached 交付。

## 实战例子与泳道图

[deck-api-examples.md](deck-api-examples.md) 记录了如何从本机询问台账和消息投递记录解析真实协作，并列出了 traceroute 工作区里 6 个实际询问的时间、回传数和走向。

- Deck 内打开 **工具 → 协作泳道**，或访问 `/deck-api`，页面实时读取 `/api/deck/lanes`，按用户、来源会话、Deck 队列、目标会话分泳道；右上角可刷新。
- 页面「指定会话」可填询问别名（`7f3a2c90`）、会话别名（`@s-3f9kq2pz`）或 `agent:threadId`；也可直接访问 `/deck-api?q=@s-…`，只解析匹配的来源或目标会话。
- 页面优先显示本机台账；后端不可用时退回 `shared/deck-api-swimlane-example.json` 的脱敏快照，不会用虚构案例填充。
- `npm run lanes:sync` 把本机解析结果写到 `.data/deck-api-swimlanes.json`；`npm run swimlane` 生成 `.data/deck-api-swimlane.svg`；`npm run swimlane:example` 重新生成仓库内脱敏示例和文档图。
- 解析只读 `ask-sessions.json`、`message-deliveries.json` 和 `thread-summaries.json`，不复制会话、不写回台账。

## 安装与入口

Deck 启动时会把与当前版本配套的脚本安装到：

```bash
${CODEX_DECK_HOME:-$HOME/.codex-deck}/bin/deck-api
```

项目里也可以直接使用 `skills/deck-api/scripts/deck-api`。脚本会优先转发到已安装版本，避免项目内副本和服务端接口脱节。

```bash
DA="${CODEX_DECK_HOME:-$HOME/.codex-deck}/bin/deck-api"
bash "$DA" help
bash "$DA" help create
bash "$DA" help send
bash "$DA" help wake
```

地址和凭据由 `${CODEX_DECK_HOME:-$HOME/.codex-deck}/instances/<实例ID>.json` 自动发现，文件权限为 600，更新时原子替换。CLI 先验证后端身份和来源会话，多实例歧义会报错。可用 `DECK_INSTANCE_ID` 固定实例，或显式设置 `DECK_API_URL` / `DECK_TOKEN`。不再读取全局 `url` / `token` 或旧的 `DECK_SEND_URL` / `DECK_WAKE_URL`。

watcher 绑定选定实例，每次投递重新读取该实例的地址和凭据，Deck 重启或更换端口后无需重新挂载。Windows + WSL 会将该实例登记到 WSL 的标准 Deck home；网络仍需可达。

常用辅助命令：

```bash
bash "$DA" agents      # 可用 Agent、是否在线、是否支持 steer
bash "$DA" sessions    # 创建记录、状态、短别名、投递 ID
bash "$DA" whoami      # 确认当前会话身份
bash "$DA" list        # 查看会话别名
```

## 快速开始

### 1. 创建一个子会话

```bash
# 新会话 + 绑定当前会话为默认收件人
bash "$DA" create codex -- '请复核下面的方案，重点看并发安全：……'

# 较长的问题从文件读取
bash "$DA" create claude --name '方案复核' --file ./question.txt

# 人创建的来源会话使用 queue，不注入当前回合
bash "$DA" create codex --mode queue -- '请给出第二意见'
```

`create` 每次都会新建独立原生会话。目标看不到发起会话的历史，问题必须自包含。目标会话会收到自己的短别名（例如 `7f3a2c`）和一次性身份信息。

### 2. 子会话主动回传

```bash
# 默认发给 create 绑定的来源，不需要查目标
bash "$DA" send -- '结论：建议方案 B。依据：……。文件：src/example.ts。'

# 多行内容
bash "$DA" send --file ./result.txt

# 显式带身份，避免多会话/跨平台识别歧义
bash "$DA" send --session demo-review:01a1503d-… -- '需要确认：超时是否包含排队时间？'
```

默认 send 模式可以多次调用 `send`，不会结束会话。正常结束时不会自动转发最终回复；**目标不主动 `send`，来源就收不到任何消息**。普通模式同样保存最终答复，来源可用 `result` 查询，不需要为了领取结果再创建或重跑任务。detached 模式直接留下最终答复，由来源自行获取。

### Detached：独立执行，稍后领取

```bash
bash "$DA" create codex --detached -- '独立完成模块，最终答复列出改动、产物和验证结果。'
# 来源继续推进自己的工作，在合适时机读取
bash "$DA" tasks
bash "$DA" result @7f3a2c90
bash "$DA" inspect @7f3a2c90 --tail 30
bash "$DA" send --to @7f3a2c90 -- '补充约束：并发上限为 8。'
```

| | 默认 send 模式 | detached 模式 |
| --- | --- | --- |
| 常规交付 | 目标主动 `send` | 目标在本会话最终答复中交付 |
| 正常结束 | 保存最终答复，不自动转发；可用 `result` 查询 | 保存最终答复，不推送任何通知；用 `result` 查询 |
| 真实失败 | 默认通知来源（可关闭） | 保存状态和 error，不推送通知；用 `result`/`tasks` 查询 |
| 中止 / 取消 | 静默，不自动通知 | 同样静默；状态标记为 `cancelled` |
| 来源如何获取 | 主动回传，或用 `result` 领取 | 用 `result` 领取，或按需读取 |
| 显式 `send` | 投递消息 | 同样投递消息 |

以下为未另行订阅时的行为。雷达面板中系统通知订阅可分别配置普通与 detached 失败；取消/中断始终静默。detached 控制默认通知策略，`--mode queue|steer|interrupt` 控制显式 `send` 的默认投递方式，两者独立。普通询问不发 `send` 并不等于 detached。detached 完成/失败时**不向来源推送任何消息**：来源可能是正在运行的主会话，自动返回会打断或污染用户回合；状态和正文只放在 `result`/`inspect`/`tasks` 里，由来源主动查询。

`result @<alias>`（也可用完整询问 ID）返回：

- `item`：当前状态、detached、resultAvailable、resultState、错误和逐条回传投递元数据。`resultState` 为 pending（待同步）、ready（可领取）、empty（没有最终文本）。
- `outgoingMessages`：绑定来源消息的 ID、回合、deliveryId、投递状态和错误；`currentTurnSentCount` / `currentTurnDeliveredCount` 为本回合提交与送达数。已提交不等于已送达，已送达也不证明有最终结论或对方已读。显式 `--to` 的投递另用 `delivery <deliveryId>` 查询。
- `result`：本回合的 `turnId`、`text`、`completedAt`、`truncated`；尚无结果时为 null。
- `pending`：回合已完成，但原生历史尚未同步出结果。可稍后再查询，不要重新创建任务。

普通和 detached 模式都保存本回合最终答复，结果查询不触发聊天。旧普通任务在首次 result 查询时按需补读，避免启动时扫描全部历史。结果只保存最终答复快照，不复制完整会话。优先提取原生 `final_answer`；无阶段标记的后端提取工具执行之后的尾部答复。没有文本时返回 result=null、resultState=empty、pending=false，不把空字符串当成交付；用户可打开子会话核对产物。超过 80,000 字符显式标记 truncated，全文保留在原生会话中。同步失败时 item 带 `captureError`（第 N 次失败原因），下次 tick/查询自动重试一次，成功后清除；不要把 `pending` 误判成任务失败而重建会话。

查询不会触发来源执行，也不会消耗结果；已保存交付可在 Deck 重启、目标离线后重复读取。继续追问启动新回合后，旧结果清除，新回合结束后保存新交付，避免把旧答复当成新结果。

`inspect` 返回近期回复、命令输出和文件路径，不包含推理；默认 40 行，可设置 1–200 行，最多 80,000 字符，裁剪时返回 truncated。它需要读取原生会话，后端不可用时会报错，不会伪装成仍在运行。

来源可以继续自己的工作，按需读取状态与结果；不要紧密轮询。**detached 默认完成/失败不通知来源；显式订阅的系统通知也仅用 queue。** 只有主动 `result`/`inspect`/`tasks` 才能拿到状态与正文。

### 3. 来源继续追问

`create` 回执和每条回传都会带短别名：

```bash
bash "$DA" send --to @7f3a2c -- '补充约束：并发上限按 8 处理。'
```

也可以使用完整会话：

```bash
bash "$DA" send --to demo-review:01a1503d-… -- '补充上下文……'
```


### 4. 停止、删除与归档

```bash
# 取消排队消息并立即打断当前回合；停止是静默的，不向来源回传失败消息
bash "$DA" stop @7f3a2c
bash "$DA" kill @7f3a2c --now          # kill 是 stop 的别名

# 让当前回合自然结束后再标记已停止；之后仍可 send 重新拉起
bash "$DA" stop @7f3a2c --after-turn

# 删除原生会话与台账；别名默认保留 2 天后回收
bash "$DA" delete @7f3a2c
bash "$DA" del @7f3a2c --keep-worktree

# 软隐藏：保留会话、结果与别名，但不能继续 send
bash "$DA" archive @7f3a2c
bash "$DA" unarchive @7f3a2c
```

| 动作 | 行为 | 备注 |
| --- | --- | --- |
| `stop --now` | 取消待投递、打断当前回合、标记 `cancelled` | 默认；不发送任何自动消息 |
| `stop --after-turn` | 取消待投递，等当前回合结束再标记 | 适合“别再开新回合” |
| `stop --force` | 打断失败时再紧急归位 | 仍会清挂起审批 |
| `delete` | 停止（必要时）→ 删原生会话 → 台账转墓碑（默认保留 2 天）→ 清理 worktree/watcher | 不可恢复 |
| `archive` | 软隐藏，保留历史与别名 | 运行中不能归档 |

- 删除会取消询问的初始投递、失败回传和 detached done 通知；显式 `send` 不在此列。
- 删除默认停止该会话绑定的 watcher；`--keep-watchers` 保留并提示。
- worktree 默认只清理 Deck 创建且无未提交改动的目录；dirty worktree 保留并报告路径。`--force` 会连同 dirty worktree 一起清理，请先确认没有未提交成果。
- Claude 等需要关闭 Deck 连接的会话删除时加 `--close-connection`；被外部进程占用时会拒绝删除。
- 删除后的询问和会话别名在保留期内仍可定位，`result` / `inspect` / `send` 返回 `DELETED`（410），不会 404 或误投；保留期默认 2 天，到期后释放。
- `stop` 只允许来源会话停止自己的子任务，或子任务停止自己；其他 Agent 需要显式 `--force`。浏览器 UI 按本机用户授权处理。

### 5. 监督外部任务

```bash
# 阻塞到任务结束：默认 watch，结束后通知当前会话
bash "$DA" wake -l train-r3 -- \
  ssh -o BatchMode=yes gpu-box 'while kill -0 12345 2>/dev/null; do sleep 60; done; tail -n 30 ~/runs/r3/train.log'

# 状态查询：poll，默认每 60 秒查询一次
bash "$DA" wake poll -l job-4821 -i 120 -- \
  ssh -o BatchMode=yes hpc 'sacct -j 4821 -n -X -o State | head -1'
```

省略别名时，Deck 会根据进程树和环境识别当前会话并使用其默认别名。无法确认来源或别名属于其他会话时会拒绝；只有用户明确授权通知另一个会话时才用 `-f`。

## create 语义

- 每次新建独立会话，正常保存在目标 Agent 的原生历史中，不复制历史。
- 自动识别来源：优先使用进程树里 Deck 托管的 Agent 进程；环境变量身份需要进程树佐证。无法确认时拒绝猜测，可显式传 `--session <agentId:threadId>`。
- 受理后返回 202，只表示会话已创建、初始问题已持久入队，不代表目标已经开始执行。默认 send 模式发起方应结束本回合，不要 sleep、tail、ps 或轮询；detached 模式可以继续推进独立工作。
- 主动回传是异步的，会以新的 `[ask:…]` 消息到达；detached 默认不回传。
- 子会话不能再 `create`，避免递归；它可以用 `send` 和来源交流。
- 目标使用 Deck 中保存的询问默认配置。只有用户明确要求时才传 `--provider` / `--model` / `--effort`；Agent 不应自行探测或挑选模型。
- 默认 send 模式启动/执行**失败**会自动通知来源，即使此前已发送进度；**中止、取消和主动 stop 静默**，只把询问标记为 `cancelled`，不会再自动回一条「询问失败」。目标被停用只记录失败。detached 的完成/失败/中止都不通知来源，状态与正文只供 `result`/`inspect`/`tasks` 查询。

## send 语义

### 收件人

| 写法 | 含义 |
| --- | --- |
| 不传目标 | 发给 `create` 绑定的来源 |
| `--to @s-0e67727` | 发给该别名对应的任意会话 |
| `--to @<alias>` | 按询问引用定位其子会话 |
| `--to <agentId:threadId>` | 发给明确已知的任意会话 |


不属于 create 关系的会话必须显式指定目标，不能默认为自己或猜测目标。

### 投递模式

`create` 的 `--mode` 设置回传默认方式，单次 `send` 可以覆盖：

| 模式 | 行为 |
| --- | --- |
| `queue` | 等对方空闲后再发送；默认 |
| `steer` | 对方正在运行时直接追加到当前回合，不打断；空闲时直接发送 |
| `interrupt` | 先停止对方当前回合，再发送 |

`steer` 只支持 Codex 这类可转向当前回合的会话（`agents` 输出带有 `steer` 标记）。不支持时会直接报错，不会静默降级为打断或排队。`steer` 投递时如果对方回合已经变化会失败，可用 `--request-id` 重试同一条消息。

显式收件人的 `send` 和 `wake` 默认使用 `queue`。

### 幂等与限制

- 向绑定来源发送时可用 `--request-id <唯一ID>` 重试同一次发送；内容和 mode 必须一致，不同消息必须使用不同 ID。
- 显式目标不支持 `--request-id`。
- 单条消息上限 80,000 字符；超限直接拒绝，避免静默截断。
- 2xx 表示 Deck 已持久受理，不表示对方已读、已执行或已经回复。
- `send` 不结束会话，也不等待回复。发送后不要轮询或反复追问。

### 失败与重试

`send` 现在使用普通会话消息队列的语义：

- 离线、忙碌等情况会留在队列里等待。
- 中止、取消和主动 `stop` 会把询问标记为 `cancelled`，不生成失败回传，也不会往来源回合灌消息。
- 明确未发送的失败会出现在会话的待发送列表，可取消或重试。
- 不会进入唤醒 outbox，也不会出现在总览的「需要处理」里；后者只处理 `wake` 投递失败。

### 收件人解析与错误码


| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `UNKNOWN_ALIAS` | 404 | 别名不存在 |
| `ARCHIVED` | 409 | 目标会话已归档 |
| `DELETED` | 410 | 询问或会话已删除；别名在保留期内返回 410，到期后释放 |
| `AMBIGUOUS` | 409 | 同一目标绑定了多个不同来源的询问，带候选列表（仅 alias/status 等安全字段），必须显式指定 |
| `BAD_FORMAT` | 400 | `--to` 格式无效 |
| `NOT_CANCELLABLE` | 409 | 询问已结束，不能再 stop |
| `BUSY` | 409 | 会话仍在执行/删除中，需要先 stop 或加 `--force` |
| `FORBIDDEN` | 403 | 跨会话停止/删除未获授权，需显式 `--force` |


### 主会话：不注入，但空闲时正常送达

人创建的会话是**主节点**（即不是任何询问的目标会话；fork/retry 产生的新 id 自然视为主节点）。发往主节点的 agent 消息不会 steer/interrupt 当前回合，但也不会无限期等待用户输入：

- `steer` / `interrupt` 对主节点降级为 `queue`，仍返回 202，不报错。
- `queue` 消息在目标空闲时立即送达并开启新回合；目标运行中则排队等空闲，不注入当前回合。
- `wake` 投递同规则。旧版本留下的缓冲条目在重启后转为普通排队，空闲即送达。
- 子会话之间、发往子会话的消息不受影响，queue/steer/interrupt 语义不变。

## 会话别名（默认开启）

每个会话——不论由 UI 新建、由 `create` 询问创建，还是 fork/重试产生——都会自动分配一个
`@s-xxxxxxx` 形式的会话别名，不需要任何开关：

- 固定 7 位小写字母数字，前缀 `s-`，与会话一一对应。
- 首次生成后落盘，会话活跃期间**永不重算**；服务重启、归档都不会改变。
- 会话删除后别名进入墓碑，默认保留 2 天：期间收件人解析和查询返回 `DELETED`（410），旧链接不会指向别的会话；到期后回收，旧链接可能指向新会话。
- 保留期在「设置 → 开发者 → deck-api」调整，`0` 表示不回收。
- 快照的 `session.threads[].alias` 会下发当前映射；`GET /s/s-…` 直接跳转到会话。
- 完整 session key 仍是唯一真源，只用于台账、API 和调试。

用法：

```bash
bash "$DA" sessions                       # 看到询问和它们的 targetAlias
bash "$DA" send --to @s-3f9kq2pz -- '补充约束……'
bash "$DA" inspect @s-3f9kq2pz --tail 30
bash "$DA" result @s-3f9kq2pz
```

## 询问别名

每次 `create` 还会生成一个询问别名，例如 `7f3a2c90`：

- 由 ask UUID 派生，默认 8 位，必要时逐级加长以避免冲突（10、12……）。
- 首次生成后写入询问台账，之后**永不重算**；服务重启、会话归档、再次追问都不会改变。
- 旧台账没有别名时，在加载时补齐一次并立即保存。
- 消息正文只使用 `[ask:<alias>]` 和 `/s/<alias>` 短链接；不会再重复携带完整 ask ID、message ID 和 session key。

来源可以用 `send --to @<alias>` 回复同一个子会话；不需要复制完整 thread ID。

## wake 语义

### watch

运行一个阻塞命令，命令结束时把退出码和末尾输出发送给绑定会话：

```bash
bash "$DA" wake -l train-r3 -n 60 -- ssh gpu-box 'wait-for-job'
```

- `-n <行数>`：附带输出末尾多少行，默认 40。
- 适合真正阻塞到任务结束的命令；同步查询不要挂 `watch`。
- watcher 会自行后台运行，不需要再套 `nohup`。

### poll

定期执行查询命令，状态进入结束态时通知：

```bash
bash "$DA" wake poll -l job-4821 -i 120 -d 'COMPLETED|FAILED' -- \
  ssh hpc 'sacct -j 4821 -n -X -o State | head -1'
```

- `-i <秒>`：轮询间隔，默认 60，最小 5。
- `-d <正则>`：自定义结束态。
- `-a`：中间状态变化也通知。
- 默认把 `COMPLETED`、`FAILED`、`CANCELLED`、`TIMEOUT`、`OUT_OF_MEMORY` 等视为结束态；空输出视为 `GONE`。
- 连续 10 次 SSH 连接失败也会通知。

### 管理 watcher

```bash
bash "$DA" wake ps             # 查看运行中的 watcher
bash "$DA" wake stop <pid>     # 主动停止（Deck 会记为主动停止，不报失联）
```

不要直接 `kill`，否则 Deck 会把 watcher 记为失联。

### 失联与重试

watcher 台账会记住见过的进程。watcher 没有发出唤醒就消失（被 kill、机器重启等）时，会作为「失联」出现在总览「需要处理」，由人决定是否通知会话。Deck 不托管 watcher 生命周期，不会自动重启。

唤醒请求先在服务端落盘，再返回 202，之后在后台重试；Agent 闪断、会话正忙或 Deck 短暂重启都不会丢。投递无望时会进入「需要处理」。自动发现模式的 watcher 会重新读取轮换后的令牌；显式 URL/令牌模式需自行更新配置。

外部脚本可在任务回传面板复制向 `/api/deck/events/s-…` 投递的 curl 示例，携带当前 Deck 的鉴权凭据。所有会话默认可接收。

```bash
bash "$DA" wake @s-0e67727 -- ssh demo-box 'wait-for-job'
```


## 界面与持久化

- 会话头部雷达按钮打开「deck-api · 任务回传」：查看询问、子会话、状态、回传统计、模型与 effort，可复制会话别名、停止/归档/删除子任务并管理 watcher。
- 删除前会确认；删除后询问从列表消失，原生会话、Deck 创建且干净的 worktree 与绑定 watcher 一并清理，别名在保留期内保留墓碑。
- 总览首页的「deck-api 监督中」列出本机 watcher；失联记录出现在「需要处理」。
- 完成状态与主动消息投递分开显示；已发进度、旧回合消息或仍在排队的消息都不等于本回合最终交付。无最终文本时单独标记，可打开子会话核对。
- 雷达面板中普通与 detached 任务均可点击「读取结果」，查看最终答复、同步错误和主动消息的投递状态；创建任务使用 CLI。
- 总览「最近会话」包含各状态会话，按最近活动排序。
- 询问关联、待发送消息、消息队列和唤醒 outbox 都会持久化，服务重启后继续处理。detached 交付的同步状态（`captureError`/重试计数）与已读指针同样落盘，重启后不重不漏。
- 向绑定来源 `send` 期间重启导致受理结果不确定时，先检查会话，再用同一个 `--request-id` 重试，或新建会话；显式目标没有 `--request-id`，只能检查会话后再决定是否重发。

## Windows 与 WSL

- Windows 原生（含 Git Bash）通过 Windows 进程树识别来源；Git Bash 的 `$$` 会转换成 Windows pid 再发送给 Deck。
- Windows 上使用 `--wsl` 时，Deck 会把发现文件和三个调用脚本安装到 WSL 用户的 `~/.codex-deck/`，并扫描 WSL 里的 watcher。
- WSL 会话标识（`CODEX_DECK_SESSION` / `CODEX_THREAD_ID`）在 WSL 模式下可作为来源依据；仍要求会话真实存在。
- WSL 与 Windows 默认不共享 `127.0.0.1`。如果 WSL 里的 `deck-api` 无法连接 Deck，请启用 WSL 镜像网络，或用 `--host 0.0.0.0` / 具体 LAN IP 启动。
- 没有会话标识的 Agent（如部分 ACP/OpenCode 调用）仍需显式 `--session`。

## 兼容与升级

- 重启升级后的 Deck 才会安装新版脚本并加载新服务端逻辑。
- `deck-send` 和 `deck-wake` 保留兼容入口；`ask` 等价于 `create`，`watch/poll` 等价于 `wake watch/poll`。
- 旧 HTTP `/api/send/*`、`/api/wake/*` 保留；新入口使用 `/api/deck/create`、`/api/deck/send` 等路由。
- 新的回传走消息队列；旧 code 对应的未送达事件会显示为投递失败，需要按会话别名重新投递。
- `deck-send` / `deck-wake` 脚本入口仍可用，但目标必须改为会话别名。
- 独立 wake-code 与 `send --code` 已移除；旧 code 无法再定位会话。升级后停止并用会话别名重新挂载旧 watcher，更新外部回调地址。新 watcher 使用实例发现，可跨地址和凭据变化继续投递。

## 安全与身份

- 来源识别只使用只读、确定性的线索：进程树、Deck 托管的会话标识、显式 `--session`。线索不足时拒绝猜测，把候选交给 Agent 去问用户。
- 环境变量会被子进程继承，只有在进程树里找到对应 Agent 后端时才可信；WSL 模式是明确例外。
- 访问令牌保存在实例发现文件中，权限 600。不要把令牌打印到终端、写进仓库或会话。
- 这是单用户本机控制面：能读取令牌的同用户进程可以调用接口。多人或不可信环境应额外做网络隔离、反向代理鉴权或独立账号。

## API 速查

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/deck/create` | 创建询问会话 |
| `POST` | `/api/deck/send` | send：绑定来源、`@alias`、显式会话或会话别名 |
| `POST` | `/api/deck/prepare` | 识别来源、确认会话别名、whoami |
| `GET` | `/api/deck/agents` | 可用 Agent、配置和 steer 能力 |
| `GET` | `/api/deck/sessions` | 询问台账、状态、别名、回传统计 |
| `GET` | `/api/deck/lanes` | 解析实际协作泳道；`q` 匹配询问/会话，或 `ask` / `session` / `project` 收窄 |
| `GET` | `/api/deck/sessions/:reference/result` | 按别名或询问 ID 读取状态与本回合最终交付 |
| `GET` | `/api/deck/deliveries/:id` | 读取单条投递回执，不返回消息正文 |
| `GET` | `/api/deck/sessions/:reference/inspect?tail=40` | 查看原生会话近期输出 |
| `POST` | `/api/deck/sessions/:reference/stop` | 停止未结束的询问；`mode=after-turn\|now\|force` |
| `POST` | `/api/deck/sessions/:reference/archive` | 归档询问会话 |
| `POST` | `/api/deck/sessions/:reference/unarchive` | 恢复归档 |
| `DELETE` | `/api/deck/sessions/:reference` | 删除原生会话与台账，别名在保留期内保留墓碑 |
| `GET` | `/api/deck/targets` | 默认会话别名 |
| `POST` | `/api/deck/events/:code` | 按会话别名投递外部事件 |
| `GET` | `/s/:alias` | `s-…` 跳转到会话；询问别名跳转到询问子会话 |
| `POST` | `/api/monitor/watchers/:pid/stop` | 停止 watcher |
| `POST` | `/api/monitor/lost-watchers/:id/notify` | 通知失联 watcher 的会话 |

`/api/send/*` 和 `/api/wake/*` 仍作为旧版兼容路由保留。

## 排障

**`deck-api` 找不到 Deck**

确认 Deck 已启动，并检查 `${CODEX_DECK_HOME:-$HOME/.codex-deck}/instances/` 中的登记与网络连通性；WSL 场景优先启用镜像网络，或用 `--host` 绑定可达地址。

**create/send 报“无法判断来源”**

使用已知身份显式指定：`create` / `send` 用 `--session <agentId:threadId>`；`wake` 先确认会话别名，必要时加 `-f`。不要猜一个看起来相似的会话。

**send 失败**

去对应会话的待发送列表查看状态，明确未发送的可以重试；不要假定对方已经收到。向绑定来源发送时用同一个 `--request-id` 重试。

**wake 没有通知**

先看 `wake ps` 和 watcher 日志。如果 watcher 已经消失且没有发出唤醒，会在「需要处理」里出现失联记录；确认远端任务现状后再决定是否重挂，避免重复监督。

**升级后旧 watcher 无法投递**

自动发现模式会刷新令牌；显式 URL 模式需检查所设置的 DECK_TOKEN 是否仍有效。


## 可选能力：未读、通知和脚本等待

常用 Agent 流程仍是 `create / send / tasks / result`。以下能力供用户或脚本选择，不要求每次调用，不要求 `send --final`。Deck 当前是宿主；这些行为不代表已发布独立核心库。

```bash
bash "$DA" tasks --unread
bash "$DA" collect @7f3a2c90 @8a4b6d20
bash "$DA" wait @7f3a2c90 --timeout 30
bash "$DA" create codex --cwd /work/demo --worktree=main -- '复核并验证'
```

- `result` / `inspect` / 投递回执均只读。`collect` 最多批量处理 100 个引用，返回可重复读取的结果，并推进已读标记，不删除结果。`unread` 表示当前回合有未领取结果/失败，或有未确认的等待变化；不是消息接收者的阅读回执。
- `waitingReason` 为 `waiting-approval`、`backend-offline`、`unresolved`、`stalled`，分别表示实际待处理审批、后端离线、空闲但历史无法匹配、运行中 5 分钟未见事件。`waitingSince` / `lastProgressAt` 用于排障；这些状态不自动中止或判失败。原生 retry 不会仅因 status=waiting 就被当成审批。
- `wait` / `GET /api/deck/sessions/:reference/result?wait=0..60` 最多等待 60 秒；就绪、失败、取消或空最终答复立即返回，超时返回 `timedOut=true`。请求断开会取消等待，服务重启是连接中断，调用方重连后可查询，不能当作成功。wait 不推进已读，也不向会话发消息；skill 不推荐 Agent 把它作为默认流程。

雷达「通信与创建设置」是配置客户端；同样可用 HTTP 读写，不需要通过聊天配置：

| 接口 | 用途 |
| --- | --- |
| `GET /api/deck/sessions?unread=true` | 筛选未读摘要 |
| `POST /api/deck/collect`，`{references:["alias",…]}` | 显式批量领取 |
| `GET/POST /api/deck/notices/:agentId/:threadId` | 来源的系统通知策略 |
| `GET /api/deck/agents` | 目标与默认配置 |
| `POST /api/deck/agents/:agentId/configuration` | 用户设置目标默认配置 |

通知配置为 `{resultReady:false,failure:true,detachedFailure:false,waiting:false,windowSeconds:5,minIntervalSeconds:60}`，窗口范围 0–3600 秒，间隔范围 0–86400 秒。普通失败与 detached 失败分别由 failure/detachedFailure 控制，保存其它设置不会隐式改变 detached 失败默认值。只聚合系统指针，不合并 send，不搬运最终答复全文。每任务/回合/事件去重，digest 在入队前落盘，重启复用同一投递 ID。已观察到但未订阅的旧事件不会在之后开启订阅时集中补推。遗留已发送失败回执不会重新通知。

## 目标目录与创建权限

`create --cwd` 对应 JSON 的 `targetCwd`，用于目标目录；已有 `cwd` 仍是调用者身份识别线索。相对目标目录以来源会话目录解析。`--worktree` 使用目标目录 HEAD，`--worktree=<base>` 使用指定分支/提交，并准确记录基准提交。

创建回执 `effectiveConfiguration` 的每项包含 `value` 和 `source`：adapter 表示适配器回显，request/default 表示传入或用户默认但未获确认（`confirmed:false`），native 表示原生默认且具体值未知（value=null）。不把传给适配器的请求值冒充适配器确认值。cwd/returnMode 也显示选择来源，主会话的有效回传方式是 queue。`worktree` 返回独立工作区记录。

用户保存的目标默认配置可含 `approvalPolicy`、`sandbox`、`permissionMode`，另有独立的 `allowedPermissions`：

```json
{"sandbox":"read-only","allowedPermissions":{"sandbox":["read-only","workspace-write"]}}
```

默认值与允许集合互不代替。未请求权限时使用默认值；默认值为空则交给原生工具。可选 `permissions`（CLI `--approval` / `--sandbox` / `--permission-mode`）必须属于用户对应允许集合，空集合禁止 Agent 自选；不对不同原生模式做高低排序。模型覆盖保留权限默认值，但不会把允许集合透传给适配器。

目标 cwd 由用户自由选择；workspace-write 的工作区范围随它改变，不意味着仍受来源项目目录限制。配置接口与其它管理接口共享可信本机鉴权，无法防止持有同一 token 的调用方改配置，不构成恶意 Agent 或跨用户安全隔离。

Agent 常用命令不增加步骤；脚本可用 `deck-api --json send …` 取得原始 JSON，create 的提示写 stderr，stdout 只保留 JSON。未读查询可用 `source=self`（附调用者身份线索）或 `source=agentId:threadId`；CLI `tasks --unread` 默认只看当前来源，`--source` 可显式选择。UI 也按来源查询。升级时已有终态记录迁移为已读，之后新结果正常标记未读。

系统通知台账损坏只暂停通知并在雷达设置中提示，原文件保留，任务/result 仍可使用；投递采用有限退避重试，永久错误标为 dead。通知正文历史保留 7 天、最多 5000 条事件和 1000 条已结束 digest；紧凑事件键保留以防修剪、时钟变化或重启后重推，不承诺总去重元数据恒定。

旧 external 已送达消息正文最多保留最近 500 条且不超过 7 天，之后清除正文/图片并从快照移除。紧凑回执和内容摘要保留用于投递查询与 Deck 内部派生 ID 去重；元数据保留不等于无限保留完整聊天内容。

通用契约与宿主策略的后续拆分见 [通用 API 边界](deck-api-boundary.md)。本轮不抽核心库，也未实现版本化通用 API。
