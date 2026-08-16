import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import type { ThreadSummary } from "./types.js";

const SCHEMA_VERSION = 1;
const MAX_ITEM_CHARS = 100_000;
const MAX_THREAD_CHARS = 2_000_000;

export interface SessionSearchMatch {
  agentId: "codex" | "claude";
  threadId: string;
  turnId?: string;
  itemId?: string;
  role: "user" | "assistant";
  snippet: string;
  score: number;
}

interface SearchDocument {
  turnId: string;
  itemId: string;
  role: SessionSearchMatch["role"];
  text: string;
}

function agentId(thread: Pick<ThreadSummary, "agentId">) {
  return thread.agentId || "codex";
}

function contentText(content: unknown) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function normalizedText(value: unknown) {
  const text = typeof value === "string" ? value : "";
  return text.replace(/\u0000/g, "").trim();
}

export function sessionSearchDocuments(full: any) {
  const documents: SearchDocument[] = [];
  let remaining = MAX_THREAD_CHARS;
  let truncated = false;
  const turns = Array.isArray(full?.turns) ? full.turns : [];
  for (
    let turnIndex = 0;
    turnIndex < turns.length && remaining > 0;
    turnIndex++
  ) {
    const turn = turns[turnIndex];
    const turnId = String(turn?.id || turnIndex);
    const items = Array.isArray(turn?.items) ? turn.items : [];
    for (
      let itemIndex = 0;
      itemIndex < items.length && remaining > 0;
      itemIndex++
    ) {
      const item = items[itemIndex];
      let role: SearchDocument["role"] | undefined;
      let raw = "";
      if (item?.type === "userMessage") {
        role = "user";
        raw = contentText(item.content) || String(item.text || "");
      } else if (item?.type === "agentMessage") {
        role = "assistant";
        raw = String(item.text || "") || contentText(item.content);
      }
      if (!role) continue;
      const normalized = normalizedText(raw);
      const fullText = normalized.slice(0, MAX_ITEM_CHARS);
      if (!fullText) continue;
      if (fullText.length < normalized.length) truncated = true;
      const text = fullText.slice(0, remaining);
      remaining -= text.length;
      if (text.length < fullText.length) truncated = true;
      documents.push({
        turnId,
        itemId: String(item?.id || `${turnId}:${itemIndex}`),
        role,
        text,
      });
    }
  }
  if (remaining === 0) truncated = true;
  return { documents, truncated };
}

export class SessionSearchStore {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    this.db = new DatabaseSync(path.join(dataDir, "session-search.sqlite"));
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=1000",
    );
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()?.user_version || 0,
    );
    if (version !== SCHEMA_VERSION) this.resetSchema();
  }

  private resetSchema() {
    this.db.exec(`
      DROP TABLE IF EXISTS session_search_fts;
      DROP TABLE IF EXISTS session_search_document;
      DROP TABLE IF EXISTS session_search_thread;
      CREATE TABLE session_search_thread (
        agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        source_updated_at INTEGER NOT NULL,
        indexed_at INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        PRIMARY KEY (agent_id, thread_id)
      );
      CREATE TABLE session_search_document (
        id INTEGER PRIMARY KEY,
        agent_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        item_id TEXT,
        role TEXT NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX session_search_document_thread
        ON session_search_document(agent_id, thread_id);
      CREATE VIRTUAL TABLE session_search_fts USING fts5(
        text,
        content='session_search_document',
        content_rowid='id',
        tokenize='trigram'
      );
      CREATE TRIGGER session_search_document_ai AFTER INSERT ON session_search_document BEGIN
        INSERT INTO session_search_fts(rowid, text) VALUES (new.id, new.text);
      END;
      CREATE TRIGGER session_search_document_ad AFTER DELETE ON session_search_document BEGIN
        INSERT INTO session_search_fts(session_search_fts, rowid, text)
          VALUES ('delete', old.id, old.text);
      END;
      PRAGMA user_version=${SCHEMA_VERSION};
    `);
  }

  needsIndex(thread: ThreadSummary) {
    const row = this.db
      .prepare(
        `SELECT source_updated_at, retry_at, last_error FROM session_search_thread
         WHERE agent_id = ? AND thread_id = ?`,
      )
      .get(agentId(thread), thread.id) as any;
    return Boolean(
      !row ||
      Number(row.source_updated_at) !== Number(thread.updatedAt) ||
      (row.last_error && Number(row.retry_at) <= Date.now()),
    );
  }

  upsert(thread: ThreadSummary, full: unknown) {
    const extracted = sessionSearchDocuments(full);
    const id = agentId(thread);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "DELETE FROM session_search_document WHERE agent_id = ? AND thread_id = ?",
        )
        .run(id, thread.id);
      const insert = this.db.prepare(
        `INSERT INTO session_search_document
          (agent_id, thread_id, turn_id, item_id, role, text)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const document of extracted.documents)
        insert.run(
          id,
          thread.id,
          document.turnId,
          document.itemId,
          document.role,
          document.text,
        );
      this.db
        .prepare(
          `INSERT INTO session_search_thread
            (agent_id, thread_id, source_updated_at, indexed_at, truncated, retry_at, last_error)
           VALUES (?, ?, ?, ?, ?, 0, NULL)
           ON CONFLICT(agent_id, thread_id) DO UPDATE SET
             source_updated_at=excluded.source_updated_at,
             indexed_at=excluded.indexed_at,
             truncated=excluded.truncated,
             retry_at=0,
             last_error=NULL`,
        )
        .run(
          id,
          thread.id,
          Number(thread.updatedAt) || 0,
          Date.now(),
          extracted.truncated ? 1 : 0,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  markFailure(thread: ThreadSummary, error: unknown) {
    this.db
      .prepare(
        `INSERT INTO session_search_thread
          (agent_id, thread_id, source_updated_at, indexed_at, retry_at, last_error)
         VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT(agent_id,thread_id) DO UPDATE SET
           source_updated_at=excluded.source_updated_at,
           retry_at=excluded.retry_at,
           last_error=excluded.last_error`,
      )
      .run(
        agentId(thread),
        thread.id,
        Number(thread.updatedAt) || 0,
        Date.now() + 5 * 60_000,
        String((error as any)?.message || error).slice(0, 500),
      );
  }

  removeAbsent(threads: ThreadSummary[]) {
    const available = new Set(
      threads.map((thread) => `${agentId(thread)}:${thread.id}`),
    );
    const stale = this.db
      .prepare("SELECT agent_id, thread_id FROM session_search_thread")
      .all() as any[];
    const removeDocuments = this.db.prepare(
      "DELETE FROM session_search_document WHERE agent_id = ? AND thread_id = ?",
    );
    const removeThread = this.db.prepare(
      "DELETE FROM session_search_thread WHERE agent_id = ? AND thread_id = ?",
    );
    for (const row of stale) {
      if (available.has(`${row.agent_id}:${row.thread_id}`)) continue;
      removeDocuments.run(row.agent_id, row.thread_id);
      removeThread.run(row.agent_id, row.thread_id);
    }
  }

  search(query: string, allowed: Set<string>, limit = 30) {
    if (allowed.size === 0) return [];
    const literal = `"${query.replace(/"/g, '""')}"`;
    const allowedValues = [...allowed];
    const placeholders = allowedValues.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT d.agent_id, d.thread_id, d.turn_id, d.item_id, d.role,
                snippet(session_search_fts, 0, '', '', ' … ', 24) AS snippet,
                bm25(session_search_fts) AS score
         FROM session_search_fts
         JOIN session_search_document d ON d.id = session_search_fts.rowid
         WHERE session_search_fts MATCH ?
           AND (d.agent_id || ':' || d.thread_id) IN (${placeholders})
         ORDER BY score
         LIMIT ?`,
      )
      .all(literal, ...allowedValues, Math.max(limit * 6, 60)) as any[];
    const results: SessionSearchMatch[] = [];
    const perThread = new Map<string, number>();
    for (const row of rows) {
      const key = `${row.agent_id}:${row.thread_id}`;
      if ((perThread.get(key) || 0) >= 2) continue;
      perThread.set(key, (perThread.get(key) || 0) + 1);
      results.push({
        agentId: row.agent_id,
        threadId: row.thread_id,
        turnId: row.turn_id || undefined,
        itemId: row.item_id || undefined,
        role: row.role,
        snippet: String(row.snippet || "").trim(),
        score: Number(row.score) || 0,
      });
      if (perThread.size >= limit && results.length >= limit) break;
    }
    return results;
  }

  indexedCount(allowed: Set<string>) {
    const rows = this.db
      .prepare(
        "SELECT agent_id, thread_id FROM session_search_thread WHERE last_error IS NULL",
      )
      .all() as any[];
    return rows.filter((row) => allowed.has(`${row.agent_id}:${row.thread_id}`))
      .length;
  }

  close() {
    this.db.close();
  }
}
