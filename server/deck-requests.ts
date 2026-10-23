import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { InboxError } from "./deck-inbox.js";

const ledgerSchema = z.object({ version: z.literal(1), items: z.array(z.object({
  scope: z.string(), id: z.string(), hash: z.string(), createdAt: z.number(),
  status: z.enum(["running", "completed", "failed"]), response: z.unknown().optional(), error: z.string().optional(),
})) });

export class DeckRequests {
  private data: z.infer<typeof ledgerSchema> = { version: 1, items: [] };
  private writes: Promise<unknown> = Promise.resolve();
  private active = new Map<string, Promise<unknown>>();
  private loadError?: string;
  constructor(private readonly file: string) {}
  async load() {
    try { this.data = ledgerSchema.parse(JSON.parse(await readFile(this.file, "utf8"))); }
    catch (error: any) { if (error.code !== "ENOENT") this.loadError = "请求回执台账损坏，已暂停新请求"; }
  }
  private save() {
    for (const item of this.data.items) if (Date.now() - item.createdAt >= 7 * 86400_000) delete item.response;
    const snapshot = JSON.stringify(this.data);
    const work = this.writes.catch(() => undefined).then(async () => {
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        await writeFile(temporary, snapshot, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.file);
      } catch { throw new InboxError("REQUESTS_UNAVAILABLE", "请求回执写入失败，请检查存储空间和权限", 503); }
    });
    this.writes = work;
    return work;
  }
  async execute<Result>(scope: string, id: string, input: unknown, operation: () => Promise<Result>): Promise<Result> {
    if (this.loadError) throw new InboxError("REQUESTS_UNAVAILABLE", this.loadError, 503);
    const key = JSON.stringify([scope, id]);
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const prior = this.data.items.find((entry) => entry.scope === scope && entry.id === id);
    if (prior) {
      if (prior.hash !== hash) throw new InboxError("REQUEST_CONFLICT", "请求 ID 已用于不同参数");
      if (Date.now() - prior.createdAt >= 7 * 86400_000) throw new InboxError("REQUEST_EXPIRED", "请求回执已过期");
      const active = this.active.get(key);
      if (active) return active as Promise<Result>;
      if (prior.status === "completed") return prior.response as Result;
      throw new InboxError("REQUEST_UNCERTAIN", prior.error || "请求期间服务重启；请核对任务列表与投递记录，不要自动重发");
    }
    const record = { scope, id, hash, createdAt: Date.now(), status: "running" as "running" | "completed" | "failed", response: undefined as unknown, error: undefined as string | undefined };
    this.data.items.push(record);
    const work = (async () => {
      await this.save();
      try {
        const response = await operation();
        record.response = response; record.status = "completed";
        await this.save();
        return response;
      } catch (error: any) {
        record.status = "failed"; record.error = String(error.message || error);
        await this.save();
        throw error;
      }
    })().finally(() => this.active.delete(key));
    this.active.set(key, work);
    return work;
  }
}
