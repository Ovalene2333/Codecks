# deck-api 使用说明

`deck-api` 是 Deck 的本地 Agent 通信入口，负责三件事：

- `create`：创建一个独立的 Agent 原生会话，并把它和发起会话绑定。
- `send`：向已知会话主动发送消息，或让子会话向来源回传结论、进度和问题。
- `wake`：监督 SSH / GPU / Slurm 等外部长任务，任务结束后唤醒对应会话。

它不是另一个 Agent 框架，也不负责替 Agent 做计划。Deck 只提供**会话隔离、可靠投递和可观测性**，什么时候委派、什么时候回传由 Agent 决定。

## 两条独立链路：send 与 wake

`send` 和 `wake` 共享底层会话消息队列，但入口、路由和语义彼此隔离：

| | `send` | `wake` |
| --- | --- | --- |
| 目标 | 已知会话 / 询问短别名 | 唤醒代号 |
| 入口 | `create` 的绑定关系、`--to`、`@alias` | `wake watch/poll`、外部 HTTP |
| 持久层 | 会话消息队列 | 唤醒 outbox |
| 消息头 | `[ask:<alias>]`、`[send:<id>]` | `[wake:<code>]` |
| 失败展示 | 会话的待发送列表 | 总览「需要处理」 |
| 典型用途 | Agent 回传、补充上下文 | 长任务结束后继续处理 |

关键区别：

- 新的 `send` 路径（绑定来源、`--to`、`@alias`）**不读取、不创建唤醒代号**。发送一条消息不会改变会话的远程唤醒配置。
- `--code` 仍然可用，但它只是兼容的“按唤醒代号定位会话”入口；新流程优先用 `--to` / `@alias`。
- `wake` 只负责“某个外部任务结束了”这一类事件，使用代号解析目标会话，并保留独立的重试和失联判定。
- `create` 也不会仅仅因为发起询问就创建唤醒代号。

消息头只携带定位这条消息所需的最少信息：

```text
[deck-api:create:7f3a2c] 来自发起会话的询问。
[ask:7f3a2c] [查看完整会话](/s/7f3a2c)
结论：建议方案 B。
[send:1a2b3c4d] 补充上下文……
[wake:2c6ffbc0] 任务结束 exit=0
```

完整 ask ID、message ID 和 session key 保存在服务端台账和 UI 里，不会反复注入会话上下文。

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

地址和访问令牌由脚本读取 `${CODEX_DECK_HOME:-$HOME/.codex-deck}/{url,token}`，不需要写进命令或会话上下文。也可以用 `DECK_API_URL` / `DECK_TOKEN` 覆盖。

常用辅助命令：

```bash
bash "$DA" agents      # 可用 Agent、是否在线、是否支持 steer
bash "$DA" sessions    # 创建记录、状态、短别名、投递 ID
bash "$DA" whoami      # 确认当前会话身份
bash "$DA" list        # 查看唤醒代号
```

## 快速开始

### 1. 创建一个子会话

```bash
# 新会话 + 绑定当前会话为默认收件人
bash "$DA" create codex -- '请复核下面的方案，重点看并发安全：……'

# 较长的问题从文件读取
bash "$DA" create claude --name '方案复核' --file ./question.txt

# Codex 来源推荐 steer：回传直接追加到当前回合
bash "$DA" create codex --mode steer -- '请给出第二意见'
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

`send` 可以多次调用，不会结束会话。正常结束时不会自动转发最终回复；**目标不主动 `send`，来源就收不到任何消息**。所以目标被要求即使没有新结论，也发送一条简短状态。

### 3. 来源继续追问

`create` 回执和每条回传都会带短别名：

```bash
bash "$DA" send --to @7f3a2c -- '补充约束：并发上限按 8 处理。'
```

也可以使用完整会话：

```bash
bash "$DA" send --to demo-review:01a1503d-… -- '补充上下文……'
```

`--code` 是旧版兼容入口，仍然可用，但新流程优先使用 `--to` 或 `@alias`。

### 4. 监督外部任务

```bash
# 阻塞到任务结束：默认 watch，结束后通知当前会话
bash "$DA" wake -l train-r3 -- \
  ssh -o BatchMode=yes gpu-box 'while kill -0 12345 2>/dev/null; do sleep 60; done; tail -n 30 ~/runs/r3/train.log'

# 状态查询：poll，默认每 60 秒查询一次
bash "$DA" wake poll -l job-4821 -i 120 -- \
  ssh -o BatchMode=yes hpc 'sacct -j 4821 -n -X -o State | head -1'
```

省略代号时，Deck 会根据进程树和环境识别当前会话并自动分配代号。无法确认来源或代号属于其他会话时会拒绝；只有用户明确授权通知另一个会话时才用 `-f`。

## create 语义

- 每次新建独立会话，正常保存在目标 Agent 的原生历史中，不复制历史。
- 自动识别来源：优先使用进程树里 Deck 托管的 Agent 进程；环境变量身份需要进程树佐证。无法确认时拒绝猜测，可显式传 `--session <agentId:threadId>`。
- 受理后返回 202，只表示会话已创建、初始问题已持久入队，不代表目标已经开始执行。发起方应结束本回合，不要 sleep、tail、ps 或轮询。
- 回传是异步的，会以新的 `[ask:…]` 回合到达。
- 子会话不能再 `create`，避免递归；它可以用 `send` 和来源交流。
- 目标使用 Deck 中保存的询问默认配置。只有用户明确要求时才传 `--provider` / `--model` / `--effort`；Agent 不应自行探测或挑选模型。
- 启动失败、执行失败、被中断或目标被停用会自动通知来源，即使此前已经发送过进度。

## send 语义

### 收件人

| 写法 | 含义 |
| --- | --- |
| 不传目标 | 发给 `create` 绑定的来源 |
| `--to @<alias>` | 发给某个询问的子会话；优先使用 |
| `--to <agentId:threadId>` | 发给明确已知的任意会话 |
| `--code <代号>` | 兼容写法：按唤醒代号定位会话 |

`--to`、`--to @alias` 和 `--code` 三选一。`--session` 永远表示**当前发送方身份**，不是收件人。

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
- 明确未发送的失败会出现在会话的待发送列表，可取消或重试。
- 不会进入唤醒 outbox，也不会出现在总览的「需要处理」里；后者只处理 `wake` 投递失败。

## 短别名与稳定性

每次 `create` 会生成一个稳定短别名，例如 `7f3a2c`：

- 由 ask UUID 派生，默认 8 位，必要时逐级加长以避免冲突。
- 首次生成后写入询问台账，之后**永不重算**；服务重启、会话归档、再次追问都不会改变。
- 旧台账没有别名时，在加载时补齐一次并立即保存。
- 完整 UUID 仍是唯一真源，只用于台账、API 和调试。
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

唤醒请求先在服务端落盘，再返回 202，之后在后台重试；Agent 闪断、会话正忙或 Deck 短暂重启都不会丢。投递无望时会进入「需要处理」。局域网/配对模式下如果未固定 `--token`，重启可能轮换令牌，导致旧 watcher 无法投递；需要跨重启保持时应固定 token 或重新挂载。

外部脚本也可以不挂 watcher，直接发事件：

```bash
curl -X POST "$(cat ~/.codex-deck/url)/api/send/events/<代号>" \
  -H "Authorization: Bearer $(cat ~/.codex-deck/token)" \
  -H "Content-Type: application/json" -d '{"text":"任务已完成"}'
```

## 界面与持久化

- 会话头部雷达按钮打开「deck-api · 任务回传」：查看询问、子会话、状态、回传统计、模型与 effort，也能管理唤醒代号和 watcher。
- 总览首页的「deck-api 监督中」列出本机 watcher；失联记录出现在「需要处理」。
- 询问完成但一条都没回传时会标红，点目标可打开子会话核对。
- 完成但未回传的询问不占用总览的「新回复 / 最近会话」，审批和异常仍正常显示。
- 询问关联、待发送消息、消息队列和唤醒 outbox 都会持久化，服务重启后继续处理。
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
- 旧询问台账里的 `wakeCode` 只作兼容保留；新询问不再创建唤醒代号。
- 新的回传走消息队列；旧的待投递回传仍由原唤醒 outbox 处理，升级不会重复回复。
- 旧式 `send <code> <消息>` 转换后同样走消息队列，不再写唤醒 outbox。
- 已运行的旧 watcher 无需重新挂载。

## 安全与身份

- 来源识别只使用只读、确定性的线索：进程树、Deck 托管的会话标识、显式 `--session`。线索不足时拒绝猜测，把候选交给 Agent 去问用户。
- 环境变量会被子进程继承，只有在进程树里找到对应 Agent 后端时才可信；WSL 模式是明确例外。
- 访问令牌保存在 `~/.codex-deck/token`，权限 600。不要把令牌打印到终端、写进仓库或会话。
- 这是单用户本机控制面：能读取令牌的同用户进程可以调用接口。多人或不可信环境应额外做网络隔离、反向代理鉴权或独立账号。

## API 速查

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/deck/create` | 创建询问会话 |
| `POST` | `/api/deck/send` | send：绑定来源、`@alias`、显式会话或兼容代号 |
| `POST` | `/api/deck/prepare` | 识别来源、确认/分配唤醒代号、whoami |
| `GET` | `/api/deck/agents` | 可用 Agent、配置和 steer 能力 |
| `GET` | `/api/deck/sessions` | 询问台账、状态、别名、回传统计 |
| `GET` | `/api/deck/targets` | 唤醒代号绑定 |
| `POST` | `/api/deck/events/:code` | 兼容的唤醒事件入口 |
| `GET` | `/s/:alias` | 短别名跳转到子会话 |
| `POST` | `/api/monitor/watchers/:pid/stop` | 停止 watcher |
| `POST` | `/api/monitor/lost-watchers/:id/notify` | 通知失联 watcher 的会话 |

`/api/send/*` 和 `/api/wake/*` 仍作为旧版兼容路由保留。

## 排障

**`deck-api` 找不到 Deck**

确认 Deck 已启动，并检查 `~/.codex-deck/url`；WSL 场景优先启用镜像网络，或用 `--host` 绑定可达地址。

**create/send 报“无法判断来源”**

使用已知身份显式指定：`create` / `send` 用 `--session <agentId:threadId>`；`wake` 先确认代号，必要时加 `-f`。不要猜一个看起来相似的会话。

**send 失败**

去对应会话的待发送列表查看状态，明确未发送的可以重试；不要假定对方已经收到。向绑定来源发送时用同一个 `--request-id` 重试。

**wake 没有通知**

先看 `wake ps` 和 watcher 日志。如果 watcher 已经消失且没有发出唤醒，会在「需要处理」里出现失联记录；确认远端任务现状后再决定是否重挂，避免重复监督。

**升级后旧 watcher 无法投递**

检查 token 是否在重启时轮换。需要跨重启保持时固定 `--token`，或重新挂载 watcher。
