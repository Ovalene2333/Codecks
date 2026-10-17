import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const askConfigurationSchema = z.object({
  providerId: z.string().trim().max(200).optional(),
  model: z.string().trim().max(300).optional(),
  reasoningEffort: z.string().trim().max(100).optional(),
});
export type AskConfiguration = z.infer<typeof askConfigurationSchema>;

/** Explicit model/provider overrides must not inherit settings from a different model. */
export function resolveAskConfiguration(defaults: AskConfiguration, override?: AskConfiguration): AskConfiguration {
  if (!override) return { ...defaults };
  return Object.fromEntries(Object.entries(override).filter(([, value]) => !!value));
}

export class AskSettingsStore {
  private data: Record<string, AskConfiguration> = {};
  private writes = Promise.resolve();
  constructor(private file: string) {}
  async load() {
    try {
      const parsed = z.record(z.string(), askConfigurationSchema).parse(JSON.parse(await readFile(this.file, "utf8")));
      this.data = parsed;
    } catch (error: any) {
      if (error.code !== "ENOENT") throw new Error(`询问默认配置读取失败：${error.message}`);
    }
  }
  get(agentId: string) { return { ...this.data[agentId] }; }
  async set(agentId: string, configuration: AskConfiguration) {
    this.data[agentId] = resolveAskConfiguration({}, configuration);
    const snapshot = JSON.stringify(this.data, null, 2);
    const write = this.writes.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.writes = write;
    await write;
    return this.get(agentId);
  }
}
