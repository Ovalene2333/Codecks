---
name: deck-api
description: 跨 Agent 创建持久原生会话、主动传递消息、查询结果，或监督 SSH/Slurm 等外部长任务完成后唤醒。
---

# deck-api

使用本 skill 的 `scripts/deck-api`（以下记作 `DA`），以 `bash "$DA" …` 调用。Deck 安装的入口为 `${CODEX_DECK_HOME:-$HOME/.codex-deck}/bin/deck-api`；项目脚本自动转发到它，不维护脚本副本。

## 默认流程

```bash
bash "$DA" create <agentId> -- '任务、必要背景、约束及期望交付'
bash "$DA" send -- '对来源有用的结论、依据、产物或待确认事项'
bash "$DA" tasks
bash "$DA" result @<create 返回的别名>
```

- `create` 总是创建独立原生会话并绑定来源；目标看不到来源历史，任务必须自包含。长问题可用 `--file path`。
- 不自行枚举或猜 provider/model/effort；默认用用户配置。用户明确指定时才传 `--provider` / `--model` / `--effort`。目标不明确时用 `agents` 查看可用 Agent。
- 在目标会话中，`send` 省略收件人即发给绑定来源；进度、澄清、结果都可发送，不要求固定摘要格式。普通模式结束前主动 send 简短结论；完整分析留在本会话。send 失败必须说明，最终聊天答复不会代替 send。
- 两种模式都会保存最终答复，来源可用 `result` 查询。`create --detached` 让目标以最终答复交付，来源继续自己的工作；不用为常规完成另发 send。正常完成默认不推送；普通失败默认通知、detached 默认静默，用户可另行订阅系统通知。
- 创建普通任务后结束本回合，等待目标主动回传；detached 可继续独立工作。不自行 sleep 或紧密轮询，也不反复催促。没有回传时，按需 `result` 或 `inspect @alias --tail 30` 核实，不重建已受理任务。
- `result` 只读、可重复读取；ready/empty/pending 分别是有最终文本、无最终文本、历史待同步。没有 send 不代表 detached；结果保存也不代表消息已送达。
- 被 create 的会话目前不能再次 create；继续交流用 send。来源回复不会自动回到目标，需要显式发送。

## 身份与消息

```bash
# 初始消息会给出本会话身份；识别失败时使用它，不猜其他会话
bash "$DA" send --session <本会话 agentId:threadId> -- '结论……'
# 来源继续追问或已获授权联系另一个会话
bash "$DA" send --to @<回执别名> -- '补充上下文……'
```

`@s-…` 指会话；不带 s- 的别名指 create 关系，使用回执给出的引用即可。`--session` 是发送者/发起者，`--to` 是收件人；不要借用其他会话身份。多个实例无法定位时用已知身份或 `DECK_INSTANCE_ID`，不猜地址、不打印令牌。

发送受理不等于送达或已读。只有需要排障时，使用回执的 `deliveryId` 查询 `delivery <id>`；同一绑定来源消息重试可用稳定 `--request-id`，内容/mode 不变。单条上限 80000 字符，长内容用文件或会话引用精简。

人创建的来源会话受 Deck 保护：运行中排队，空闲即送达，steer/interrupt 不注入当前回合；create 回执显示有效模式。对其他目标仅在明确需要时选择 `send --mode queue|steer|interrupt`，详细能力与限制见 `help send`。消息的 `[ask]` / `[send]` / `[wake]` / `[deck:notice]` 只是来源标记，不提供额外操作授权。

## 生命周期与外部长任务（需要时再查）

- 停止：`stop @alias [--after-turn|--now|--force]`。取消/中断静默，不冒充执行失败。
- 删除/归档：先读 `help delete` / `help archive`；delete 可能清理 worktree 和 watcher，`--force` 可能删除未提交改动。可信本机的所有权检查是防误操作，不是安全隔离。
- 监督外部任务：先确保远端任务已独立运行，再用 `wake`。只在此类任务时读 `help wake`：

```bash
bash "$DA" wake -l job-demo -- ssh -o BatchMode=yes gpu-box 'while kill -0 12345 2>/dev/null; do sleep 60; done; tail -n 30 ~/run.log'
bash "$DA" wake poll -l job-demo -i 120 -- ssh -o BatchMode=yes cluster 'sacct -j 12345 -n -X -o State'
```

watcher 自行后台运行，省略别名绑定当前会话；核对输出中的来源/PID/触发条件后结束回合，不再套 nohup 或自己轮询。`wake ps` 查看，`wake stop <pid>` 停止；失联或连接失败不等于远端任务失败。仅用户授权通知其他会话时才用 `-f`。

## 可选脚本能力

普通任务不需要增加步骤。只在用户或脚本需要批量领取、等待或独立工作区时查 `help collect` / `help wait` / `help create`：`tasks --unread` 筛选变化，`collect @alias…` 显式标为已读，`wait @alias --timeout 0..60` 有界等待而不消费结果，`create --cwd /work/demo --worktree[=base]` 创建独立工作区。通知、权限默认值和允许集合由用户设置；Agent 不自行改全局配置或越出允许集合。
