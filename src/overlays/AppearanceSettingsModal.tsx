import {
  Feather,
  Layers,
  Monitor,
  Moon,
  Sparkles,
  Sun,
  ZapOff,
} from "lucide-react";
import type {
  AppearancePreferences,
  EffectsPreference,
  MotionPreference,
  ResolvedAppearance,
  ThemePreference,
} from "../appearance";
import { Modal } from "../ui";

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

const effectsOptions: {
  value: EffectsPreference;
  label: string;
  detail: string;
  icon: typeof Monitor;
}[] = [
  {
    value: "on",
    label: "完整效果",
    detail: "玻璃模糊、柔和阴影与环境光",
    icon: Layers,
  },
  {
    value: "off",
    label: "省电简洁",
    detail: "纯色表面，停用模糊与大阴影",
    icon: Feather,
  },
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
        <SettingGroup
          title="界面效果"
          value={preferences.effects}
          options={effectsOptions}
          onChange={(effects) =>
            onChange({ effects: effects as EffectsPreference })
          }
        />
        <p className="appearance-resolution" aria-live="polite">
          当前生效：{resolved.theme === "light" ? "浅色" : "深色"}主题 · 动画
          {resolved.motion === "on" ? "开启" : "关闭"} · 效果
          {resolved.effects === "on" ? "完整" : "省电"}
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
    <fieldset className="appearance-group">
      <legend>{title}</legend>
      <div className="appearance-options">
        {options.map((option) => {
          const Icon = option.icon;
          const selected = option.value === value;
          return (
            <label className={selected ? "selected" : ""} key={option.value}>
              <input
                type="radio"
                name={`appearance-${title}`}
                value={option.value}
                checked={selected}
                onChange={() => onChange(option.value)}
              />
              <span className="appearance-option-icon" aria-hidden="true">
                <Icon />
              </span>
              <span>
                <b>{option.label}</b>
                <small>{option.detail}</small>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
