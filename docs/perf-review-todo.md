# 性能优化 TODO（2026-09-04 性能审阅结论，第二轮已落地）

> 来源：对 `src/` + `server/` + 构建/协议的性能审阅（渲染、网络/WS、存储/IO、进程、构建五方面）。
> 图例：`[x]` 已落地　`[ ]` 后续排期。位置为审阅时的 `文件:行号`。

## 第一轮已落地（高风险、低改动成本）

- [x] P1 `src/session/markdown.tsx` — `AssistantMarkdown/CopyablePre/DeferredImage` memo 化，
      `remarkPlugins/components` 提升为模块常量，避免每次 render 新建数组/对象导致全树重解析。
- [x] P1 `src/session/TurnBlock.tsx` — `TurnBlock` memo + 内容签名对比（只看 active 相关流式签名），
      非活跃 turn 在流式 delta 下跳过重渲染；`TurnItem` memo 化。
- [x] P2 `server/session-search.ts:291` — `indexedCount` 全表拉回 JS 再 filter，
      改为库内 `COUNT` + 分批 `IN`（500/批），避免 threads 上千时全量行传输。
- [x] P2 `server/fs-browse.ts:56` — `readdir + 逐个 stat + 全量排序` 无缓存，
      加 3s TTL + 100 条 LRU 目录缓存；WSL 路径复用同一缓存（spawn 约 300-800ms，命中直接返回）。
- [x] P3 `vite.config.ts` — 无分包，主包吃下 react-markdown/xterm。
      加 `manualChunks {vendor-react, vendor-markdown, vendor-xterm}` + `chunkSizeWarningLimit`。
      注：`react-dom/client` 子路径需显式列出才命中分包，否则 react-dom 漏回主包。

## 第二轮已落地（2026-09-05）

- [x] P0 `server/index.ts` WS 广播 — `snapshot` 事件 50ms 合并窗口（只保留最新一次全量，
      落地时刻才构建）；`thread.updated/deleted` 与 `codex.event` 等增量小包直接透传；
      广播跳过 `bufferedAmount > 1MB` 的慢客户端；主 WS 开 `perMessageDeflate`（level 3/threshold 512）。
      未做：snapshot-lite 协议拆分、revision 字符串复用（需前后端协议变更，留后续）。
- [x] P0 `src/App.tsx` 根重算 — `baseGroups/activeGroups` 两级 memo，query/筛选变化不再重跑
      归一化+排序；render 内 `projectCount` 与 `recentProjects` 的重复 `mergeProjectGroups` 复用；
      `src/projects.ts normalizeProjectPath` 加 2000 条有界缓存。
- [x] P0 `src/session/streaming.ts` — `appendCodexEvent` 重写：delta 合并倒序扫（尾部命中近 O(1)，
      末位命中免双 slice）；尾部追加统一 `appendCapped` 单 spread + 只读倒序扫描，
      替代原来的三次 filter + 两次 spread（顺序语义经 delta 恒居尾不变量保持一致）；
      新增单遍 `collectStreamed`，`ChatWorkspace` 从每 render 全扫两遍降为一遍（+ useMemo）。
      旧 `collectStreamedAgentMessages/TurnItems` 保留为薄封装，单测不动。
- [x] P0 `src/session/Timeline.tsx` — 滚动应用收进 rAF，同帧多次 effect 合并为一次
      `scrollTop/scrollIntoView`；无 rAF 环境（单测/SSR）直接执行；卸载时 cancel。
- [x] P1 `server/codex-usage.ts` — `save()` 改 300ms 合并窗口，多次 set/setMany/remove 只落一次盘；
      返回的 promise 在实际写完后 resolve，`await set()` 语义不变；`flush()` 立即落盘。
- [x] P3 `server/index.ts` 传输入口 — 加 `compression`（threshold 1KB，图片/音视频/压缩类型跳过）；
      `express.static` 改 `maxAge 365d + immutable + index:false`（hash 资源长缓存），
      `index.html` 回退路由显式 `Cache-Control: no-store`。新增 `compression` +
      `@types/compression` 依赖。

## 后续排期

- [ ] P1 `ChatWorkspace.tsx` 全量 `readThread`：任何非 delta 事件 300ms 后全量拉 turns。
      方向：`?sinceTurnId/sinceSeq` 增量接口 + 前端 merge（需协议变更）。
- [ ] P1 索引主线程阻塞（`session-search-indexer.ts:94` 同步 upsert）：移入 worker；
      `search` 的超长 IN 改临时表/JOIN，大 thread 只索引最近 N turns。
- [ ] P1 `thread-summary-cache` 高频全量重写：与 usage 统一为 DebouncedAtomicJsonStore。
- [ ] P2 图片：`getBlob` 无 LRU、`Composer` 无压缩（20MB 上限前端不拦）。方向：blobUrl LRU +
      canvas 压缩 1600px/0.8。
- [ ] P3 `index.html` 启动脚本同步 parse 大快照：只读 meta 行，延后到 idle。

## 第三轮内存专项（2026-10-13 晚，glibc malloc 碎片实证）

现象：deck 主进程空载 ~370-400MB，活跃使用 1 小时后 RSS ~590-700MB；换成二进制 `opencode serve`
(Bun) 子进程踱到 ~900MB；`devin acp` ~230MB、`codex app-server` ~250-300MB——全家桶 ~2.2GB。

实证（临时 DATA_DIR + 禁用全部 agent 二进制的空载实例 + 1500 次 `GET /api/snapshot`）：

| 阶段 | RSS | glibc [heap]（Private_Dirty） | V8 JS 堆（自算 self_size） |
| --- | --- | --- | --- |
| 启动 30s | 372-384MB | 78-92MB | ~121MB |
| 压 1500 snapshot 后 | 494-525MB | 177-212MB | 基本不变 |
| 闲置 5 分钟 | 513-527MB | **194-214MB 一毫不还** | 基本不变 |
| WS connect/close ×300 | 545MB | +3MB | — |

`malloc_info(0, stderr)` 直采（自编 mimalloc 风格 LD_PRELOAD 观察器）：
deck node 在压测后 `system current ≈ 201MB`，其中 **~223MB 是 free chunk**（fastbin=0、非堆顶）。
结论：流失在 glibc 的「大块暂时性分配（全量快照/大 JSON 序列化、deflate 暂存）穿插小对象常驻导致的
内部碎片」，非真正的内存泄漏；`MALLOC_TRIM_THRESHOLD_/TOP_PAD_` 实测无效（trim 只还堆顶）。
`heapstat`:V8 侧确认无 JS 泄露（两轮堆快照 self 100.7 vs 121.2MB，反而下降）。

已落地：
- [x] `GET /api/snapshot` 加 150ms 纯读 memo（`server/index.ts` snapshotGet）——页面加载与关弹层
      动作簇只构建一次；每个动作的后置 `fullSnapshot()` 与 WS 快照合并窗口保持原语义。
- [x] `OPENCODE_IDLE_RESTART_MS`（同日提交）：serve 空闲 30min 且无忙碌/待审批时重建，回收
      opencode serve 的数百 MB。
- [x] 模型目录 / 技能列表 / 任务快照缓存（同日提交，见 docs/caching-inventory.md）。

量化为无效（晚上实测，勿再做）：
- 懒加载 `@anthropic-ai/claude-agent-sdk`（动态 import）——空载 RSS 无可见收益，SDK 图谱远比
  源码字符串小；且把回合工厂变异步会新开 abort 竞态面。
- `MALLOC_TRIM_THRESHOLD_` / `MALLOC_TOP_PAD_`——对已滞留的 Y 形空闲块无效。

后续排期（按收益排序）：
- [ ] P1 换分配器：`apt install libjemalloc2`（需 root）或自编 mimalloc，LD_PRELOAD 到 deck 主
      进程与 opencode serve；decay 可以归还碎片。验证口径同本轮。
- [ ] P1 `/api/snapshot` 增量协议：revision + `If-None-Match`/304 或 `?since=`，把每客户端
      3s/5s 轮询的全量 JSON 打成小 delta（需协议变更，与「后续排期」第一项联动）。
- [ ] P2 `.data` 下 `message-deliveries.json` 804KB 常驻内存 + 高频全文替换由 DebouncedAtomicJsonStore
      承接（并入上面第三项）。

## 验证（第三轮）

- `npm test`：815 例，813 通过，2 跳过。
- `npm run build` 全绿；`server/index.ts` memo 与 WS/广播语义 README 无感知（纯服务端行为）。
- 压测产物：`/tmp/luomemstat/mallocstat.so`（LD_PRELOAD 观察器，源码留档 tmp）、堆快照已删。

## 验证（第二轮）

- `npm test`：407 例，406 通过，1 跳过（Windows 无 POSIX shell 预设跳过）。
- `npm run build`：`tsc --noEmit`（前端）+ `tsc -p tsconfig.server.json` + `vite build` 全绿；
  主包 `index 222kB` + `vendor-react 185kB` + `vendor-markdown 166kB` + `vendor-xterm 334kB`。
- 基线：改造前按 AGENTS.md 先提交 `8bf6f96`，本轮改动单独提交。
