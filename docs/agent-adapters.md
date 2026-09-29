# Agent Adapter 开发约定

Deck 的运行时层以 Agent 为边界。Codex、Claude Code、OpenCode 等 CLI
必须各自实现 adapter；Deck 不把不同 CLI 的私有协议混进同一个 manager。

Codex adapter 已完整接入网页兼容入口。Claude Code adapter 已接入生产后端、
通用 Agent API 和网页核心会话流程；OpenCode 尚未实现。

## 目录与职责

| 文件                                | 职责                                            |
| ----------------------------------- | ----------------------------------------------- |
| `server/agents/types.ts`            | 通用 adapter、能力和快照类型                    |
| `server/agents/registry.ts`         | adapter 注册、生命周期、事件转发和快照合并      |
| `server/agents/codex-adapter.ts`    | Codex app-server 协议、会话、审批和供应商隔离   |
| `server/agents/claude-adapter.ts`   | Claude Agent SDK 会话、流式事件、审批和生命周期 |
| `server/agents/claude-history.ts`   | Claude JSONL 消息树主链与通用 Turn 归一化       |
| `server/agents/opencode-adapter.ts` | OpenCode serve HTTP API 会话与审批              |
| `server/agents/acp-client.ts`       | ACP agent 子进程与 stdio JSON-RPC 传输          |
| `server/agents/acp-adapter.ts`      | 通用 ACP adapter：一个实现驱动所有 ACP CLI      |
| `server/agents/acp-agents.ts`       | ACP descriptor 内置表与用户配置加载             |
| `server/manager.ts`                 | 旧导入路径的兼容导出，不应再加入实现            |
| `server/codex-client.ts`            | Codex app-server 子进程与 JSON-RPC 传输         |
| `server/index.ts`                   | HTTP/WebSocket 边界和 adapter 组装              |

依赖方向必须保持为：

```text
server/index.ts
  -> AgentRegistry
    -> AgentAdapter
      -> CodexAdapter -> CodexClient
      -> ClaudeAdapter -> Claude Agent SDK
      -> OpenCodeAdapter -> opencode serve
      -> AcpAdapter -> AcpClient -> <cli> acp（任意 ACP 子进程）
```

`AgentRegistry` 不应导入任何 Codex、Claude 或 OpenCode 私有类型。
`AgentId` 是开放的 `string`：内置 adapter 固定用 `codex` / `claude` /
`opencode`，ACP adapter 用 descriptor 声明的自定义 id（`devin`、`kimi`…）。
路由层只允许 `^[a-z0-9][a-z0-9_-]*$` 形态的 id。

## AgentAdapter 契约

每个 adapter 必须实现 `server/agents/types.ts` 中的 `AgentAdapter`：

- `id`：稳定的 Agent 标识，写入会话和事件。
- `descriptor()`：返回可用性、在线状态、`protocol` 分组标记
  （`native`/`acp`，前端用于 Agent 选择器分层）和 capability matrix。
- `snapshot()`：返回该 Agent 的会话、归档会话和待处理审批。
- `startAll()`：启动或连接该 Agent 所需的 runtime，并加载历史。
- `refreshAll()`：重新读取该 Agent 的会话状态。
- `busyThreads()`：列出运行中或等待审批的会话。
- `restart()`：停止 adapter 管理的进程和连接；该操作必须可重复调用。
- `event`：所有增量更新通过 EventEmitter 的 `event` 事件发给 registry。

`startAll()` 和 `refreshAll()` 会被多个 adapter 并行调用。实现不能依赖注册
顺序，也不能修改其它 adapter 的环境或状态。

## 快照与身份

通用会话使用 `agentId` 区分 Agent。当前 Codex 的兼容路由仍用
`providerId + threadId`，因此前端和缓存对缺少 `agentId` 的旧数据按
`codex` 处理。

新增 adapter 时必须满足：

1. 每条 `ThreadSummary` 写入自己的 `agentId`。
2. 每条审批写入自己的 `agentId`。
3. 每条流式事件写入自己的 `agentId`。
4. 浏览器缓存键至少包含 `agentId`，避免不同 CLI 的原生 session ID 冲突。
5. 原生会话 ID 保持原样，不由 Deck 重新编号。

`AgentRegistry.snapshot()` 会保留主 adapter 的兼容字段，同时合并所有
adapter 的 `threads`、`archivedThreads` 和 `approvals`。Codex 仍是主 adapter，
所以顶层 `providers` 和 `runtime` 保持原行为。通用 API 使用
`/api/agents/:agentId/...` 路由，旧 Codex 路由继续兼容。合并时会按
`AgentDescriptor.fallbackFor` 隐藏备选 agent 与主 agent 重复的会话，规则见
「备选 Agent」一节。

## 能力声明

`AgentCapabilities` 是 UI 和 API 的功能门禁，不是宣传信息。adapter 只有在
对应操作真实可用且有测试时才应声明 `true`。

例如：

- 不支持原生 fork 时，不能用复制文本伪装成原生 fork。
- 不支持动态修改模型时，`sessionSettings` 应为 `false`。
- Skills、MCP、review 等 Codex 私有能力不能默认套用到其它 CLI。
- 隐藏能力必须在服务端同样拒绝调用，不能只靠前端隐藏按钮。

## Provider 边界

Deck 的 Agent adapter 不拥有 Provider。Provider、认证和连接配置由 CC Switch
或 Agent CLI 自己管理。

- adapter 可以只读发现 CC Switch 中与自身 `app_type` 对应的配置档。
- adapter 可以在启动会话时引用该配置档，但不得写回 CC Switch。
- 密钥只能在服务端进程内使用，不能进入快照、事件、日志或浏览器缓存。
- CC Switch 没有对应配置时，应使用 CLI 当前配置或明确报告不可用；不要新增
  Deck 自有 Provider 表单作为后备。

Codex 目前仍保留历史上的自定义供应商兼容逻辑。后续移除时需要单独做数据迁移，
不能在新增 Agent adapter 的提交里顺带删除。

## Codex Adapter

`CodexAdapter` 负责以下 Codex 专属行为：

- 启动共享 `codex app-server`，并连接本机 control WebSocket。
- 把 CC Switch Codex 配置编译为进程级 `-c` 参数和隔离环境变量。
- 通过 `thread/*`、`turn/*`、`item/*` JSON-RPC 管理会话和审批。
- 读取 `~/.codex` 历史，处理未落盘 rollout、resume 和 writer lock 错误。
- 将 Codex 通知映射为 Deck 的 `thread.updated`、`approval.*` 和
  `codex.event`。

Codex 协议相关逻辑应留在 `codex-adapter.ts`、`codex-client.ts` 或 Codex
专属 helper 中。不要为了复用把 `thread/start`、`model_provider`、rollout 等
概念加入通用 adapter 类型。

`server/manager.ts` 仅为现有测试和第三方导入提供：

```ts
export {
  CodexAdapter,
  CodexAdapter as CodexManager,
} from "./agents/codex-adapter.js";
```

新代码必须直接导入 `CodexAdapter`。

## Claude Code Adapter

`ClaudeAdapter` 通过官方 `@anthropic-ai/claude-agent-sdk` 为每个 Deck 管理的
会话保持一条长期 streaming query。首轮启动 Claude Code 子进程，后续 turn
写入同一条输入流；连接意外退出后才用原生 session ID resume。浏览器断开
不会关闭 query。外部 Claude Agent View 的 `claude attach` 由其 supervisor
负责；SDK 没有公开的跨进程 attach API，Deck 不会对这类会话执行 `stop` 或抢锁。
空闲但仍连接的 Deck 会话可在明确确认后关闭其 SDK 连接并删除；关闭连接会
终止该进程中的后台任务。正在执行 turn 的会话拒绝删除，外部进程占用的会话
显示占用 PID 并保留原会话。分支会建立独立会话；关闭 Deck 服务会结束 Deck
自己持有的 SDK 连接。CC Switch 重新加载
只刷新 Claude 配置档，不关闭已有 Claude 连接，新凭据用于新建或分支会话。
adapter 负责：

- Windows 自动模式只复用独立的 `claude.exe`，忽略 npm shim 并回退到 SDK
  随附 CLI；显式 `CLAUDE_BIN=.cmd` 时才通过 `cmd.exe` 包装。Linux 跳过挂载盘
  中的 Windows shim。
- Windows `--wsl` 优先启动 WSL 内的 `CLAUDE_WSL_BIN`。若未安装，只对
  `/mnt/<盘符>` 工作目录回退到 Windows Claude；`/home/...` 不会交给 Windows
  进程执行。

- 扫描 `CLAUDE_CONFIG_DIR`、当前用户 `~/.claude`，以及 WSL 可见的 Windows
  用户 Claude 目录。
- 按 `parentUuid` 分链回溯 JSONL 主链：>=2.1 的链路会穿过 attachment/system
  记录，`compact_boundary` 之后还会另起新链（`parentUuid=null`），因此按链根
  分段、每段从文件末尾的记录回溯，只收集非 sidechain 的 user/assistant，
  避免把重试分支和 Task 子代理内部消息并进同一 timeline。
- 将 assistant 文本、思考、tool use 和 tool result 归一化为通用 Turn item。
- 将 SDK partial message 映射为带 `agentId='claude'` 的 `agent.event`。
- 只把 `text` block 的增量作为助手正文；thinking/tool use block 不混入回答。
- 用 SDK assistant/tool_result 消息实时更新命令与文件操作卡片，结束后再与 JSONL 历史按 tool use ID 合并。
- 用 `canUseTool` 暂停工具执行，将批准一次、会话内批准和拒绝回送 SDK。
- `AskUserQuestion` 的 1–4 个问题全部显示；答案按问题文本转换为 SDK 所需的映射。
- 提供 Default、Sonnet、Opus、Haiku 模型目录和手动模型 ID，并把会话模型传给每个 query。
- `model='default'` 不向 SDK 传固定模型；`init.model` 只记录到 `resolvedModel`，保留 Claude Code 的默认模型选择。新建会话同时持久化这一选择。
- 暴露 SDK 原生 `default`、`acceptEdits`、`plan`、`dontAsk`、`bypassPermissions`
  权限模式；空闲时修改，从下一个 turn 生效。
- 将重命名写成 Claude JSONL `custom-title` 记录；永久删除同时移除 JSONL 和历史索引。
- 只读加载 CC Switch `app_type='claude'` 配置；自定义网关、API key 和
  Bedrock/Vertex/Foundry 配置在认证信息完整时可用。认证环境只注入对应
  Claude 子进程。运行时重载 CC Switch 会同步刷新 Claude profiles，显式
  供应商选择持久化到 `thread-settings.json`。始终追加
  「本机 Claude」兜底配置档：不带自有 env，复用 CLI 当前登录态（`~/.claude`
  凭据或环境变量），没有可用中转时 adapter 仍在线；CC Switch 里的 Official
  行仍单独拒绝直选（等价于本机档）。

Claude 当前声明 `approvals`、`images`、`interrupt`、`models`、`sessionSettings`、
`delete`、`fork` 和 `skills`。Skill 枚举有两条路径：会话保持活跃 SDK 连接时
用 `reload_skills` 控制请求取权威列表；未连接时按 Claude Code 发现规则扫
`<cwd>/.claude/skills` 与 `<claudeHome>/skills` 的 SKILL.md（plugin 来源只在
连接态可见）。没有实现的 archive、compact、review、shell 和 MCP 枚举
保持关闭。网页接线时必须按该 capability matrix 隐藏并禁用对应操作。

`forkThread` / `retryFromTurn`（中途编辑、回滚重试）走文件级分支：历史
turn 的 `id` 就是其 user 消息的 JSONL uuid，`retryFromTurn` 以目标 turn
之前最后一条主链消息为界，把链上前缀（外加无 uuid 的元数据行）复制成
`<新 sessionId>.jsonl`（sessionId 全部重写），再 `resume` 分支发送新文本；
`forkThread` 带 `lastTurnId` 时截到该 turn 末尾，否则整份复制。原文件
完全不动；这是基于当前 JSONL 格式的文件级分支，后续 CLI 格式变化需重新验证；
目标是首条消息时回滚等价于同配置新会话。锚点 uuid 不在当前主链（已被
回退或传错）会明确报错，不会拿无效 uuid 去撞 CLI。

会话锁：Claude Code >=2.1 在 `<claudeHome>/sessions/<pid>.json` 登记
活进程持有的 sessionId。Deck 已连接的会话直接用长期 query 续聊；外部
进程持有锁时只读显示历史并提示通过 `claude attach` 继续，或创建独立分支。
不建议为了进入 Deck 而运行 `claude stop`，因为它会结束 Claude 的后台会话。
同一长期 query 的认证环境固定；要换供应商，请创建分支并给分支选新配置。
模型和权限可在空闲时通过 SDK 控制请求调整。Server 进程重启不能恢复
旧进程的 stdio 连接；重启后通过 transcript resume，进行中的后台任务是否
接续取决于 Claude Code 自身机制。turn 失败消息附带 stderr 尾部和登录目录。

## OpenCode Adapter

`OpenCodeAdapter` 通过本机 `opencode serve` 的 HTTP API 管理会话。
OpenCode 当前声明 `approvals`、`archive`、`delete`、`images`、`interrupt`、
`models` 和 `sessionSettings`。其中 `archive` 是 Deck 侧软归档（OpenCode
serve 没有原生归档接口）：归档态写进 `thread-settings.json` 的 `archived`
标记并在重启后保留，`snapshot()` 按该标记拆分现有库和归档箱，服务端会话
原样保留；运行中的会话不能归档，归档会话的发送/中断在服务端同样拒绝，
不能只靠前端隐藏按钮。P0 命令透传（`listSessionCommands` /
`runSessionCommand` 走 `GET /command` 与 `POST /session/:id/command`，
`compactSession` 走 `POST /session/:id/summarize`）复用 `sessionSettings`
门禁，不新增 capability 字段。撤回（`revertSession` /
`unrevertSession` 走 `POST /session/:id/revert|unrevert`，无参时以后端
最后一条 user 消息为边界）是破坏性操作，同样只在 opencode 会话开放，
前端的「撤回」强制二次确认并用服务端 `revert.summary` 核验展示。
Codex 的「编辑」另走 App Server 原生 `thread/revert { beforeTurnId }`，
只回退对话历史，不恢复工作区文件；Claude/ACP 无等价原会话回退接口，
不显示「编辑」。Skills 走
`GET /skill`（按会话目录带 `directory` 参数），skill 同时被 OpenCode 的
`Command.list()` 并入可调命令，面板选中后插入 `/name` 走既有命令透传调用。
`GET /command` 也带会话目录，以读取项目自定义命令。OpenCode 1.18 的
`GET /config` 将默认模型表示为 `provider/model` 字符串；旧对象格式仍兼容。
模型目录也按所选工作目录请求 `GET /provider` 和 `GET /config`，以包含
项目级 provider、模型变体和默认模型。
`POST /session/:id/command` 会等整轮执行结束才返回，Deck 提交后立即
返回运行态，后台等待结果，避免把超过 60 秒的正常任务误判为超时。
权限由 OpenCode 自己按配置决定；新版的 `permission.asked` 与
`permission.replied` 对应 `POST /permission/:requestID/reply`，旧版
`permission.updated` 与 `/session/:id/permissions/:permissionID` 保留兼容。
事件流断开会重连，并从 `GET /permission` 与 `GET /question` 补回漏掉的
待审批请求；回复失败时保留卡片供重试。运行状态
同时处理 `session.status` 的 `busy`、`retry`、`idle` 和独立的
`session.idle`；文本增量来自 `message.part.delta`。
没有实现的 review、shell 和 MCP 枚举保持关闭。

## 通用 ACP Adapter

[Agent Client Protocol](https://agentclientprotocol.com) 是 CLI agent 的
标准 JSON-RPC over stdio 协议（`initialize`、`session/*`）。
`AcpAdapter` 是它的通用 client 实现：任何支持 ACP 的 CLI 只需要一份
descriptor，不需要再写专有 adapter。

### Descriptor 格式

内置表在 `server/agents/acp-agents.ts` 的 `BUILTIN_ACP_AGENTS`（devin、
kimi、goose、copilot、droid 等）。用户可在 `DATA_DIR/acp-agents.json`
里覆盖同 id 字段或注册新 agent（格式与 `AcpAgentSpec` 相同，
`acp-agents.example.json` 是自动生成的样例）：

```jsonc
{
  "agents": [
    {
      "id": "my-agent", // ^[a-z0-9][a-z0-9_-]*$，不得占用内置 id
      "name": "My Agent", // UI 显示名
      "command": "my-agent", // 可执行文件（Windows .cmd shim 自动包装）
      "args": ["acp"],
      "env": { "MY_KEY": "…" }, // 附加子进程环境，不进快照/事件
      "listSessions": {
        // 可选：无 session/list 能力时的历史列举命令
        "args": ["list", "--format", "json"],
        "perDirectory": true, // 每个已知项目目录各执行一次（devin list）
      },
      "models": [{ "id": "sonnet", "name": "Sonnet" }], // 可选静态模型目录
      "fallbackFor": "claude", // 可选：声明为某个主 agent 的备选，见下文
    },
  ],
}
```

接入 Claude Code 的官方 ACP 实现（`@zed-industries/claude-code-acp`，
内部即 claude-agent-sdk，凭据沿用 `~/.claude` 与环境变量）。它与原生
`claude` adapter 读写同一份 `~/.claude/projects/*.jsonl`，应声明为原生的备选：

```jsonc
{
  "agents": [
    {
      "id": "claude-acp",
      "name": "Claude (ACP)",
      "command": "claude-code-acp",
      "fallbackFor": "claude",
    },
  ],
}
```

### 备选 Agent（`fallbackFor`）

`claude-code-acp` 的 `session/list` 会扫描 `~/.claude/projects` 下全部会话，
和原生 Claude adapter 读的是同一批文件：每条原生会话都会在 ACP 侧再出现
一次「历史」重复项，另有没有任何对话内容的空壳会话（JSONL 只有元数据：原生
adapter 会跳过，`session/list` 却会列出）。此外，搜索索引会对每条需要索引的
重复项调用 `readThread`，等于让 `claude-code-acp` 对它们逐个 `session/load` 回放。

声明 `fallbackFor` 后，`AgentRegistry` 在合并快照时按主 agent 的状态处理，
描述符里 `fallbackFor` 原样透传，待命时再由 registry 加上 `standby: true`：

- 主 agent 可用（在线或正在启动，且历史读取没有失败）时，备选 agent **待命**：
  它未接管的会话（非 `managed` 且状态为 `idle`，含归档库）不进入快照，
  因此列表、平铺、搜索和索引都看不到，也不会被索引器触发 `session/load`。
- 备选 agent 已接管的会话（`managed` 或有活动）始终可见；此时主 agent 里同 id
  的未接管副本让位，避免同一会话出现两次。两边都被接管则都保留，宁可重复
  也不隐藏活动会话。
- 主 agent 不可用（离线、启动失败、历史读取失败）时不隐藏任何会话，备选
  agent 完整顶上：这就是「备选」。
- 备选 agent 仍在「新建会话」的 ACP 标签页里，名称带「（备选）」；设置页
  ACP 标签会标出它是谁的备选。
- 隐藏作用于快照，以及待命备选 agent 自己发出的 `thread.updated` 增量事件
  （否则空闲会话会经增量重新冒出来）；让位的主 agent 副本只在快照里过滤，
  下一次快照即纠正。按 id 直接调用 API 仍可访问。客户端看到 `standby: true`
  时不再为该 agent 保留本地缓存的旧会话（`src/cache.ts` 的
  `retainPendingAgentThreads`）。

`fallbackFor` 只应指向与本 agent 共用会话存储的主 agent；指向不存在的 agent、
自己或非字符串值会被忽略，不会隐藏任何会话。不想要备选行为时删掉该字段即可；
想彻底停用这个 agent（不启动、不出现在选择器里），在同一条配置里写
`"enabled": false`。

### 协议映射

| ACP                                                | Deck                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize`                                       | 能力探测（`loadSession`、image、`sessionCapabilities`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `session/new`（cwd）                               | `createThread`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `session/prompt`                                   | `sendTurn`，异步长跑请求                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `session/cancel`                                   | `interrupt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `session/request_permission`                       | `approval.requested`。前端逐档渲染 `params.options` 并回传 `{optionId}` 原样选中（devin 一次给 `allow_once`/`allow_session`/`allow_always`/`allow_always_global`/`switch_bypass`/`reject_once` 等多档）；旧 decision 语义保留：allow_once→`accept`、allow_always→`acceptForSession`（优先挑 optionId/name 含 session 的选项）、reject→`decline`、无选项/`cancel`→`cancelled`。toolCall 可能只是 `{toolCallId,_meta}` 快照（devin 在 `_meta["cognition.ai/editableCommand"]` 放命令文本），kind/title/rawInput 按 toolCallId 从已归一化的 `session/update` 补齐 |
| `session/update`                                   | `agent.event`：`agent_message_chunk`→`item/agentMessage/delta`、`agent_thought_chunk`→reasoning item、`tool_call`/`tool_call_update`→commandExecution/fileChange/dynamicToolCall（`__raw` 保留原始 toolCall）、`plan`→`extension{kind:"todo"}`、`current_mode_update`→`thread.sessionMode`、`available_commands_update`→`listSessionCommands`、`session_info_update`→会话标题、`usage_update`→`tokenUsage`                                                                                                                                                     |
| `session/set_mode`                                 | `updateThreadSettings{sessionMode}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `session/set_config_option`                        | 模型切换（`category:"model"` 的 select 选项）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `session/set_model`（unstable）                    | 模型切换（agent 在 `session/*` 响应里返回 `models` 目录时走这条路）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `session/fork`（unstable）                         | `forkThread`，有能力时才声明 `fork`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `session/list` / `session/load` / `session/resume` | 历史列举与回放；不存在时降级到 `listSessions` 命令或仅保留缓存摘要                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `session/delete`                                   | `deleteThread`（有能力时才声明 `delete`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

`session/load` 的回放走同一套 `session/update` 归一化，但只累积
`turns[]` 不发流式事件；`user_message_chunk` 开启新 turn。

会话锁：`session/list` 项 `_meta` 里以 `*/isLocked` 结尾的布尔标记
（devin 用 `cognition.ai/isLocked`），以及 `session/load`、`resume`、
`delete`、`prompt` 返回的 `errorKind:"session_locked"` 错误，统一映射为
`ThreadSummary.locked`。锁只是提示不硬拦：列表和会话内显示「占用中」，
发送仍放行以便过期标记自愈，失败时翻成中文提示；本进程成功
load/resume 或下次列举未锁定时自动清除。

### 能力规则

ACP 能力从 `initialize` 响应动态声明：approval/interrupt 恒开；
`images` 看 `promptCapabilities.image`；`delete`/`fork` 看
`sessionCapabilities.delete`/`fork`；`models` 看 session 响应里的
`models` 目录、model configOption 或静态 `models[]`；`archive` 是
Deck 侧软归档。review/shell/mcp/skills 恒为 `false`。`fs/*` 与
`terminal/*` 反向请求未声明能力，一律回 JSON-RPC `-32601`。

### 进程生命周期

`AcpClient` 与 `CodexClient` 同一套模式：Windows 下 `*.cmd` shim 经
`cmd.exe /d /s /c` 包装、PATH 里找到 `.exe` 时直接 spawn；stderr 收成
最近 8KB 附加到错误；进程退出把所有 pending request 判失败并把运行中
会话标 `error`；`stop()` 先回 `cancelled` 再 `stopChildProcess` 杀整棵
进程树。

### 测试

`server/agents/acp-adapter.test.ts` 用 PassThrough stdin/stdout 桩进程
覆盖 initialize、session/new、流式 chunk、tool_call、permission 往返、
cancel、load 回放、resume、无历史能力降级、畸形行和进程退出。新增
descriptor 时若改变了启动参数形态，需同步补 `acpLaunchSpec` 测试。

## Agent 启停与重载

Agent 的启用状态在 `AgentRegistry` 层管理（`server/agents/registry.ts`），
不重启 Deck 主服务。描述符字段：`enabled`（`!== false` 即启用）、
`toggleable`（Codex 为 `false`，供应商/Runtime 挂在它上面，不能停用）、
`disabledReason`（`"user"` 在设置里停用 / `"default"` 默认策略不加载）、
`defaultNote`（默认不加载的原因，如「未检测到 kimi 命令」）。

默认加载策略（`loadAcpAgentEntries`）：用户在 acp-agents.json 显式声明的
agent 默认启用；内置 agent 没有显式声明时按 `commandExists` 探测 PATH，
找不到命令就默认不加载——监控台里显示「未启用」而不是一排「启动失败」。
配置里 `enabled: false` 恒为默认不加载。设置里的显式选择持久化在
`{dataDir}/agent-settings.json`；与默认一致的显式选择会被清掉，使默认策略
（比如命令后来装上了）继续生效。

HTTP 接口：

| 路由                          | 语义                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /api/agents/:id/enabled` | 启用/停用，body `{enabled, force?}`；有会话在运行或待审批时返回 `applied:false + busyCount`，带 `force` 才中断                           |
| `POST /api/agents/:id/reload` | 重启该 agent 的后端进程并重读配置与会话，body `{force?}` 同上有 busy 保护                                                                |
| `POST /api/agents/reload`     | 先由 `AcpAgentHost.sync` 按 acp-agents.json 增删改 ACP agent（变更的描述符整体替换、被删的注销、忙于会话的跳过），再重载全部已启用 agent |

停用的 agent 不启动、不产生快照条目（threads/approvals/profiles/tasks），
事件也被 registry 拦截；它的历史会话仍留在 `agents.cacheSnapshot()` 的磁盘
缓存里，重新启用即恢复。同一 agent 的启停/重载经串行锁执行，连点不会造成
stop/start 交叠（`AcpAdapter.restart` 会等待旧进程真正退出后再启动新进程）。
Claude 的 `reload()` 是软重载：刷新 profiles/历史而不断开已有会话连接。

## 新增 Adapter 的顺序

0. **先检查目标 CLI 是否支持 ACP**。支持时只需在
   `BUILTIN_ACP_AGENTS` 或 `DATA_DIR/acp-agents.json` 加 descriptor，
   不需要实现 `AgentAdapter`。需要 CLI 私有协议时再走下面的完整流程。
1. 扩展 `AgentId`，定义保守的 capability matrix。
2. 新建独立 adapter 文件，不修改 Codex adapter 来兼容新协议。
3. 为进程启动、历史解析、事件归一化和审批回包添加 fixture 测试。
4. 注册到 `AgentRegistry`，确认单个 adapter 启动失败不会破坏其它 adapter。
5. 增加通用 session API，再让前端按 `agentId` 路由。
6. 桌面和移动端都验证新建、发送、流式输出、审批、取消和恢复。
7. 更新 README 的安装、配置、能力差异和迁移说明。

## 前端适配器（消息展示侧）

服务端 adapter 把 native 数据归一化为 Codex 形状的 `turns[].items[]` 与
`agent.event` 流；没有通用形状可表达的原生条目用 `extension` 条目透传：

```ts
{ id, type: "extension", kind: string, agentId?, status?, payload? }
```

- 服务端：历史归一化时不要丢弃原生数据（OpenCode 的 todo/choice part、
  Claude 的 `TodoWrite` 等），能转成 `extension` 就保留原始 payload。
- 前端：`src/session/adapters/` 按 `agentId` 提供 `AgentUiAdapter`，
  `TurnItem` 渲染前先问适配器，未认领的条目回落到通用渲染与
  `UnknownItem` 兜底；`streaming.ts` 负责把 OpenCode 的
  `item/updated` 原生 part 快照转成共享 item 形状。没有注册过
  `agentId` 的条目走 `acp.tsx` 兜底（渲染 ACP 的 `kind:"todo"`
  计划面板），再往下才是 `UnknownItem`。
- 纯转换逻辑放 `adapters/native-parts.ts`，供 streaming 与各适配器共用。

## 测试

Codex adapter 的核心回归测试：

```bash
node --import tsx --test \
  server/manager.test.ts \
  server/agent-registry.test.ts \
  server/codex-client.test.ts
```

提交前仍必须执行完整检查：

```bash
npm test
npm run build
```

adapter 改动至少覆盖：启动失败、并发启动、历史列表失败、创建/续聊、流式事件、
审批、取消、归档/删除、进程退出、密钥不出现在公开数据中，以及适用平台的路径处理。
