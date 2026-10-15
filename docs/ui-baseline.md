# UI 标准

Codex Deck 是一个远程控制台：用户来这里看状态、批准命令、读结果。界面要像一件趁手的工具，
安静、准确、信息优先，而不是一张展示页。本文件是前端视觉与交互的唯一标准，
新界面和改动都按这里执行；与旧代码冲突时，以本文件为准并顺手迁移旧代码。

## 1. 原则

1. **内容优先，界面退后。** 颜色、边框、阴影只用来区分层级和表达状态，不用来装饰。
2. **一处强调。** 一屏只有一个主操作（反相实心按钮）；状态色只出现在需要人处理的地方。
3. **正常不标注。** 一切正常时保持安静，只标出例外：待确认、异常、接近上限。
4. **同类同形。** 同一种信息在任何页面长得一样：状态点、计数、元信息、区块标题都只有一种写法。
5. **桌面与触屏都是正式场景。** 减少的是包装和留白，不是触控命中区域。

## 2. Token（`src/tokens.css`）

全部尺寸、颜色、字体都来自 `tokens.css`。组件只写语义 token，不写裸色值，
也不写主题分支（深浅两套已在 token 层处理）。发丝线 1px 与少量图标几何可以写裸 px。

### 颜色

| 用途 | Token | 说明 |
| --- | --- | --- |
| 画布 / 侧栏 | `--bg` / `--sidebar` | 中性石墨（深色）或近白（浅色），不偏蓝紫 |
| 面板 / 弹出层 | `--surface` / `--surface-raised` | 弹出层只比面板亮一档 |
| 内嵌区（代码、命令） | `--surface-muted` | |
| 悬停 / 选中 | `--surface-hover` / `--surface-selected` | 半透明叠加，列表行、导航、分段控件共用 |
| 分隔线 | `--line` / `--line-strong` | 默认用 `--line`；需要独立容器时用 `--line-strong` |
| 文字 | `--text` / `--text-soft` / `--text-dim` / `--text-faint` | 正文 / 次要正文 / 标签 / 元信息 |
| 主操作 | `--primary` / `--primary-text` | 深色下浅底深字，浅色下深底白字 |
| 强调色 | `--accent` | 只用于焦点环、链接、进度与选择控件内部（开关、单选），不做按钮底色 |
| 状态 | `--ok` / `--wait` / `--danger` / `--info` | 见「状态表达」 |

禁止：渐变底色、渐变文字、发光阴影、毛玻璃 `backdrop-filter`、给普通容器整块着色。

### 字体与字号

- 无衬线 `--font-sans`（Geist + 系统中文字体）；等宽 `--font-mono` **只用于代码、命令、路径与 diff**。
  数字统计、计数、百分比用无衬线 + `tabular-nums`，不用等宽字体装饰。
- 字号语义槽只有 8 个：`--fs-micro` 11（微标/计数）· `--fs-meta` 12（元信息）· `--fs-ui` 13（界面控件）·
  `--fs-body` 14（正文）· `--fs-title` 15（小标题）· `--fs-dialog` 16（弹窗与空态标题）·
  `--fs-heading` 18（页标题）· `--fs-display` 28（大数字与欢迎标题，≤760px 自动降到 22）。
  旧别名 `--fs-caption` 已并入 `--fs-meta`，全站只有 `--fs-meta`。新代码不写裸 `font-size: Npx`。
- 字重只有三档：`--fw-regular` 400、`--fw-medium` 500、`--fw-strong` 600。
  600 只给页标题与品牌名；列表标题、区块标题、按钮都用 500；正文与元信息用 400。
- 行高只有四档：`--lh-flat` 1（按钮/徽标等单行控件）· `--lh-tight` 1.25（标题与紧凑行）·
  `--lh-ui` 1.45（界面正文）· `--lh-body` 1.65（消息正文）。±0.15 内就近并入，不新增档位。

### 形状与尺寸

- 圆角：`--radius-xs` 4（徽标、键帽、细装饰条）· `--radius-sm` 6（按钮、输入框、列表行）·
  `--radius-md` 8（面板、独立容器）· `--radius-lg` 10（弹出菜单、浮窗）· `--radius-xl` 12（弹窗、底部面板）·
  `--radius-pill` 999（胶囊：进度条、药丸徽标）。`50%` 只给真正的圆（头像、状态圆点）；
  `0` 去圆角原样保留；其余裸值就近并入（1–3px→xs，5–7px→sm，16px 贴底面板→xl）。- 焦点光晕统一用 `--focus-halo`，各控件 `:focus` 不再各写透明度。
- 不随主题变的纯白（开关圆点等）用 `--static-white`，不用裸 `#fff`。
- 间距：4px 栅格 `--space-1…8`（4/8/12/16/20/24/32）。区块之间 24–32，区块内行距 8–12。
- 控件高度：`--control-h-sm` 28 / `--control-h` 32；触屏（`pointer: coarse`）自动放大到 34/40。
  关键操作（审批按钮、底栏、发送）在窄屏不低于 `--touch-h` 44。
- 阴影只用于浮在内容上方的层：`--shadow-md`（菜单、浮窗）、`--shadow-lg`（弹窗）、
  `--shadow-knob`（开关圆点与滑块圆钮的物理投影）。
  按钮、选中行、输入框、普通面板都不加阴影。

## 3. 组件规则

### 按钮

| 类型 | 外观 | 用在 |
| --- | --- | --- |
| 主操作 | `--primary` 实心，文字 `--primary-text` | 每屏一个：允许一次、新建（内容区）、发送、保存 |
| 次级 | `--control` 底 + `--control-border` 描边 | 拒绝、更多、侧栏「新建」、表单里的普通按钮 |
| 幽灵 | 无底无边，悬停 `--surface-hover` | 区块标题右侧的「明细」「管理」「全部已读」、图标按钮 |
| 危险 | `--danger-bg` + `--danger-border` | 删除、清空等不可逆操作 |

- 新代码用 `src/kit` 的 `Button`（`variant` default/primary/danger/ghost）。旧的 `.primary` / `.text-btn`
  已对齐到同一套外观，迁移时直接换成 `Button`。
- 「停止」不是危险操作，用次级样式 + 方块图标。

### 下拉选择

- 普通单选统一使用 `src/kit` 的 `Select`（Base UI Select），通过 `onValueChange` 返回值；支持空值、禁用项和分组。不要在业务页自行拼装弹层。
- 需要搜索的目录使用 `SearchablePicker`（Base UI Combobox）；模型业务继续由 `ModelPicker` 提供数据、连接筛选、推理强度与手动输入。大目录使用虚拟列表，键盘导航覆盖完整结果。
- 选择器共用控件背景、边框、箭头、焦点环、选中勾和弹层表面；操作菜单仍使用 `Menu`。
- 手机搜索选择以底部面板呈现，展开时不自动唤起键盘；触控目标至少 44px。Escape 先关闭选择器并返回触发按钮，不关闭外层设置弹窗。

### 状态表达

- 状态点 6px 圆点，不发光、不呼吸（只有短暂的「启动中」做动画）。
- 文字颜色：运行中、有新回复用 `--text-dim`，只有点着色；**待确认**用 `--wait`，**异常**用 `--danger`。
- 「在线」「正常」这类常态用 `--text-faint` 或干脆不写；异常时才用状态色。
- 进度条默认 `--text-dim`，接近上限才变 `--wait` / `--danger`。

### 计数与元信息

- 计数是紧跟在标签后的浅色数字（`--text-faint`），不加底色、不加圆框。
  只有移动端底栏的提醒角标可以用实心小圆。
- Agent 名、项目名、时间、模型都是 12px 元信息文字，不做彩色色块。
- 列表行与标题里的并列元信息用 8–12px 间距分隔（flex `gap`），不用「·」串起来；句子里的并列用中文标点。
  悬停提示（`title`）和底栏额度这类两项的紧凑指标可以保留「·」。

### 区块与容器

- 默认容器是「标题 + 分隔线 + 列表」，不套卡片。区块标题 13px / 500，后面跟浅色计数，
  右侧放幽灵按钮；标题前不放装饰图标。
- 只有需要人决策的内容（审批）使用独立容器：`--surface` 底、`--line-strong` 描边、`--radius-md`，
  内部不再嵌套卡片（会话入口是一行文字链接）。
- 列表行：悬停 `--surface-hover`，选中 `--surface-selected`，不加强调色竖条。
- 弹出层（菜单、审批浮窗、工具面板）：`--surface-raised` + `--line` 描边 + `--shadow-md`，不做毛玻璃。

### 文案

标题自明则零描述；描述只讲“是什么/有何不同”，不超过一行，不讲操作步骤。
`Note` 只留给阻断与丢数据风险，一屏最多一个；“改后重载/重启生效”这类事实只说一次
（优先放在操作按钮的 `title` 与操作后的 toast 里）。
并列信息用中文逗号，不用 `·` 串；英文专有名词（模型名、路径、URL、协议枚举）保留原文，
其余一律中文：`Key`→`密钥`、`Base URL`→`服务地址`、`State DB`→`索引`、`SDK 包`→`接口`。
- 错误详情只显示第一行，完整内容放 `title`。

### 图标

- 统一用 `lucide-react`，界面内 15–16px、`stroke-width` 默认；图标颜色跟随文字，
  只有表达状态时才着色（审批的盾牌用 `--wait`）。
- 应用内品牌标是单色线框 `layout/BrandMark.tsx`，随文字颜色变化；彩色 `assets/logo.svg`
  只用于 favicon 与 README。

### 动效

- 过渡 `--ease`（120ms），只用于颜色与透明度。不做位移悬停（`translateY`）、不做缩放强调。
- 尊重 `prefers-reduced-motion` 与设置里的「动画：关闭」。

## 4. 响应式

| 环境 | 要求 |
| --- | --- |
| 桌面（>1100px） | 侧栏 + 内容区；总览为主栏 + 右栏 |
| 平板（761–1100px） | 总览右栏下移成网格 |
| 手机（≤760px） | 底栏导航；状态计数单行横向滚动；审批按钮、底栏、发送键 ≥44px |

不依赖 hover 才出现的关键操作；hover 才显示的次要操作（行尾「···」）在触屏常显。

## 5. 文件分工

| 文件 | 职责 |
| --- | --- |
| `src/tokens.css` | 全部 token（唯一真源）、深浅主题与 `data-motion`/`data-effects` 开关 |
| `src/kit.css` + `src/kit/index.tsx` | `ui-*` 组件原语：Button / Switch / Seg / Choice / Row / Section / Badge / Dot / Note / Disclosure / SearchField / Empty |
| `src/settings.css` | 面板型弹窗外壳 `.ui-panel` 与设置页布局 |
| `src/deck-ui.css` | 应用外壳：侧栏、底栏额度、会话页头部 |
| `src/monitor.css` | 总览 |
| `src/chat.css` | 会话页：时间线、工具行、审批卡、输入框 |
| `src/styles.css` | 全局元素样式与旧版通用类（primary/text-btn 等）的历史归口 |

旧的历史覆盖层 `polish.css` / `appearance.css` 已整体并入上述责任文件并删除：
同一选择器只保留最终渲染值，级联位置随迁（属性级 delta 追加在 pivot 文件末尾）。

样式按 `main.tsx` 的引入顺序层叠，后引入的同权重规则生效。新样式写进负责该区域的文件；
发现同一选择器在多个文件重复定义时，合并到负责的文件并删掉旧的那份。

## 6. 核对方式

- `demo-harness.html`：整站演示页，假数据覆盖侧栏、总览、审批、会话页、设置；`?theme=light` 切浅色。
  改完界面在这里看桌面宽屏与手机窄屏（390px）两种视口、深浅两套主题。
- `settings-harness.html` / `monitor-harness.html` / `list-harness.html`：单块预览，参数见各文件头部注释。
- README 截图从 `demo-harness.html` 生成：桌面 1280×800、手机 390×844，2 倍像素。

---

## 附：设置与表单界面

设置/表单类界面在上面的标准之上，还有以下约定。

### 面板型弹窗 `.ui-panel`

`Modal` 传 `className="ui-panel xxx"`。结构固定为：

```text
header（标题，固定）
.ui-panel__tabs（分段标签，固定，可选）
.ui-panel__body（唯一滚动区）
```

高度固定（`min(--modal-h, 100dvh - 32px)`），各标签共用同一高度，切换标签弹窗不跳变。
≤640px 时变成贴底面板：全宽、只留顶部圆角、底部让出 `safe-area-inset`。

### 组件原语（`src/kit`）

| 组件      | 用途                                                                         |
| --------- | ---------------------------------------------------------------------------- |
| `Section` | 一块内容：标题 + 可选描述 + 右上角 `actions`；`scope="device"` 加「本设备」badge |
| `Group`   | 一组设置项的圆角卡片，`pad` 时内部留表单边距                                 |
| `Row`     | 一行设置项：状态点/首字母块 + 标题 + badges + desc + side；`onOpen` 变下一级入口行 |
| `Field`   | 表单字段：label + 控件 + hint；控件是一组按钮（Choice 等）时加 `group`        |
| `Button`  | `variant` default/primary/danger/ghost，`size` sm/md，<br>`iconOnly`、`busy` |
| `Switch`  | 开关，`label` 必填（读屏名称）                                               |
| `Seg`     | 分段控件/标签页，支持方向键 + roving tabindex                                |
| `Choice`  | 单选分段控件（role=radiogroup）：改一个值，与 Seg 同外观不同语义             |
| `Kbd`     | 键帽，快捷键说明里的单个键                                                   |
| `Badge`   | 状态小标，`tone` neutral/ok/info/warn/danger/accent                          |
| `Dot`     | 状态点，语义同总览：ok/busy/warn/error/off                                   |
| `Note`    | 提示条：icon + 标题 + 正文 + 可选 action                                     |
| `Disclosure` | 折叠区（Base UI Collapsible）：高级/次要表单默认收起，标题 + 可选 meta 摘要 |
| `SearchField` | 列表过滤搜索框：长列表顶部过滤，无结果时显示空态                          |
| `Empty`   | 空态：图标 + 标题 + 可选描述 + 可选操作；总览、搜索无结果、空列表共用        |

- 进行中状态用 `busy`（按钮禁用 + 光标进度态），不手写 spinner 结构；图标旋转加 `.ui-spin`。
- `Row` 的 `dim` 表示已停用/弱化；`stack` 让窄屏时右侧控件折行；
  `onOpen` 把标题区变成按钮并在行尾加箭头（进二级页用）。
- `Section` 的 `scope="device"` 标「本设备」：值存在浏览器里，换设备不跟随；只标例外。

### 设置弹窗外壳 `.settings-modal`

`ui-panel` + `settings-modal`：桌面左侧分组固定导航（通用 / 模型与 Agent / 系统，
对标 shadcn Settings Page 的 SidebarGroup），≤640px 改成同构分组的分类列表，点进去是页面，标题栏左侧出现返回
（`Modal` 的 `leading`）。新增/编辑表单走弹窗 Dialog + 底部 sticky 操作
（`.ui-form-dialog`），不把列表顶下去；长列表顶部配 `SearchField` 过滤；次要表单收进 `Disclosure`。二级页用 `useOverlayHistory` 各占一格历史：系统返回 / Esc 先退回上一级。

各页表单经 `DirtyContext`（`useDirtyFlag("页面:表单", dirty)`）向外壳汇报未保存修改：
导航项点圆点，关闭前弹确认（`onClose` 返回 `false` 即拒绝关闭，外壳重新压回弹层占位）。

### 交互行为：借无头库，不借外观

行为复杂的控件（焦点管理、键盘导航、aria 状态）内部用 Radix 无头原语实现：`Switch` 是
`@radix-ui/react-switch`，`Seg` 是 `@radix-ui/react-tabs`。样式始终来自 `kit.css` 的 `ui-*` class。
不要引入带样式的成品组件库；新增行为型控件（Tooltip/Popover/Menu/Dialog 等）时按同一模式接入 Radix。

### 既有代码的迁移

旧弹窗里的 `.sync-note` → `Note`、`.provider-list/.provider-row` → `Group` + `Row`、
手写 label 块 → `Field`、裸 `<button>` → `Button`、各写一套的空态 → `Empty`。
迁移后顺手删掉对应的旧 CSS。

### 例外清单与自查

以下裸值是功能性的，不并入 token，改动时保留并带注释：

| 裸值 | 位置 | 原因 |
| --- | --- | --- |
| `font-size: 16px`（触屏输入框） | `kit.css` / `chat.css` / `search-picker.css` | 低于 16px 时 iOS Safari 聚焦会整页放大 |
| `em` 字号（`1.08em` 等） | `chat.css` 消息排版 | 跟随用户可调的 `--message-size` 缩放 |
| `line-height: 40px` | `chat.css` `.composer-model-label` | 与定高 40px 锁死的垂直居中 hack |
| `font-size: 0` | 图标字排版 | 图文隐藏术 |
| `border-radius: 50% / 0` | 各处 | 真圆与去圆角 |

发版前自查（应无输出；`50%/0` 与上表例外除外）：

```bash
grep -rn "font-size: *[0-9]" src/*.css | grep -v "var(--fs" | grep -v "var(--message" | grep -v inherit
grep -rn "border-radius: *[0-9]" src/*.css | grep -v "var(--radius" | grep -vE "border-radius: (0|50%)"
grep -rn "line-height: *[0-9]" src/*.css | grep -v "var(--lh"
grep -rn "fs-small\|fs-modal-title\|#fff\b" src/*.css src/*.tsx | grep -v tokens.css
```
