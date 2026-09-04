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

## 验证（第二轮）

- `npm test`：407 例，406 通过，1 跳过（Windows 无 POSIX shell 预设跳过）。
- `npm run build`：`tsc --noEmit`（前端）+ `tsc -p tsconfig.server.json` + `vite build` 全绿；
  主包 `index 222kB` + `vendor-react 185kB` + `vendor-markdown 166kB` + `vendor-xterm 334kB`。
- 基线：改造前按 AGENTS.md 先提交 `8bf6f96`，本轮改动单独提交。
