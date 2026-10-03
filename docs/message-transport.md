# 通用消息输送与普通对话

网页默认使用 **追加**（等当前任务完成后处理），可在已发出的待发送气泡上点击 **即时反馈**（现在介入，必要时先停止当前任务）。Deck 的持久输送层把这两种语义适配到各后端；底层新回合、严格 steer 和原生队列仍保留为独立 API 契约。回执不代表模型已读或任务完成。现有 `/turns`、`/interrupt` 和 deck-wake 接口保留。

## 用户发送模式

| 后端 | 追加 `queue` | 即时反馈 `feedback` |
| --- | --- | --- |
| Codex native | Deck 持久队列，等空闲后 `turn/start` | 运行中严格 `turn/steer`，不打断 |
| Claude native | Deck 持久队列，等空闲后送入 SDK 输入流 | 请求 SDK interrupt，确认空闲后发送 |
| OpenCode native | Deck 持久队列，等空闲后 `prompt_async` | 请求 abort，确认空闲后 `prompt_async` |
| ACP | Deck 持久队列，等空闲后 `session/prompt` | 暂停旧的 adapter FIFO、请求 cancel，确认旧回合与清理结束后发送反馈，再恢复 FIFO |

没有运行中的任务时，两种模式都启动新回合。追加在同一会话内保持 FIFO；即时反馈优先于未发送的追加消息，不丢弃这些追加。对于不支持 steer 或 interrupt 的第三方 adapter，仅开放可真实实现的模式。

发送模式属于 Deck 输送层。旧服务端没有 `deliveryModes` 时，网页保留旧发送行为，不假装支持新模式。

## 底层直接发送的行为矩阵

| Deck 后端 | 空闲发送 | 运行中 / 待审批时发送 | 打断机制 | 打断后的队列 |
| --- | --- | --- | --- | --- |
| Codex native | `turn/start` | 有活动回合时 `turn/steer`，携带 `expectedTurnId` | `turn/interrupt {threadId, turnId}`，目标是回合 | 底层直接接口不排队 |
| Claude native | 将 user message 写入长期 SDK 输入流；无连接时创建或恢复 query | 当前 adapter 拒绝，包含 query 尚未启动的预约窗口 | 连接建立后 `query.interrupt()`；启动前通过 AbortController 取消 | 当前 adapter 未开放排队 |
| OpenCode native | `POST /session/:id/prompt_async`，204 确认受理 | 使用同一接口，Deck 未建立严格追加或排队契约 | `POST /session/:id/abort`，目标是整个会话 | 由后端决定，Deck 不保证清空 |
| ACP（含 Claude ACP 等） | `session/prompt` | Deck adapter 的 `pendingSends` 内存 FIFO；每条开始时创建独立回合 | `session/cancel` notification；adapter 先校验活动回合 | 完成、失败或取消后都会继续 drain，取消当前回合不会清空队列 |

能力以接入方式为边界。Claude native 与 Claude ACP 的行为可以不同，不能仅根据模型或 CLI 品牌推断。

Claude SDK 的 streaming input 支持 queued messages，但当前 Deck adapter 使用 busy 保护，不能把 SDK 的潜在能力标成已经开放。OpenCode 的 `prompt_async` 受理成功不足以证明新消息会注入正在运行的模型请求，第一版保守声明 `unknown`，严格 `append` 不开放。

压缩中的会话拒绝底层直接发送；持久输送层会等待压缩结束，网页在压缩期间禁用发送。归档会话需要先恢复。普通消息不会替代审批决策。停止当前回合不回滚已经发生的文件改动，也不保证终止已脱离会话运行的 SSH、Slurm 或其他后台任务。

## 能力发现

`GET /api/snapshot` 的 `agents[].capabilities.messages`（HTTP 与 WS fullSnapshot 共用）包含：

```json
{
  "busyBehavior": "queue",
  "interruptScope": "session",
  "queueDurability": "memory",
  "deliveryModes": ["queue", "feedback"]
}
```

`busyBehavior` 为 `steer / queue / reject / unknown`，描述底层 auto 行为。`queueDurability: memory` 描述 ACP 原生 adapter 队列，不是 Deck 的持久队列。`deliveryModes` 由 registry 根据 sendMessage / steer / interrupt 能力补充。字段 optional，旧 adapter 和旧服务端不被推断为支持新接口。

## 发送 API

`POST /api/agents/:agentId/threads/:threadId/messages`。原生 threadId 保留，路径段必须 `encodeURIComponent`。鉴权沿用现有 Deck 访问令牌。

```json
{
  "text": "请补充检查数据划分",
  "mode": "append",
  "expectedTurnId": "turn_123"
}
```

也接受与 `/turns` 一致的 `images: [{url, name?}]`。网页使用两种模式：

- `queue`：消息落盘后返回 HTTP 202，等目标会话空闲并完成 adapter 清理，再用 `start` 投递。
- `feedback`：消息落盘后返回 HTTP 202；支持 steer 时严格追加，否则先打断目标回合，最多等待 30 秒确认空闲，再用 `start` 投递。

202 回执带消息记录的 `id / mode / status`、`disposition: queued` 和 `queueDurability: disk`。通过 `fullSnapshot.messageDeliveries`（WS、HTTP 与 localStorage seed）追踪其 `queued / interrupting / sending / delivered / failed` 状态。`delivered` 只表示后端已受理。本页发起、在本页观察到等待/发送，或属于当前活动回合的投递，在正文同步前保留补位气泡；首次打开会话时，历史完成回执不生成底部气泡列表，尤其不能把尾部缓存之外的旧消息再次显示。HTTP 回执填补下一次快照到达前的显示空窗，快照到达后按 ID 更新同一条气泡。

底层调用方仍可使用三种直接模式：

- `auto`（默认）：沿用该 adapter 的行为。Codex 的活动回合已结束时允许回退到新回合，并在回执中报告实际方式；Claude 忙时拒绝；ACP 忙时内存排队；OpenCode 忙时交给后端。
- `start`：只允许在空闲时开新回合；忙时拒绝，不追加、不排队。
- `append`：仅支持严格追加的 adapter 可用，必须指定 `expectedTurnId`；目标回合结束、变化或追加失败时拒绝，不能悄悄开新回合。

`auto/start` 也可携带 `expectedTurnId`，作为操作前的状态检查。它不使会话级后端获得跨客户端的原子回合检查能力。

直接模式受理成功返回 HTTP 200：

```json
{
  "id": "本次调用的回执ID",
  "agentId": "codex",
  "threadId": "thread_123",
  "status": "accepted",
  "disposition": "appended",
  "turnId": "turn_123"
}
```

`disposition` 是 `started / appended / queued / backend-managed`。ACP 排队回执另带 `queueDurability: "memory"`。`turnId` 是 adapter 的回合标识，OpenCode 的标识由 Deck 生成。

同一会话的新 API 请求按受理顺序串行处理，锁在后端受理后释放，不等待模型完成。它不锁住 CLI、旧接口或其他客户端；最终是否接受仍由后端决定。不同会话互不阻塞。

直接模式不自动重试、不持久化，也不提供跨请求幂等。`id` 只用于关联一次成功调用的回执；调用超时后不能根据它推断后端未收到消息。

`queue / feedback` 的文本和图片保存在 `.data/message-deliveries.json`，写入权限 600。queued 在服务重启后继续处理；interrupting 恢复成可重试的失败记录；sending 恢复成受理状态未知的失败记录，禁止自动重试，以免重复执行。明确的忙碌或目标回合结束拒绝可重新等待；其他发送故障不盲目重投。

如果新的活动回合替代了反馈绑定的旧回合，Deck 不会继续打断新任务；打断超时也不会直接发送。未发送内容保留在会话的待发送列表中。只有能确认消息未发送的失败才显示重试。

取消未发送消息：`DELETE /api/agents/:agentId/threads/:threadId/messages/:id`；重试明确未发送的失败：`POST .../messages/:id/retry`。取消正在等待打断的消息不会撤销已经发生的打断。sending / delivered 不能取消；消息记录校验 agentId 和 threadId 归属。deck-wake 的持久 outbox 独立保留。

将追加气泡改为即时反馈：`POST .../messages/:id/feedback`，返回 HTTP 202。只提升同一条 queued 消息，保留 ID、正文和图片，绑定点击时的活动回合；落盘后才参与即时反馈调度。重复请求已经提升的消息返回原记录，不创建新消息。已开始发送、已受理的追加或失败记录不能提升，返回 409；操作中已取消则返回 404。

## 打断 API

`POST /api/agents/:agentId/threads/:threadId/messages/interrupt`：

```json
{ "expectedTurnId": "turn_123" }
```

Deck 检查是否仍为该活动回合，再调用 adapter。成功回执：

```json
{
  "status": "interrupt_requested",
  "agentId": "codex",
  "threadId": "thread_123",
  "turnId": "turn_123",
  "scope": "turn"
}
```

`scope` 为 `turn / session`，准确反映底层控制粒度。对于会话级打断，Deck 的检查是发送前的防过期保护，不能消除后端与其他客户端并发切换回合的竞态。

回执只确认请求发出或受理。ACP cancel 是 notification，没有 RPC 应答；Codex、Claude、OpenCode 的控制请求成功也不代表任务已经退出。独立打断的调用方需继续观察 `agent.event` 中的 `turn/completed` 和 `thread.updated`，确认目标回合终止，再决定是否发 `start`。feedback 模式由输送层检查活动回合状态和 adapter 清理状态，完成等待后才发送；它不清空原有队列。

## 错误契约

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `invalid_request` | 空消息、参数格式错误、append 缺目标回合等 |
| 409 | `busy` | start 或当前 adapter 不允许忙时发送 |
| 409 | `turn_mismatch` | 当前回合与调用方看到的不一致 |
| 409 | `no_active_turn` | 目标回合已结束或不存在 |
| 409 | `archived / compacting` | 当前会话不允许操作 |
| 422 | `unsupported` | adapter 没有对应能力 |
| 400 | `delivery_failed` | 其余后端错误，包含未知 Agent、会话不存在、未启用或连接故障 |

响应形如 `{code, error}`。后端无法确认是否已经受理时，通用层不会声称“未投递”。

## 普通对话界面

输入框默认追加，不再显示模式选择器。发送后，消息在时间线中显示为右侧用户气泡，正文末尾内联显示简短状态，以及即时反馈（闪电）和取消（叉号）图标，不额外占用工具条或说明行。图标带读屏名称与悬停说明，反馈说明按后端能力提示直接介入或先停止当前任务。点击即时反馈提升原消息，不重发正文；正在打断或发送时显示进度，已开始投递后不再提供切换按钮。四类后端在运行中都可发送；本地斜杠命令沿用原行为。输入框的说明按钮解释两种用户语义；API `append` 仍指严格 steer，不等同于网页的“追加”。

受理后正文不被错误归入旧回合，而是在待发送气泡中展示等待、打断、发送或失败状态，支持取消和安全重试。未完成气泡来自首屏快照并缓存，刷新后仍可见；未完成记录和最近 50 条完成记录携带全文与图片数量，图片本体只在服务端持久队列中保存。需要补位的完成记录显示「已发送」，不提供取消或即时反馈；正文同步后移除气泡。旧服务端只有完成预览时不展示截断的正文。旧服务端和未声明 deliveryModes 的 adapter 回退到原发送方式。停止按钮保持独立，成功只提示“已请求停止”。

时间线统一核对本地发送气泡、持久队列与实际渲染的历史/流式 user item，同一条消息只显示一次。匹配基于发送前的消息身份与相同正文的出现次数，不以历史数组的全局下标为边界，兼容排序变化、尾部缓存、重复正文与两端注入上下文剥离。Codex/Claude 使用回执回合 ID；OpenCode 完成后切换为原生消息 ID 时结合发送时间；ACP session/load 重建 `acp-replay-*` ID 时按正文一对一对应。真实待发送列表按创建时间正序排列。Claude/ACP 新版历史解析保留用户图片部分，ACP 图片回放不再把图片拼成正文里的 `[image]`。

## 核对依据与验证范围

本机核对版本：Codex CLI 0.159.2、Claude Code 2.1.283 / Agent SDK 0.3.283、OpenCode 1.18.33。

- [OpenAI 官方 app-server 文档](https://developers.openai.com/codex/app-server)：`turn/steer` 要求 expectedTurnId、没有新 turn/started；打断后的结束状态通过事件确认。
- [Claude SDK streaming input](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)：SDK 提供排队与 interrupt；安装版本的 Query.interrupt 类型也明确可能保留 queued user messages。
- [ACP prompt](https://agentclientprotocol.com/protocol/prompt-turn) / [取消](https://agentclientprotocol.com/protocol/session-cancel)：prompt 与 cancel 分别是请求与通知；Deck FIFO 是 adapter 实现。
- [OpenCode 1.18.33 prompt 源码](https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/session/prompt.ts)：用户消息先写入会话再驱动执行循环；仅凭 async HTTP 受理不建立严格 steer 保证。

验证覆盖两个用户模式、持久队列 FIFO、反馈优先级、气泡提升与重复请求、投递期间拒绝切换、打断确认与超时、过期目标保护、取消、安全重试与重启恢复；也覆盖四类真实 adapter 的协议 fixture、ACP 暂停旧队列后的执行顺序，以及普通聊天的气泡操作。没有调用真实模型、消耗额度或打断用户正在运行的会话。各原生 CLI 的键盘快捷键不是 Deck 的 API 契约。
