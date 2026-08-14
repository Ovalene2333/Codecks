# Slash 指令支持路线图

本文记录 Codex Deck 的 Slash 指令优先级、当前行为和后续兼容策略，便于开发与使用时查阅。指令清单以本机 `codex-cli 0.147.0` 的 TUI 和 app-server 协议为基线；Codex 的 app-server 仍是实验接口，Deck 会按 Runtime 实际能力调用，不支持的 RPC 会给出明确提示。

## 已支持

| 指令                                | Deck 行为                                                           |
| ----------------------------------- | ------------------------------------------------------------------- |
| `/model [model] [effort]`           | 无参数时打开模型选择；带参数时直接修改当前会话                      |
| `/permissions [sandbox] [approval]` | 无参数时打开权限选择；支持直接指定沙箱及审批策略                    |
| `/skills [query]`                   | 读取当前目录可用 Skill，搜索后将 `$skill-name` 插入输入框           |
| `/status`                           | 显示模型、推理强度、状态、权限、Fast、上下文、供应商、目录及线程 ID |
| `/usage`                            | 打开 Official 账号额度面板                                          |
| `/mention [query]`                  | 通过 Runtime 搜索当前工作区文件，将 `@path` 插入输入框              |
| `/fast [on\|off]`                   | 开关当前会话的 Fast service tier；省略参数时切换当前状态            |
| `/mcp [verbose]`                    | 查看 MCP 服务器、认证状态及工具；详细模式同时列出资源和模板         |
| `/compact`                          | 压缩当前会话上下文                                                  |
| `/review [target]`                  | 审查未提交改动、基准分支、提交或自定义目标                          |
| `/init`                             | 生成或更新 `AGENTS.md`                                              |
| `/diff`                             | 查看 Git 工作区改动                                                 |
| `/plan`                             | 切换为只规划任务                                                    |
| `/goal <目标>`                      | 设置会话目标；`/goal clear` 清除目标                                |
| `!command`                          | 按 Codex CLI 行为在无沙箱模式执行终端命令                           |

## 建议下一批

这些指令使用频率高，且能自然映射到网页会话管理：

1. `/new`、`/resume`、`/fork`：创建、恢复和分支会话。
2. `/rename`：修改当前会话名称。
3. `/copy`：复制最近一条助手回复。
4. `/ps`：查看正在运行的任务和子进程。
5. `/plugins`：查看插件并进入安装或连接流程。
6. `/approve`：集中处理待审批请求。
7. `/archive`、`/delete`：归档或删除当前会话，需二次确认。

## 可后续评估

- 编辑体验：`/keymap`、`/vim`、`/ide`。
- 高级能力：`/experimental`、`/memories`、`/agent`、`/side`、`/raw`、`/hooks`、`/import`。
- 外观：`/title`、`/statusline`、`/theme`、`/pets`。
- 账号与应用生命周期：`/logout`、`/exit`、`/feedback`。

部分 TUI 指令依赖本地终端、剪贴板或全屏布局，在网页端不会机械照搬，而会采用等价的浏览器交互。新增协议调用必须做能力检测或错误降级，不能假设所有用户都运行同一 Codex CLI 版本。
