import { Fragment, type ReactNode } from "react";
import { modKeyLabel, useDeckSettings } from "../deck-settings";
import { Group, Kbd, Row, Section } from "../kit";

type Shortcut = { keys: string[][]; title: string; desc?: string };

/** keys：外层是「或」，内层是同时按下的组合。 */
function Keys({ keys }: { keys: string[][] }) {
  return (
    <span className="settings-keys">
      {keys.map((combo, index) => (
        <Fragment key={combo.join("+")}>
          {index > 0 ? <span className="settings-keys__or">或</span> : null}
          <span className="settings-keys__combo">
            {combo.map((key) => (
              <Kbd key={key}>{key}</Kbd>
            ))}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

function ShortcutGroup({
  title,
  desc,
  items,
}: {
  title: string;
  desc?: ReactNode;
  items: Shortcut[];
}) {
  return (
    <Section title={title} desc={desc}>
      <Group>
        {items.map((item) => (
          <Row
            key={item.title}
            stack
            title={item.title}
            desc={item.desc}
            side={<Keys keys={item.keys} />}
          />
        ))}
      </Group>
    </Section>
  );
}

/**
 * 快捷键一览（只读）。条目与各处 keydown 处理器一一对应：
 * shortcuts.ts（Esc）、Sidebar（/、Mod+K）、Composer、MonitorApprovals、
 * 终端与文本编辑器插件。改了键位记得同步这里。
 */
export function ShortcutsPage() {
  const { sendKey } = useDeckSettings();
  const mod = modKeyLabel();
  const send: Shortcut =
    sendKey === "enter"
      ? { title: "发送", keys: [["Enter"]] }
      : { title: "发送", keys: [[mod, "Enter"]] };
  const newline: Shortcut =
    sendKey === "enter"
      ? { title: "换行", keys: [["Shift", "Enter"]] }
      : { title: "换行", keys: [["Enter"]] };
  return (
    <>
      <ShortcutGroup
        title="全局"
        desc="桌面端键盘快捷键；移动端软键盘不产生这些按键。"
        items={[
          {
            title: "分层退出",
            desc: "依次：关闭最上层弹窗 → 输入框失焦 → 回到总览。终端内的 Esc 保留给 shell。",
            keys: [["Esc"]],
          },
          {
            title: "搜索会话",
            desc: "聚焦侧栏搜索框（不在输入框里时）",
            keys: [["/"], [mod, "K"]],
          },
        ]}
      />
      <ShortcutGroup
        title="输入框"
        desc="发送键可在「会话 › 输入」中切换。"
        items={[
          send,
          newline,
          {
            title: "斜杠命令",
            desc: "行首输入 / 弹出命令菜单",
            keys: [["/"]],
          },
          { title: "在命令菜单中移动", keys: [["↑"], ["↓"]] },
          {
            title: "补全 / 执行命令",
            desc: "Tab 只补全；Enter 补全并执行面板类命令",
            keys: [["Tab"], ["Enter"]],
          },
          {
            title: "附加图片",
            desc: "或将图片拖入输入框",
            keys: [[mod, "V"]],
          },
        ]}
      />
      <ShortcutGroup
        title="总览"
        items={[
          {
            title: "切换审批卡片",
            desc: "多个待审批时",
            keys: [["←"], ["→"]],
          },
        ]}
      />
      <ShortcutGroup
        title="工具"
        items={[
          {
            title: "终端：复制选中内容",
            keys: [["Ctrl", "Shift", "C"]],
          },
          {
            title: "终端：粘贴",
            keys: [
              ["Ctrl", "Shift", "V"],
              ["Shift", "Insert"],
            ],
          },
          { title: "文本编辑器：保存", keys: [[mod, "S"]] },
          { title: "文本编辑器：查找", keys: [[mod, "F"]] },
        ]}
      />
    </>
  );
}
