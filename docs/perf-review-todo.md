# 性能优化 TODO（2026-09-04 性能审阅结论）

> 来源：对 `src/` + `server/` + 构建/协议的性能审阅（渲染、网络/WS、存储/IO、进程、构建五方面）。
> 图例：`[x]` 本轮已落地　`[ ]` 后续排期。位置为审阅时的 `文件:行号`。

## 本轮已落地（高风险、低改动成本）

- [x] P1 `src/session/markdown.tsx` — `AssistantMarkdown/CopyablePre/DeferredImage` memo 化，
      `remarkPlugins/components` 提升为模块常量，避免每次 render 新建数组/对象导致全树重解析。
- [x] P1 `src/session/TurnBlock.tsx` — `TurnBlock` memo + 内容签名对比（只看 active 相关流式签名），
      非活跃 turn 在流式 delta 下跳过重渲染；`TurnItem` memo 化。
- [x] P2 `server/session-search.ts:291` — `indexedCount` 全表拉回 JS 再 filter，
      改为库内 `COUNT` + 分批 `IN`（500/批），避免 threads 上千时全量行传输。
- [x] P2 `server/fs-browse.ts:56` — `readdir + 逐个 stat + 全量排序` 无缓存，
      加 3s TTL + 100 条 LRU 目录缓存；WSL 路径复用同一缓存（spawn 约 300-800ms，命中直接返回）。
- [x] P3 `vite.config.ts` — 无分包，主包吃下 react-markdown/xterm。
      加 `manualChunks {vendor-react, vendor-markdown, vendor-xterm}` + `chunkSizeWarningLimit`，
      终端/markdown 懒加载前先做到并行缓存。

## 后续排期（需大改或当时工作区文件正被他人修改，本轮只记录不碰）

- [ ] P0 `server/index.ts:1187` WS 全量快照广播：每条 event 全量 `agents.snapshot()+fullSnapshot()+JSON.stringify`
      再逐 client `send`，无背压。方向：snapshot-lite 高频推 + revision 字符串复用 +
      `bufferedAmount` 慢客户端跳过 + `perMessageDeflate` + 50ms 合并窗口。
      （本轮未碰：该文件已有他人 staged 改动，避免冲突。）
- [ ] P0 `src/App.tsx` 根 snapshot 全树重算：`mergeProjectGroups` 每次 render 全量正则归一化+排序，
      render 内又调一次求 `projectCount`。方向：归一化缓存 / 后端下发 projectKey / 分片订阅。
      （本轮未碰：该文件 unstaged 改动进行中。）
- [ ] P0 `src/session/Timeline.tsx:50` + `streaming.ts:80` — `useLayoutEffect` 全量 DOM 扫描 +
      事件缓冲全数组拷贝。方向：虚拟化（视口 ±N turn）、环形缓冲、增量 `collectStreamed`。
- [ ] P1 `ChatWorkspace.tsx:118` 全量 `readThread`：任何非 delta 事件 300ms 后全量拉 turns。
      方向：`?sinceTurnId/sinceSeq` 增量接口 + 前端 merge。
- [ ] P1 JSON 落盘风暴（`codex-usage.ts:106` 每次全量重写等）：统一 DebouncedAtomicJsonStore，
      usage 改 JSONL 追加 + 定时 compact。
- [ ] P1 索引主线程阻塞（`session-search-indexer.ts:94` 同步 upsert）：移入 worker，后台化；
      `search` 的超长 IN 改临时表/JOIN，大 thread 只索引最近 N turns。
- [ ] P2 图片：`getBlob` 无 LRU、`Composer` 无压缩（20MB 上限前端不拦）。方向：blobUrl LRU +
      canvas 压缩 1600px/0.8。
- [ ] P3 静态资源：`express.static` 无 maxAge/compression，`index.html` 启动脚本同步 parse 大快照。
      方向：hashed 资源 `maxAge 1y immutable` + `index.html no-cache` + 启动只读 meta 行。

## 验证

- `npm test`（改了有测试覆盖的 session-search；fs-browse 无单测，靠 tsc + 手工路径验证）
- `tsc --noEmit -p tsconfig.json && tsc -p tsconfig.server.json && vite build`
- 注：工作区另有他人 staged/unstaged 改动（正确性修复分支），本轮只动干净文件；
  按 AGENTS.md，有他人并行改动时不代提交，编译/测试结果如实记录。
