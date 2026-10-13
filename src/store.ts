import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryError } from './memory-types.js';
import type { MemoryChange, MemoryDeletion, MemoryInput, MemoryKind, MemoryRecord, MemoryRef, MemorySections, PrimaryPerson, ProfileField } from './memory-types.js';
import type { ChannelRoute, ExternalRunInput } from './channel-types.js';

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
  modelInputText?: string;
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
  modelInputText?: string;
  eventId?: string;
  senderId?: string;
  senderName?: string;
  externalMessageId?: string;
  actorId?: string;
  messageKind?: 'chat' | 'memory';
}

export class DuplicateMessageError extends Error {
  constructor() { super('当前会话已保存该渠道消息，拒绝重复运行。'); this.name = 'DuplicateMessageError'; }
}

const SCHEMA_VERSION = 5;
const OWNER_ID = 'local-owner';
const PROFILE_FIELDS = ['diet', 'preferred_name', 'interests', 'reply_style'];

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
    ...(row.modelInputText == null ? {} : { modelInputText: String(row.modelInputText) }),
  };
}

function asMessage(row: Record<string, unknown>): MessageRecord {
  return {
    id: String(row.id), conversationId: String(row.conversationId), role: row.role as MessageRecord['role'],
    text: String(row.text), createdAt: String(row.createdAt), piEntryId: row.piEntryId === null ? null : String(row.piEntryId),
    runStatus: row.runStatus === null ? null : String(row.runStatus),
    deliveryStatus: row.deliveryStatus === null ? null : String(row.deliveryStatus),
    ...(row.modelInputText == null ? {} : { modelInputText: String(row.modelInputText) }),
    ...(row.eventId == null ? {} : { eventId: String(row.eventId) }),
    ...(row.senderId == null ? {} : { senderId: String(row.senderId), actorId: String(row.actorId) }),
    ...(row.senderName == null ? {} : { senderName: String(row.senderName) }),
    ...(row.externalMessageId == null ? {} : { externalMessageId: String(row.externalMessageId) }),
    ...(row.messageKind === 'memory' ? { messageKind: 'memory' } : {}),
  };
}

function conversationRoute(key: string, route?: ChannelRoute): ChannelRoute {
  const selected = route ?? { channel: 'cli', accountId: 'local', roomType: 'private', roomId: key };
  if (![selected.channel, selected.accountId, selected.roomId].every(value => typeof value === 'string' && value.length > 0)
    || !['group', 'private'].includes(selected.roomType)) throw new Error('渠道会话路由无效。');
  return selected;
}

function asMemory(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id), conversationId: String(row.conversation_id), kind: row.kind as MemoryKind,
    content: String(row.content), revision: Number(row.revision), origin: 'explicit_user',
    sourceEventId: String(row.source_event_id),
    sourceMessageId: row.source_message_id === null ? null : String(row.source_message_id),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    ...(row.subject_actor_id == null ? {} : { subjectActorId: String(row.subject_actor_id) }),
    ...(row.writer_actor_id == null ? {} : { writerActorId: String(row.writer_actor_id) }),
    ...(row.profile_field == null ? {} : { profileField: row.profile_field as ProfileField }),
    ...(row.person_id == null ? {} : { personId: String(row.person_id) }),
    occurredAt: row.occurred_at == null ? null : String(row.occurred_at),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
  };
}

function validateMemoryInput(input: MemoryInput): void {
  if (!input || typeof input.content !== 'string' || !input.content.trim()) throw new MemoryError('记忆内容不能为空。');
  if ([...input.content].length > 4000) throw new MemoryError('记忆内容不能超过 4000 个 Unicode 字符。');
  if (input.kind !== undefined && !['fact', 'preference', 'episode'].includes(input.kind)) throw new MemoryError('记忆类型必须是 fact、preference 或 episode。');
  if (input.sourceMessageId !== undefined && (typeof input.sourceMessageId !== 'string' || !input.sourceMessageId)) throw new MemoryError('记忆来源消息 ID 无效。');
  if (input.subjectActorId !== undefined && (typeof input.subjectActorId !== 'string' || !input.subjectActorId)) throw new MemoryError('记忆成员 ID 无效。');
  if (input.profileField !== undefined && !PROFILE_FIELDS.includes(input.profileField)) throw new MemoryError('成员资料字段无效。');
  normalizeMemoryTime(input.occurredAt);
  normalizeMemoryTime(input.expiresAt);
}

function normalizeMemoryTime(value: string | null | undefined): string | null {
  if (value == null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw new MemoryError('记忆时间必须是有效 ISO 日期时间。');
  const day = value.slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  if (date.toISOString().slice(0, 10) !== day) throw new MemoryError('记忆时间必须是有效 ISO 日期时间。');
  return new Date(value).toISOString();
}

function validateMemoryQuery(query: string, limit: number): void {
  if (typeof query !== 'string' || [...query].length > 1000) throw new MemoryError('记忆查询不能超过 1000 个 Unicode 字符。');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new MemoryError('记忆 limit 必须是 1 到 200 的整数。');
}

function validateRevision(revision: number | undefined): void {
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new MemoryError('记忆版本必须是正整数。');
}

export class ConversationStore {
  readonly databasePath: string;
  private readonly db: DatabaseSync;
  private closed = false;
  private transactionDepth = 0;

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
    // Old channel CHECK constraints require table replacement. Disable FK enforcement
    // before the transaction, then validate the complete migrated graph before commit.
    this.db.exec('PRAGMA foreign_keys = OFF;');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
      if (version > SCHEMA_VERSION) throw new Error(`数据库版本 ${version} 高于当前支持版本 ${SCHEMA_VERSION}。`);
      if (version > 0 && this.db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('数据库已有外键损坏，拒绝迁移。');
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
      if (version < 3) this.migrateChannels();
      if (version < 4) this.migrateGroupMemories();
      if (version < 5) this.migratePersonalMemories();
      if (this.db.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('数据库迁移后的外键校验失败。');
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON;');
    }
    this.enableWal();
  }

  private migrateChannels(): void {
    this.db.exec(`
      CREATE TABLE rooms_v3 (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        account TEXT NOT NULL,
        external_chat_id TEXT NOT NULL,
        room_type TEXT NOT NULL CHECK (room_type IN ('group', 'private')),
        UNIQUE (channel, account, room_type, external_chat_id)
      );
      INSERT INTO rooms_v3 SELECT id, channel, account, external_chat_id, 'private' FROM rooms;
      DROP TABLE rooms;
      ALTER TABLE rooms_v3 RENAME TO rooms;
      CREATE TABLE actors_v3 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('local-owner', 'external-user')),
        room_id TEXT REFERENCES rooms(id),
        external_user_id TEXT,
        UNIQUE (room_id, external_user_id),
        CHECK ((kind = 'local-owner' AND room_id IS NULL AND external_user_id IS NULL)
          OR (kind = 'external-user' AND room_id IS NOT NULL AND external_user_id IS NOT NULL))
      );
      INSERT INTO actors_v3 (id, kind) SELECT id, kind FROM actors;
      DROP TABLE actors;
      ALTER TABLE actors_v3 RENAME TO actors;
      ALTER TABLE messages ADD COLUMN model_input_text TEXT;
      ALTER TABLE messages ADD COLUMN external_event_id TEXT;
      ALTER TABLE messages ADD COLUMN sender_name TEXT;
      CREATE UNIQUE INDEX external_message_per_conversation ON messages(conversation_id, external_event_id)
        WHERE external_event_id IS NOT NULL;
      CREATE TABLE deliveries_v3 (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id),
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
        channel TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'uncertain')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        room_id TEXT NOT NULL REFERENCES rooms(id),
        external_message_id TEXT
      );
      INSERT INTO deliveries_v3
        SELECT d.id, d.conversation_id, d.run_id, d.message_id, d.channel, d.status, d.created_at, d.updated_at, c.room_id, NULL
        FROM deliveries d JOIN conversations c ON c.id = d.conversation_id;
      DROP TABLE deliveries;
      ALTER TABLE deliveries_v3 RENAME TO deliveries;
    `);
  }

  private enableWal(): void {
    this.db.exec('PRAGMA synchronous = FULL;');
    const mode = this.db.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
    if (mode !== 'wal') throw new Error('无法启用 SQLite WAL 日志模式。');
  }

  private migrateGroupMemories(): void {
    this.db.exec(`
      ALTER TABLE memories ADD COLUMN subject_actor_id TEXT REFERENCES actors(id);
      ALTER TABLE memories ADD COLUMN writer_actor_id TEXT REFERENCES actors(id);
      ALTER TABLE memories ADD COLUMN profile_field TEXT
        CHECK (profile_field IS NULL OR (subject_actor_id IS NOT NULL
          AND profile_field IN ('diet', 'preferred_name', 'interests', 'reply_style')));
      CREATE UNIQUE INDEX active_profile_per_writer ON memories(conversation_id, subject_actor_id, writer_actor_id, profile_field)
        WHERE status = 'active' AND profile_field IS NOT NULL;
      ALTER TABLE messages ADD COLUMN message_kind TEXT NOT NULL DEFAULT 'chat' CHECK (message_kind IN ('chat', 'memory'));
      ALTER TABLE memory_events ADD COLUMN actor_id TEXT REFERENCES actors(id);
      ALTER TABLE memory_events ADD COLUMN source_message_id TEXT REFERENCES messages(id);
      ALTER TABLE memories ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'legacy' CHECK (scope_type IN ('legacy', 'room', 'actor'));
      ALTER TABLE memory_context_state ADD COLUMN history_after_rowid INTEGER NOT NULL DEFAULT 0 CHECK (history_after_rowid >= 0);
    `);
  }

  private migratePersonalMemories(): void {
    this.db.exec(`
      ALTER TABLE memories ADD COLUMN person_id TEXT;
      ALTER TABLE memories ADD COLUMN occurred_at TEXT;
      ALTER TABLE memories ADD COLUMN expires_at TEXT;
      ALTER TABLE memories ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1));
      ALTER TABLE memories ADD COLUMN profile_source_self INTEGER NOT NULL DEFAULT 0 CHECK (profile_source_self IN (0, 1));
      UPDATE memories SET profile_source_self = 1 WHERE profile_field IS NOT NULL AND writer_actor_id = subject_actor_id
        AND EXISTS (SELECT 1 FROM messages source WHERE source.id = memories.source_message_id
          AND source.role = 'user' AND source.actor_id = memories.subject_actor_id AND source.conversation_id = memories.conversation_id);
      ALTER TABLE memory_revisions ADD COLUMN occurred_at TEXT;
      ALTER TABLE memory_revisions ADD COLUMN expires_at TEXT;
      CREATE TABLE primary_person_bindings (
        channel TEXT NOT NULL, account TEXT NOT NULL, room_type TEXT NOT NULL CHECK (room_type IN ('group', 'private')),
        room_id TEXT NOT NULL, sender_id TEXT NOT NULL, person_id TEXT NOT NULL,
        PRIMARY KEY (channel, account, room_type, room_id, sender_id)
      );
      DROP INDEX active_profile_per_writer;
      CREATE UNIQUE INDEX active_profile_per_writer ON memories(conversation_id, subject_actor_id, writer_actor_id, profile_field)
        WHERE status = 'active' AND is_current = 1 AND profile_field IS NOT NULL;
      CREATE UNIQUE INDEX active_person_profile ON memories(person_id, profile_field)
        WHERE status = 'active' AND is_current = 1 AND person_id IS NOT NULL AND profile_field IS NOT NULL AND writer_actor_id = subject_actor_id;
      CREATE INDEX memories_by_person ON memories(person_id, status, is_current, updated_at);
    `);
  }

  configurePrimaryPerson(primary: PrimaryPerson | null): void {
    if (primary !== null && (!primary || typeof primary.id !== 'string' || !primary.id.trim() || primary.id.length > 512
      || !Array.isArray(primary.bindings))) throw new MemoryError('主要成员配置无效。');
    const bindings = (primary?.bindings ?? []).map(binding => {
      if (!binding || typeof binding.senderId !== 'string' || !binding.senderId || binding.senderId.length > 512 || !binding.route) {
        throw new MemoryError('主要成员绑定无效。');
      }
      const route = conversationRoute('', binding.route);
      if ([route.channel, route.accountId, route.roomId].some(value => value.length > 512)) throw new MemoryError('主要成员绑定无效。');
      return { channel: route.channel, account: route.accountId, room_type: route.roomType, room_id: route.roomId, sender_id: binding.senderId, person_id: primary!.id };
    });
    const key = (binding: Record<string, unknown>) => JSON.stringify([binding.channel, binding.account, binding.room_type, binding.room_id, binding.sender_id, binding.person_id]);
    if (new Set(bindings.map(key)).size !== bindings.length) throw new MemoryError('主要成员绑定不能重复。');
    this.memoryTransaction(() => {
      const old = this.db.prepare('SELECT * FROM primary_person_bindings').all();
      if (JSON.stringify(old.map(key).sort()) === JSON.stringify(bindings.map(key).sort())) return;
      const affected = new Set<string>();
      for (const binding of [...old, ...bindings]) {
        for (const row of this.db.prepare(`SELECT c.id FROM conversations c JOIN rooms r ON r.id = c.room_id
          WHERE r.channel = ? AND r.account = ? AND r.room_type = ? AND r.external_chat_id = ?`)
          .all(String(binding.channel), String(binding.account), String(binding.room_type), String(binding.room_id))) affected.add(String(row.id));
      }
      this.db.exec('DELETE FROM primary_person_bindings');
      for (const binding of bindings) this.db.prepare(`INSERT INTO primary_person_bindings
        (channel, account, room_type, room_id, sender_id, person_id) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(binding.channel, binding.account, binding.room_type, binding.room_id, binding.sender_id, binding.person_id);
      // A prior person's rows retain their original identity after an account is rebound.
      // Only actor-local records can be promoted by the current local configuration.
      const candidates = this.db.prepare(`SELECT m.id, b.person_id FROM memories m
        JOIN conversations c ON c.id = m.conversation_id JOIN rooms r ON r.id = c.room_id
        JOIN actors a ON a.id = m.subject_actor_id AND a.room_id = c.room_id
        JOIN primary_person_bindings b ON b.channel = r.channel AND b.account = r.account AND b.room_type = r.room_type
          AND b.room_id = r.external_chat_id AND b.sender_id = a.external_user_id
        WHERE m.person_id IS NULL AND m.scope_type = 'actor'
        ORDER BY m.updated_at DESC, m.rowid DESC`).all();
      // Temporarily remove the global uniqueness guard while choosing the latest self profile.
      this.db.exec('DROP INDEX active_person_profile');
      for (const row of candidates) this.db.prepare('UPDATE memories SET person_id = ? WHERE id = ?').run(String(row.person_id), String(row.id));
      const profiles = this.db.prepare(`SELECT id, person_id, profile_field FROM memories
        WHERE person_id IS NOT NULL AND status = 'active' AND is_current = 1 AND profile_field IS NOT NULL AND writer_actor_id = subject_actor_id
        ORDER BY updated_at DESC, rowid DESC`).all();
      const seen = new Set<string>();
      for (const row of profiles) {
        const profileKey = JSON.stringify([row.person_id, row.profile_field]);
        if (seen.has(profileKey)) {
          this.db.prepare('UPDATE memories SET is_current = 0 WHERE id = ?').run(String(row.id));
          this.db.prepare("UPDATE memory_revisions SET status = 'superseded' WHERE memory_id = ? AND status = 'active'").run(String(row.id));
        } else seen.add(profileKey);
      }
      this.db.exec(`CREATE UNIQUE INDEX active_person_profile ON memories(person_id, profile_field)
        WHERE status = 'active' AND is_current = 1 AND person_id IS NOT NULL AND profile_field IS NOT NULL AND writer_actor_id = subject_actor_id`);
      for (const conversationId of affected) this.requireContextReset(conversationId);
    });
  }

  private personForActor(conversationId: string, actorId: string | undefined): string | null {
    if (actorId === undefined) return null;
    const row = this.db.prepare(`SELECT b.person_id FROM conversations c JOIN rooms r ON r.id = c.room_id
      JOIN actors a ON a.room_id = c.room_id AND a.id = ? JOIN primary_person_bindings b
      ON b.channel = r.channel AND b.account = r.account AND b.room_type = r.room_type
        AND b.room_id = r.external_chat_id AND b.sender_id = a.external_user_id WHERE c.id = ?`).get(actorId, conversationId);
    return row ? String(row.person_id) : null;
  }

  private memoryScopeConversations(conversationId: string, personId: unknown): Set<string> {
    const affected = new Set([conversationId]);
    if (typeof personId === 'string') for (const row of this.db.prepare(`SELECT DISTINCT c.id FROM primary_person_bindings b
      JOIN rooms r ON r.channel = b.channel AND r.account = b.account AND r.room_type = b.room_type AND r.external_chat_id = b.room_id
      JOIN conversations c ON c.room_id = r.id WHERE b.person_id = ?`).all(personId)) affected.add(String(row.id));
    return affected;
  }

  private resetMemoryScopes(conversationId: string, personId: unknown): void {
    for (const id of this.memoryScopeConversations(conversationId, personId)) this.requireContextReset(id);
  }

  refreshExpiredContext(conversationId: string): void {
    this.memoryTransaction(() => {
      this.requireMemoryConversation(conversationId);
      const expired = this.db.prepare(`SELECT DISTINCT memory.person_id FROM memory_uses used
        JOIN memories memory ON memory.id = used.memory_id JOIN agent_runs run ON run.id = used.run_id
        JOIN messages input ON input.id = run.input_message_id
        LEFT JOIN memory_context_state state ON state.conversation_id = run.conversation_id
        WHERE run.conversation_id = ? AND input.rowid > COALESCE(state.history_after_rowid, 0)
          AND memory.status = 'active' AND memory.is_current = 1 AND memory.expires_at IS NOT NULL AND memory.expires_at <= ?`)
        .all(conversationId, now());
      const affected = new Set<string>();
      for (const memory of expired) for (const id of this.memoryScopeConversations(conversationId, memory.person_id)) affected.add(id);
      for (const id of affected) this.requireContextReset(id);
    });
  }

  ensureConversation(key: string, piSessionFile: string, route?: ChannelRoute): ConversationRecord {
    if (!key) throw new Error('会话 key 不能为空。');
    const selected = conversationRoute(key, route);
    const existing = this.db.prepare(`
      SELECT c.id, r.external_chat_id AS key, c.pi_session_file AS piSessionFile
      FROM conversations c JOIN rooms r ON r.id = c.room_id
      WHERE r.channel = ? AND r.account = ? AND r.room_type = ? AND r.external_chat_id = ?
    `).get(selected.channel, selected.accountId, selected.roomType, selected.roomId) as Record<string, unknown> | undefined;
    if (existing) {
      const conversation = asConversation({ ...existing, key });
      if (conversation.piSessionFile !== piSessionFile) throw new Error('会话已绑定到不同的 Pi session 文件。');
      return conversation;
    }
    const roomId = randomUUID();
    const id = randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO rooms (id, channel, account, external_chat_id, room_type) VALUES (?, ?, ?, ?, ?)')
        .run(roomId, selected.channel, selected.accountId, selected.roomId, selected.roomType);
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
    const savepoint = `store_operation_${this.transactionDepth}`;
    const nested = this.transactionDepth > 0;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      if (nested) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } else this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private requireMemoryConversation(conversationId: string): void {
    if (!this.db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId)) throw new MemoryError('会话不存在。');
  }

  private validateMemorySource(conversationId: string, sourceMessageId: string | undefined): string {
    if (sourceMessageId !== undefined) {
      const source = this.db.prepare(`SELECT m.actor_id FROM messages m
        JOIN conversations c ON c.id = m.conversation_id JOIN rooms r ON r.id = c.room_id
        JOIN actors a ON a.id = m.actor_id
        WHERE m.id = ? AND m.conversation_id = ? AND m.role = 'user'
          AND ((r.channel = 'cli' AND a.kind = 'local-owner') OR a.room_id = c.room_id)`)
        .get(sourceMessageId, conversationId);
      if (!source) throw new MemoryError('记忆来源必须是当前会话的用户消息。');
      return String(source.actor_id);
    }
    const conversation = this.db.prepare(`SELECT r.channel FROM conversations c JOIN rooms r ON r.id = c.room_id WHERE c.id = ?`).get(conversationId);
    if (!conversation) throw new MemoryError('会话不存在。');
    if (conversation.channel !== 'cli') throw new MemoryError('渠道记忆必须提供当前会话的来源消息。');
    return OWNER_ID;
  }

  private requireMemoryActor(conversationId: string, actorId: string): void {
    if (typeof actorId !== 'string' || !actorId || !this.db.prepare(`SELECT a.id FROM actors a
      JOIN conversations c ON c.room_id = a.room_id WHERE c.id = ? AND a.id = ?`).get(conversationId, actorId)) {
      throw new MemoryError('记忆成员必须属于当前会话。');
    }
  }

  private findMemory(conversationId: string, id: string, actorId?: string): Record<string, unknown> {
    const personId = this.personForActor(conversationId, actorId);
    const row = this.db.prepare(`SELECT * FROM memories WHERE id = ? AND
      ((conversation_id = ? AND person_id IS NULL) OR (person_id IS NOT NULL AND person_id = ?))`).get(id, conversationId, personId);
    if (!row) throw new MemoryError('记忆不存在。');
    return row;
  }

  private requireCurrentMemory(conversationId: string, id: string, expectedRevision: number | undefined, actorId?: string): Record<string, unknown> {
    const row = this.findMemory(conversationId, id, actorId);
    if (row.status === 'deleted') throw new MemoryError('记忆已删除。');
    if (row.is_current !== 1) throw new MemoryError('记忆已被更新的成员资料替代。');
    if (expectedRevision !== undefined && Number(row.revision) !== expectedRevision) throw new MemoryError('记忆版本已变化，请重新查询后重试。');
    return row;
  }

  private requireContextReset(conversationId: string): void {
    this.db.prepare(`INSERT INTO memory_context_state (conversation_id, reset_required, generation, history_after_rowid)
      VALUES (?, 1, 1, (SELECT COALESCE(MAX(rowid), 0) FROM messages WHERE conversation_id = ?))
      ON CONFLICT (conversation_id) DO UPDATE SET reset_required = 1, generation = generation + 1,
        history_after_rowid = excluded.history_after_rowid`).run(conversationId, conversationId);
  }

  rememberMemory(conversationId: string, input: MemoryInput): MemoryChange {
    validateMemoryInput(input);
    return this.memoryTransaction(() => {
      this.requireMemoryConversation(conversationId);
      const writerActorId = this.validateMemorySource(conversationId, input.sourceMessageId);
      if (input.subjectActorId !== undefined) this.requireMemoryActor(conversationId, input.subjectActorId);
      if (input.profileField !== undefined && input.subjectActorId === undefined) throw new MemoryError('成员资料必须指定当前会话成员。');
      const id = randomUUID();
      const eventId = randomUUID();
      const createdAt = now();
      const personId = this.personForActor(conversationId, input.subjectActorId);
      const occurredAt = normalizeMemoryTime(input.occurredAt);
      const expiresAt = normalizeMemoryTime(input.expiresAt);
      if (input.profileField !== undefined) {
        const profileScope = this.actorMemoryScope(conversationId, input.subjectActorId);
        const expired = this.db.prepare(`SELECT id FROM memories WHERE ${profileScope.sql} AND profile_field = ?
          AND writer_actor_id = ? AND status = 'active' AND is_current = 1 AND expires_at IS NOT NULL AND expires_at <= ?`)
          .all(...profileScope.parameters, input.profileField, writerActorId, createdAt);
        // Global self profiles keep their original writer/subject pair across rooms.
        if (personId !== null && writerActorId === input.subjectActorId) expired.push(...this.db.prepare(`SELECT id FROM memories
          WHERE person_id = ? AND profile_field = ? AND writer_actor_id = subject_actor_id AND status = 'active'
            AND is_current = 1 AND expires_at IS NOT NULL AND expires_at <= ?`).all(personId, input.profileField, createdAt));
        for (const row of expired) {
          this.db.prepare('UPDATE memories SET is_current = 0 WHERE id = ?').run(String(row.id));
          this.db.prepare("UPDATE memory_revisions SET status = 'superseded' WHERE memory_id = ? AND status = 'active'").run(String(row.id));
        }
      }
      this.db.prepare(`INSERT INTO memory_events (id, conversation_id, memory_id, action, revision, created_at, actor_id, source_message_id)
        VALUES (?, ?, ?, 'remember', 1, ?, ?, ?)`).run(eventId, conversationId, id, createdAt, writerActorId, input.sourceMessageId ?? null);
      this.db.prepare(`INSERT INTO memories (id, conversation_id, kind, content, revision, status, origin, source_event_id, source_message_id, created_at, updated_at,
        subject_actor_id, writer_actor_id, profile_field, scope_type, person_id, occurred_at, expires_at, profile_source_self)
        VALUES (?, ?, ?, ?, 1, 'active', 'explicit_user', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, conversationId, input.kind ?? 'fact', input.content, eventId, input.sourceMessageId ?? null, createdAt, createdAt,
          input.subjectActorId ?? null, writerActorId, input.profileField ?? null, input.subjectActorId === undefined ? 'room' : 'actor', personId, occurredAt, expiresAt,
          input.profileField !== undefined && input.sourceMessageId !== undefined && writerActorId === input.subjectActorId ? 1 : 0);
      this.db.prepare(`INSERT INTO memory_revisions (memory_id, revision, content, status, source_event_id, source_message_id, created_at, occurred_at, expires_at)
        VALUES (?, 1, ?, 'active', ?, ?, ?, ?, ?)`).run(id, input.content, eventId, input.sourceMessageId ?? null, createdAt, occurredAt, expiresAt);
      if (personId !== null || input.profileField !== undefined) this.resetMemoryScopes(conversationId, personId);
      return { memory: asMemory(this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id)!), contextResetRequired: this.contextState(conversationId).required };
    });
  }

  private actorMemoryScope(conversationId: string, actorId?: string): { sql: string; parameters: (string | null)[] } {
    if (actorId !== undefined) this.requireMemoryActor(conversationId, actorId);
    return { sql: `scope_type = 'actor' AND ((conversation_id = ? AND subject_actor_id = ? AND person_id IS NULL)
      OR (person_id IS NOT NULL AND person_id = ?))`, parameters: [conversationId, actorId ?? null, this.personForActor(conversationId, actorId)] };
  }

  private selectMemories(scope: string, parameters: (string | null)[], query: string, limit: number, at = now()): MemoryRecord[] {
    return this.db.prepare(`SELECT * FROM memories WHERE (${scope}) AND status = 'active' AND is_current = 1
      AND (expires_at IS NULL OR expires_at > ?) AND instr(content, ?) > 0
      ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(...parameters, at, query, limit).map(asMemory);
  }

  queryMemories(conversationId: string, query = '', limit = 20, subjectActorId?: string | null, viewerActorId?: string): MemoryRecord[] {
    validateMemoryQuery(query, limit);
    this.requireMemoryConversation(conversationId);
    if (viewerActorId !== undefined) this.requireMemoryActor(conversationId, viewerActorId);
    if (subjectActorId === null) return this.selectMemories("conversation_id = ? AND scope_type = 'room' AND subject_actor_id IS NULL AND person_id IS NULL", [conversationId], query, limit);
    if (subjectActorId !== undefined) {
      const scope = this.actorMemoryScope(conversationId, subjectActorId);
      return this.selectMemories(scope.sql, scope.parameters, query, limit);
    }
    return this.selectMemories('(conversation_id = ? AND person_id IS NULL) OR (person_id IS NOT NULL AND person_id = ?)',
      [conversationId, this.personForActor(conversationId, viewerActorId)], query, limit);
  }

  recallMemories(conversationId: string, actorId?: string, query = '', limit = 20, profileFields?: readonly ProfileField[]): MemoryRecord[] {
    validateMemoryQuery(query, limit);
    if (actorId !== undefined) this.requireMemoryActor(conversationId, actorId);
    if (profileFields !== undefined && (!Array.isArray(profileFields) || profileFields.some(field => !PROFILE_FIELDS.includes(field)))) {
      throw new MemoryError('成员资料字段无效。');
    }
    const actorScope = this.actorMemoryScope(conversationId, actorId);
    const profileScope = profileFields === undefined ? '' : ` AND writer_actor_id = subject_actor_id AND profile_source_self = 1 AND
      ${profileFields.length > 0 ? `profile_field IN (${profileFields.map(() => '?').join(', ')})` : '0'}`;
    return this.selectMemories(`(conversation_id = ? AND scope_type = 'room' AND subject_actor_id IS NULL AND person_id IS NULL)
      OR (${actorScope.sql}${profileScope})`, [conversationId, ...actorScope.parameters, ...(profileFields ?? [])], query, limit);
  }

  recallMemorySections(conversationId: string, actorId?: string, profileFields: readonly ProfileField[] = [], query = '', at?: string): MemorySections {
    validateMemoryQuery(query, 8);
    this.requireMemoryConversation(conversationId);
    if (!Array.isArray(profileFields) || profileFields.some(field => !PROFILE_FIELDS.includes(field))) throw new MemoryError('成员资料字段无效。');
    const timestamp = at === undefined ? now() : normalizeMemoryTime(at)!;
    const scope = this.actorMemoryScope(conversationId, actorId);
    const block = (sql: string, parameters: (string | null)[], limit: number): MemoryRecord[] => {
      const matched = this.selectMemories(sql, parameters, query, limit, timestamp);
      return matched.length > 0 || query === '' ? matched : this.selectMemories(sql, parameters, '', limit, timestamp);
    };
    return {
      roomMemories: block("conversation_id = ? AND scope_type = 'room' AND subject_actor_id IS NULL AND person_id IS NULL", [conversationId], 2),
      personalMemories: block(`${scope.sql} AND profile_field IS NULL`, scope.parameters, 2),
      profile: profileFields.length === 0 ? [] : block(`${scope.sql} AND writer_actor_id = subject_actor_id AND profile_source_self = 1
        AND profile_field IN (${profileFields.map(() => '?').join(', ')})`, [...scope.parameters, ...profileFields], 4),
    };
  }

  selfProfileMemory(conversationId: string, actorId: string, field: ProfileField): MemoryRecord | undefined {
    this.requireMemoryActor(conversationId, actorId);
    if (!PROFILE_FIELDS.includes(field)) throw new MemoryError('成员资料字段无效。');
    const scope = this.actorMemoryScope(conversationId, actorId);
    const rows = this.selectMemories(`${scope.sql} AND writer_actor_id = subject_actor_id AND profile_field = ?`, [...scope.parameters, field], '', 2);
    if (rows.length > 1) throw new MemoryError('成员资料存在多条记录，拒绝猜测修改目标。');
    return rows[0];
  }

  correctMemory(conversationId: string, id: string, input: MemoryInput, expectedRevision?: number): MemoryChange {
    validateMemoryInput(input);
    validateRevision(expectedRevision);
    return this.memoryTransaction(() => {
      const actorId = this.validateMemorySource(conversationId, input.sourceMessageId);
      const existing = this.requireCurrentMemory(conversationId, id, expectedRevision, input.sourceMessageId === undefined ? undefined : actorId);
      if (input.subjectActorId !== undefined && input.subjectActorId !== existing.subject_actor_id) {
        this.requireMemoryActor(conversationId, input.subjectActorId);
        if (existing.person_id === null || input.subjectActorId !== actorId || this.personForActor(conversationId, input.subjectActorId) !== existing.person_id) {
          throw new MemoryError('纠正记忆不能改变成员范围。');
        }
      }
      if (input.profileField !== undefined && input.profileField !== existing.profile_field) throw new MemoryError('纠正记忆不能改变成员资料字段。');
      const revision = Number(existing.revision) + 1;
      const eventId = randomUUID();
      const updatedAt = now();
      const occurredAt = input.occurredAt === undefined ? existing.occurred_at as string | null : normalizeMemoryTime(input.occurredAt);
      const expiresAt = input.expiresAt === undefined ? existing.expires_at as string | null : normalizeMemoryTime(input.expiresAt);
      const profileSourceSelf = existing.profile_field !== null && existing.writer_actor_id === existing.subject_actor_id
        && input.sourceMessageId !== undefined && (actorId === existing.subject_actor_id
          || (existing.person_id !== null && this.personForActor(conversationId, actorId) === existing.person_id)) ? 1 : 0;
      this.db.prepare(`INSERT INTO memory_events (id, conversation_id, memory_id, action, revision, created_at, actor_id, source_message_id)
        VALUES (?, ?, ?, 'correct', ?, ?, ?, ?)`).run(eventId, conversationId, id, revision, updatedAt, actorId, input.sourceMessageId ?? null);
      this.db.prepare("UPDATE memory_revisions SET status = 'superseded' WHERE memory_id = ? AND status = 'active'").run(id);
      this.db.prepare(`INSERT INTO memory_revisions (memory_id, revision, content, status, source_event_id, source_message_id, created_at, occurred_at, expires_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`).run(id, revision, input.content, eventId, input.sourceMessageId ?? null, updatedAt, occurredAt, expiresAt);
      this.db.prepare(`UPDATE memories SET kind = ?, content = ?, revision = ?, source_event_id = ?, source_message_id = ?, updated_at = ?, occurred_at = ?, expires_at = ?, profile_source_self = ?
        WHERE id = ?`).run(input.kind ?? String(existing.kind), input.content, revision, eventId, input.sourceMessageId ?? null, updatedAt, occurredAt, expiresAt, profileSourceSelf, id);
      this.resetMemoryScopes(conversationId, existing.person_id);
      return { memory: asMemory(this.findMemory(conversationId, id, input.sourceMessageId === undefined ? undefined : actorId)), contextResetRequired: true };
    });
  }

  deleteMemory(conversationId: string, id: string, expectedRevision?: number, sourceMessageId?: string): MemoryDeletion {
    validateRevision(expectedRevision);
    return this.memoryTransaction(() => {
      const actorId = this.validateMemorySource(conversationId, sourceMessageId);
      const existing = this.findMemory(conversationId, id, sourceMessageId === undefined ? undefined : actorId);
      if (existing.status === 'deleted') return { id, revision: Number(existing.revision), deleted: true, contextResetRequired: this.contextState(conversationId).required };
      if (expectedRevision !== undefined && Number(existing.revision) !== expectedRevision) throw new MemoryError('记忆版本已变化，请重新查询后重试。');
      const revision = Number(existing.revision) + 1;
      const eventId = randomUUID();
      const updatedAt = now();
      this.db.prepare(`INSERT INTO memory_events (id, conversation_id, memory_id, action, revision, created_at, actor_id, source_message_id)
        VALUES (?, ?, ?, 'delete', ?, ?, ?, ?)`).run(eventId, conversationId, id, revision, updatedAt, actorId, sourceMessageId ?? null);
      this.db.prepare("UPDATE memory_revisions SET content = NULL, occurred_at = NULL, expires_at = NULL, status = 'deleted' WHERE memory_id = ?").run(id);
      this.db.prepare(`INSERT INTO memory_revisions (memory_id, revision, content, status, source_event_id, source_message_id, created_at)
        VALUES (?, ?, NULL, 'deleted', ?, NULL, ?)`).run(id, revision, eventId, updatedAt);
      this.db.prepare(`UPDATE memories SET content = NULL, occurred_at = NULL, expires_at = NULL, status = 'deleted', revision = ?, source_event_id = ?, source_message_id = NULL, updated_at = ?
        WHERE id = ?`).run(revision, eventId, updatedAt, id);
      this.resetMemoryScopes(conversationId, existing.person_id);
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

  hasExternalMessage(conversationId: string, eventId: string): boolean {
    return this.db.prepare('SELECT id FROM messages WHERE conversation_id = ? AND external_event_id = ?')
      .get(conversationId, eventId) !== undefined;
  }

  externalMessage(conversationId: string, eventId: string): { id: string; actorId: string; senderId: string; text: string } | undefined {
    const row = this.db.prepare(`SELECT m.id, m.actor_id, a.external_user_id, m.text FROM messages m
      JOIN actors a ON a.id = m.actor_id JOIN conversations c ON c.id = m.conversation_id AND c.room_id = a.room_id
      WHERE m.conversation_id = ? AND m.external_event_id = ? AND m.role = 'user'`).get(conversationId, eventId);
    return row ? { id: String(row.id), actorId: String(row.actor_id), senderId: String(row.external_user_id), text: String(row.text) } : undefined;
  }

  findActor(conversationId: string, senderId: string): string | undefined {
    const row = this.db.prepare(`SELECT a.id FROM actors a JOIN conversations c ON c.room_id = a.room_id
      WHERE c.id = ? AND a.external_user_id = ?`).get(conversationId, senderId);
    return row ? String(row.id) : undefined;
  }

  ensureActor(conversationId: string, senderId: string): string {
    if (typeof senderId !== 'string' || !senderId || senderId.length > 512) throw new MemoryError('渠道发送者账号无效。');
    return this.memoryTransaction(() => {
      const conversation = this.db.prepare(`SELECT c.room_id, r.channel FROM conversations c JOIN rooms r ON r.id = c.room_id WHERE c.id = ?`).get(conversationId);
      if (!conversation || conversation.channel === 'cli') throw new MemoryError('渠道成员必须属于真实渠道会话。');
      const existing = this.findActor(conversationId, senderId);
      if (existing) return existing;
      const id = randomUUID();
      this.db.prepare("INSERT INTO actors (id, kind, room_id, external_user_id) VALUES (?, 'external-user', ?, ?)").run(id, String(conversation.room_id), senderId);
      return id;
    });
  }

  private insertInbound(conversationId: string, messageId: string, text: string, createdAt: string, external?: ExternalRunInput): void {
    const conversation = this.db.prepare(`SELECT c.room_id, r.channel FROM conversations c
      JOIN rooms r ON r.id = c.room_id WHERE c.id = ?`).get(conversationId);
    if (!conversation) throw new Error('会话不存在。');
    let actorId = OWNER_ID;
    if (external) {
      if (!external.eventId || typeof external.eventId !== 'string' || !external.senderId || typeof external.senderId !== 'string'
        || typeof external.modelInputText !== 'string'
        || (external.senderName !== undefined && typeof external.senderName !== 'string')
        || (external.messageKind !== undefined && !['chat', 'memory'].includes(external.messageKind))) throw new Error('渠道消息身份或模型输入无效。');
      if (this.hasExternalMessage(conversationId, external.eventId)) throw new DuplicateMessageError();
      actorId = this.ensureActor(conversationId, external.senderId);
    } else if (conversation.channel !== 'cli') {
      throw new Error('渠道输入必须提供实际发送者与事件 ID。');
    }
    this.db.prepare(`INSERT INTO messages (id, conversation_id, actor_id, role, text, created_at, model_input_text, external_event_id, sender_name, message_kind)
      VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)`)
      .run(messageId, conversationId, actorId, text, createdAt, external?.modelInputText ?? null, external?.eventId ?? null,
        external?.senderName ?? null, external?.messageKind ?? 'chat');
  }

  recordInbound(conversationId: string, text: string, external: ExternalRunInput): boolean {
    return this.memoryTransaction(() => {
      if (this.hasExternalMessage(conversationId, external.eventId)) return false;
      this.insertInbound(conversationId, randomUUID(), text, now(), external);
      return true;
    });
  }

  beginRun(conversationId: string, text: string, provider: string, model: string, memoryRefs: readonly MemoryRef[] = [], external?: ExternalRunInput): RunRecord {
    const id = randomUUID();
    const inputMessageId = randomUUID();
    const createdAt = now();
    return this.memoryTransaction(() => {
      if (external && this.hasExternalMessage(conversationId, external.eventId)) throw new DuplicateMessageError();
      for (const ref of memoryRefs) {
        validateRevision(ref.revision);
        const actorId = external ? this.findActor(conversationId, external.senderId) : undefined;
        const memory = this.findMemory(conversationId, ref.id, actorId);
        if (memory.status === 'deleted') throw new MemoryError('记忆已删除。');
        if (memory.is_current !== 1 || (memory.expires_at !== null && String(memory.expires_at) <= createdAt)) throw new MemoryError('记忆已失效。');
        if (external && memory.scope_type === 'actor' && memory.person_id === null && memory.subject_actor_id !== actorId) throw new MemoryError('记忆不存在。');
        if (external && (memory.scope_type === 'legacy' || (memory.profile_field !== null
          && (memory.writer_actor_id !== memory.subject_actor_id || memory.profile_source_self !== 1)))) throw new MemoryError('记忆不存在。');
        if (Number(memory.revision) !== ref.revision) throw new MemoryError('记忆版本已变化，请重新查询后重试。');
      }
      this.insertInbound(conversationId, inputMessageId, text, createdAt, external);
      this.db.prepare(`INSERT INTO agent_runs (id, conversation_id, input_message_id, status, provider, model, started_at)
        VALUES (?, ?, ?, 'running', ?, ?, ?)`).run(id, conversationId, inputMessageId, provider, model, createdAt);
      for (const ref of memoryRefs) {
        this.db.prepare('INSERT INTO memory_uses (run_id, memory_id, revision) VALUES (?, ?, ?)').run(id, ref.id, ref.revision);
      }
      return { id, conversationId, inputMessageId, inputText: text, status: 'running', provider, model,
        ...(external ? { modelInputText: external.modelInputText } : {}) };
    });
  }

  completeRun(runId: string, text: string, piUserEntryId: string | undefined, piAssistantEntryId: string | undefined, recovered = false): { messageId: string; deliveryId: string } {
    return this.memoryTransaction(() => {
      const run = this.db.prepare(`SELECT a.conversation_id, a.provider, a.model, c.room_id, r.channel FROM agent_runs a
        JOIN conversations c ON c.id = a.conversation_id JOIN rooms r ON r.id = c.room_id
        WHERE a.id = ? AND a.status = 'running'`).get(runId) as Record<string, unknown> | undefined;
      if (!run) throw new Error('运行不存在或已结束，不能完成。');
      const conversationId = String(run.conversation_id);
      const messageId = randomUUID();
      const deliveryId = randomUUID();
      const createdAt = now();
      const messageKind = run.provider === 'local' && run.model === 'memory-control' ? 'memory' : 'chat';
      this.db.prepare(`INSERT INTO messages (id, conversation_id, actor_id, role, text, pi_entry_id, created_at, message_kind)
        VALUES (?, ?, NULL, 'assistant', ?, ?, ?, ?)`).run(messageId, conversationId, text, piAssistantEntryId ?? null, createdAt, messageKind);
      this.db.prepare(`UPDATE agent_runs SET status = 'completed', response_message_id = ?, recovered = ?, finished_at = ?
        WHERE id = ? AND status = 'running'`).run(messageId, recovered ? 1 : 0, createdAt, runId);
      this.db.prepare(`INSERT INTO deliveries (id, conversation_id, run_id, message_id, channel, status, created_at, updated_at, room_id)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(deliveryId, conversationId, runId, messageId, String(run.channel), createdAt, createdAt, String(run.room_id));
      if (piUserEntryId !== undefined) {
        this.db.prepare('UPDATE messages SET pi_entry_id = ? WHERE id = (SELECT input_message_id FROM agent_runs WHERE id = ?)').run(piUserEntryId, runId);
      }
      return { messageId, deliveryId };
    });
  }

  recordControlRun(conversationId: string, text: string, external: ExternalRunInput,
    operation: (source: { id: string; actorId: string; senderId: string; text: string }) => string): { text: string; runId: string; deliveryId: string } {
    return this.memoryTransaction(() => {
      const run = this.beginRun(conversationId, text, 'local', 'memory-control', [], { ...external, messageKind: 'memory' });
      const source = this.externalMessage(conversationId, external.eventId);
      if (!source) throw new Error('渠道管理消息来源不存在。');
      const response = operation(source);
      if (typeof response !== 'string') throw new Error('管理操作回复无效。');
      const delivery = this.completeRun(run.id, response, undefined, undefined);
      return { text: response, runId: run.id, deliveryId: delivery.deliveryId };
    });
  }

  failRun(runId: string, status: 'failed' | 'interrupted', kind: string, message: string): void {
    const result = this.db.prepare(`UPDATE agent_runs SET status = ?, error_kind = ?, error_message = ?, finished_at = ?
      WHERE id = ? AND status = 'running'`).run(status, kind, message, now(), runId);
    if (result.changes !== 1) throw new Error('运行不存在或已结束，不能标记失败。');
  }

  unfinishedRuns(conversationId: string): RunRecord[] {
    return this.db.prepare(`SELECT r.id, r.conversation_id AS conversationId, r.input_message_id AS inputMessageId,
      m.text AS inputText, m.model_input_text AS modelInputText, r.status, r.provider, r.model FROM agent_runs r
      JOIN messages m ON m.id = r.input_message_id WHERE r.conversation_id = ? AND r.status = 'running'
      ORDER BY r.started_at, r.rowid`).all(conversationId).map(row => asRun(row as Record<string, unknown>));
  }

  markPendingUncertain(conversationId: string): void {
    this.db.prepare("UPDATE deliveries SET status = 'uncertain', updated_at = ? WHERE conversation_id = ? AND status = 'pending'")
      .run(now(), conversationId);
  }

  ackDelivery(deliveryId: string, status: 'sent' | 'uncertain', externalMessageId?: string): void {
    if (externalMessageId !== undefined && (typeof externalMessageId !== 'string' || !externalMessageId)) throw new Error('渠道投递消息 ID 无效。');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT status, external_message_id FROM deliveries WHERE id = ?').get(deliveryId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('投递记录不存在。');
      const current = String(row.status);
      if (current === status) {
        if (externalMessageId !== undefined && row.external_message_id !== null && row.external_message_id !== externalMessageId) throw new Error('投递已绑定到不同的渠道消息 ID。');
        if (externalMessageId !== undefined && row.external_message_id === null) this.db.prepare('UPDATE deliveries SET external_message_id = ?, updated_at = ? WHERE id = ?')
          .run(externalMessageId, now(), deliveryId);
        this.db.exec('COMMIT'); return;
      }
      if (current !== 'pending') throw new Error(`不能将 ${current} 投递改为 ${status}。`);
      this.db.prepare('UPDATE deliveries SET status = ?, external_message_id = ?, updated_at = ? WHERE id = ?').run(status, externalMessageId ?? null, now(), deliveryId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listMessages(conversationKey: string, limit: number, route?: ChannelRoute): MessageRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit 必须是正整数。');
    const selected = conversationRoute(conversationKey, route);
    const rows = this.db.prepare(`
      SELECT m.id, m.conversation_id AS conversationId, m.role, m.text, m.created_at AS createdAt,
        m.pi_entry_id AS piEntryId, r.status AS runStatus, d.status AS deliveryStatus, m.rowid AS rowId,
        m.model_input_text AS modelInputText, m.external_event_id AS eventId, a.external_user_id AS senderId,
        m.sender_name AS senderName, d.external_message_id AS externalMessageId, m.actor_id AS actorId, m.message_kind AS messageKind
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      JOIN rooms room ON room.id = c.room_id
      LEFT JOIN agent_runs r ON r.input_message_id = m.id OR r.response_message_id = m.id
      LEFT JOIN deliveries d ON d.message_id = m.id
      LEFT JOIN actors a ON a.id = m.actor_id
      WHERE room.channel = ? AND room.account = ? AND room.room_type = ? AND room.external_chat_id = ?
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?
    `).all(selected.channel, selected.accountId, selected.roomType, selected.roomId, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map(asMessage);
  }

  contextMessages(conversationId: string, limit: number, senderId?: string): MessageRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit 必须是正整数。');
    this.requireMemoryConversation(conversationId);
    const rows = this.db.prepare(`SELECT m.id, m.conversation_id AS conversationId, m.role, m.text, m.created_at AS createdAt,
      m.pi_entry_id AS piEntryId, r.status AS runStatus, d.status AS deliveryStatus,
      m.model_input_text AS modelInputText, m.external_event_id AS eventId, a.external_user_id AS senderId,
      m.sender_name AS senderName, d.external_message_id AS externalMessageId, m.actor_id AS actorId, m.message_kind AS messageKind
      FROM messages m LEFT JOIN memory_context_state s ON s.conversation_id = m.conversation_id
      LEFT JOIN agent_runs r ON r.input_message_id = m.id OR r.response_message_id = m.id
      LEFT JOIN messages input ON input.id = r.input_message_id LEFT JOIN actors inputactor ON inputactor.id = input.actor_id
      LEFT JOIN deliveries d ON d.message_id = m.id LEFT JOIN actors a ON a.id = m.actor_id
      WHERE m.conversation_id = ? AND m.rowid > COALESCE(s.history_after_rowid, 0) AND m.message_kind = 'chat'
        AND (r.id IS NULL OR (r.status = 'completed' AND input.rowid > COALESCE(s.history_after_rowid, 0)
          AND NOT EXISTS (SELECT 1 FROM memory_uses used JOIN memories memory ON memory.id = used.memory_id WHERE used.run_id = r.id
            AND (memory.status <> 'active' OR memory.is_current <> 1 OR memory.revision <> used.revision
              OR (memory.expires_at IS NOT NULL AND memory.expires_at <= ?)))))
        AND (? IS NULL OR r.id IS NULL OR inputactor.external_user_id = ?)
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?`).all(conversationId, now(), senderId ?? null, senderId ?? null, limit);
    return rows.reverse().map(asMessage);
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
