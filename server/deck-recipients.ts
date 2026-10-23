import type { AgentId } from "./types.js";

/**
 * deck-api 收件人解析的统一出口：`--to @询问别名`、`--to @s-会话别名`、
 * `--to agentId:threadId` 三个通道在这里收敛，
 * 错误分类（UNKNOWN_ALIAS / ARCHIVED / AMBIGUOUS / BAD_FORMAT）和 HTTP
 * 状态码映射（404 / 409）也只在这一处定义，CLI 与 UI 依赖同一套语义。
 */
export type RecipientErrorCode =
  | "UNKNOWN_ALIAS"
  | "ARCHIVED"
  | "DELETED"
  | "AMBIGUOUS"
  | "BAD_FORMAT"
  | "NOT_CANCELLABLE"
  | "BUSY"
  | "FORBIDDEN";

/** 候选只携带定位所需的 安全字段，不透传完整台账内容到 CLI 输出。 */
export interface RecipientCandidate {
  agentId: AgentId;
  threadId: string;
  alias?: string;
  status?: string;
}

export class DeckRecipientError extends Error {
  constructor(
    readonly code: RecipientErrorCode,
    readonly statusCode: number,
    message: string,
    readonly candidates?: RecipientCandidate[],
  ) {
    super(message);
  }
}

export interface ExplicitRecipient {
  kind: "ask" | "session";
  target: { agentId: AgentId; threadId: string };
  alias?: string;
}

export interface RecipientResolverDeps {
  findSessionByAlias(alias: string): { agentId: AgentId; threadId: string } | undefined;
  findAskByAlias(alias: string):
    | { alias: string; target: { agentId: AgentId; threadId: string } }
    | undefined;
  isArchived(target: { agentId: AgentId; threadId: string }): boolean;
  /** 已删除会话别名仍保留，但必须明确拒绝，不能继续投递。 */
  isDeleted?(target: { agentId: AgentId; threadId: string }): boolean;
  ensureAlias(target: { agentId: AgentId; threadId: string }): Promise<string | undefined>;
}

const archivedError = (label: string) =>
  new DeckRecipientError("ARCHIVED", 409, `${label}已归档`);

const deletedError = (label: string) =>
  new DeckRecipientError("DELETED", 410, `${label}已删除`);

/**
 * 解析显式收件人。调用方校验输入格式；
 * 这里只负责把引用安全地落到一个具体会话，失败抛 DeckRecipientError。
 */
export async function resolveExplicitRecipient(
  input: { to?: string },
  deps: RecipientResolverDeps,
): Promise<ExplicitRecipient> {
  const to = input.to!;
  if (to.startsWith("@")) {
    const reference = to.slice(1);
    if (!reference)
      throw new DeckRecipientError("BAD_FORMAT", 400, "--to 别名不能为空");
    if (reference.startsWith("s-")) {
      const found = deps.findSessionByAlias(reference);
      if (!found)
        throw new DeckRecipientError("UNKNOWN_ALIAS", 404, `会话别名 ${to} 不存在`);
      if (deps.isDeleted?.(found)) throw deletedError(`会话 ${to}`);
      if (deps.isArchived(found)) throw archivedError(`会话 ${to}`);
      return { kind: "session", target: found, alias: reference };
    }
    const found = deps.findAskByAlias(reference);
    if (!found)
      throw new DeckRecipientError(
        "UNKNOWN_ALIAS",
        404,
        `询问别名 ${to} 不存在或尚未创建完成`,
      );
    if (deps.isDeleted?.(found.target)) throw deletedError(`询问 ${to} 的目标会话`);
    if (deps.isArchived(found.target)) throw archivedError(`询问 ${to} 的目标会话`);
    return { kind: "ask", target: found.target, alias: found.alias };
  }
  const separator = to.indexOf(":");
  if (separator < 1 || separator === to.length - 1)
    throw new DeckRecipientError("BAD_FORMAT", 400, "--to 格式应为 agentId:threadId");
  const [agentId, threadId] = [to.slice(0, separator), to.slice(separator + 1)];
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(agentId))
    throw new DeckRecipientError("BAD_FORMAT", 400, "--to 的 agentId 格式无效");
  const target = { agentId: agentId as AgentId, threadId };
  if (deps.isDeleted?.(target)) throw deletedError("目标会话");
  if (deps.isArchived(target)) throw archivedError("目标会话");
  return { kind: "session", target, alias: await deps.ensureAlias(target) };
}
