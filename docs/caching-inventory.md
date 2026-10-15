# 缓存清单（2026-10-13 审计）

> 记录 Deck 当前「有缓存 / 故意不缓存」的全部位置，回应模型选择卡等响应即时性问题
> 的第二轮修复。行号为当时状态，供巡检参考。
> 原则：可复算的低频数据加 TTL + 在途去重；编辑面与实时状态故意不缓存。

## 服务端响应缓存

| 缓存 | 位置 | Key | TTL | 并发/失效保护 | 说明 |
| --- | --- | --- | --- | --- | --- |
| Codex 模型目录 | `server/agents/codex-adapter.ts:141` | providerId | 10min | 在途去重（`:142`）；启动预热（`:180`）；供应商集合变化才清空；拉取失败回退旧值 | stale-while-revalidate：过期先返回旧目录、后台刷新，避免阻塞等 runtime 冷启动 |
| OpenCode 项目模型目录 | `server/agents/opencode-adapter.ts:754-756` | directory | 10min | 在途去重；失效点：PATCH /config、`server.instance.disposed`、refreshAll 清理；refreshAll 后后台预热；上游失败回退旧值 | 旧实现每次现拉 `/provider`+`/config` 两轮 HTTP，已改为过期即返回 |
| 会话技能列表 | `server/agents/registry.ts:132` | `agent:thread` | 30s | 在途去重；`?reload=1` 绕过；128 条上限 | 与前端 CommandModal 的 30s 缓存对齐；Claude 无连接时避免每开一次就全目录扫 SKILL.md |
| 任务中心快照 | `server/agents/registry.ts:130` | 单例 | 1.5s | 在途去重 | 快照内有数据就立即返回、过期后台刷新；省去轮询时对每个忙碌会话 `thread/read` |
| 用量/限额（Codex 官方） | `server/agents/codex-adapter.ts:1705` | 单例 | 60s | 在途去重；`?force=1` 绕过 | `account/read` + `rateLimits/read` 两轮 JSON-RPC |
| 目录浏览 | `server/fs-browse.ts:8` | 路径 | 3s | 100 条 LRU；WSL 路径复用同一缓存 | 主要吸收 `wsl.exe` 每次约 300-800ms 的 spawn |
| 唤醒监视器进程扫描 | `server/wake-watchers.ts:188` | 单例 | 5s | 后台定时 60s 自刷 | `/proc` 全量扫描的 stale-while-revalidate |
| 唤醒去重账本 | `server/wake-outbox.ts:16` | thread | 5min | — | 防重复唤醒投递，非响应缓存 |
| CLAUDE.md / Claude 会话历史 | `server/agents/claude-adapter.ts:2271` | 文件 mtime+size | 常驻 | mtime 变化才重解析 | 历史 JSONL 解析结果按修改时间判新鲜 |
| Codex 会话 resume | `server/agents/codex-adapter.ts:2083` | threadId | 常驻（进程内） | `loadedThreads` 一次执行 | skills/mcp 等首个读接口隐式 `thread/resume`，一线程最多一次 |
| CC Switch 供应商镜像 | `server/store.ts:112` | 单例 | 5s 轮询 | 整体签名比对，变化才广播 | 5s 重开 SQLite 是同步机制本身，请求路径读内存 |

## 传输与存储层缓冲（非 TTL，但属同类）

| 机制 | 位置 | 参数 | 说明 |
| --- | --- | --- | --- |
| WS snapshot 合并 | `server/index.ts:2066` | 50ms 窗口 | 连发全量只保留最新一次 |
| WS 慢客户端跳过 | `server/index.ts` | bufferedAmount > 1MB | 防单个客户端拖垮广播 |
| usage 落盘合并 | `server/codex-usage.ts:192` | 300ms 去抖 | 多次写入一次 IO |
| 静态资源 | `server/index.ts` | 365d immutable | index.html 显式 no-store |
| HTTP 响应压缩 | `server/index.ts` | threshold 1KB | 图片/音视频跳过 |

## 前端缓存（`src/swr-cache.ts` 通用 SWR 组件：内存 + 可选 localStorage）

| 使用点 | 位置 | TTL | 落盘 | 说明 |
| --- | --- | --- | --- | --- |
| 模型目录 | `src/ModelPicker.tsx:23` | 60s | 是（>300KB 只留内存） | 8s 超时后可切换手输；后端已有 10min TTL 兜底 |
| P0 命令列表 | `src/session/ChatWorkspace.tsx:143` | 5min | 是 | 很少变化 |
| 会话技能 / MCP | `src/session/CommandModal.tsx:409` | 30s | 否 | 服务端技能列表也 30s，双层一致 |

另有：`src/projects.ts:31` 路径归一化 2000 条有界缓存；任务中心 3s / host 监控 5s /
监视器 15s 轮询均为服务端可见性开启时的轻量循环。

## 故意不缓存（勿"优化"）

| 位置 | 原因 |
| --- | --- |
| `GET /api/agents/opencode/config`、`/providers`（`server/index.ts:755`、`846`） | 编辑面：用户改的就是磁盘上的 `opencode.json`，必须每次读文件 |
| `GET .../mcp`（`server/index.ts:1768`） | MCP 状态要求实时；隐式 resume 已一次执行去重 |
| `GET .../threads/:id/files` 文件搜索 | 按输入实时查询 |
| 会话详情 `thread/read`（`server/index.ts:971`） | 首开延迟来自协议 replay，客户端已用本地缓存播种 |
| agent 启停 / reload / model-context / 项目保存 | 全是写路径 + runtime 重启，即时生效是目的本身 |
| `GET /api/monitor/host` | 实时指标（Linux 读 /proc 本身便宜） |

## 验证

- `npm test`：812 例，810 通过，2 跳过（既有）。
- `npm run build`：`tsc --noEmit`（前端）+ `tsc -p tsconfig.server.json` + `vite build` 全绿。
- 相关测试：`server/agents/opencode-adapter.test.ts` 目录 disposed 失效用例，无既有用例针对新缓存结构。
