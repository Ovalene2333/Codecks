import type {
  AppearancePreferences,
  EffectsPreference,
  MotionPreference,
  ResolvedAppearance,
  ThemePreference,
} from "../appearance";
import { Choice, Group, Row, Section } from "../kit";
import { MessageTypographySection } from "./MessageTypographySection";

export interface AppearanceControl {
  preferences: AppearancePreferences;
  resolved: ResolvedAppearance;
  update: (patch: Partial<AppearancePreferences>) => void;
}

/** 界面：外观与阅读。全部是本设备偏好，改了立即生效，没有保存按钮。 */
export function InterfacePage({
  appearance,
}: {
  appearance: AppearanceControl;
}) {
  const { preferences, resolved, update } = appearance;
  return (
    <>
      <Section title="外观" scope="device">
        <Group>
          <Row
            stack
            title="主题"
            desc={
              preferences.theme === "system"
                ? `跟随系统，当前为${resolved.theme === "light" ? "浅色" : "深色"}`
                : undefined
            }
            side={
              <Choice<ThemePreference>
                label="主题"
                value={preferences.theme}
                onChange={(theme) => update({ theme })}
                items={[
                  { value: "system", label: "跟随系统" },
                  { value: "light", label: "浅色" },
                  { value: "dark", label: "深色" },
                ]}
              />
            }
          />
          <Row
            stack
            title="动画"
            desc={
              preferences.motion === "system"
                ? `遵循系统「减少动态效果」，当前${resolved.motion === "on" ? "开启" : "关闭"}`
                : "等待指示与过渡动画"
            }
            side={
              <Choice<MotionPreference>
                label="动画"
                value={preferences.motion}
                onChange={(motion) => update({ motion })}
                items={[
                  { value: "system", label: "跟随系统" },
                  { value: "on", label: "开启" },
                  { value: "off", label: "关闭" },
                ]}
              />
            }
          />
          <Row
            stack
            title="界面效果"
            desc={
              preferences.effects === "on"
                ? "玻璃模糊、柔和阴影与环境光"
                : "纯色表面，停用模糊与大阴影，更省电"
            }
            side={
              <Choice<EffectsPreference>
                label="界面效果"
                value={preferences.effects}
                onChange={(effects) => update({ effects })}
                items={[
                  { value: "on", label: "完整" },
                  { value: "off", label: "省电" },
                ]}
              />
            }
          />
        </Group>
      </Section>
      <MessageTypographySection />
    </>
  );
}
