# Agent Adapter 开发约定

Deck 的运行时层以 Agent 为边界。Codex、Claude Code、OpenCode 等 CLI
必须各自实现 adapter；Deck 不把不同 CLI 的私有协议混进同一个 manager。

Codex adapter 已完整接入网页兼容入口。Claude Code adapter 已接入生产后端、
通用 Agent API 和网页核心会话流程；OpenCode 尚未实现。

## 目录与职责

| 文件                              | 职责                                            |
| --------------------------------- | ----------------------------------------------- |
| `server/agents/types.ts`          | 通用 adapter、能力和快照类型                    |
| `server/agents/registry.ts`       | adapter 注册、生命周期、事件转发和快照合并      |
| `server/agents/codex-adapter.ts`  | Codex app-server 协议、会话、审批和供应商隔离   |
| `server/agents/claude-adapter.ts` | Claude Agent SDK 会话、流式事件、审批和生命周期 |
| `server/agents/claude-history.ts` | Claude JSONL 消息树主链与通用 Turn 归一化       |
| `server/manager.ts`               | 旧导入路径的兼容导出，不应再加入实现            |
| `server/codex-client.ts`          | Codex app-server 子进程与 JSON-RPC 传输         |
| `server/index.ts`                 | HTTP/WebSocket 边界和 adapter 组装              |

依赖方向必须保持为：

```text
server/index.ts
  -> AgentRegistry
    -> AgentAdapter
      -> CodexAdapter -> CodexClient
      -> ClaudeAdapter -> Claude Agent SDK
```

`AgentRegistry` 不应导入任何 Codex、Claude 或 OpenCode 私有类型。

## AgentAdapter 契约

每个 adapter 必须实现 `server/agents/types.ts` 中的 `AgentAdapter`：

- `id`：稳定的 Agent 标识，写入会话和事件。
- `descriptor()`：返回可用性、在线状态和 capability matrix。
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
`/api/agents/:agentId/...` 路由，旧 Codex 路由继续兼容。

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

`ClaudeAdapter` 通过官方 `@anthropic-ai/claude-agent-sdk` 为每个活动 turn 启动
独立查询进程，优先复用 `PATH` / `CLAUDE_BIN` 指向的系统 Claude Code，并使用
原生 session ID 创建或 resume 会话。adapter 负责：

- 扫描 `CLAUDE_CONFIG_DIR`、当前用户 `~/.claude`，以及 WSL 可见的 Windows
  用户 Claude 目录。
- 按 `last-prompt.leafUuid` 和 `parentUuid` 回溯 JSONL 当前主链，避免把重试分支
  重复合并进同一 timeline。
- 将 assistant 文本、思考、tool use 和 tool result 归一化为通用 Turn item。
- 将 SDK partial message 映射为带 `agentId='claude'` 的 `agent.event`。
- 用 `canUseTool` 暂停工具执行，将批准一次、会话内批准和拒绝回送 SDK。
- 只读加载 CC Switch `app_type='claude'` 配置；认证环境变量只传给查询进程。

Claude 当前声明 `approvals`、`images` 和 `interrupt`。没有实现的 fork、archive、
review、shell、MCP/Skills 枚举、模型枚举和动态会话设置保持关闭。网页接线时必须按
该 capability matrix 隐藏并禁用对应操作。

## 新增 Adapter 的顺序

1. 扩展 `AgentId`，定义保守的 capability matrix。
2. 新建独立 adapter 文件，不修改 Codex adapter 来兼容新协议。
3. 为进程启动、历史解析、事件归一化和审批回包添加 fixture 测试。
4. 注册到 `AgentRegistry`，确认单个 adapter 启动失败不会破坏其它 adapter。
5. 增加通用 session API，再让前端按 `agentId` 路由。
6. 桌面和移动端都验证新建、发送、流式输出、审批、取消和恢复。
7. 更新 README 的安装、配置、能力差异和迁移说明。

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
