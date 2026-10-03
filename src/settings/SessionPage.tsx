import { Send } from "lucide-react";
import {
  modKeyLabel,
  updateDeckSettings,
  useDeckSettings,
  type SendKey,
} from "../deck-settings";
import { Button, Choice, Group, Row, Section, Switch } from "../kit";
import {
  sendSystemNotification,
  type DeckNotificationPermission,
} from "../notifications";
import type {
  AgentDescriptor,
  DeckPreferences,
  Provider,
  Snapshot,
} from "../types";
import { SessionDefaultsSection } from "./SessionDefaultsSection";

const PERMISSION_TEXT: Record<DeckNotificationPermission, string> = {
  granted: "浏览器已授权，由下方开关控制推送。",
  denied: "已被浏览器拒绝；需在浏览器站点设置中重新允许通知。",
  default: "尚未授权。授权后，审批与新回复将推送系统通知。",
  unsupported: "当前浏览器不支持系统通知。",
};

/** 会话：新建默认值（服务端）+ 输入与提醒（本设备）。 */
export function SessionPage({
  agents,
  providers,
  preferences,
  notificationPermission,
  onRequestNotifications,
  onSaved,
  onToast,
}: {
  agents: AgentDescriptor[];
  providers: Provider[];
  preferences?: DeckPreferences;
  notificationPermission: DeckNotificationPermission;
  onRequestNotifications: () => void;
  onSaved: (snapshot: Snapshot) => void;
  onToast: (message: string) => void;
}) {
  const settings = useDeckSettings();
  const mod = modKeyLabel();
  const granted = notificationPermission === "granted";
  return (
    <>
      <SessionDefaultsSection
        agents={agents}
        providers={providers}
        preferences={preferences}
        onSaved={onSaved}
        onToast={onToast}
      />
      <Section title="输入" scope="device">
        <Group>
          <Row
            stack
            title="发送消息"
            desc={
              settings.sendKey === "enter"
                ? "Enter 发送，Shift+Enter 换行"
                : `${mod}+Enter 发送，Enter 换行`
            }
            side={
              <Choice<SendKey>
                label="发送消息的按键"
                value={settings.sendKey}
                onChange={(sendKey) => updateDeckSettings({ sendKey })}
                items={[
                  { value: "enter", label: "Enter" },
                  { value: "mod-enter", label: `${mod}+Enter` },
                ]}
              />
            }
          />
        </Group>
      </Section>
      <Section title="系统提醒" scope="device">
        <Group>
          <Row
            dot={
              granted
                ? "ok"
                : notificationPermission === "denied"
                  ? "error"
                  : "off"
            }
            title="通知权限"
            desc={PERMISSION_TEXT[notificationPermission]}
            side={
              notificationPermission === "default" ? (
                <Button size="sm" onClick={onRequestNotifications}>
                  开启
                </Button>
              ) : granted ? (
                <Button
                  size="sm"
                  title="发一条测试通知"
                  onClick={() => {
                    const sent = sendSystemNotification({
                      title: "Codex Deck · 测试通知",
                      body: "系统提醒工作正常",
                      tag: "codex-deck-test",
                      onClick: () => undefined,
                    });
                    onToast(sent ? "已发送测试通知" : "通知发送失败");
                  }}
                >
                  <Send />
                  测试
                </Button>
              ) : undefined
            }
          />
          <Row
            dim={!granted}
            title="需要审批"
            desc="Agent 请求执行命令或改文件时"
            side={
              <Switch
                label="需要审批时提醒"
                checked={settings.notifyApprovals}
                disabled={!granted}
                onChange={(notifyApprovals) =>
                  updateDeckSettings({ notifyApprovals })
                }
              />
            }
          />
          <Row
            dim={!granted}
            title="有新回复"
            desc="会话完成一轮回复且不在该会话页时"
            side={
              <Switch
                label="有新回复时提醒"
                checked={settings.notifyReplies}
                disabled={!granted}
                onChange={(notifyReplies) =>
                  updateDeckSettings({ notifyReplies })
                }
              />
            }
          />
          <Row
            dim={!granted}
            title="仅在后台时提醒"
            desc="页面位于前台时不推送，切至后台或锁屏后才通知"
            side={
              <Switch
                label="仅在页面不在前台时提醒"
                checked={settings.notifyOnlyHidden}
                disabled={!granted}
                onChange={(notifyOnlyHidden) =>
                  updateDeckSettings({ notifyOnlyHidden })
                }
              />
            }
          />
        </Group>
      </Section>
    </>
  );
}
