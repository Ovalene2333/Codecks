# 代码审阅 Todo（2026-09-04 全仓审阅结论）

> 来源：对 `server/`（~16k 行）、`src/`（~13k 行）、`plugin/` 的只读审阅。
> 本文档记录全部发现与修复状态；高风险项在本轮修复，其余留作后续。

## 图例

- [x] 已修复　- [ ] 待修复（后续排期）　`位置` 为审阅时的 `文件:行号`

---

## 🔴 严重：崩溃 / 永久卡死（本轮修复）

- [x] #1 `server/index.ts:1128,1139` — upgrade 回调内 `new URL(host)` / `decodeURIComponent` 同步抛异常，
      在鉴权前崩溃整个进程（免 token 可远程 DoS）。修复：整个回调包 try/catch + 安全解码。
- [x] #2 `server/codex-client.ts:368` — `stdin.write` 无 `error` 监听，子进程死亡瞬间 EPIPE 未捕获
      即崩溃全服务。修复：stdin 挂 error 监听 + 写保护。
- [x] #3 `server/agents/codex-adapter.ts:248-260` — `restart()` 绕过 `markOffline()`，被杀回合从
      状态库复活为 running，永久拒绝供应商切换。修复：restart 走 markOffline 语义。
- [x] #4 `server/agents/opencode-adapter.ts:1100-1132` — `sendTurn` 先置 running 再 POST，无失败回滚，
      线程永久卡 running。修复：try/catch 回滚到 error/idle。
- [x] #5 `server/agents/opencode-adapter.ts:782-811,1271-1315` — SSE 断流后永不重订阅，
      `reuseHealthyServer` 直接返回。修复：健康复用路径重建事件流。

## 🟠 高（本轮修复）

- [x] #6 `server/index.ts:1127-1156` — 免 token 模式无 Origin/Host 校验，任意网页可跨站开 WS
      拿全量快照。修复：token 为空时校验 Origin 与 Host 一致（允许空 Origin 的非浏览器客户端）。
- [x] #7a `server/thread-summary-cache.ts:70-90` — timer 路径 `void flush()` 丢 promise，
      写失败即 unhandled rejection 崩进程；写链 reject 后永久跳过后续 flush。
      修复：timer 侧 catch + 写链自愈。
- [x] #7b `server/thread-settings.ts:137-146` — 同款写链毒化，一次瞬时 IO 错误后设置永久停止持久化。
      修复：写链自愈（失败后重置链，后续写入继续）。
- [x] #7c `server/thread-settings.ts:62-81` — 脏 JSON（非 ENOENT）启动即抛杀死服务。
      修复：损坏时回退空设置（与 summary-cache 一致）。
- [x] #8 `server/runtime-lock.ts:30-38,99-134` — stale childPid 无归属验证直接 `taskkill /T /F`
     （Windows PID 复用可误杀）；`acquire` 非原子创建（TOCTOU）；`EPERM` 误判为未存活。
      修复：win32 下 kill 前用进程创建时间校验 PID 归属 + `O_EXCL` 原子创建 + EPERM 视为存活。
- [x] #9 `server/index.ts:1276-1291` — 关机 `server.close()` 不终止 WS 客户端，可永久挂起；
      `shuttingDown` 吞掉二次 Ctrl+C。修复：关机先 terminate 全部 WS + 硬退出超时 + 二次 SIGINT 强退。
- [x] #10 `server/cc-switch.ts:70,104` — 第三方 DB 一行脏 `settings_config` 即抛，中断整机启动。
      修复：逐行 try/catch 跳过脏行。
- [x] #11 `server/store.ts:39-54,236-241` — `providers.json` 写坏后 catch 分支用默认供应商**覆盖源文件**，
      永久丢失全部 API key；写入非原子；形状错误不校验。修复：原子写入 + 损坏时保留文件并告警 +
      形状守卫。`projects.ts:368-380` 同样改原子写入。
- [x] #12 `src/App.tsx:350-365,768-781,905` + `src/cache.ts:178-195` — 并发快照响应乱序，
      旧响应覆盖 WS 已推送的新审批/状态。修复：请求序号守卫（旧响应丢弃）。

## 🟡 中（留作后续）

- [ ] #13 前端每次按键全量重渲染转写 + markdown 重解析（`ChatWorkspace.tsx:493-512`，
      `Timeline.tsx:88-101`，`TurnBlock` 未 memo）。方向：memo 化 + useMemo + draft 下沉。
- [ ] #14 `/api/pair` 按 `req.ip` 限流，隧道下全员同桶（锁死所有人）+ `attempts` Map 无界增长
     （`index.ts:191-193`，`pairing.ts:51-77`）。方向：隧道场景固定桶 + LRU。
- [ ] #15 OpenCode `request()` 无超时（`opencode-adapter.ts:1530-1551`）。方向：AbortController 超时。
- [ ] #16 OpenCode 审批 offline 不清理、失败响应跳过 delete（`:1553-1562,1157-1199`）。
- [ ] #17 Claude 未跑首回合的内存线程被刷新删除、改名丢失（`claude-adapter.ts:549-581,606-629`）；
      `message.usage` 无守卫（`:950-965`）。
- [ ] #18 Claude token 用量累计口径与末帧快照混算（`claude-history.ts:52-87`）。
- [ ] #19 `normalizeProjectPath` 全平台小写整条路径，大小写敏感文件系统下合并无关项目
     （`projects.ts:16-42`）。方向：仅 Windows 盘符小写。
- [ ] #20 前端：`DeferredImage` 重试 no-op；`ConfirmDialog` 双发；`ApprovalInbox` 静默吞第二次解析；
      `ApprovalCard` answers 越界崩溃；`PermissionsCommand` 条件 hooks；`DirBrowser` 无序号守卫；
      updater 内写 localStorage；`NewThreadModal` 直接改受控 select；乐观消息无过期路径。

## 🟢 低（择机处理）

- [ ] route catch 无 `headersSent` 守卫；内部错误原文回客户端；WSL listing 换行文件名；
      tasks 按文本合并；ddns 校验；token 进 URL/argv；pairing 非恒定比较；`spawnSync` 阻塞；
      codex 2000 上限致老线程消失；`CODEX_WSL_HOME` 未转 WSL 路径；opencode `NaN` 时间戳；
      `thread-image` 相对路径锚点；WS token 进 query；Git 视图清空勾选；终端主题冻结；
      TurnBlock key 碰撞。
- [x] 已核查无问题：thread-image symlink 防护、FTS5 参数化、argv 无注入、快照不泄漏 secret、
      前端无 dangerouslySetInnerHTML。

## 备注

- 本轮动手时工作区另有他人未提交改动（subagent 展示功能），过程中对方已提交
  （`6bf5836 feat: OpenCode 子代理会话以父会话 task 卡片呈现实时活动`），
  当前工作区仅剩本轮修复，按 AGENTS.md 跑测试与编译验证。
- 按仓库约定，大型改动的提交由用户确认后执行，本轮不代提交。
