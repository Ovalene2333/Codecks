import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { MessageDeliveryQueue } from "./message-delivery.js";
import type { AskSession } from "./types.js";
import { sanitizeInline } from "./ask-service.js";

export const noticePolicySchema = z.object({
  resultReady: z.boolean().default(false), failure: z.boolean().default(true),
  detachedFailure: z.boolean().default(false), waiting: z.boolean().default(false),
  windowSeconds: z.number().int().min(0).max(3600).default(5),
  minIntervalSeconds: z.number().int().min(0).max(86400).default(60),
});
const noticeSchema = z.object({
  taskId: z.string(), turnId: z.string().optional(), key: z.string(), source: z.string(),
  agentId: z.string(), threadId: z.string(), alias: z.string(), kind: z.string(),
  detail: z.string().optional(), at: z.number(), deliveryId: z.string().optional(),
});
const digestSchema = z.object({
  id: z.string(), source: z.string(), agentId: z.string(), threadId: z.string(), text: z.string(), at: z.number(),
  state: z.enum(["pending", "accepted", "dead"]), attempts: z.number().int().min(0),
  nextAttemptAt: z.number().optional(), error: z.string().optional(),
});
const ledgerSchema = z.object({
  version: z.literal(1), policies: z.record(z.string(), noticePolicySchema),
  notices: z.array(noticeSchema), digests: z.array(digestSchema), seen: z.record(z.string(), z.boolean()),
});
type Policy = z.infer<typeof noticePolicySchema>;
type Notice = z.infer<typeof noticeSchema>;
type Outcome = AskSession & { turnId?: string; createdAt: number; updatedAt?: number; targetAgentId: string; replyDeliveryId?: string; suppressFailureNotice?: boolean };
const RETENTION_MS = 7 * 86400_000;

/** Deck host extension: system notices never merge or rewrite Agent messages. */
export class DeckNotices {
  private data: z.infer<typeof ledgerSchema> = { version: 1, policies: {}, notices: [], digests: [], seen: {} };
  private writes = Promise.resolve();
  private active = false;
  private loadError?: string;
  private persistenceFailed = false;
  constructor(private file: string, private messages: MessageDeliveryQueue) {}
  async load() {
    try { this.data = ledgerSchema.parse(JSON.parse(await readFile(this.file, "utf8"))); }
    catch (error: any) {
      if (error.code !== "ENOENT") {
        this.loadError = "通知台账格式无效，已暂停系统通知；修复文件后重启，原文件保留";
        console.error(this.loadError);
      }
    }
  }
  get(agentId: string, threadId: string) { return { ...(this.data.policies[JSON.stringify([agentId, threadId])] || noticePolicySchema.parse({})) }; }
  status(agentId: string, threadId: string) {
    const source = JSON.stringify([agentId, threadId]);
    return { error: this.loadError, dead: this.data.digests.filter((entry) => entry.source === source && entry.state === "dead").map(({ id, error }) => ({ id, error })) };
  }
  async configure(agentId: string, threadId: string, policy: Policy) {
    if (this.loadError) throw new Error(this.loadError);
    this.data.policies[JSON.stringify([agentId, threadId])] = noticePolicySchema.parse(policy);
    await this.save();
    return this.get(agentId, threadId);
  }
  /** Baseline restored outcomes without turning historical errors into new messages. */
  async baseline(items: Outcome[]) {
    if (this.loadError) return;
    let changed = false;
    for (const item of items) {
      const kind = item.resultAvailable ? "result-ready" : item.status === "failed" ? "failed" : item.waitingReason;
      if (!kind) continue;
      const key = `${item.id}:${item.turnId || "creating"}:${kind}`;
      if (!this.data.seen[key]) { this.data.seen[key] = true; changed = true; }
    }
    // Existing pending notices/digests retain their durable delivery and retry state.
    if (changed) await this.save();
  }
  private enabled(kind: string, policy: Policy, item?: Outcome) {
    return kind === "result-ready" ? policy.resultReady : kind === "failed"
      ? !(item?.replyDeliveryId || item?.suppressFailureNotice) && (item?.detached ? policy.detachedFailure : policy.failure)
      : policy.waiting;
  }
  async tick(items: Outcome[], now = Date.now()) {
    if (this.active || this.loadError) return;
    this.active = true;
    try {
      if (this.persistenceFailed) await this.save();
      let changed = false;
      const tasks = new Map(items.map((item) => [item.id, item]));
      for (const item of items) {
        const eventAt = item.updatedAt || item.createdAt;
        if (item.deletedAt || item.archivedAt || item.status === "cancelled") continue;
        const kind = item.resultAvailable ? "result-ready" : item.status === "failed" ? "failed" : item.waitingReason;
        if (!kind) continue;
        const key = `${item.id}:${item.turnId || "creating"}:${kind}`;
        if (this.data.seen[key]) continue;
        this.data.seen[key] = true; changed = true;
        if (eventAt < now - RETENTION_MS) continue;
        this.data.notices.push({ taskId: item.id, turnId: item.turnId, key, source: JSON.stringify([item.sourceAgentId, item.sourceThreadId]),
          agentId: item.sourceAgentId, threadId: item.sourceThreadId, alias: item.alias || item.id, kind, at: now,
          detail: kind === "failed" ? sanitizeInline(item.error) : undefined,
          deliveryId: this.enabled(kind, this.get(item.sourceAgentId, item.sourceThreadId), item) ? undefined : "suppressed" });
      }
      const groups = new Map<string, Notice[]>();
      for (const entry of this.data.notices.filter((entry) => !entry.deliveryId)) {
        const item = tasks.get(entry.taskId);
        if (!this.enabled(entry.kind, this.get(entry.agentId, entry.threadId), item) ||
          (item && (item.deletedAt || item.archivedAt || item.status === "cancelled" || item.turnId !== entry.turnId))) {
          entry.deliveryId = "suppressed"; changed = true; continue;
        }
        const group = groups.get(entry.source) || []; group.push(entry); groups.set(entry.source, group);
      }
      if (changed) await this.save();
      for (const [source, entries] of groups) {
        const first = entries[0]; const policy = this.get(first.agentId, first.threadId);
        const latest = this.data.digests.filter((entry) => entry.source === source).at(-1);
        if (now - first.at < policy.windowSeconds * 1000 || (latest && now - latest.at < policy.minIntervalSeconds * 1000)) continue;
        const id = `digest:${randomUUID()}`;
        const selected = entries.slice(0, 100);
        const label: Record<string, string> = { "result-ready": "结果就绪", failed: "执行失败", "waiting-approval": "等待审批", "backend-offline": "后端离线", unresolved: "等待匹配历史", stalled: "长时间无进展" };
        const text = `[deck:notice] ${selected.map((entry) => `@${entry.alias} ${label[entry.kind] || entry.kind}${entry.detail ? `：${entry.detail}` : ""}`).join("；")}。用 result / inspect 查看。`;
        this.data.digests.push({ id, source, agentId: first.agentId, threadId: first.threadId, text, at: now, state: "pending", attempts: 0 });
        for (const entry of selected) entry.deliveryId = id;
        await this.save(); // Exact body/id durable before enqueue, replayable across restart.
      }
      for (const digest of this.data.digests.filter((entry) => entry.state === "pending" && (entry.nextAttemptAt || 0) <= now)) {
        try {
          const receipt = await this.messages.enqueue(digest.agentId, digest.threadId, "queue", { text: digest.text }, { id: digest.id });
          digest.state = receipt.status === "failed" ? "dead" : "accepted";
          digest.error = receipt.error;
        } catch (error: any) {
          digest.attempts++;
          digest.error = sanitizeInline(error.message);
          if (["unsupported", "archived", "invalid_request"].includes(error.code) || digest.attempts >= 6 || now - digest.at >= RETENTION_MS) digest.state = "dead";
          else digest.nextAttemptAt = now + Math.min(60_000, 1000 * 2 ** digest.attempts);
        }
        await this.save();
      }
      // Bound history bodies; compact task/turn/kind dedup keys survive history pruning.
      const removed = this.data.notices.filter((entry, index, all) => entry.at < now - RETENTION_MS || index < all.length - 5000);
      if (removed.length) {
        const discarded = new Set(removed);
        this.data.notices = this.data.notices.filter((entry) => !discarded.has(entry));
      }
      const digests = this.data.digests.filter((entry, index, all) => entry.state === "pending" || (entry.at >= now - RETENTION_MS && index >= all.length - 1000));
      if (removed.length || digests.length !== this.data.digests.length) { this.data.digests = digests; await this.save(); }
    } finally { this.active = false; }
  }
  private save() {
    const snapshot = JSON.stringify(this.data);
    const pending = this.writes.catch(() => {}).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, snapshot, { mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.writes = pending;
    return pending.then(() => { this.persistenceFailed = false; }, (error) => { this.persistenceFailed = true; throw error; });
  }
}
