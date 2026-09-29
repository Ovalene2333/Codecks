# Slash 指令支持路线图

本文记录 Codex Deck 的 Slash 指令优先级、当前行为和后续兼容策略，便于开发与使用时查阅。指令清单以本机 `codex-cli 0.147.0` 的 TUI 和 app-server 协议为基线；Codex 的 app-server 仍是实验接口，Deck 会按 Runtime 实际能力调用，不支持的 RPC 会给出明确提示。

## 已支持（Codex）

| 指令                                | Deck 行为                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `/model`                            | 打开模型与推理强度选择器；模型只从选择器应用，避免误把提示词当模型名                   |
| `/permissions [sandbox] [approval]` | 无参数时打开权限选择；审批模式支持 `untrusted`、`on-request`、`auto-review` 和 `never` |
| `/skills [query]`                   | 读取当前目录可用 Skill，搜索后将 `$skill-name` 插入输入框                              |
| `/status`                           | 显示模型、推理强度、状态、权限、Fast、上下文、供应商、目录及线程 ID                    |
| `/ps`                               | 打开任务中心并筛选当前 Session；支持停止 Turn，Runtime 支持时可单独停止后台终端        |
| `/usage`                            | 打开 Official 账号额度面板                                                             |
| `/mention [query]`                  | 通过 Runtime 搜索当前工作区文件，将 `@path` 插入输入框                                 |
| `/fast [on\|off]`                   | 开关当前会话的 Fast service tier；省略参数时切换当前状态                               |
| `/mcp [verbose]`                    | 查看 MCP 服务器、认证状态及工具；详细模式同时列出资源和模板                            |
| `/compact`                          | 压缩当前会话上下文                                                                     |
| `/review [target]`                  | 审查未提交改动、基准分支、提交或自定义目标                                             |
| `/init`                             | 生成或更新 `AGENTS.md`                                                                 |
| `/diff`                             | 查看 Git 工作区改动                                                                    |
| `/plan`                             | 切换为只规划任务                                                                       |
| `/goal <目标>`                      | 设置会话目标；`/goal clear` 清除目标                                                   |
| `!command`                          | 按 Codex CLI 行为在无沙箱模式执行终端命令                                              |

## 已支持（OpenCode，P0）

OpenCode 会话的 `parse/matching` 按 `agentId` 分流，不复用 Codex 指令表：

| 指令                                     | Deck 行为                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `/compact`（别名 `/summarize`）          | `POST /api/agents/opencode/threads/:id/compact` → `POST /session/:id/summarize`，模型按会话模型/已解析模型/OpenCode 默认的顺序解析；运行中拒绝并提示 |
| `/init [args]` 及其他自定义命令          | `POST /api/agents/opencode/threads/:id/commands` → `POST /session/:id/command { command, arguments }`，携带会话当前模型/variant；未知命令由服务端校验报错 |
| `/models`（别名 `/model`）               | 打开现有模型选择器（`PATCH` 会话设置，逻辑与 Codex 共用）                  |
| `/skills [query]`                        | `GET /api/agents/opencode/threads/:id/skills` → `GET /skill`（按会话目录），选中后将 `/name ` 插入输入框，发送时走既有命令透传调用 |
| `/new`（别名 `/clear`）、`/sessions`（别名 `/resume`、`/continue`） | Deck 侧指引：新建去左上角，切换点左侧列表，不另调服务端 |
| `/details`、`/thinking`                  | Deck 等价说明：工具细节/思考过程本就折叠在时间线里，点击展开即可           |
| `/status`、`/ps`、`/usage`、`/help`      | 状态只显示模型/状态/上下文/供应商/目录/Thread（不显示沙箱/Fast/性格）；`ps/usage` 走现有面板；`help` 列出可用命令 |
| 命令补全                                 | 内置表 + `GET /api/agents/opencode/threads/:id/commands`（即 `GET /command`，含 `.opencode/commands/*.md` 自定义命令）合并去重后提示 |

### 撤回（`/undo`、`/redo`，破坏性，需确认）

OpenCode 的 revert 是 staging 式撤回（`POST /session/:id/revert` 只落边界、消息清理在后续提交点），因此 Deck 侧强制二次确认。只想换个说法重试、又不想丢历史时，请改用非破坏性的分支（`POST /session/:id/fork`，见下节），撤回确认框里也会提示这一点：

| 入口 | Deck 行为 |
| ---- | --------- |
| `/undo` | 以后端消息列表最后一条 user 消息为边界撤回最近一轮；先弹确认框（目标预览 + 非 git 仓库仅回滚对话的警告），执行后用服务端 `revert.summary{files,additions,deletions}` 核验并展示结果，提示可用 `/redo` 恢复 |
| `/redo` | 同样先确认，再调 `POST /session/:id/unrevert` 恢复内容与文件 |
| 时间线每条 user 消息旁「撤回」 | opencode 专属（补上 `fork:false` 导致缺失的按条操作位），以该 `turn.id` 为边界走同一确认链路 |

门禁：运行中/待审批/已归档一律拒绝（服务端忙时同样拒绝，不只靠前端隐藏）。执行后重读历史并刷新快照；`files=0` 时明确提示"仅回滚了对话"。

## 已支持（Claude Code）

| 指令              | Deck 行为                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `/skills [query]` | `GET /api/agents/claude/threads/:id/skills`：活跃连接走 SDK `reload_skills` 控制请求取权威列表，未连接时扫 `<cwd>/.claude/skills` 与 `<claudeHome>/skills` 的 SKILL.md；选中后将 `/name ` 插入输入框，作为普通 prompt 交给 Claude Code 展开 |
| `/status`、`/ps`、`/usage` | 状态面板与现有面板复用                                                                    |
| `/model`、`/permissions` | 模型/权限选择器（`sessionSettings` 门禁）                                              |

## 已支持（ACP 通用 agent）

ACP 没有统一的命令执行接口：斜杠命令就是普通 prompt 文本，由 agent 自己解析。Deck 的行为：

| 行为 | 实现 |
| ---- | ---- |
| `/cmd args` 透传 | `POST /api/agents/:id/threads/:tid/commands` → `session/prompt` 发送 `/cmd args` 原文，turn 正常流式渲染 |
| 命令补全 | `GET /commands` 返回 agent 经 `available_commands_update` 自报的列表（name/description）；之后该通知增量到达时通过 `agent.event` 的 `session/commands` 推给前端刷新，无需重新进会话 |
| 回放会话 | `session/load` 回放期间的 `available_commands_update`/`current_mode_update`/`config_option_update`/`session_info_update`/`usage_update` 同样生效，不被 turn 归一化吞掉 |
| 兜底 | agent 在 `session/new`/`resume`/`load` 响应里顺带返回的 `commands.availableCommands`（或顶层 `availableCommands`）也会接收 |

### 分支与编辑

「编辑」在当前会话回退到所选消息，原文回填输入框。OpenCode 使用原生
`session/revert`，Codex 使用原生 `thread/revert`；后者只回退对话历史，不
恢复工作区文件。Claude 与 ACP 缺少可靠的原会话回退接口，不显示「编辑」。

| 入口 | Deck 行为 |
| ---- | --------- |
| 每轮下「从此处分支」 | Deck 传入所选 `lastTurnId`，适配器找下一条 user 消息作为 OpenCode fork 的排除边界；新分支保留所选轮次及其回复，原分支保留 |
| 消息旁「编辑」 | 与 OpenCode TUI 双击 Esc 一致：在原会话 `revert` 所选 user 消息及之后的内容，把该消息原文放回输入框；编辑后发送仍在原会话继续。撤回可用 `/redo` 恢复（再次发送前） |

分支使用 OpenCode 官方 fork 接口，原会话保留；编辑调用原生 revert，作用于当前会话。fork 子会话带 `parentID`，Deck 按 `fork` 字段与 fork 记录识别为可见分支，subagent 子会话仍隐藏并挂回父会话的任务卡片。旧版 OpenCode（无 `/session/:id/fork`，返回 404）会给出升级提示。

尚未接入（仍请用原生 TUI）：`/share`、`/unshare`、`/export`、`!cmd`、`/connect`、`/editor`、`/themes`、`/exit`。

## 建议下一批

这些指令使用频率高，且能自然映射到网页会话管理：

1. `/new`、`/resume`、`/fork`：创建、恢复和分支会话。
2. `/rename`：修改当前会话名称。
3. `/copy`：复制最近一条助手回复。
4. `/plugins`：查看插件并进入安装或连接流程。
5. `/approve`：集中处理待审批请求。
6. `/archive`、`/delete`：归档或删除当前会话，需二次确认。

## 可后续评估

- 编辑体验：`/keymap`、`/vim`、`/ide`。
- 高级能力：`/experimental`、`/memories`、`/agent`、`/side`、`/raw`、`/hooks`、`/import`。
- 外观：`/title`、`/statusline`、`/theme`、`/pets`。
- 账号与应用生命周期：`/logout`、`/exit`、`/feedback`。

部分 TUI 指令依赖本地终端、剪贴板或全屏布局，在网页端不会机械照搬，而会采用等价的浏览器交互。新增协议调用必须做能力检测或错误降级，不能假设所有用户都运行同一 Codex CLI 版本。
