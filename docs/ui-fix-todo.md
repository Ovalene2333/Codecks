# UI 基线修复 Todo（2026-10-18 全前端扫描结论）

> 来源：对照 `docs/ui-baseline.md` 的全前端只读扫描（settings / session / overlays / monitor / layout / usage / task / css）。
> 基线点：tag `deck-api-baseline`（998469a）。本文档记录全部发现与修复状态，逐项修复、逐项提交。
> 2026-10-18 第一轮：高优项与多数 token/文案项已修复（#1-#16、#18、#24-#30），
> 结构性重构（#17b、#19b、#20-#23、#31、#32）留待后续。
> `位置` 为扫描时的 `文件:行号`，修复时以内容为准。

## 图例

- [x] 已修复　- [ ] 待修复　`位置` 为扫描时的 `文件:行号`

---

## 🔴 高：用户直接可见 / 行为缺陷（本轮修复）

- [x] #1 `settings/ProvidersPage.tsx:426-427` — ccProviders 非空时，`providerSection("CC Switch", …)` 与
      `<Section title="CC Switch">` 相邻，屏幕连续出现两个同名标题；Claude 签（:449）只有一个，同页不同形。
      修复：汇总 Section 换标题（如「CC Switch 同步」）或并入 providerSection。
- [x] #2 `session/ApprovalCard.tsx` — 三张审批卡整套手搓：裸 `<button>`（:302-360）、手写 radio（:271-289）、
      手写 checkbox（:470-487）、手写选中选项组（:655-679）、三份重复的头部/busy/error 骨架（:221,452,601 / :292,492,719）。
      修复：迁 kit `Button`/`Choice`/`Switch`，抽公共骨架；busy 文案改 `Button busy`。
- [x] #3 `overlays/WakeModal.tsx:254-267` — 手写开关（裸 checkbox+`<i>`）；:138-181,223-276 裸按钮 +
      `.primary`/`.danger-btn` 旧类。修复：kit `Switch`/`Button`（danger 用 variant）。
- [x] #4 手写 `role="tablist"` 五处、均无键盘导航：`layout/Sidebar.tsx:325`、`usage/UsageChip.tsx:115,191`、
      `tasks/TaskCenter.tsx:120`、`overlays/NewThreadModal.tsx:276`。修复：迁 kit `Seg`。
- [x] #5 `sidebar.css:283-294` — 选中行 accent 渐变底 + 强调色竖条，同时踩两条明文禁令；
      现被 `deck-ui.css:299` 覆盖成死代码，删掉覆盖即复发。修复：删除该段。
      注：`session-row--fork` 的中性竖条保留（fork 行的功能标记，不是强调色）。
- [x] #6 手写加载态：`session/CommandModal.tsx:385-394` 三点 spinner（+ `overlays.css:759-778` keyframes）、
      `session/OperationStatus.tsx:26` 自写旋转动画。修复：改 `busy` / `.ui-spin`，删配套 CSS。
- [x] #7 原生弹窗与体系不符：`monitor/MonitorBoard.tsx:715` `window.confirm`、
      `overlays/NewThreadModal.tsx:367` `window.alert`。修复：`ConfirmDialog` / toast。

## 🟠 中：token 违规与「同类同形」（本轮修复）

- [x] #8 `mobile-nav.css:193` — 全站唯一裸 hex `#1a1305`。修复：tokens.css 增补 `--static-ink`（不随主题变的深色墨），引用之。
- [x] #9 `mobile-nav.css:180` — `transform: scale(0.96)` 按压缩放（禁令：不做缩放强调）。修复：删。
- [x] #10 裸行高/字重/字号簇（发版自查 grep 红项）：
      `deck-ui.css:104,149,164,696,713`（line-height:20px）、`:1184`（fw 裸值）、`:1187`（font-size:12px）；
      `project-groups.css:104,113`（20px）、`:714,715`（fw/16px）；`overlays.css:945`（1）、`:1010,1028`（1.8）、
      `:928,943,1018,1022`（fw 裸值）；`session/operation-status.css:11`（1.5）；`monitor.css:601,828,840`（font: 简写夹带 1.4/1.3）。
      修复：并入 `--lh-*` / `--fw-*` / `--fs-*` token。
- [x] #11 裸圆角：`project-groups.css:710`、`session/operation-status.css:31` `border-radius: 4px` → `--radius-xs`。
- [x] #12 `layout/ChatHeader.tsx:124` + `chat.css:90,3068` — 待确认计数做成底色胶囊。
      修复：改普通浅色计数（`--text-faint` 数字），仅移动端底栏角标可保留实心圆。
- [x] #13 手写空态 ×7 → kit `Empty`：`layout/Sidebar.tsx:476`、`tasks/TaskCenter.tsx:150`、
      `usage/UsageChip.tsx:237`、`monitor/MonitorBoard.tsx:674`、`session/Timeline.tsx:288`、
      `DirBrowser.tsx:70`、`settings/OpenCodeProvidersSection.tsx:367`。
      注：Empty 增加 compact 变体；总览监督面板的行级提示保留（列表行版式不同于页面级空态）。
- [x] #14 可见文案「·」串 → flex gap 分隔（title 属性内的豁免）：`layout/Sidebar.tsx:369,371`、
      `session/AskNotice.tsx:12-14`、`overlays/WakeModal.tsx:169,195`、`session/ApprovalCard.tsx:514,527`、
      `session/MessageQueue.tsx:31`、`settings/AboutPage.tsx:162,209,231`、`settings/AgentsPanel.tsx:32,74`、
      `settings/DataPage.tsx:341,410`、`tasks/TaskCenter.tsx:181,205`、`usage/UsageChip.tsx:219,296`、
      `monitor/MonitorBoard.tsx:326`、`settings/OpenCodeProvidersSection.tsx:657`、`session/CommandModal.tsx:361`、
      `session/ChatWorkspace.tsx:607-649`、`session/adapters/opencode.tsx:22`、`session/TurnBlock.tsx:437`、`settings/BackendSection.tsx:91`。
- [x] #15 `monitor.css:123` 计数 `--text` + 500 字重 → `--text-faint` + regular（与 `deck-ui.css:240` 对齐）。
- [x] #16 `overlays.css:210-212,254` — accent 染行底/文字标「当前」行 → `--surface-selected` / 中性文字。
- [x] #17 裸 `<button className="primary">` / `.text-btn` / `.icon-btn` 未迁移 kit `Button`：
      `session/CommandModal.tsx:121,195,240`、`session/ChatWorkspace.tsx:115-123,127-144,1312`、
      `overlays/RenameModal.tsx:42`、`overlays/ProviderSwitchModal.tsx:122-135`、`overlays/NewThreadModal.tsx:503-541,624`、
      `overlays/AskForm.tsx:92,110`、`overlays/ApprovalInbox.tsx:228-278`、`DirBrowser.tsx:75`、
      `App.tsx:1314,1332,1788,2015`、`ui.tsx:260-271`、`session/MessageQueue.tsx:46-54`、`session/TurnBlock.tsx:170,245,1298`、
      `session/Timeline.tsx:276-326`、`monitor/MonitorHealth.tsx:155`、`monitor/MonitorUsage.tsx:96`、
      `layout/SessionToolbar.tsx:234`、`usage/ContextBar.tsx:19-59`、`SearchablePicker.tsx:365`、
      `settings/SettingsModal.tsx:424`、`settings/OpenCodeProvidersSection.tsx:700`、`project/ProjectGroup.tsx:196-214,277-286`。
- [x] #18 零散手搓：`settings/MessageTypographySection.tsx:201` `<details>` → `Disclosure`；
      `settings/BackendSection.tsx:66` 内联 style → class。

## 🟡 低：重复实现与冗余文案（本轮尽量，剩余留档）

- [x] #19 `settings/BackendSection.tsx:160-501` — Local/Codex 两个 Section 约 140 行克隆（含逐字相同的 desc 与两条 Note）。
      修复：抽公共组件。
- [ ] #19b Local/Codex 两个运行时组件仍有约 100 行同构 JSX（CliVersionField + Group 提交区）；
      已抽共享描述与告警合成，主体可继续抽成同一组件。
- [ ] #20 「沙箱 + 审批」Select 对三处各写一遍：`session/CommandModal.tsx:152-209`、
      `overlays/NewThreadModal.tsx:554-603`、`overlays/ProjectDefaultsModal.tsx:230-279`。修复：抽共用组件。
- [ ] #21 手写 `<label>+<Select>` 字段块 → kit `Field`：`session/CommandModal.tsx:154-238`、
      `overlays/ProviderSwitchModal.tsx:95`、`overlays/NewThreadModal.tsx`（约 10 处）、
      `overlays/AskForm.tsx:70-107`、`overlays/RenameModal.tsx:33`、`ModelPicker.tsx:287-422`。
- [ ] #22 四套「图标+标题+正文」横幅 → kit `Note`：`session/ChatWorkspace.tsx:98-146`（TaskErrorNotice）、
      `:1298-1309`（lock-banner）、`session/AskNotice.tsx:11-17`、`overlays/ProviderSwitchModal.tsx:76-94`。
- [ ] #23 状态计数条双实现：`monitor/MonitorPanel.tsx:81-98` vs `layout/Sidebar.tsx:377-425` → 统一；
      agent 徽标三抄（`MonitorBoard.tsx:153`、`MonitorRecent.tsx:40`、`ProjectGroup.tsx:238`）、
      「···」菜单三抄（`MonitorBoard.tsx:171`、`MonitorRecent.tsx:61`、`ProjectGroup.tsx:218`）→ 抽组件。
- [x] #24 `kit.css:272-291` vs `:943-962` — `.ui-switch-row` 系列双定义且值冲突，前者死代码。修复：删前者。
- [x] #25 `deck-ui.css:878,954,897-924` vs `session-settings.css:29,157,62-91` — `.session-toolbar--panel` 等
      跨文件重复且 gap 值冲突；`session-settings.css:99-136` 写死 `40px/11px`。修复：合并到负责文件、换 token。
- [x] #26 死代码清理：`mobile-nav.css:124-141`（反制已删规则）、`sidebar.css:140-145`（选中态 accent+阴影，已被覆盖）、
      `sidebar.css:327-329`（fork 竖条残留）、`monitor.css:203-205`（渲染即隐藏的死图标 JSX）。
- [x] #27 「重载/重启生效」收敛为只说一次（title/toast）：`settings/CodexPage.tsx:211-266` 一屏三说
      （badge+hint+按钮）→ 留按钮语义；`settings/SettingsModal.tsx:64` 删导航 desc 里的复述；
      `session/CommandModal.tsx:120,194,239` 同弹窗三遍 → 弹窗级一处。
- [x] #28 同屏多 Note：`settings/BackendSection.tsx:287-297,445-469,355-360`（最多 4 条并存）→ 条件互斥或合并；
      `settings/OpenCodePermissionsSection.tsx:153-156` 双 Note 可同时成立 → 合并。
- [x] #29 用词与语义分裂：`usage/UsageChip.tsx:189 vs 393` 免责声明两遍 → 留一处；
      `layout/ChatHeader.tsx:106 vs 211` Claude/Deck 主语 → 统一 Deck；`welcome/Welcome.tsx:42`「官方额度」→「Codex 额度」；
      `overlays/AskForm.tsx:87` / `session/AskNotice.tsx:13`「Effort」→「推理强度」；
      `tasks/TaskCenter.tsx:251 vs 273`「停止整个任务」/「中断当前轮次」语义对齐；
      展开脚注量词「条/个」统一（`MonitorBoard.tsx:485`、`MonitorRecent.tsx:153`、`ProjectGroup.tsx:333`）。
- [x] #30 超一行/含步骤的 desc 收敛（放 title 或精简）：`settings/SessionPage.tsx:133,23`、
      `overlays/AskForm.tsx:69,101`、`monitor/MonitorPanel.tsx:257-260`、`settings/BackendSection.tsx:348-351`、
      `session/ApprovalCard.tsx:459`、`session/AskNotice.tsx:14`（API 名不进常驻条）、`overlays/WakeModal.tsx:211-245`。
- [ ] #31 `settings/ProvidersPage.tsx:283` vs `OpenCodeProvidersSection.tsx:525` 弹窗表单壳同构 → 抽共享 FormDialog。
- [ ] #32 其余跨文件重复选择器（约 80 处，chat/deck-ui/sidebar 等，多为允许的 pivot delta）
      → 按 baseline §5 逐步合并；本轮先完成 #24/#25 点名的冲突项，其余留档。
