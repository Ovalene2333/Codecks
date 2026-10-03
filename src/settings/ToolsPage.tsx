import { ExternalLink } from "lucide-react";
import { toolIcon } from "../../plugin/client-registry";
import type { ToolDescriptor } from "../../plugin/types";
import {
  updateDeckSettings,
  useDeckSettings,
  type ToolOpenTarget,
} from "../deck-settings";
import { Badge, Button, Choice, Group, Row, Section, Switch } from "../kit";

/** 旧服务端快照里没有 tools 时的兜底列表（与 plugin/*.server.ts 一致）。 */
const FALLBACK_TOOLS: ToolDescriptor[] = [
  { id: "terminal", name: "Web Terminal", description: "通过浏览器连接服务端所在主机的交互式终端", icon: "terminal", available: true },
  { id: "git", name: "Git 管理", description: "查看改动、管理暂存区与分支，并同步远端仓库", icon: "git", available: true },
  { id: "text-editor", name: "文本编辑器", description: "浏览宿主机文件系统，查看、编辑、查找并保存文本文件", icon: "text-editor", available: true },
  { id: "commands", name: "快捷指令", description: "在指定目录一键执行常用指令", icon: "commands", available: true },
];

/** 工具：菜单里显示哪些工具、桌面端怎么打开。本设备偏好。 */
export function ToolsPage({
  tools,
  mobile,
  onOpenTool,
}: {
  tools?: ToolDescriptor[];
  mobile: boolean;
  onOpenTool?: (path: string) => void;
}) {
  const settings = useDeckSettings();
  const list = tools?.length ? tools : FALLBACK_TOOLS;
  const hidden = new Set(settings.hiddenTools);
  const setVisible = (id: string, visible: boolean) => {
    const next = new Set(hidden);
    if (visible) next.delete(id);
    else next.add(id);
    updateDeckSettings({ hiddenTools: [...next] });
  };
  return (
    <>
      <Section
        title="工具菜单"
        scope="device"
        desc="关闭的工具不显示在侧栏与底栏的工具菜单中；直接访问链接仍可使用。"
      >
        <Group>
          {list.map((tool) => {
            const Icon = toolIcon(tool.id);
            const visible = !hidden.has(tool.id);
            return (
              <Row
                key={tool.id}
                dim={!visible}
                title={
                  <>
                    <span className="settings-tool-icon" aria-hidden="true">
                      <Icon />
                    </span>
                    {tool.name}
                  </>
                }
                badges={
                  tool.available ? null : (
                    <Badge tone="warn" title={tool.unavailableReason}>
                      不可用
                    </Badge>
                  )
                }
                desc={
                  tool.available
                    ? tool.description
                    : tool.unavailableReason || tool.description
                }
                side={
                  <>
                    {onOpenTool && tool.available ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        iconOnly
                        title={`打开${tool.name}`}
                        aria-label={`打开${tool.name}`}
                        onClick={() =>
                          onOpenTool(tool.pagePath || `/${tool.id}`)
                        }
                      >
                        <ExternalLink />
                      </Button>
                    ) : null}
                    <Switch
                      label={`在工具菜单中显示${tool.name}`}
                      checked={visible}
                      onChange={(next) => setVisible(tool.id, next)}
                    />
                  </>
                }
              />
            );
          })}
        </Group>
      </Section>
      <Section title="打开方式" scope="device">
        <Group>
          <Row
            stack
            title="桌面端打开工具"
            desc={
              mobile
                ? "移动端始终在应用内打开；此项仅影响桌面浏览器。"
                : settings.toolOpenTarget === "tab"
                  ? "新标签页打开，不占用当前会话的返回记录"
                  : "在当前页打开，经返回键返回会话"
            }
            side={
              <Choice<ToolOpenTarget>
                label="桌面端打开工具的方式"
                value={settings.toolOpenTarget}
                onChange={(toolOpenTarget) =>
                  updateDeckSettings({ toolOpenTarget })
                }
                items={[
                  { value: "tab", label: "新标签页" },
                  { value: "inline", label: "当前页" },
                ]}
              />
            }
          />
        </Group>
      </Section>
    </>
  );
}
