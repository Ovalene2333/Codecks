# OpenCode V2 迁移 TODO（2026-10-07 调研结论）

> 来源：OpenCode V2 文档（opencode.ai/v2/docs/migrate-v1、/v2/docs/api）与本地 runtime 核对。
> 图例：`[x]` 已落地　`[ ]` 待做。
>
> **当前状态**：本机 `opencode` = 1.18.34，npm `latest` = 1.18.35，V1 stable 基本最新。
> V2 只以 `0.0.0-*` 预发布挂在 npm `dev`/`beta`/`next` tag 下，未进 stable；
> 且 V1/V2 共用 `opencode` 命令、安装 V2 会替换 V1 二进制。**升级前先完成本文件的服务端 API 迁移。**

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

- [ ] endpoint 映射到 `/api/*`（V2 已有 session fork/interrupt/compact/inbox、
      permission reply、event subscribe、agent/command/skill/provider/model 列表等）。
- [ ] 鉴权：V2 server 支持 pairing 与 session token，本机 loopback 场景确认是否需要。
- [ ] 消息/事件 payload 归一化重写：`record.info/parts`、`session.status`、
      `question.asked`、permission 事件等在 V2 的形状要重新核对。
- [ ] `normalizeSessions/normalizeProfiles/modelSupportsImages` 等兼容层按 V2 schema 调整。
- [ ] `docs/agent-adapters.md`、`docs/message-transport.md`、`docs/slash-commands.md`
      中 OpenCode 相关小节同步更新。
