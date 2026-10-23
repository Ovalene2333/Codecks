import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const askModelConfigurationSchema = z.object({
  providerId: z.string().trim().max(200).optional(),
  model: z.string().trim().max(300).optional(),
  reasoningEffort: z.string().trim().max(100).optional(),
});
export const askPermissionSchema = z.object({
  approvalPolicy: z.enum(["untrusted", "on-request", "never"]).optional(),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).optional(),
  permissionMode: z.enum(["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]).optional(),
});
const permissionChoicesSchema = z.object({
  approvalPolicy: z.array(askPermissionSchema.shape.approvalPolicy.unwrap()).max(10).optional(),
  sandbox: z.array(askPermissionSchema.shape.sandbox.unwrap()).max(10).optional(),
  permissionMode: z.array(askPermissionSchema.shape.permissionMode.unwrap()).max(10).optional(),
});
export const askConfigurationSchema = askModelConfigurationSchema.extend(askPermissionSchema.shape).extend({
  allowedPermissions: permissionChoicesSchema.optional(),
});
export type AskConfiguration = z.infer<typeof askConfigurationSchema>;

/** Model replacement preserves independent user permission defaults, never the allowed-choice policy. */
export function resolveAskConfiguration(defaults: AskConfiguration, override?: AskConfiguration): AskConfiguration {
  if (!override) { const { allowedPermissions: _allowed, ...configuration } = defaults; return configuration; }
  const permissions = Object.fromEntries(Object.keys(askPermissionSchema.shape).map((key) => [key, defaults[key as keyof AskConfiguration]]).filter(([, value]) => !!value));
  const { allowedPermissions: _allowed, ...configuration } = override;
  return { ...permissions, ...Object.fromEntries(Object.entries(configuration).filter(([, value]) => !!value)) };
}

/** Native modes are not ordered. The host's user-maintained allowlist defines choices. */
export function boundedAskPermissions(defaults: AskConfiguration, requested: z.infer<typeof askPermissionSchema>) {
  const result: Record<string, string> = {};
  for (const key of Object.keys(askPermissionSchema.shape) as (keyof z.infer<typeof askPermissionSchema>)[]) {
    const value = requested[key];
    const allowed = defaults.allowedPermissions?.[key] as string[] | undefined;
    if (value !== undefined) {
      if (!allowed?.includes(value)) throw new Error(`所请求的 ${key} 不在用户允许集合中`);
      result[key] = value;
    } else if (defaults[key]) result[key] = defaults[key];
  }
  return askPermissionSchema.parse(result);
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
    this.data[agentId] = askConfigurationSchema.parse(configuration);
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
