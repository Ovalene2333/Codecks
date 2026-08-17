import { Monitor, Moon, Sparkles, Sun, ZapOff } from "lucide-react";
import type {
  AppearancePreferences,
  MotionPreference,
  ResolvedAppearance,
  ThemePreference,
} from "../appearance";
import { Modal } from "../ui";
import { ModeButton, ModeButtonGroup } from "../design-system/components";

const themeOptions: {
  value: ThemePreference;
  label: string;
  detail: string;
  icon: typeof Monitor;
}[] = [
  {
    value: "system",
    label: "跟随系统",
    detail: "自动匹配设备外观",
    icon: Monitor,
  },
  { value: "light", label: "浅色", detail: "始终使用浅色界面", icon: Sun },
  { value: "dark", label: "深色", detail: "始终使用深色界面", icon: Moon },
];

const motionOptions: {
  value: MotionPreference;
  label: string;
  detail: string;
  icon: typeof Monitor;
}[] = [
  {
    value: "system",
    label: "跟随系统",
    detail: "遵循减少动态效果设置",
    icon: Monitor,
  },
  {
    value: "on",
    label: "强制开启",
    detail: "显示等待与过渡动画",
    icon: Sparkles,
  },
  { value: "off", label: "关闭", detail: "停用非必要动画", icon: ZapOff },
];

export function AppearanceSettingsModal({
  preferences,
  resolved,
  onChange,
  onClose,
}: {
  preferences: AppearancePreferences;
  resolved: ResolvedAppearance;
  onChange: (patch: Partial<AppearancePreferences>) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="外观设置"
      className="appearance-settings-modal"
      onClose={onClose}
    >
      <div className="appearance-settings">
        <SettingGroup
          title="主题"
          value={preferences.theme}
          options={themeOptions}
          onChange={(theme) => onChange({ theme: theme as ThemePreference })}
        />
        <SettingGroup
          title="动画"
          value={preferences.motion}
          options={motionOptions}
          onChange={(motion) =>
            onChange({ motion: motion as MotionPreference })
          }
        />
        <p className="appearance-resolution" aria-live="polite">
          当前生效：{resolved.theme === "light" ? "浅色" : "深色"}主题 · 动画
          {resolved.motion === "on" ? "开启" : "关闭"}
        </p>
      </div>
    </Modal>
  );
}

function SettingGroup({
  title,
  value,
  options,
  onChange,
}: {
  title: string;
  value: string;
  options: {
    value: string;
    label: string;
    detail: string;
    icon: typeof Monitor;
  }[];
  onChange: (value: string) => void;
}) {
  return (
    <section
      className="appearance-group"
      aria-labelledby={`appearance-${title}`}
    >
      <h3 id={`appearance-${title}`}>{title}</h3>
      <ModeButtonGroup
        exclusive
        fullWidth
        className="appearance-options"
        value={value}
        aria-label={title}
        onChange={(_, next) => {
          if (next !== null) onChange(next);
        }}
      >
        {options.map((option) => {
          const Icon = option.icon;
          return (
            <ModeButton
              key={option.value}
              value={option.value}
              aria-label={option.label}
            >
              <span className="appearance-option-icon" aria-hidden="true">
                <Icon />
              </span>
              <span>
                <b>{option.label}</b>
                <small>{option.detail}</small>
              </span>
            </ModeButton>
          );
        })}
      </ModeButtonGroup>
    </section>
  );
}
