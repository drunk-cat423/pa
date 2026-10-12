import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryError } from './memory-types.js';
import type { MemoryChange, MemoryDeletion, MemoryInput, MemoryKind, MemoryRecord, MemoryRef } from './memory-types.js';

export interface ConversationRecord {
  id: string;
  key: string;
  piSessionFile: string;
}

export interface RunRecord {
  id: string;
  conversationId: string;
  inputMessageId: string;
  inputText: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  provider: string;
  model: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  piEntryId: string | null;
  runStatus: string | null;
  deliveryStatus: string | null;
}

const SCHEMA_VERSION = 2;
const OWNER_ID = 'local-owner';

function now(): string {
  return new Date().toISOString();
}

function asConversation(row: Record<string, unknown>): ConversationRecord {
  return { id: String(row.id), key: String(row.key), piSessionFile: String(row.piSessionFile) };
}

function asRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row.id), conversationId: String(row.conversationId), inputMessageId: String(row.inputMessageId),
    inputText: String(row.inputText), status: row.status as RunRecord['status'],
    provider: String(row.provider), model: String(row.model),
  };
}

function asMemory(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id), conversationId: String(row.conversation_id), kind: row.kind as MemoryKind,
    content: String(row.content), revision: Number(row.revision), origin: 'explicit_user',
    sourceEventId: String(row.source_event_id),
    sourceMessageId: row.source_message_id === null ? null : String(row.source_message_id),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

function validateMemoryInput(input: MemoryInput): void {
  if (!input || typeof input.content !== 'string' || !input.content.trim()) throw new MemoryError('记忆内容不能为空。');
  if ([...input.content].length > 4000) throw new MemoryError('记忆内容不能超过 4000 个 Unicode 字符。');
  if (input.kind !== undefined && !['fact', 'preference', 'episode'].includes(input.kind)) throw new MemoryError('记忆类型必须是 fact、preference 或 episode。');
  if (input.sourceMessageId !== undefined && (typeof input.sourceMessageId !== 'string' || !input.sourceMessageId)) throw new MemoryError('记忆来源消息 ID 无效。');
}

function validateRevision(revision: number | undefined): void {
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new MemoryError('记忆版本必须是正整数。');
}

export class ConversationStore {
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(databasePath: string) {
    this.databasePath = resolve(databasePath);
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.initialize();
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  private initialize(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      if (version > SCHEMA_VERSION) throw new Error(`数据库版本 ${version} 高于当前支持版本 ${SCHEMA_VERSION}。`);
      if (version === 0) {
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
        if (tables.length > 0) throw new Error('拒绝初始化版本为 0 的非空未知数据库。');
        this.db.exec(`
        CREATE TABLE actors (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind = 'local-owner')
        );
        INSERT INTO actors (id, kind) VALUES ('${OWNER_ID}', 'local-owner');

        CREATE TABLE rooms (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL CHECK (channel = 'cli'),
          account TEXT NOT NULL CHECK (account = 'local'),
          external_chat_id TEXT NOT NULL,
          UNIQUE (channel, account, external_chat_id)
        );
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id),
          pi_session_file TEXT NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          actor_id TEXT REFERENCES actors(id),
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          text TEXT NOT NULL,
          pi_entry_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE agent_runs (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          input_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
          status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
          response_message_id TEXT UNIQUE REFERENCES messages(id),
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          error_kind TEXT,
          error_message TEXT,
          recovered INTEGER NOT NULL DEFAULT 0 CHECK (recovered IN (0, 1)),
          started_at TEXT NOT NULL,
          finished_at TEXT,
          CHECK ((status = 'completed' AND response_message_id IS NOT NULL AND finished_at IS NOT NULL)
            OR (status <> 'completed' AND response_message_id IS NULL))
        );
        CREATE UNIQUE INDEX one_running_run_per_conversation ON agent_runs(conversation_id) WHERE status = 'running';
        CREATE TABLE deliveries (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id),
          message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
          channel TEXT NOT NULL CHECK (channel = 'cli'),
          status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'uncertain')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        `);
      }
      if (version < 2) this.db.exec(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'episode')),
          content TEXT,
          revision INTEGER NOT NULL CHECK (revision >= 1),
          status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
          origin TEXT NOT NULL CHECK (origin = 'explicit_user'),
          source_event_id TEXT NOT NULL REFERENCES memory_events(id),
          source_message_id TEXT REFERENCES messages(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK ((status = 'active' AND content IS NOT NULL) OR (status = 'deleted' AND content IS NULL))
        );
        CREATE INDEX memories_by_conversation ON memories(conversation_id, status, updated_at);
        CREATE TABLE memory_events (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL REFERENCES conversations(id),
          memory_id TEXT NOT NULL REFERENCES memories(id) DEFERRABLE INITIALLY DEFERRED,
          action TEXT NOT NULL CHECK (action IN ('remember', 'correct', 'delete')),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          created_at TEXT NOT NULL
        );
        CREATE TABLE memory_revisions (
          memory_id TEXT NOT NULL REFERENCES memories(id),
          revision INTEGER NOT NULL CHECK (revision >= 1),
          content TEXT,
          status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'deleted')),
          source_event_id TEXT NOT NULL REFERENCES memory_events(id),
          source_message_id TEXT REFERENCES messages(id),
          created_at TEXT NOT NULL,
          PRIMARY KEY (memory_id, revision),
          CHECK ((status IN ('active', 'superseded') AND content IS NOT NULL) OR (status = 'deleted' AND content IS NULL))
        );
        CREATE TABLE memory_uses (
          run_id TEXT NOT NULL REFERENCES agent_runs(id),
          memory_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          PRIMARY KEY (run_id, memory_id, revision),
          FOREIGN KEY (memory_id, revision) REFERENCES memory_revisions(memory_id, revision)
        );
        CREATE TABLE memory_context_state (
          conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
          reset_required INTEGER NOT NULL CHECK (reset_required IN (0, 1)),
          generation INTEGER NOT NULL CHECK (generation >= 0)
        );
      `);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.enableWal();
  }

  private enableWal(): void {
    this.db.exec('PRAGMA synchronous = FULL;');
    const mode = this.db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
    if (mode !== 'wal') throw new Error('无法启用 SQLite WAL 日志模式。');
  }

  ensureConversation(key: string, piSessionFile: string): ConversationRecord {
    if (!key) throw new Error('会话 key 不能为空。');
    const existing = this.db.prepare(`
      SELECT c.id, r.external_chat_id AS key, c.pi_session_file AS piSessionFile
      FROM conversations c JOIN rooms r ON r.id = c.room_id
      WHERE r.channel = 'cli' AND r.account = 'local' AND r.external_chat_id = ?
    `).get(key) as Record<string, unknown> | undefined;
    if (existing) {
      const conversation = asConversation(existing);
      if (conversation.piSessionFile !== piSessionFile) throw new Error('会话已绑定到不同的 Pi session 文件。');
      return conversation;
    }
    const roomId = randomUUID();
    const id = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO rooms (id, channel, account, external_chat_id) VALUES (?, ?, ?, ?)')
        .run(roomId, 'cli', 'local', key);
      this.db.prepare('INSERT INTO conversations (id, room_id, pi_session_file) VALUES (?, ?, ?)')
        .run(id, roomId, piSessionFile);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { id, key, piSessionFile };
  }

  private memoryTransaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private requireMemoryConversation(conversationId: string): void {
    if (!this.db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId)) throw new MemoryError('会话不存在。');
  }

  private validateMemorySource(conversationId: string, sourceMessageId: string | undefined): void {
    if (sourceMessageId !== undefined && !this.db.prepare("SELECT id FROM messages WHERE id = ? AND conversation_id = ? AND role = 'user'")
      .get(sourceMessageId, conversationId)) throw new MemoryError('记忆来源必须是当前会话的用户消息。');
  }

  private findMemory(conversationId: string, id: string): Record<string, unknown> {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ? AND conversation_id = ?').get(id, conversationId);
    if (!row) throw new MemoryError('记忆不存在。');
    return row;
  }

  private requireCurrentMemory(conversationId: string, id: string, expectedRevision: number | undefined): Record<string, unknown> {
    const row = this.findMemory(conversationId, id);
    if (row.status === 'deleted') throw new MemoryError('记忆已删除。');
    if (expectedRevision !== undefined && Number(row.revision) !== expectedRevision) throw new MemoryError('记忆版本已变化，请重新查询后重试。');
    return row;
  }

  private requireContextReset(conversationId: string): void {
    this.db.prepare(`INSERT INTO memory_context_state (conversation_id, reset_required, generation) VALUES (?, 1, 1)
      ON CONFLICT (conversation_id) DO UPDATE SET reset_required = 1, generation = generation + 1`).run(conversationId);
  }

  rememberMemory(conversationId: string, input: MemoryInput): MemoryChange {
    validateMemoryInput(input);
    return this.memoryTransaction(() => {
      this.requireMemoryConversation(conversationId);
      this.validateMemorySource(conversationId, input.sourceMessageId);
      const id = randomUUID();
      const eventId = randomUUID();
      const createdAt = now();
      this.db.prepare(`INSERT INTO memory_events (id, conversation_id, memory_id, action, revision, created_at)
        VALUES (?, ?, ?, 'remember', 1, ?)`).run(eventId, conversationId, id, createdAt);
      this.db.prepare(`INSERT INTO memories (id, conversation_id, kind, content, revision, status, origin, source_event_id, source_message_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 'active', 'explicit_user', ?, ?, ?, ?)`)
        .run(id, conversationId, input.kind ?? 'fact', input.content, eventId, input.sourceMessageId ?? null, createdAt, createdAt);
      this.db.prepare(`INSERT INTO memory_revisions (memory_id, revision, content, status, source_event_id, source_message_id, created_at)
        VALUES (?, 1, ?, 'active', ?, ?, ?)`).run(id, input.content, eventId, input.sourceMessageId ?? null, createdAt);
      return { memory: asMemory(this.findMemory(conversationId, id)), contextResetRequired: this.contextState(conversationId).required };
    });
  }

  queryMemories(conversationId: string, query = '', limit = 20): MemoryRecord[] {
    if (typeof query !== 'string' || [...query].length > 1000) throw new MemoryError('记忆查询不能超过 1000 个 Unicode 字符。');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new MemoryError('记忆 limit 必须是 1 到 200 的整数。');
    return this.db.prepare(`SELECT * FROM memories WHERE conversation_id = ? AND status = 'active' AND instr(content, ?) > 0
      ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(conversationId, query, limit).map(asMemory);
  }

  correctMemory(conversationId: string, id: string, input: MemoryInput, expectedRevision?: number): MemoryChange {
    validateMemoryInput(input);
    validateRevision(expectedRevision);
    return this.memoryTransaction(() => {
      const existing = this.requireCurrentMemory(conversationId, id, expectedRevision);
      this.validateMemorySource(conversationId, input.sourceMessageId);
      const revision = Number(existing.revision) + 1;
      const eventId = randomUUID();
      const updatedAt = now();
      this.db.prepare(`INSERT INTO memory_events (id, conversation_id, memory_id, action, revision, created_at)
        VALUES (?, ?, ?, 'correct', ?, ?)`).run(eventId, conversationId, id, revision, updatedAt);
      this.db.prepare("UPDATE memory_revisions SET status = 'superseded' WHERE memory_id = ? AND status = 'active'").run(id);
      this.db.prepare(`INSERT INTO memory_revisions (memory_id, revision, content, status, source_event_id, source_message_id, created_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?)`).run(id, revision, input.content, eventId, input.sourceMessageId ?? null, updatedAt);
      this.db.prepare(`UPDATE memories SET kind = ?, content = ?, revision = ?, source_event_id = ?, source_message_id = ?, updated_at = ?
        WHERE id = ? AND conversation_id = ?`).run(input.kind ?? String(existing.kind), input.content, revision, eventId, input.sourceMessageId ?? null, updatedAt, id, conversationId);
      this.requireContextReset(conversationId);
      return { memory: asMemory(this.findMemory(conversationId, id)), contextResetRequired: true };
    });
  }

  deleteMemory(conversationId: string, id: string, expectedRevision?: number): MemoryDeletion {
    validateRevision(expectedRevision);
    return this.memoryTransaction(() => {
      const existing = this.findMemory(conversationId, id);
      if (existing.status === 'deleted') return { id, revision: Number(existing.revision), deleted: true, contextResetRequired: this.contextState(conversationId).required };
      if (expectedRevision !== undefined && Number(existing.revision) !== expectedRevision) throw new MemoryError('记忆版本已变化，请重新查询后重试。');
      const revision = Number(existing.revision) + 1;
      const eventId = randomUUID();
      const updatedAt = now();
      this.db.prepare(`INSERT INTO memory_events (id, conversation_id, memory_id, action, revision, created_at)
        VALUES (?, ?, ?, 'delete', ?, ?)`).run(eventId, conversationId, id, revision, updatedAt);
      this.db.prepare("UPDATE memory_revisions SET content = NULL, status = 'deleted' WHERE memory_id = ?").run(id);
      this.db.prepare(`INSERT INTO memory_revisions (memory_id, revision, content, status, source_event_id, source_message_id, created_at)
        VALUES (?, ?, NULL, 'deleted', ?, NULL, ?)`).run(id, revision, eventId, updatedAt);
      this.db.prepare(`UPDATE memories SET content = NULL, status = 'deleted', revision = ?, source_event_id = ?, source_message_id = NULL, updated_at = ?
        WHERE id = ? AND conversation_id = ?`).run(revision, eventId, updatedAt, id, conversationId);
      this.requireContextReset(conversationId);
      return { id, revision, deleted: true, contextResetRequired: true };
    });
  }

  contextState(conversationId: string): { required: boolean; generation: number } {
    this.requireMemoryConversation(conversationId);
    const row = this.db.prepare('SELECT reset_required, generation FROM memory_context_state WHERE conversation_id = ?').get(conversationId);
    return { required: row?.reset_required === 1, generation: Number(row?.generation ?? 0) };
  }

  ackContextReset(conversationId: string, generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new MemoryError('上下文代次必须是非负整数。');
    this.requireMemoryConversation(conversationId);
    this.db.prepare('UPDATE memory_context_state SET reset_required = 0 WHERE conversation_id = ? AND generation = ?').run(conversationId, generation);
  }

  beginRun(conversationId: string, text: string, provider: string, model: string, memoryRefs: readonly MemoryRef[] = []): RunRecord {
    const id = randomUUID();
    const inputMessageId = randomUUID();
    const createdAt = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const ref of memoryRefs) {
        validateRevision(ref.revision);
        const memory = this.findMemory(conversationId, ref.id);
        if (memory.status === 'deleted') throw new MemoryError('记忆已删除。');
        if (Number(memory.revision) !== ref.revision) throw new MemoryError('记忆版本已变化，请重新查询后重试。');
      }
      this.db.prepare(`INSERT INTO messages (id, conversation_id, actor_id, role, text, created_at)
        VALUES (?, ?, ?, 'user', ?, ?)`).run(inputMessageId, conversationId, OWNER_ID, text, createdAt);
      this.db.prepare(`INSERT INTO agent_runs (id, conversation_id, input_message_id, status, provider, model, started_at)
        VALUES (?, ?, ?, 'running', ?, ?, ?)`).run(id, conversationId, inputMessageId, provider, model, createdAt);
      for (const ref of memoryRefs) {
        this.db.prepare('INSERT INTO memory_uses (run_id, memory_id, revision) VALUES (?, ?, ?)').run(id, ref.id, ref.revision);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { id, conversationId, inputMessageId, inputText: text, status: 'running', provider, model };
  }

  completeRun(runId: string, text: string, piUserEntryId: string | undefined, piAssistantEntryId: string | undefined, recovered = false): { messageId: string; deliveryId: string } {
    const run = this.db.prepare("SELECT conversation_id FROM agent_runs WHERE id = ? AND status = 'running'").get(runId) as Record<string, unknown> | undefined;
    if (!run) throw new Error('运行不存在或已结束，不能完成。');
    const conversationId = String(run.conversation_id);
    const messageId = randomUUID();
    const deliveryId = randomUUID();
    const createdAt = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO messages (id, conversation_id, actor_id, role, text, pi_entry_id, created_at)
        VALUES (?, ?, NULL, 'assistant', ?, ?, ?)`).run(messageId, conversationId, text, piAssistantEntryId ?? null, createdAt);
      this.db.prepare(`UPDATE agent_runs SET status = 'completed', response_message_id = ?, recovered = ?, finished_at = ?
        WHERE id = ? AND status = 'running'`).run(messageId, recovered ? 1 : 0, createdAt, runId);
      this.db.prepare(`INSERT INTO deliveries (id, conversation_id, run_id, message_id, channel, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'cli', 'pending', ?, ?)`).run(deliveryId, conversationId, runId, messageId, createdAt, createdAt);
      if (piUserEntryId !== undefined) {
        this.db.prepare('UPDATE messages SET pi_entry_id = ? WHERE id = (SELECT input_message_id FROM agent_runs WHERE id = ?)').run(piUserEntryId, runId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { messageId, deliveryId };
  }

  failRun(runId: string, status: 'failed' | 'interrupted', kind: string, message: string): void {
    const result = this.db.prepare(`UPDATE agent_runs SET status = ?, error_kind = ?, error_message = ?, finished_at = ?
      WHERE id = ? AND status = 'running'`).run(status, kind, message, now(), runId);
    if (result.changes !== 1) throw new Error('运行不存在或已结束，不能标记失败。');
  }

  unfinishedRuns(conversationId: string): RunRecord[] {
    return this.db.prepare(`SELECT r.id, r.conversation_id AS conversationId, r.input_message_id AS inputMessageId,
      m.text AS inputText, r.status, r.provider, r.model FROM agent_runs r
      JOIN messages m ON m.id = r.input_message_id WHERE r.conversation_id = ? AND r.status = 'running'
      ORDER BY r.started_at, r.rowid`).all(conversationId).map(row => asRun(row as Record<string, unknown>));
  }

  markPendingUncertain(conversationId: string): void {
    this.db.prepare("UPDATE deliveries SET status = 'uncertain', updated_at = ? WHERE conversation_id = ? AND status = 'pending'")
      .run(now(), conversationId);
  }

  ackDelivery(deliveryId: string, status: 'sent' | 'uncertain'): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT status FROM deliveries WHERE id = ?').get(deliveryId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('投递记录不存在。');
      const current = String(row.status);
      if (current === status) { this.db.exec('COMMIT'); return; }
      if (current !== 'pending') throw new Error(`不能将 ${current} 投递改为 ${status}。`);
      this.db.prepare('UPDATE deliveries SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), deliveryId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listMessages(conversationKey: string, limit: number): MessageRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit 必须是正整数。');
    const rows = this.db.prepare(`
      SELECT m.id, m.conversation_id AS conversationId, m.role, m.text, m.created_at AS createdAt,
        m.pi_entry_id AS piEntryId, r.status AS runStatus, d.status AS deliveryStatus, m.rowid AS rowId
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      JOIN rooms room ON room.id = c.room_id
      LEFT JOIN agent_runs r ON r.input_message_id = m.id OR r.response_message_id = m.id
      LEFT JOIN deliveries d ON d.message_id = m.id
      WHERE room.channel = 'cli' AND room.account = 'local' AND room.external_chat_id = ?
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?
    `).all(conversationKey, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map(row => ({
      id: String(row.id), conversationId: String(row.conversationId), role: row.role as MessageRecord['role'],
      text: String(row.text), createdAt: String(row.createdAt), piEntryId: row.piEntryId === null ? null : String(row.piEntryId),
      runStatus: row.runStatus === null ? null : String(row.runStatus),
      deliveryStatus: row.deliveryStatus === null ? null : String(row.deliveryStatus),
    }));
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
