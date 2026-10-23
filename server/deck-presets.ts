import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { askModelConfigurationSchema } from "./ask-settings.js";

export const deckPresetSchema = askModelConfigurationSchema
  .extend({
    name: z
      .string()
      .trim()
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/,
        "预设名须为 1–64 位字母、数字、- 或 _",
      ),
    agentId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
    model: z.string().trim().min(1, "请填写模型").max(300),
  })
  .strict();
export const deckPresetsSchema = z
  .array(deckPresetSchema)
  .max(100)
  .superRefine((items, ctx) => {
    const names = new Set<string>();
    items.forEach((item, index) => {
      if (names.has(item.name))
        ctx.addIssue({
          code: "custom",
          message: "预设名称重复",
          path: [index, "name"],
        });
      names.add(item.name);
    });
  });
export type DeckPreset = z.infer<typeof deckPresetSchema>;

/** Named model combinations are independent of per-agent permission defaults. */
export class DeckPresetsStore {
  private items: DeckPreset[] = [];
  private writes = Promise.resolve();
  constructor(private file: string) {}
  async load() {
    try {
      this.items = deckPresetsSchema.parse(
        JSON.parse(await readFile(this.file, "utf8")),
      );
    } catch (error: any) {
      if (error.code !== "ENOENT")
        throw new Error(`Deck 预设读取失败：${error.message}`);
    }
  }
  list() {
    return this.items.map((item) => ({ ...item }));
  }
  resolve(input: {
    preset?: string;
    targetAgentId?: string;
    configuration?: z.infer<typeof askModelConfigurationSchema>;
    providerId?: string;
    model?: string;
    reasoningEffort?: string;
  }) {
    if (!input.preset) {
      if (!input.targetAgentId) throw new Error("请指定目标 Agent 或预设");
      return {
        targetAgentId: input.targetAgentId,
        configuration:
          input.configuration ??
          (input.providerId || input.model || input.reasoningEffort
            ? {
                providerId: input.providerId,
                model: input.model,
                reasoningEffort: input.reasoningEffort,
              }
            : undefined),
      };
    }
    const preset = this.items.find((item) => item.name === input.preset);
    if (!preset)
      throw new Error(`预设不存在：${input.preset}，请用 presets 查看`);
    if (input.targetAgentId && input.targetAgentId !== preset.agentId)
      throw new Error("目标 Agent 与预设不一致");
    if (
      input.configuration !== undefined ||
      input.providerId ||
      input.model ||
      input.reasoningEffort
    )
      throw new Error(
        "预设不能与 provider / model / effort 覆盖同时使用，请修改预设或直接指定 Agent",
      );
    const { name: _name, agentId, ...configuration } = preset;
    return { targetAgentId: agentId, configuration };
  }
  async replace(value: unknown) {
    const items = deckPresetsSchema.parse(value);
    const pending = this.writes
      .catch(() => {})
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify(items, null, 2), {
          mode: 0o600,
        });
        await rename(temporary, this.file);
        this.items = items;
        return this.list();
      });
    this.writes = pending.then(
      () => {},
      () => {},
    );
    return pending;
  }
}
