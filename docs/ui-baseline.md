# UI 基线

设置/表单类界面的统一规范。目标：任何新弹窗、新设置页默认就是一致的，
不再各自发明尺寸、间距与控件。

实现位置：

| 文件                | 职责                                             |
| ------------------- | ------------------------------------------------ |
| `src/tokens.css`    | 全部尺寸/颜色 token（唯一真源）                  |
| `src/kit.css`       | `ui-*` 组件样式（Button/Switch/Row/Section 等）  |
| `src/kit/index.tsx` | 组件原语，只负责结构与无障碍，视觉全部来自 token |
| `src/settings.css`  | 面板型弹窗外壳 `.ui-panel` + 设置页专属布局      |

预览页：`settings-harness.html`（vite 下打开），无后端、自带假 API，
可直接点按验证启用/重载/确认弹窗等交互。

## 尺寸 token（4px 栅格）

间距 `--space-1`…`--space-6`（4/8/12/16/20/24）。控件高度
`--control-h-sm` 28 / `--control-h` 36；行高 `--row-h` 56。
触屏（`pointer: coarse`）自动放大到 32/40/60。

弹窗：`--modal-w` 560、`--modal-h` 640、`--fs-modal-title` 17。

**新代码只写 token，不写裸 px**（发丝线 1px 与 switch 内部几何除外）。

## 面板型弹窗 `.ui-panel`

`Modal` 传 `className="ui-panel xxx"`。结构固定为：

```text
header（标题，固定）
.ui-panel__tabs（分段标签，固定，可选）
.ui-panel__body（唯一滚动区）
```

高度固定（`min(--modal-h, 100dvh - 32px)`），各标签共用同一高度——
切换标签弹窗不跳变。≤640px 时变成贴底面板：全宽、只留顶部圆角、
底部让出 `safe-area-inset`。

## 组件原语（`src/kit`）

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
| `Dot`     | 状态点，语义同监控台：ok/busy/warn/error/off                                 |
| `Note`    | 提示条：icon + 标题 + 正文 + 可选 action                                     |

约定：

- 一切正常不标注（行尾只标例外，如「待应用」「未装入」）。
- 错误详情只显示第一行，完整内容放 `title` 悬停。
- 进行中状态用 `busy`（按钮禁用 + 光标进度态），不手写 spinner 结构；
  图标旋转加 `.ui-spin`。
- `Row` 的 `dim` 表示已停用/弱化；`stack` 让窄屏时右侧控件折行；
  `onOpen` 把标题区变成按钮并在行尾加箭头（进二级页用）。
- `Section` 的 `scope="device"` 标「本设备」：值存在浏览器里，换设备不跟随；
  只标例外，服务端设置不用标。
- 字段标签中文（沙箱/审批/推理强度/权限模式），选项值（on-request、
  Workspace Write 等枚举 label）保持英文与后端一致。

## 设置弹窗外壳 `.settings-modal`

`ui-panel` + `settings-modal`：桌面左侧固定导航（`--settings-nav-w`），
供应商等不常用项放导航底部 `is-minor`；≤640px 改成两档——先是分类列表
（`.settings-index`），点进去是页面，标题栏左侧出现返回
（`Modal` 的 `leading`）。二级页用 `useOverlayHistory` 各占一格历史：
系统返回 / Esc 先退回上一级。

各页表单经 `DirtyContext`（`useDirtyFlag("页面:表单", dirty)`）向外壳
汇报未保存修改：导航项点圆点，关闭前弹确认（`onClose` 返回 `false`
即拒绝关闭，外壳重新压回弹层占位）。

## 交互行为：借无头库，不借外观

行为复杂的控件（焦点管理、键盘导航、aria 状态）内部用 Radix 无头
原语实现——目前 `Switch` 是 `@radix-ui/react-switch`，`Seg` 是
`@radix-ui/react-tabs`。样式始终来自 `kit.css` 的 `ui-*` class，
调用方签名不变。不要引入带样式的成品组件库（视觉语言与本项目
不一致）；新增行为型控件（Tooltip/Popover/Menu/Dialog 等）时优先
按同一模式接入 Radix。

## 色彩

组件一律用语义 token（`--text-*`、`--surface-*`、`--line`、`--accent`
与 `ok/wait/danger/info` 状态色），深浅两套主题都已在 `tokens.css`
定义，新组件不需要（也不应该）写主题分支。

## 既有代码的迁移

旧弹窗里的 `.sync-note` → `Note`、`.provider-list/.provider-row` →
`Group` + `Row`、手写 label 块 → `Field`、裸 `<button>` → `Button`。
迁移后顺手删掉对应的旧 CSS。
