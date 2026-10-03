import { useState, type CSSProperties } from "react";
import { useDeckSettings, updateDeckSettings } from "../deck-settings";
import {
  DEFAULT_MESSAGE_TYPOGRAPHY,
  MESSAGE_PRESETS,
  TYPOGRAPHY_RANGES,
  messageTypographyVariables,
  sameTypography,
  type MessageTypography,
} from "../message-typography";
import { Button, Choice, Group, Row, Section } from "../kit";
import { AssistantMarkdown } from "../session/markdown";

const PREVIEW = `## 消息排版预览
这是一段中文与 English 混排的回复。**重点结论**应该容易找到，\`session.turns\` 等代码也应该清晰可读。

下一段留出适当距离，长回答读起来更轻松。

### 建议的处理步骤
1. 保留清晰的标题层级，方便快速浏览。
2. 调整段落与列表间距，让每一项有自己的空间。这是一条较长的说明，用于观察换行后的阅读效果。

| 类型 | 大小 | 说明 |
| --- | --- | --- |
| Buffer | ~21MB | 原始输出与缓存 |
| 堆内存 | 278MB | 会话消息、工具结果与其他对象 |

\`\`\`ts
const message = "中文与 English";
console.log(message);
\`\`\``;

export function MessageTypographySection() {
  const settings = useDeckSettings();
  const typography = settings.messageTypography;
  const [name, setName] = useState("");
  const templates = [...MESSAGE_PRESETS, ...settings.messageTemplates];
  const selected = templates.find((item) =>
    sameTypography(item.typography, typography),
  );
  const patch = (value: Partial<MessageTypography>) =>
    updateDeckSettings({ messageTypography: { ...typography, ...value } });
  const saveTemplate = () => {
    const trimmed = name.trim();
    if (!trimmed || settings.messageTemplates.length >= 12) return;
    updateDeckSettings({
      messageTemplates: [
        ...settings.messageTemplates,
        {
          id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: trimmed,
          typography: { ...typography },
        },
      ],
    });
    setName("");
  };
  return (
    <Section
      title="消息排版"
      scope="device"
      desc="选用模板后可继续微调，立即生效；自定义模板随设置一起导入导出。"
      actions={
        <Button
          size="sm"
          onClick={() =>
            updateDeckSettings({
              messageTypography: DEFAULT_MESSAGE_TYPOGRAPHY,
            })
          }
        >
          恢复原始
        </Button>
      }
    >
      <Group>
        <Row
          stack
          title="排版模板"
          desc={selected ? `当前：${selected.name}` : "当前：自定义"}
          side={
            <select
              className="ui-input message-template-select"
              aria-label="排版模板"
              value={selected?.id || "custom"}
              onChange={(event) => {
                const template = templates.find(
                  (item) => item.id === event.target.value,
                );
                if (template)
                  updateDeckSettings({
                    messageTypography: template.typography,
                  });
              }}
            >
              <option value="custom" disabled>
                自定义
              </option>
              <optgroup label="内置模板">
                {MESSAGE_PRESETS.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </optgroup>
              {settings.messageTemplates.length > 0 && (
                <optgroup label="我的模板">
                  {settings.messageTemplates.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          }
        />
        <Row
          stack
          title="正文字体"
          side={
            <Choice<MessageTypography["font"]>
              label="正文字体"
              value={typography.font}
              onChange={(font) => patch({ font })}
              items={[
                { value: "sans", label: "无衬线" },
                { value: "system", label: "系统" },
                { value: "serif", label: "衬线" },
                { value: "mono", label: "等宽" },
              ]}
            />
          }
        />
        {(
          Object.keys(TYPOGRAPHY_RANGES) as (keyof typeof TYPOGRAPHY_RANGES)[]
        ).map((key) => {
          const range = TYPOGRAPHY_RANGES[key];
          return (
            <Row
              key={key}
              stack
              title={range.label}
              desc={
                key === "contentWidth"
                  ? "0 表示铺满；窄屏始终适应屏幕宽度。"
                  : undefined
              }
              side={
                <label className="message-range">
                  <input
                    type="range"
                    aria-label={range.label}
                    min={range.min}
                    max={range.max}
                    step={range.step}
                    value={typography[key]}
                    onChange={(event) =>
                      patch({ [key]: Number(event.target.value) })
                    }
                  />
                  <output>
                    {key === "contentWidth" && typography[key] === 0
                      ? "铺满"
                      : `${Number(typography[key].toFixed(2))}${range.unit}`}
                  </output>
                </label>
              }
            />
          );
        })}
        <Row
          stack
          title="行内代码底色"
          side={
            <Choice<MessageTypography["codeStyle"]>
              label="行内代码底色"
              value={typography.codeStyle}
              onChange={(codeStyle) => patch({ codeStyle })}
              items={[
                { value: "subtle", label: "淡底色" },
                { value: "plain", label: "无底色" },
              ]}
            />
          }
        />
        <Row
          stack
          title="表格样式"
          side={
            <Choice<MessageTypography["tableStyle"]>
              label="表格样式"
              value={typography.tableStyle}
              onChange={(tableStyle) => patch({ tableStyle })}
              items={[
                { value: "grid", label: "网格" },
                { value: "minimal", label: "简洁" },
              ]}
            />
          }
        />
      </Group>
      <details
        className="message-preview"
        open
        style={messageTypographyVariables(typography) as CSSProperties}
      >
        <summary>实时预览</summary>
        <div className="message agent">
          <AssistantMarkdown text={PREVIEW} />
        </div>
      </details>
      <Group>
        <Row
          stack
          title="保存为我的模板"
          desc={`${settings.messageTemplates.length}/12 个模板`}
          side={
            <form
              className="message-template-save"
              onSubmit={(event) => {
                event.preventDefault();
                saveTemplate();
              }}
            >
              <input
                className="ui-input"
                aria-label="模板名称"
                placeholder="模板名称"
                maxLength={30}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <Button
                type="submit"
                size="sm"
                disabled={
                  !name.trim() || settings.messageTemplates.length >= 12
                }
              >
                保存
              </Button>
            </form>
          }
        />
        {settings.messageTemplates.map((item) => (
          <Row
            key={item.id}
            title={item.name}
            side={
              <Button
                size="sm"
                variant="ghost"
                aria-label={`删除模板 ${item.name}`}
                onClick={() =>
                  updateDeckSettings({
                    messageTemplates: settings.messageTemplates.filter(
                      (template) => template.id !== item.id,
                    ),
                  })
                }
              >
                删除
              </Button>
            }
          />
        ))}
      </Group>
    </Section>
  );
}
