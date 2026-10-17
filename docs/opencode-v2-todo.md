# OpenCode V2 迁移 TODO（2026-10-07 调研结论）

> 来源：OpenCode V2 文档（opencode.ai/v2/docs/migrate-v1、/v2/docs/api）与本地 runtime 核对。
> 图例：`[x]` 已落地　`[ ]` 待做。
>
> **当前状态（2026-10-17 更新）**：服务端 API 迁移已落地为独立 adapter
> `server/agents/opencode-v2-adapter.ts`，由统一的 `opencode` 运行时入口按 CLI 版本选择。
> Agent 设置仅保留一个 OpenCode；「运行时」探测并列出 V1/V2 CLI，按所选 CLI 的 1.x/2.x 版本自动匹配协议，统一向前端输出会话、消息、工具事件与审批，不再手动选择协议或注册独立 V2 Agent。
> 以下待办中「已验证」指在 V2 `0.0.0-dev-202610161232` 隔离实例上实测通过；
> 「实现保留」指已按协议实现、遇到未接线构建时抛中文友好错误，能力保持关闭。
>
> 此前状态：本机 `opencode` = 1.18.34，npm `latest` = 1.18.35，V1 stable 基本最新。
> V2 只以 `0.0.0-*` 预发布挂在 npm `dev`/`beta`/`next` tag 下，未进 stable；
> 且 V1/V2 共用 `opencode` 命令、安装 V2 会替换 V1 二进制。**升级前先完成本文件的服务端 API 迁移。**

## 2.0.32 真实实例回归（2026-10-17）

使用真实 V2 二进制、本地可控模型服务、临时 Deck/XDG 配置与数据目录进行验证，没有复制用户配置、凭据或会话。

| 流程 | 验证结果 |
| --- | --- |
| 发送 / 流式正文 / 工具步骤 | 顶层 `text`；`assistantMessageID` + ordinal 映射到稳定 part；工具各阶段合并，整轮 execution 完成才转空闲 |
| 桌面与手机浏览器 | Chromium 1440×1000、390×844；直达链接、实时输出、停止、继续、刷新历史、历史分支重试跳转通过；正式构建使用本地测试模型首次可见正文约 464ms / 462ms |
| 工具审批 / 问答 | 真实 shell 命令申请允许；手机选择表单选项并提交后继续回复；表单按字段 key 回传 `answer` |
| 会话操作 | 创建、改名、模型切换、归档/恢复、删除、分支、从历史重试、撤回通过 |
| 命令 / 压缩 / 图片 | 无参数自定义命令、压缩接口、PNG 附件发送通过；图片历史还原有回归测试 |
| 长历史 | 72 轮、216 条原生消息跨 200 条边界；全文、最新 5 轮、前 5 轮无丢失或重复；实测全文读取约 42ms |
| 消息投递 | 磁盘队列等待空闲；停止后队列自动继续；即时反馈先停止当前轮再发送通过 |
| 目录与默认模型 | 项目目录通过 `location[directory]` 传递；模型目录不污染其他项目；恢复默认模型时同步原生选择 |

修复了旧适配事件信封缺少 `type`、流式字段不匹配、工具步骤误结束整轮、审批缺少会话关联、表单答案格式错误、分页游标方向错误、图片历史遗漏以及首次加载快照竞态导致会话直达链接失效。

真实云模型连通检查：直接读取用户原生配置、历史另写临时目录，不复制配置和凭据。默认免费模型返回“已弃用”，尝试的三个已配置通道均返回 `Invalid token`；失败被正确转成会话错误。因上游配置不可用，真实云模型成功回复尚未验收。

验证边界：本地模型用于确定性复现协议与交互，未验证真实云模型的质量、额度、网络抖动；未进行 Windows、Safari 或手机实体键盘测试。下方“未接线”清单保留的是早期 dev 构建记录，不代表 2.0.32 的接口现状。配置原生形态迁移仍按下方待办跟进。

## 配置文件层（小改，V1 语法仍被 V2 归一化接受）

`server/opencode-config.ts` 读写 `~/.config/opencode/opencode.json(c)` 与 `<project>/opencode.json(c)`。
V2 读取同样的位置，V1 字段在内存中归一化、不重写源文件，所以现有写入大多仍有效：

- `model` 不变；`small_model` 无警告归一化为 `agents.title.model`。
- `agent.<name>.{model,prompt,temperature,disable}` 作为 V1 语法仍受支持
  （V2 原生形态为 `agents.<name>.{system,model#variant,request.body.temperature,disabled}`）。

待办：

- [ ] `readOpenCodeConfig` 补读 `<project>/.opencode/opencode.json(c)`
      （V2 也读这里，且优先级高于项目根 `opencode.json`）。
- [ ] 读写识别 V2 原生形态：同一 canonical 值上「有效 V2 值优先于 V1 值」，
      若文件已有 `agents:`/`disabled`/`system`，我们继续写 `agent.*` 会被静默覆盖；
      前端 `OpenCodeAgentsSection` 读 `config.agent` 也读不到 `agents` 的内容。
      建议按文件当前所用格式下笔，或统一写 V2 形态。
- [ ] `PATCH /config`（在线热更新）：V2 对应 `PATCH /api/config` 且只管 global 配置，
      项目级运行时 patch 的行为需要在 V2 上重新确认。

## Server API（大头，V2 三大 breaking change 之一）

`server/agents/opencode-adapter.ts` 走的是 V1 REST 路由，V2 全部改为 `/api/*` 新契约，
官方要求迁移到 `@opencode/client`；还带 pairing code / session token 鉴权（401 响应）。

现用 V1 路由清单（迁移时逐个对到 V2）：

- 会话：`GET/POST /session`、`/session/:id`、`prompt_async`、`abort`、`fork`、
  `revert`、`unrevert`、`summarize`、`command`、`message`、`/session/status`
- 审批：`/permission/:id/reply`、`/question/:id/reply|reject`
- 事件流：`/global/event`（SSE）、`/global/health`
- 目录：`/provider`、`/agent`、`/command`、`/skill`
- 配置：`GET /config`、`PATCH /config`

待办：

- [x] endpoint 映射到 `/api/*`（已落地：session 列表/详情/创建/prompt、
  message 分页、interrupt、switchAgent/switchModel、permission 列表与回复、
  provider/agent/command/skill/model 枚举、event SSE；`{data}` 信封解包）。
- [x] 鉴权：正式版 `2.0.32` 的 loopback 也要求密码。Deck 启动自己的
      serve 时通过环境变量传入本轮随机密码（或继承显式密码），REST 与 SSE
      均使用 Basic 鉴权；不读取服务注册信息、不输出密码、不改用户配置。
- [x] 消息/事件 payload 归一化重写：`record.info/parts` → V2 平铺消息
  （`{id, time, type, text?, content?[]}`，assistant 正文在 `content[]` 的
  text/reasoning/tool 条目里）、`session.status`/`session.idle` 状态机、
  `permission.asked/replied`（decision once/always/reject）、`form.created`
  问答审批、step/text/reasoning/tool/usage/compaction 事件映射；
  同时兼容 dev 构建的 `session.next.*` 前缀。
- [x] `normalizeSessions/normalizeProfiles/modelSupportsImages` 等兼容层按 V2 schema 调整。
      模型 `providerID/modelID` 字符串与 V1 同形，前端 `opencodeProviderId`
      与模型目录选择器直接复用；图片能力走模型 `capabilities.input`；
      V2 模型无 variant/effort 档位，推理强度能力不声明、误传直接拒绝。
- [x] `docs/agent-adapters.md`、`docs/message-transport.md`、`docs/slash-commands.md`
      中 OpenCode 相关小节同步更新。（本轮更新 agent-adapters；
      message-transport/slash-commands 待 V2 命令执行接线后补。）

## 该构建尚未接线的路由（已按协议实现，遇到即抛中文友好错误，随接线自动可用）

- `DELETE /api/session/:id`（删除，含并发去重与本地清理）、
  `POST /:id/fork {before?}`（分支，含 lastTurnId→下一条 user 边界映射、
  去重、落盘持久化与回滚、1.5s 辅助改名）、`PATCH /:id {title}`
  （重命名走 Deck 侧标题先行）、`POST /:id/command {name, text?}`
  （命令执行，与发送共用受理锁）、`POST /:id/compact`（服务端回 503）、
  revert 暂存/提交/清除（`unrevert` 语义为清除已暂存，
  V2 没有已 commit 撤回的恢复接口）、prompt 文件附件、
  `GET /api/config` 与 `PATCH /api/experimental/config`（配置读写）、
  `POST /api/pair`（配对）、form 回复、mcp/stats/`/experimental/*`。
  adapter 遇到 SPA HTML 回退或 404/503 会抛中文友好错误，不吞成空成功。
- 有意与 V1 不同的三处：send 繁忙时排队而非顶掉旧轮；allowForProject
  退化为会话级允许（配置接口未接线）；模型无推理强度档位（effort 直接拒绝）。
- 前端 opencode 特例已对齐 `opencode-v2`（选择器分组、短名、能力兜底、
  provider 解析、模型目录、新建会话、斜杠命令、工具栏、会话头、搜索、
  亲和度）；设置页的 V1 配置编辑/供应商管理/服务行不复制——对应服务端
  接口（config、connected、bins 切换）尚未接线或仍是 V1 专有，
  V2 二进制与 V1 共用运行时版本选择；`OPENCODE_V2_BIN` 仅作旧配置的兼容回退。
