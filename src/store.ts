import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { MemoryError } from './memory-types.js';
import type { MemoryChange, MemoryInput, MemoryKind, MemoryRecord, MemoryRef, PrimaryPerson } from './memory-types.js';
import type { ChannelRoute, ExternalRunInput, InboundMessage } from './channel-types.js';
import { AutoMemoryStore, migrateAutoMemory, migrateMemoryRetrieval } from './auto-memory-store.js';
import { migrateSelfProfile } from './self-profile-store.js';
import { memoryWords } from './memory-text.js';
import { validateTurnPlan, type TurnPlan, type TurnReceipt } from './turn-plan.js';
import { isMemoryOwner, type HarnessPolicy } from './harness-policy.js';
import { reclassifySelfProfileTerms, type SelfProfileTermMove } from './self-profile-reclassification.js';

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
  piSessionFile?: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  piEntryId: string | null;
  runStatus: string | null;
  runId?: string;
  deliveryStatus: string | null;
  modelInputText?: string;
  eventId?: string;
  senderId?: string;
  senderName?: string;
  externalMessageId?: string;
  actorId?: string;
  messageKind?: 'chat' | 'memory';
  ingestSeq?: number;
  sentAt?: string;
  piSessionFile?: string;
}

export type ChannelTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted';
export interface ChannelTaskRecord {
  id: string;
  messageId: string;
  input: InboundMessage;
  status: ChannelTaskStatus;
  deliveryId?: string;
}
export type DeliveryMode = 'passive' | 'active';

export class DuplicateMessageError extends Error {
  constructor() { super('当前会话已保存该渠道消息，拒绝重复运行。'); this.name = 'DuplicateMessageError'; }
}

const SCHEMA_VERSION = 14;
const OWNER_ID = 'local-owner';
const historyTokens = memoryWords;

export interface HistoryOptions {
  query?: string; scope?: 'sender' | 'room'; senderId?: string; before?: string; after?: string; limit?: number;
}
export interface HistoryMessage {
  id: string; senderId?: string; senderName?: string; replyToSenderId?: string;
  role: 'user' | 'assistant'; text: string; sentAt?: string;
}


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
    ...(row.piSessionFile == null ? {} : { piSessionFile: String(row.piSessionFile) }),
  };
}

function asMessage(row: Record<string, unknown>): MessageRecord {
  return {
    id: String(row.id), conversationId: String(row.conversationId), role: row.role as MessageRecord['role'],
    text: String(row.text), createdAt: String(row.createdAt), piEntryId: row.piEntryId === null ? null : String(row.piEntryId),
    runStatus: row.runStatus === null ? null : String(row.runStatus),
    ...(row.runId == null ? {} : { runId: String(row.runId) }),
    deliveryStatus: row.deliveryStatus === null ? null : String(row.deliveryStatus),
    ...(row.modelInputText == null ? {} : { modelInputText: String(row.modelInputText) }),
    ...(row.eventId == null ? {} : { eventId: String(row.eventId) }),
    ...(row.senderId == null ? {} : { senderId: String(row.senderId), actorId: String(row.actorId) }),
    ...(row.senderName == null ? {} : { senderName: String(row.senderName) }),
    ...(row.externalMessageId == null ? {} : { externalMessageId: String(row.externalMessageId) }),
    ...(row.messageKind === 'memory' ? { messageKind: 'memory' } : {}),
    ...(row.ingestSeq == null ? {} : { ingestSeq: Number(row.ingestSeq) }),
    ...(row.sentAt == null ? {} : { sentAt: String(row.sentAt) }),
    ...(row.piSessionFile == null ? {} : { piSessionFile: String(row.piSessionFile) }),
  };
}

function asChannelTask(row: Record<string, unknown>): ChannelTaskRecord {
  return { id: String(row.id), messageId: String(row.message_id), input: JSON.parse(String(row.input_json)) as InboundMessage,
    status: row.status as ChannelTaskStatus,
    ...(row.result_delivery_id == null ? {} : { deliveryId: String(row.result_delivery_id) }) };
}

function validateDeliveryMode(mode: DeliveryMode, replySlot?: number): void {
  if (!['passive', 'active'].includes(mode) || (replySlot !== undefined
    && (!Number.isSafeInteger(replySlot) || replySlot < 1 || mode !== 'passive'))) throw new Error('投递模式或被动回复序号无效。');
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
    ...(row.profile_field == null ? {} : { profileField: String(row.profile_field) }),
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
  if ('subjectActorId' in input || 'profileField' in input) throw new MemoryError('个人长期记忆已停用；人物画像请通过自然语言明确更新。');
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
  readonly autoMemory: AutoMemoryStore;
  private readonly db: DatabaseSync;
  private closed = false;
  private transactionDepth = 0;

  constructor(databasePath: string) {
    this.databasePath = resolve(databasePath);
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      this.db.function('history_tokens', { deterministic: true }, value => historyTokens(String(value ?? '')).join(' '));
      this.initialize();
      this.autoMemory = new AutoMemoryStore(this.db, operation => this.memoryTransaction(operation));
    } catch (error) {
      this.db.close();
      this.closed = true;
      throw error;
    }
  }

  private initialize(): void {
    const oldVersion = Number(this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
    if (oldVersion > 0 && oldVersion < SCHEMA_VERSION) {
      const backupPath = `${this.databasePath}.v${oldVersion}.${randomUUID()}.bak`;
      this.db.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    }
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
      if (version < 6) migrateAutoMemory(this.db);
      if (version < 7) migrateSelfProfile(this.db);
      if (version < 8) this.db.exec(`
        CREATE UNIQUE INDEX delivery_conversation_identity ON deliveries(id, conversation_id);
        CREATE TABLE delivery_parts (
          delivery_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          part_index INTEGER NOT NULL CHECK (part_index >= 0),
          text TEXT NOT NULL CHECK (length(text) > 0),
          status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'uncertain', 'rejected')),
          external_message_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (delivery_id, part_index),
          FOREIGN KEY (delivery_id, conversation_id) REFERENCES deliveries(id, conversation_id),
          CHECK (status <> 'sent' OR (external_message_id IS NOT NULL AND length(external_message_id) > 0))
        );
        CREATE INDEX delivery_parts_external_id ON delivery_parts(conversation_id, external_message_id)
          WHERE status = 'sent';
      `);
      if (version < 9) this.db.exec(`
        CREATE TABLE self_profile_pending_v9 (
          id TEXT PRIMARY KEY, content TEXT NOT NULL, source_message_id TEXT NOT NULL REFERENCES messages(id),
          created_at TEXT NOT NULL, archived_revision INTEGER REFERENCES self_profile_revisions(revision), archived_at TEXT,
          UNIQUE(source_message_id,content));
        INSERT INTO self_profile_pending_v9 SELECT * FROM self_profile_pending ORDER BY rowid;
        DROP TABLE self_profile_pending;
        ALTER TABLE self_profile_pending_v9 RENAME TO self_profile_pending;
        CREATE INDEX active_self_profile_pending ON self_profile_pending(archived_revision);
        CREATE TABLE person_profile_pending (
          id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES persons(id), content TEXT NOT NULL,
          source_message_id TEXT NOT NULL REFERENCES messages(id), source_type TEXT NOT NULL CHECK(source_type IN ('self','third_party','inference')),
          created_at TEXT NOT NULL, archived_revision INTEGER, archived_at TEXT,
          FOREIGN KEY(person_id, archived_revision) REFERENCES person_profile_revisions(person_id, revision));
        CREATE INDEX active_person_pending ON person_profile_pending(person_id, archived_revision);
        CREATE TABLE profile_tool_receipts (
          call_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id),
          source_message_id TEXT NOT NULL REFERENCES messages(id), operation TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
          PRIMARY KEY(source_message_id,call_id));
        CREATE TABLE run_progress (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id), text TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','uncertain','rejected')),
          external_message_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE VIRTUAL TABLE message_history_fts USING fts5(message_id UNINDEXED, tokens, tokenize='unicode61');
        INSERT INTO message_history_fts(message_id,tokens) SELECT id,history_tokens(text) FROM messages;
        CREATE TRIGGER history_message_insert AFTER INSERT ON messages BEGIN
          INSERT INTO message_history_fts(message_id,tokens) VALUES (NEW.id,history_tokens(NEW.text));
        END;
        CREATE TRIGGER history_message_update AFTER UPDATE OF text ON messages BEGIN
          DELETE FROM message_history_fts WHERE message_id=OLD.id;
          INSERT INTO message_history_fts(message_id,tokens) VALUES (NEW.id,history_tokens(NEW.text));
        END;
        CREATE TRIGGER history_message_delete AFTER DELETE ON messages BEGIN
          DELETE FROM message_history_fts WHERE message_id=OLD.id;
        END;
      `);
      if (version < 10) this.db.exec(`
        ALTER TABLE agent_runs ADD COLUMN pi_session_file TEXT CHECK (pi_session_file IS NULL OR length(trim(pi_session_file)) > 0);
        DROP INDEX one_running_run_per_conversation;
        CREATE UNIQUE INDEX one_running_run_per_conversation ON agent_runs(conversation_id)
          WHERE status = 'running' AND pi_session_file IS NULL;
        CREATE UNIQUE INDEX one_running_run_per_session ON agent_runs(pi_session_file)
          WHERE status = 'running' AND pi_session_file IS NOT NULL;
        CREATE UNIQUE INDEX message_conversation_identity ON messages(id, conversation_id);
        CREATE TABLE channel_tasks (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
          message_id TEXT NOT NULL UNIQUE, input_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','interrupted')),
          result_delivery_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          FOREIGN KEY (message_id, conversation_id) REFERENCES messages(id, conversation_id),
          FOREIGN KEY (result_delivery_id, conversation_id) REFERENCES deliveries(id, conversation_id),
          CHECK (status <> 'completed' OR result_delivery_id IS NOT NULL)
        );
        CREATE INDEX channel_tasks_by_conversation ON channel_tasks(conversation_id, status, created_at);
        ALTER TABLE run_progress ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'passive' CHECK (delivery_mode IN ('passive','active'));
        ALTER TABLE run_progress ADD COLUMN reply_slot INTEGER CHECK (reply_slot IS NULL OR reply_slot >= 1);
        ALTER TABLE delivery_parts ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'passive' CHECK (delivery_mode IN ('passive','active'));
        ALTER TABLE delivery_parts ADD COLUMN reply_slot INTEGER CHECK (reply_slot IS NULL OR reply_slot >= 1);
      `);
      if (version < 11) {
        this.db.exec(`CREATE TABLE turn_preparations (
          source_message_id TEXT PRIMARY KEY REFERENCES messages(id), plan_json TEXT NOT NULL,
          receipt_json TEXT NOT NULL, created_at TEXT NOT NULL);
          CREATE TABLE room_rule_revisions (
            conversation_id TEXT NOT NULL REFERENCES conversations(id), rule_key TEXT NOT NULL,
            revision INTEGER NOT NULL, content TEXT NOT NULL, source_message_id TEXT NOT NULL REFERENCES messages(id),
            created_at TEXT NOT NULL, PRIMARY KEY(conversation_id,rule_key,revision));
          ALTER TABLE person_profile_pending ADD COLUMN purpose TEXT NOT NULL DEFAULT 'profile' CHECK(purpose IN ('profile','memory'));`);
        migrateMemoryRetrieval(this.db);
      }
      if (version < 12) this.db.exec(`CREATE TABLE self_profile_reclassifications (
        pending_id TEXT PRIMARY KEY REFERENCES self_profile_pending(id),
        source_message_id TEXT NOT NULL REFERENCES messages(id),
        conversation_id TEXT NOT NULL, rule_key TEXT NOT NULL, rule_revision INTEGER NOT NULL,
        from_revision INTEGER NOT NULL REFERENCES self_profile_revisions(revision),
        to_revision INTEGER NOT NULL REFERENCES self_profile_revisions(revision), created_at TEXT NOT NULL,
        FOREIGN KEY (conversation_id,rule_key,rule_revision) REFERENCES room_rule_revisions(conversation_id,rule_key,revision),
        CHECK (to_revision > from_revision));`);
      if (version < 13) this.db.exec(`CREATE TABLE auto_memory_job_deferrals (
        job_id TEXT PRIMARY KEY REFERENCES auto_memory_jobs(id), reason TEXT NOT NULL, created_at TEXT NOT NULL,
        input_hash TEXT, progress_hash TEXT);`);
      if (version < 14) this.db.exec(`
        CREATE TABLE person_profile_pending_results (
          job_id TEXT NOT NULL REFERENCES auto_memory_jobs(id), pending_id TEXT NOT NULL,
          person_id TEXT NOT NULL REFERENCES persons(id), source_message_id TEXT NOT NULL REFERENCES messages(id),
          source_type TEXT NOT NULL CHECK(source_type IN ('self','third_party','inference')),
          content_hash TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('merged','superseded','not_profile','deferred')),
          profile_revision INTEGER NOT NULL, fact_index INTEGER, replacement_message_id TEXT REFERENCES messages(id), reason TEXT,
          created_at TEXT NOT NULL, PRIMARY KEY(job_id,pending_id),
          FOREIGN KEY(person_id,profile_revision) REFERENCES person_profile_revisions(person_id,revision));
        CREATE INDEX profile_pending_results_person ON person_profile_pending_results(person_id,pending_id);
        CREATE TABLE person_profile_revision_sources (
          person_id TEXT NOT NULL, revision INTEGER NOT NULL, fact_index INTEGER NOT NULL,
          message_id TEXT NOT NULL REFERENCES messages(id), PRIMARY KEY(person_id,revision,fact_index,message_id),
          FOREIGN KEY(person_id,revision) REFERENCES person_profile_revisions(person_id,revision));`);
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

  configurePersons(persons: readonly PrimaryPerson[]): void {
    this.memoryTransaction(() => {
      const existing=this.db.prepare('SELECT * FROM person_bindings').all();
      const key=(binding: Record<string,unknown>)=>JSON.stringify([binding.channel,binding.account,binding.room_type,binding.room_id,binding.sender_id,binding.person_id]);
      const requested=persons.flatMap(p=>p.bindings.map(b=>({channel:b.route.channel,account:b.route.accountId,room_type:b.route.roomType,room_id:b.route.roomId,sender_id:b.senderId,person_id:p.id})));
      if(JSON.stringify(existing.map(key).sort())===JSON.stringify(requested.map(key).sort())) return;
      this.autoMemory.configurePersons(persons);
      for (const row of this.db.prepare('SELECT id FROM conversations').all()) this.requireContextReset(String(row.id));
    });
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
      if (expired.length) this.requireContextReset(conversationId);
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

  private supportsSharedMemory(conversationId: string): boolean {
    const room=this.db.prepare('SELECT r.channel,r.room_type FROM conversations c JOIN rooms r ON r.id=c.room_id WHERE c.id=?').get(conversationId);
    return room?.channel==='cli' || room?.room_type==='group';
  }

  private findMemory(conversationId: string, id: string): Record<string, unknown> {
    if (!this.supportsSharedMemory(conversationId)) throw new MemoryError('个人长期记忆已停用，私聊仅支持画像更新。');
    const row = this.db.prepare(`SELECT * FROM memories WHERE id=? AND conversation_id=?
      AND subject_actor_id IS NULL AND person_id IS NULL AND profile_field IS NULL`).get(id,conversationId);
    if (!row) throw new MemoryError('群记忆不存在；个人长期记忆已停用。');
    return row;
  }

  private requireCurrentMemory(conversationId: string, id: string, expectedRevision: number | undefined): Record<string, unknown> {
    const row = this.findMemory(conversationId, id);
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
      if (!this.supportsSharedMemory(conversationId)) throw new MemoryError('个人长期记忆已停用，私聊仅支持画像更新。');
      const writerActorId = this.validateMemorySource(conversationId, input.sourceMessageId);
      const id=randomUUID(), eventId=randomUUID(), createdAt=now();
      const occurredAt=normalizeMemoryTime(input.occurredAt), expiresAt=normalizeMemoryTime(input.expiresAt);
      this.db.prepare(`INSERT INTO memory_events (id,conversation_id,memory_id,action,revision,created_at,actor_id,source_message_id)
        VALUES (?,?,?,'remember',1,?,?,?)`).run(eventId,conversationId,id,createdAt,writerActorId,input.sourceMessageId??null);
      this.db.prepare(`INSERT INTO memories (id,conversation_id,kind,content,revision,status,origin,source_event_id,source_message_id,created_at,updated_at,
        writer_actor_id,scope_type,occurred_at,expires_at) VALUES (?,?,?,?,1,'active','explicit_user',?,?,?,?,?,'room',?,?)`)
        .run(id,conversationId,input.kind??'fact',input.content,eventId,input.sourceMessageId??null,createdAt,createdAt,writerActorId,occurredAt,expiresAt);
      this.db.prepare(`INSERT INTO memory_revisions (memory_id,revision,content,status,source_event_id,source_message_id,created_at,occurred_at,expires_at)
        VALUES (?,1,?,'active',?,?,?,?,?)`).run(id,input.content,eventId,input.sourceMessageId??null,createdAt,occurredAt,expiresAt);
      return {memory:asMemory(this.findMemory(conversationId,id)),contextResetRequired:this.contextState(conversationId).required};
    });
  }

  private selectMemories(scope: string, parameters: (string | null)[], query: string, limit: number, at = now()): MemoryRecord[] {
    return this.db.prepare(`SELECT * FROM memories WHERE (${scope}) AND status = 'active' AND is_current = 1
      AND (expires_at IS NULL OR expires_at > ?) AND instr(content, ?) > 0
      ORDER BY updated_at DESC, rowid DESC LIMIT ?`).all(...parameters, at, query, limit).map(asMemory);
  }

  queryMemories(conversationId: string, query = '', limit = 20): MemoryRecord[] {
    validateMemoryQuery(query,limit);
    this.requireMemoryConversation(conversationId);
    if (!this.supportsSharedMemory(conversationId)) return [];
    return this.selectMemories(`conversation_id=? AND subject_actor_id IS NULL AND person_id IS NULL AND profile_field IS NULL
      AND (scope_type='room' OR (scope_type='legacy' AND EXISTS (SELECT 1 FROM conversations c JOIN rooms r ON r.id=c.room_id WHERE c.id=memories.conversation_id AND r.channel='cli')))`,[conversationId],query,limit);
  }

  correctMemory(conversationId: string, id: string, input: MemoryInput, expectedRevision?: number): MemoryChange {
    validateMemoryInput(input);
    validateRevision(expectedRevision);
    return this.memoryTransaction(() => {
      const actorId=this.validateMemorySource(conversationId,input.sourceMessageId);
      const existing=this.requireCurrentMemory(conversationId,id,expectedRevision);
      if(input.sourceMessageId!==undefined && existing.source_message_id!=null) {
        const incoming=this.db.prepare('SELECT ingest_seq FROM messages WHERE id=?').get(input.sourceMessageId);
        const previous=this.db.prepare('SELECT ingest_seq FROM messages WHERE id=?').get(String(existing.source_message_id));
        if(Number(incoming?.ingest_seq??0)<Number(previous?.ingest_seq??0))throw new MemoryError('较旧来源不能覆盖较新的明确记忆。');
      }
      const revision=Number(existing.revision)+1,eventId=randomUUID(),updatedAt=now();
      const occurredAt=input.occurredAt===undefined?existing.occurred_at as string|null:normalizeMemoryTime(input.occurredAt);
      const expiresAt=input.expiresAt===undefined?existing.expires_at as string|null:normalizeMemoryTime(input.expiresAt);
      this.db.prepare(`INSERT INTO memory_events (id,conversation_id,memory_id,action,revision,created_at,actor_id,source_message_id)
        VALUES (?,?,?,'correct',?,?,?,?)`).run(eventId,conversationId,id,revision,updatedAt,actorId,input.sourceMessageId??null);
      this.db.prepare("UPDATE memory_revisions SET status='superseded' WHERE memory_id=? AND status='active'").run(id);
      this.db.prepare(`INSERT INTO memory_revisions (memory_id,revision,content,status,source_event_id,source_message_id,created_at,occurred_at,expires_at)
        VALUES (?,?,?,'active',?,?,?,?,?)`).run(id,revision,input.content,eventId,input.sourceMessageId??null,updatedAt,occurredAt,expiresAt);
      this.db.prepare(`UPDATE memories SET kind=?,content=?,revision=?,source_event_id=?,source_message_id=?,updated_at=?,occurred_at=?,expires_at=? WHERE id=?`)
        .run(input.kind??String(existing.kind),input.content,revision,eventId,input.sourceMessageId??null,updatedAt,occurredAt,expiresAt,id);
      this.requireContextReset(conversationId);
      return {memory:asMemory(this.findMemory(conversationId,id)),contextResetRequired:true};
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

  identityCard(conversationId: string, senderId: string, policy: HarnessPolicy): {
    senderId: string; personId?: string; displayName?: string; isMaintainer: boolean;
  } {
    const row = this.db.prepare(`SELECT a.id, ap.person_id,
      (SELECT sender_name FROM messages WHERE actor_id=a.id AND sender_name IS NOT NULL ORDER BY ingest_seq DESC LIMIT 1) AS name,
      r.channel,r.account,r.room_type,r.external_chat_id
      FROM conversations c JOIN rooms r ON r.id=c.room_id JOIN actors a ON a.room_id=r.id
      LEFT JOIN actor_person_bindings ap ON ap.actor_id=a.id WHERE c.id=? AND a.external_user_id=?`).get(conversationId,senderId);
    if (!row) return { senderId, isMaintainer: false };
    return { senderId, ...(row.person_id ? { personId: String(row.person_id) } : {}),
      ...(row.name ? { displayName: String(row.name).slice(0,100) } : {}),
      isMaintainer: isMemoryOwner(policy, { route: { channel: String(row.channel), accountId: String(row.account),
        roomType: row.room_type as 'group' | 'private', roomId: String(row.external_chat_id) }, senderId }) };
  }

  roomRules(conversationId: string): { key: string; content: string }[] {
    this.requireMemoryConversation(conversationId);
    return this.autoMemory.roomRules(conversationId);
  }

  reclassifySelfProfileTerms(moves: readonly SelfProfileTermMove[], policy: HarnessPolicy, expectedVersion: number): {
    revision: number; moved: number;
  } {
    return this.memoryTransaction(() => reclassifySelfProfileTerms(this.db,
      this.autoMemory.selfProfile.snapshot(), moves, policy, expectedVersion));
  }

  prepareTurn(conversationId: string, sourceMessageId: string, proposed: TurnPlan, policy: HarnessPolicy,
    mentionedSenderIds: readonly string[] = [], selfBudget?: number): TurnReceipt {
    const plan = validateTurnPlan(proposed);
    return this.memoryTransaction(() => {
      const source = this.db.prepare(`SELECT m.text,m.actor_id,a.external_user_id,r.room_type FROM messages m
        JOIN conversations c ON c.id=m.conversation_id JOIN rooms r ON r.id=c.room_id JOIN actors a ON a.id=m.actor_id
        WHERE m.id=? AND m.conversation_id=? AND m.role='user' AND a.room_id=c.room_id`).get(sourceMessageId,conversationId);
      if (!source) throw new MemoryError('本轮缺少有效来源。');
      const canonical = JSON.stringify({ intent:plan.intent,mode:plan.mode,
        ...(plan.progressText === undefined ? {} : {progressText:plan.progressText}),updates:plan.updates.map(u=>({target:u.target,
        content:u.content,sourceType:u.sourceType??'third_party',senderId:u.senderId??null,key:u.key??null})) });
      const previous = this.db.prepare('SELECT plan_json,receipt_json FROM turn_preparations WHERE source_message_id=?').get(sourceMessageId);
      if (previous) {
        if (previous.plan_json !== canonical) throw new MemoryError('本条消息已经完成准备，不能重复更改保存内容。');
        return JSON.parse(String(previous.receipt_json)) as TurnReceipt;
      }
      const current = this.identityCard(conversationId,String(source.external_user_id),policy);
      const receipt: TurnReceipt = {prepared:true,mode:plan.mode,saved:[]};
      for (const update of plan.updates) {
        if (!String(source.text).includes(update.content)) throw new MemoryError('保存内容必须连续摘录当前消息原文。');
        if (['mentioned_person','room_rule','room_memory'].includes(update.target) && !current.isMaintainer) {
          throw new MemoryError('你没有管理其他人物或群规则、群记忆的权限；本批内容均未保存。');
        }
        if (['room_rule','room_memory'].includes(update.target) && source.room_type !== 'group') throw new MemoryError('群规则和群记忆只能在对应群聊中设置。');
        if (update.target === 'sender' || update.target === 'mentioned_person') {
          const subject = update.target === 'sender' ? String(source.actor_id) : this.findActor(conversationId,update.senderId!);
          if (!subject || (update.target === 'mentioned_person' && !mentionedSenderIds.includes(update.senderId!)
            && !String(source.text).includes(`<@${update.senderId}>`) && !String(source.text).includes(`<@!${update.senderId}>`))) {
            throw new MemoryError('请在当前消息明确 @ 要记录的已知群成员。');
          }
          this.autoMemory.addProfilePending(this.autoMemory.ensureActorPerson(subject),sourceMessageId,update.content,
            update.target==='mentioned_person'?'third_party':update.sourceType??'third_party',
            {allowThirdParty:update.target==='mentioned_person'});
          receipt.saved.push({target:update.target,status:'saved_pending'});
        } else if (update.target === 'ai_self') {
          this.autoMemory.selfProfile.addPending(sourceMessageId,update.content,selfBudget);
          receipt.saved.push({target:update.target,status:'saved_pending'});
        } else if (update.target === 'room_rule') {
          const key=update.key!.normalize('NFKC').trim().toLocaleLowerCase('zh');
          const old=this.db.prepare('SELECT revision,content FROM room_rule_revisions WHERE conversation_id=? AND rule_key=? ORDER BY revision DESC LIMIT 1').get(conversationId,key);
          if (old?.content !== update.content) this.db.prepare('INSERT INTO room_rule_revisions VALUES (?,?,?,?,?,?)')
            .run(conversationId,key,Number(old?.revision??0)+1,update.content,sourceMessageId,now());
          const rules=this.roomRules(conversationId);
          if(rules.length>50 || Buffer.byteLength(JSON.stringify(rules))>12000) throw new MemoryError('本群规则容量已满，请精简或纠正已有约定。');
          receipt.saved.push({target:update.target,status:'saved'});
        } else {
          const duplicate=this.db.prepare(`SELECT id FROM memories WHERE conversation_id=? AND scope_type='room'
            AND status='active' AND is_current=1 AND content=?`).get(conversationId,update.content);
          if(!duplicate)this.rememberMemory(conversationId,{content:update.content,kind:'fact',sourceMessageId});
          receipt.saved.push({target:update.target,status:'saved'});
        }
      }
      this.db.prepare('INSERT INTO turn_preparations VALUES (?,?,?,?)').run(sourceMessageId,canonical,JSON.stringify(receipt),now());
      return receipt;
    });
  }

  readHistory(conversationId: string, currentMessageId: string, options: HistoryOptions = {}): { messages: HistoryMessage[]; scope: 'sender' | 'room' } {
    const limit = options.limit ?? 6;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 || !['sender','room'].includes(options.scope ?? 'sender')
      || (options.query !== undefined && (typeof options.query !== 'string' || [...options.query].length > 1000))
      || (options.senderId !== undefined && (typeof options.senderId !== 'string' || !options.senderId))) throw new MemoryError('历史检索参数无效。');
    const before = normalizeMemoryTime(options.before); const after = normalizeMemoryTime(options.after);
    if (before && after && after >= before) throw new MemoryError('历史时间范围无效。');
    return this.memoryTransaction(() => {
      const current = this.db.prepare(`SELECT m.actor_id,m.ingest_seq,r.room_type,c.room_id FROM messages m
        JOIN actors a ON a.id=m.actor_id JOIN conversations c ON c.id=m.conversation_id JOIN rooms r ON r.id=c.room_id
        WHERE m.id=? AND m.conversation_id=? AND m.role='user' AND (a.room_id=c.room_id OR a.kind='local-owner')`)
        .get(currentMessageId,conversationId);
      if (!current) throw new MemoryError('历史检索边界必须属于当前会话的真人消息。');
      const scope = options.scope ?? 'sender';
      if (scope === 'room' && current.room_type !== 'group') throw new MemoryError('仅群聊允许按当前房间检索。');
      let actorId: string | null = scope === 'sender' ? String(current.actor_id) : null;
      if (options.senderId !== undefined) {
        const actor = this.db.prepare('SELECT id FROM actors WHERE room_id=? AND external_user_id=?').get(String(current.room_id),options.senderId);
        if (!actor) throw new MemoryError('历史检索成员不属于当前房间。');
        actorId = String(actor.id);
      }
      const tokens = historyTokens(options.query ?? '');
      const match = [...new Set(tokens)].map(token => '"' + token.replaceAll('"','""') + '"').join(' OR ');
      const filtered = `SELECT m.id,m.role,m.text,m.ingest_seq,m.sent_at,m.created_at,m.sender_name,
        a.external_user_id AS sender_id,inputa.external_user_id AS reply_sender_id,r.input_message_id,r.response_message_id
        ${match ? ',bm25(message_history_fts) AS score' : ''}
        FROM messages m LEFT JOIN actors a ON a.id=m.actor_id
        LEFT JOIN agent_runs r ON r.input_message_id=m.id OR r.response_message_id=m.id
        LEFT JOIN messages input ON input.id=r.input_message_id LEFT JOIN actors inputa ON inputa.id=input.actor_id
        LEFT JOIN deliveries d ON d.message_id=m.id
        ${match ? 'JOIN message_history_fts ON message_history_fts.message_id=m.id' : ''}
        WHERE m.conversation_id=? AND m.ingest_seq<?
          AND (m.role='user' OR (r.status='completed' AND d.status='sent' AND input.ingest_seq<?))
          AND (? IS NULL OR CASE WHEN m.role='assistant' THEN input.actor_id ELSE m.actor_id END=?)
          AND (? IS NULL OR COALESCE(m.sent_at,m.created_at)<?)
          AND (? IS NULL OR COALESCE(m.sent_at,m.created_at)>?)`;
      const parameters = [conversationId,Number(current.ingest_seq),Number(current.ingest_seq),actorId,actorId,before,before,after,after];
      const ranked = this.db.prepare(filtered + (match ? ' AND message_history_fts MATCH ? ORDER BY score,m.ingest_seq DESC LIMIT ?' : ' ORDER BY m.ingest_seq DESC LIMIT ?'))
        .all(...parameters,...(match ? [match] : []),limit);
      const selected = new Map<string, (typeof ranked)[number]>();
      // Include the matching turn's other half only inside the same scope and time window.
      if (match) {
        const eligible = this.db.prepare(filtered.replace(',bm25(message_history_fts) AS score','')
          .replace('JOIN message_history_fts ON message_history_fts.message_id=m.id','') + ' AND m.id=?');
        for (const row of ranked) {
          if (selected.size >= limit) break;
          selected.set(String(row.id),row);
          if (selected.size >= limit) break;
          const paired = row.role === 'user' ? row.response_message_id : row.input_message_id;
          if (paired == null || selected.has(String(paired))) continue;
          const reply = eligible.get(...parameters,paired);
          if (reply) selected.set(String(reply.id),reply);
          if (selected.size >= limit) break;
        }
      }
      if (!match) for (const row of ranked) selected.set(String(row.id),row);
      return { scope, messages: [...selected.values()].sort((a,b) => Number(a.ingest_seq)-Number(b.ingest_seq)).map(row => ({
        id: String(row.id), role: row.role as 'user'|'assistant', text: String(row.text),
        ...(row.sender_id == null ? {} : { senderId: String(row.sender_id) }),
        ...(row.sender_name == null ? {} : { senderName: String(row.sender_name) }),
        ...(row.role !== 'assistant' || row.reply_sender_id == null ? {} : { replyToSenderId: String(row.reply_sender_id) }),
        sentAt: String(row.sent_at ?? row.created_at),
      })) };
    });
  }

  createProgress(runId: string, text: string): { id: string } {
    if (typeof text !== 'string' || !text.trim()) throw new Error('进展内容不能为空。');
    return this.memoryTransaction(() => {
      if (!this.db.prepare("SELECT id FROM agent_runs WHERE id=? AND status='running'").get(runId)) throw new Error('进展必须属于正在运行的任务。');
      const id = randomUUID();
      this.db.prepare("INSERT INTO run_progress (id,run_id,text,status,external_message_id,created_at,updated_at) VALUES (?,?,?,'pending',NULL,?,?)").run(id,runId,text,now(),now());
      return { id };
    });
  }
  startProgress(id: string, mode: DeliveryMode = 'passive', replySlot?: number): void {
    validateDeliveryMode(mode, replySlot);
    if (this.db.prepare("UPDATE run_progress SET status='sending',delivery_mode=?,reply_slot=?,updated_at=? WHERE id=? AND status='pending'").run(mode,replySlot ?? null,now(),id).changes !== 1) {
      throw new Error('进展已经尝试发送或不存在。');
    }
  }
  ackProgress(id: string, status: 'sent'|'uncertain'|'rejected', externalId?: string): void {
    if (!['sent','uncertain','rejected'].includes(status) || (externalId !== undefined && (typeof externalId !== 'string' || !externalId))) throw new Error('进展回执无效。');
    this.memoryTransaction(() => {
      const row = this.db.prepare('SELECT status,external_message_id FROM run_progress WHERE id=?').get(id);
      if (row?.status === status && row.external_message_id === (externalId ?? null)) return;
      if (!row || row.status !== 'sending') throw new Error('进展不能修改或重复发送。');
      this.db.prepare('UPDATE run_progress SET status=?,external_message_id=?,updated_at=? WHERE id=?').run(status,externalId ?? null,now(),id);
    });
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

  quotedMessage(conversationId: string, externalId: string): { role: 'user' | 'assistant'; senderId?: string; text: string } | undefined {
    if (typeof externalId !== 'string' || !externalId || externalId.length > 512
      || externalId.trim() !== externalId || /[\u0000-\u001f\u007f]/.test(externalId)) return undefined;
    // Both inbound event IDs and confirmed outgoing IDs are scoped to this exact conversation.
    // Ambiguous IDs fail closed instead of selecting an arbitrary message.
    const rows = this.db.prepare(`SELECT m.id, m.role, m.text, a.external_user_id AS senderId FROM messages m
      LEFT JOIN actors a ON a.id = m.actor_id
      WHERE m.conversation_id = ? AND ((m.role = 'user' AND m.external_event_id = ?)
        OR (m.role = 'assistant' AND EXISTS (SELECT 1 FROM deliveries d WHERE d.message_id = m.id
          AND d.conversation_id = m.conversation_id AND d.status = 'sent' AND d.external_message_id = ?
          AND NOT EXISTS (SELECT 1 FROM delivery_parts p WHERE p.delivery_id = d.id))))
      UNION ALL SELECT p.delivery_id || ':' || p.part_index, 'assistant', p.text, NULL FROM delivery_parts p
        WHERE p.conversation_id = ? AND p.status = 'sent' AND p.external_message_id = ?
      LIMIT 2`).all(conversationId, externalId, externalId, conversationId, externalId);
    if (rows.length !== 1) return undefined;
    const row = rows[0]!;
    return { role: row.role as 'user' | 'assistant', text: String(row.text),
      ...(row.senderId == null ? {} : { senderId: String(row.senderId) }) };
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
      if (existing) { this.autoMemory.ensureActorPerson(existing); return existing; }
      const id = randomUUID();
      this.db.prepare("INSERT INTO actors (id, kind, room_id, external_user_id) VALUES (?, 'external-user', ?, ?)").run(id, String(conversation.room_id), senderId);
      this.autoMemory.ensureActorPerson(id);
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
    this.db.prepare(`INSERT INTO messages (id, conversation_id, actor_id, role, text, created_at, model_input_text, external_event_id, sender_name, message_kind, sent_at)
      VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?)`)
      .run(messageId, conversationId, actorId, text, createdAt, external?.modelInputText ?? null, external?.eventId ?? null,
        external?.senderName ?? null, external?.messageKind ?? 'chat', external?.sentAt === undefined ? null : normalizeMemoryTime(external.sentAt));
  }

  recordInbound(conversationId: string, text: string, external: ExternalRunInput): boolean {
    return this.memoryTransaction(() => {
      if (this.hasExternalMessage(conversationId, external.eventId)) return false;
      this.insertInbound(conversationId, randomUUID(), text, now(), external);
      return true;
    });
  }

  enqueueChannelTask(conversationId: string, sourceMessageId: string, input: InboundMessage): { id: string; status: ChannelTaskStatus } {
    return this.memoryTransaction(() => {
      const source = this.db.prepare(`SELECT m.id,m.text,m.external_event_id,m.sender_name,m.sent_at,a.external_user_id,
        room.channel,room.account,room.room_type,room.external_chat_id FROM messages m
        JOIN conversations c ON c.id=m.conversation_id JOIN rooms room ON room.id=c.room_id
        JOIN actors a ON a.id=m.actor_id AND a.room_id=c.room_id
        WHERE m.id=? AND m.conversation_id=? AND m.role='user'`).get(sourceMessageId, conversationId);
      if (!source || !input || !input.route || source.text !== input.text || source.external_event_id !== input.eventId
        || source.external_user_id !== input.senderId || source.channel !== input.route.channel || source.account !== input.route.accountId
        || source.room_type !== input.route.roomType || source.external_chat_id !== input.route.roomId
        || typeof input.mentioned !== 'boolean' || typeof input.sentAt !== 'string'
        || (input.senderName !== undefined && typeof input.senderName !== 'string')) throw new Error('任务来源与原始渠道消息不一致。');
      const sentAt = normalizeMemoryTime(input.sentAt);
      if (source.sent_at != null && source.sent_at !== sentAt) {
        throw new Error('任务来源与原始渠道消息不一致。');
      }
      const inputJson = JSON.stringify(input);
      const existing = this.db.prepare('SELECT id,status,input_json FROM channel_tasks WHERE message_id=?').get(sourceMessageId);
      if (existing) {
        if (!isDeepStrictEqual(JSON.parse(String(existing.input_json)), JSON.parse(inputJson))) throw new Error('任务原始输入不能修改。');
        return { id: String(existing.id), status: existing.status as ChannelTaskStatus };
      }
      if (this.db.prepare('SELECT id FROM agent_runs WHERE input_message_id=?').get(sourceMessageId)) throw new Error('已运行的消息不能重新排队。');
      const id = randomUUID();
      const createdAt = now();
      this.db.prepare(`INSERT INTO channel_tasks (id,conversation_id,message_id,input_json,status,created_at,updated_at)
        VALUES (?,?,?,?,'queued',?,?)`).run(id, conversationId, sourceMessageId, inputJson, createdAt, createdAt);
      return { id, status: 'queued' };
    });
  }

  claimChannelTask(id: string): boolean {
    return this.db.prepare(`UPDATE channel_tasks SET status='running',updated_at=? WHERE id=? AND status='queued'
      AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE input_message_id=channel_tasks.message_id)`).run(now(), id).changes === 1;
  }

  finishChannelTask(id: string, status: 'completed' | 'failed' | 'interrupted', deliveryId?: string): void {
    if (!['completed', 'failed', 'interrupted'].includes(status)) throw new Error('任务结束状态无效。');
    this.memoryTransaction(() => {
      const task = this.db.prepare('SELECT * FROM channel_tasks WHERE id=?').get(id);
      if (!task) throw new Error('渠道任务不存在。');
      let resultId: string | null = null;
      if (status === 'completed') {
        const result = this.db.prepare(`SELECT d.id FROM agent_runs r JOIN deliveries d ON d.run_id=r.id
          WHERE r.input_message_id=? AND r.conversation_id=? AND r.status='completed'
            AND (? IS NULL OR d.id=?)`).get(String(task.message_id), String(task.conversation_id), deliveryId ?? null, deliveryId ?? null);
        if (!result) throw new Error('任务没有对应的已完成运行或投递。');
        resultId = String(result.id);
      } else if (deliveryId !== undefined) throw new Error('未完成任务不能绑定结果投递。');
      if (task.status === status && task.result_delivery_id === resultId) return;
      if (!['queued', 'running'].includes(String(task.status))) throw new Error('渠道任务已结束，不能修改。');
      this.db.prepare('UPDATE channel_tasks SET status=?,result_delivery_id=?,updated_at=? WHERE id=?').run(status, resultId, now(), id);
    });
  }

  listChannelTasks(conversationId: string, status?: ChannelTaskStatus): ChannelTaskRecord[] {
    if (status !== undefined && !['queued', 'running', 'completed', 'failed', 'interrupted'].includes(status)) throw new Error('任务状态无效。');
    return this.db.prepare(`SELECT * FROM channel_tasks WHERE conversation_id=? AND (? IS NULL OR status=?)
      ORDER BY created_at,rowid`).all(conversationId, status ?? null, status ?? null).map(row => asChannelTask(row));
  }

  recoverChannelTasks(conversationId: string): void {
    this.memoryTransaction(() => {
      const tasks = this.db.prepare(`SELECT t.id,t.status,r.status AS run_status,d.id AS delivery_id
        FROM channel_tasks t LEFT JOIN agent_runs r ON r.input_message_id=t.message_id
        LEFT JOIN deliveries d ON d.run_id=r.id
        WHERE t.conversation_id=? AND t.status IN ('queued','running')`).all(conversationId);
      for (const task of tasks) {
        if (task.status === 'queued' && task.run_status == null) continue;
        const status = task.run_status === 'completed' && task.delivery_id != null ? 'completed'
          : task.run_status === 'failed' ? 'failed' : 'interrupted';
        this.db.prepare('UPDATE channel_tasks SET status=?,result_delivery_id=?,updated_at=? WHERE id=?')
          .run(status, status === 'completed' ? String(task.delivery_id) : null, now(), String(task.id));
      }
    });
  }

  latestTaskResult(conversationId: string, senderId: string, taskId?: string): {
    taskId: string; text: string; deliveryId: string; sourceEventId: string; sourceText: string;
  } | undefined {
    if (typeof senderId !== 'string' || !senderId) return undefined;
    let selectedId: string | undefined;
    if (taskId !== undefined) {
      if (!/^(?:[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{3}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(taskId)) return undefined;
      const candidates = this.db.prepare('SELECT id FROM channel_tasks WHERE conversation_id=? AND substr(id,1,?)=? COLLATE NOCASE')
        .all(conversationId, taskId.length, taskId);
      if (candidates.length !== 1) return undefined;
      selectedId = String(candidates[0]!.id);
    }
    const row = this.db.prepare(`SELECT t.id,d.id AS delivery_id,response.text,m.external_event_id,m.text AS source_text
      FROM channel_tasks t JOIN messages m ON m.id=t.message_id AND m.conversation_id=t.conversation_id
      JOIN actors a ON a.id=m.actor_id JOIN conversations c ON c.id=t.conversation_id AND c.room_id=a.room_id
      JOIN agent_runs r ON r.input_message_id=m.id AND r.conversation_id=t.conversation_id AND r.status='completed'
      JOIN deliveries d ON d.run_id=r.id AND d.id=t.result_delivery_id AND d.conversation_id=t.conversation_id
      JOIN messages response ON response.id=r.response_message_id
      WHERE t.conversation_id=? AND a.external_user_id=? AND t.status='completed'
        AND NOT (r.provider='local' AND r.model='memory-control') AND (? IS NULL OR t.id=?)
      ORDER BY t.created_at DESC,t.rowid DESC LIMIT 1`).get(conversationId, senderId, selectedId ?? null, selectedId ?? null);
    if (!row) return undefined;
    const parts = this.db.prepare('SELECT text FROM delivery_parts WHERE delivery_id=? ORDER BY part_index').all(row.delivery_id!);
    return { taskId: String(row.id), text: parts.length ? parts.map(part => String(part.text)).join('') : String(row.text),
      deliveryId: String(row.delivery_id), sourceEventId: String(row.external_event_id), sourceText: String(row.source_text) };
  }

  beginRun(conversationId: string, text: string, provider: string, model: string, memoryRefs: readonly MemoryRef[] = [], external?: ExternalRunInput, modelInputText?: string, piSessionFile?: string): RunRecord {
    if(modelInputText!==undefined&&typeof modelInputText!=='string') throw new Error('模型输入必须是字符串。');
    if (piSessionFile !== undefined && (typeof piSessionFile !== 'string' || !piSessionFile.trim())) throw new Error('独立 Pi session 路径不能为空。');
    const id = randomUUID();
    const inputMessageId = external?.existingMessageId ?? randomUUID();
    const createdAt = now();
    return this.memoryTransaction(() => {
      if (piSessionFile !== undefined && this.db.prepare('SELECT id FROM conversations WHERE pi_session_file=?').get(piSessionFile)) {
        throw new Error('独立运行不能使用会话的 canonical Pi session。');
      }
      if (piSessionFile !== undefined && this.db.prepare('SELECT id FROM agent_runs WHERE pi_session_file=? AND input_message_id<>?')
        .get(piSessionFile, inputMessageId)) throw new Error('独立 Pi session 已绑定其他来源消息。');
      if (external?.existingMessageId !== undefined) {
        const source = this.externalMessage(conversationId, external.eventId);
        if (!source || source.id !== external.existingMessageId || source.senderId !== external.senderId || source.text !== text
          || this.db.prepare('SELECT id FROM agent_runs WHERE input_message_id=?').get(source.id)) throw new DuplicateMessageError();
      } else if (external && this.hasExternalMessage(conversationId, external.eventId)) throw new DuplicateMessageError();
      for (const ref of memoryRefs) {
        validateRevision(ref.revision);
        const memory = this.findMemory(conversationId, ref.id);
        if (memory.status === 'deleted') throw new MemoryError('记忆已删除。');
        if (memory.is_current !== 1 || (memory.expires_at !== null && String(memory.expires_at) <= createdAt)) throw new MemoryError('记忆已失效。');
        if (external && memory.scope_type === 'legacy') throw new MemoryError('记忆不存在。');
        if (Number(memory.revision) !== ref.revision) throw new MemoryError('记忆版本已变化，请重新查询后重试。');
      }
      if (external?.existingMessageId === undefined) this.insertInbound(conversationId, inputMessageId, text, createdAt, external);
      else if (external.messageKind === 'memory') this.db.prepare("UPDATE messages SET message_kind='memory' WHERE id=?").run(inputMessageId);
      const actualModelInput=modelInputText??external?.modelInputText;
      if(actualModelInput!==undefined) this.db.prepare('UPDATE messages SET model_input_text=? WHERE id=?').run(actualModelInput,inputMessageId);
      this.db.prepare(`INSERT INTO agent_runs (id, conversation_id, input_message_id, status, provider, model, started_at, pi_session_file)
        VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`).run(id, conversationId, inputMessageId, provider, model, createdAt, piSessionFile ?? null);
      for (const ref of memoryRefs) {
        this.db.prepare('INSERT INTO memory_uses (run_id, memory_id, revision) VALUES (?, ?, ?)').run(id, ref.id, ref.revision);
      }
      return { id, conversationId, inputMessageId, inputText: text, status: 'running', provider, model,
        ...(piSessionFile === undefined ? {} : { piSessionFile }),
        ...(actualModelInput===undefined ? {} : { modelInputText: actualModelInput }) };
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
      const result = this.beginControlRun(conversationId, text, external, operation);
      const delivery = this.completeRun(result.runId, result.text, undefined, undefined);
      return { ...result, deliveryId: delivery.deliveryId };
    });
  }

  // Commit the authoritative operation before an optional model confirmation.
  // A crash leaves a running marker; recovery never repeats the operation or request.
  beginControlRun(conversationId: string, text: string, external: ExternalRunInput,
    operation: (source: { id: string; actorId: string; senderId: string; text: string }) => string): { text: string; runId: string } {
    return this.memoryTransaction(() => {
      const run = this.beginRun(conversationId, text, 'local', 'memory-control', [], { ...external, messageKind: 'memory' });
      const source = this.externalMessage(conversationId, external.eventId);
      if (!source) throw new Error('渠道管理消息来源不存在。');
      const response = operation(source);
      if (typeof response !== 'string') throw new Error('管理操作回复无效。');
      return { text: response, runId: run.id };
    });
  }

  failRun(runId: string, status: 'failed' | 'interrupted', kind: string, message: string): void {
    const result = this.db.prepare(`UPDATE agent_runs SET status = ?, error_kind = ?, error_message = ?, finished_at = ?
      WHERE id = ? AND status = 'running'`).run(status, kind, message, now(), runId);
    if (result.changes !== 1) throw new Error('运行不存在或已结束，不能标记失败。');
  }

  unfinishedRuns(conversationId: string): RunRecord[] {
    return this.db.prepare(`SELECT r.id, r.conversation_id AS conversationId, r.input_message_id AS inputMessageId,
      m.text AS inputText, m.model_input_text AS modelInputText, r.status, r.provider, r.model, r.pi_session_file AS piSessionFile FROM agent_runs r
      JOIN messages m ON m.id = r.input_message_id WHERE r.conversation_id = ? AND r.status = 'running'
      ORDER BY r.started_at, r.rowid`).all(conversationId).map(row => asRun(row as Record<string, unknown>));
  }

  recordedTaskSessions(conversationId: string): { piSessionFile: string; inputMessageId: string }[] {
    return this.db.prepare(`SELECT pi_session_file,input_message_id FROM agent_runs
      WHERE conversation_id=? AND pi_session_file IS NOT NULL ORDER BY started_at,rowid`).all(conversationId)
      .map(row => ({ piSessionFile: String(row.pi_session_file), inputMessageId: String(row.input_message_id) }));
  }

  markPendingUncertain(conversationId: string): void {
    this.memoryTransaction(() => {
      this.db.prepare("UPDATE run_progress SET status='uncertain',updated_at=? WHERE run_id IN (SELECT id FROM agent_runs WHERE conversation_id=?) AND status IN ('pending','sending')").run(now(),conversationId);
      this.db.prepare("UPDATE delivery_parts SET status = 'uncertain', updated_at = ? WHERE conversation_id = ? AND status IN ('pending', 'sending')")
        .run(now(), conversationId);
      this.db.prepare("UPDATE deliveries SET status = 'uncertain', updated_at = ? WHERE conversation_id = ? AND status = 'pending'")
        .run(now(), conversationId);
    });
  }

  prepareDeliveryParts(conversationId: string, deliveryId: string, texts: readonly string[]): void {
    if (!texts.length || texts.some(text => typeof text !== 'string' || !text.length)) throw new Error('投递分段不能为空。');
    this.memoryTransaction(() => {
      const parent = this.db.prepare('SELECT status FROM deliveries WHERE id = ? AND conversation_id = ?').get(deliveryId, conversationId);
      if (!parent || parent.status !== 'pending') throw new Error('投递不存在或不能继续。');
      if (this.db.prepare('SELECT 1 FROM delivery_parts WHERE delivery_id = ?').get(deliveryId)) throw new Error('投递分段已经保存，不能覆盖或重发。');
      const createdAt = now();
      texts.forEach((text, index) => this.db.prepare(`INSERT INTO delivery_parts
        (delivery_id, conversation_id, part_index, text, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run(deliveryId, conversationId, index, text, createdAt, createdAt));
    });
  }

  beginDeliveryPart(conversationId: string, deliveryId: string, partIndex: number, mode: DeliveryMode = 'passive', replySlot?: number): void {
    if (!Number.isSafeInteger(partIndex) || partIndex < 0) throw new Error('投递分段序号无效。');
    validateDeliveryMode(mode, replySlot);
    this.memoryTransaction(() => {
      const parent = this.db.prepare('SELECT status FROM deliveries WHERE id = ? AND conversation_id = ?').get(deliveryId, conversationId);
      const part = this.db.prepare('SELECT status FROM delivery_parts WHERE delivery_id = ? AND conversation_id = ? AND part_index = ?')
        .get(deliveryId, conversationId, partIndex);
      const previous = Number(this.db.prepare("SELECT count(*) n FROM delivery_parts WHERE delivery_id = ? AND part_index < ? AND status = 'sent'")
        .get(deliveryId, partIndex)?.n ?? 0);
      if (!parent || parent.status !== 'pending' || !part || part.status !== 'pending' || previous !== partIndex) {
        throw new Error('投递分段不存在、已经尝试或前一段尚未确认。');
      }
      this.db.prepare("UPDATE delivery_parts SET status = 'sending', delivery_mode = ?, reply_slot = ?, updated_at = ? WHERE delivery_id = ? AND part_index = ?")
        .run(mode, replySlot ?? null, now(), deliveryId, partIndex);
    });
  }

  ackDeliveryPart(conversationId: string, deliveryId: string, partIndex: number,
    status: 'sent' | 'uncertain' | 'rejected', externalMessageId?: string): void {
    if (!['sent', 'uncertain', 'rejected'].includes(status) || !Number.isSafeInteger(partIndex) || partIndex < 0
      || (status === 'sent' && (typeof externalMessageId !== 'string' || !externalMessageId))) throw new Error('投递分段回执无效。');
    this.memoryTransaction(() => {
      const parent = this.db.prepare('SELECT status FROM deliveries WHERE id = ? AND conversation_id = ?').get(deliveryId, conversationId);
      const part = this.db.prepare('SELECT status, external_message_id FROM delivery_parts WHERE delivery_id = ? AND conversation_id = ? AND part_index = ?')
        .get(deliveryId, conversationId, partIndex);
      if (!parent || !part) throw new Error('投递分段不存在。');
      if (part.status === status && part.external_message_id === (externalMessageId ?? null)) return;
      if (parent.status !== 'pending' || part.status !== 'sending') throw new Error('投递分段不能修改或继续。');
      this.db.prepare('UPDATE delivery_parts SET status = ?, external_message_id = ?, updated_at = ? WHERE delivery_id = ? AND part_index = ?')
        .run(status, externalMessageId ?? null, now(), deliveryId, partIndex);
      if (status !== 'sent') {
        this.ackDelivery(deliveryId, 'uncertain', undefined, conversationId);
      } else if (!this.db.prepare("SELECT 1 FROM delivery_parts WHERE delivery_id = ? AND status <> 'sent'").get(deliveryId)) {
        // Preserve the legacy parent ID for a one-part response only.
        const count = Number(this.db.prepare('SELECT count(*) n FROM delivery_parts WHERE delivery_id = ?').get(deliveryId)?.n);
        this.db.prepare("UPDATE deliveries SET status = 'sent', external_message_id = ?, updated_at = ? WHERE id = ?")
          .run(count === 1 ? externalMessageId! : null, now(), deliveryId);
      }
    });
  }

  ackDelivery(deliveryId: string, status: 'sent' | 'uncertain', externalMessageId?: string, conversationId?: string): void {
    if (externalMessageId !== undefined && (typeof externalMessageId !== 'string' || !externalMessageId)) throw new Error('渠道投递消息 ID 无效。');
    this.memoryTransaction(() => {
      const row = this.db.prepare('SELECT status, external_message_id FROM deliveries WHERE id = ?').get(deliveryId) as Record<string, unknown> | undefined;
      if (!row || (conversationId !== undefined && !this.db.prepare('SELECT 1 FROM deliveries WHERE id = ? AND conversation_id = ?')
        .get(deliveryId, conversationId))) throw new Error('投递记录不存在。');
      if (status === 'sent' && this.db.prepare('SELECT 1 FROM delivery_parts WHERE delivery_id = ?').get(deliveryId)) {
        throw new Error('分段投递必须逐段确认。');
      }
      const current = String(row.status);
      if (current === status) {
        if (externalMessageId !== undefined && row.external_message_id !== null && row.external_message_id !== externalMessageId) throw new Error('投递已绑定到不同的渠道消息 ID。');
        if (externalMessageId !== undefined && row.external_message_id === null) this.db.prepare('UPDATE deliveries SET external_message_id = ?, updated_at = ? WHERE id = ?')
          .run(externalMessageId, now(), deliveryId);
        return;
      }
      if (current !== 'pending') throw new Error(`不能将 ${current} 投递改为 ${status}。`);
      this.db.prepare('UPDATE deliveries SET status = ?, external_message_id = ?, updated_at = ? WHERE id = ?').run(status, externalMessageId ?? null, now(), deliveryId);
      if (status === 'uncertain') this.db.prepare("UPDATE delivery_parts SET status = 'uncertain', updated_at = ? WHERE delivery_id = ? AND status IN ('pending', 'sending')")
        .run(now(), deliveryId);
    });
  }

  listMessages(conversationKey: string, limit: number, route?: ChannelRoute): MessageRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit 必须是正整数。');
    const selected = conversationRoute(conversationKey, route);
    const rows = this.db.prepare(`
      SELECT m.id, m.conversation_id AS conversationId, m.role, m.text, m.created_at AS createdAt,
        m.pi_entry_id AS piEntryId, r.status AS runStatus, r.id AS runId, r.pi_session_file AS piSessionFile, d.status AS deliveryStatus, m.rowid AS rowId,
        m.model_input_text AS modelInputText, m.external_event_id AS eventId, a.external_user_id AS senderId,
        m.sender_name AS senderName, d.external_message_id AS externalMessageId, m.actor_id AS actorId, m.message_kind AS messageKind, m.ingest_seq AS ingestSeq, m.sent_at AS sentAt
      FROM messages m JOIN conversations c ON c.id = m.conversation_id
      JOIN rooms room ON room.id = c.room_id
      LEFT JOIN agent_runs r ON r.input_message_id = m.id OR r.response_message_id = m.id
      LEFT JOIN deliveries d ON d.message_id = m.id
      LEFT JOIN actors a ON a.id = m.actor_id
      WHERE room.channel = ? AND room.account = ? AND room.room_type = ? AND room.external_chat_id = ?
      ORDER BY m.ingest_seq DESC LIMIT ?
    `).all(selected.channel, selected.accountId, selected.roomType, selected.roomId, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map(asMessage);
  }

  recentHumanMessages(conversationId: string, limit = 10, beforeMessageId?: string): MessageRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('群聊背景条数必须在1到10之间。');
    this.requireMemoryConversation(conversationId);
    const boundary = beforeMessageId === undefined ? undefined
      : this.db.prepare('SELECT ingest_seq FROM messages WHERE id=? AND conversation_id=?').get(beforeMessageId, conversationId);
    if (beforeMessageId !== undefined && !boundary) throw new Error('历史边界消息必须属于当前会话。');
    // This is raw background, independent of answer/delivery status or memory checkpoints.
    // Filter before LIMIT so assistant replies and control messages never displace human chat.
    const rows = this.db.prepare(`SELECT m.id,m.conversation_id AS conversationId,m.role,m.text,
      m.created_at AS createdAt,m.pi_entry_id AS piEntryId,NULL AS runStatus,NULL AS deliveryStatus,
      m.external_event_id AS eventId,a.external_user_id AS senderId,m.sender_name AS senderName,
      m.actor_id AS actorId,m.message_kind AS messageKind,m.ingest_seq AS ingestSeq,m.sent_at AS sentAt
      FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN actors a ON a.id=m.actor_id AND a.room_id=c.room_id
      WHERE m.conversation_id=? AND m.role='user' AND m.message_kind='chat'
        AND (? IS NULL OR m.ingest_seq<?)
      ORDER BY m.ingest_seq DESC LIMIT ?`).all(conversationId, boundary?.ingest_seq ?? null, boundary?.ingest_seq ?? null, limit);
    return rows.reverse().map(asMessage);
  }

  contextMessages(conversationId: string, limit: number, senderId?: string, beforeMessageId?: string): MessageRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('limit 必须是正整数。');
    this.requireMemoryConversation(conversationId);
    const boundary=beforeMessageId===undefined?undefined:this.db.prepare('SELECT ingest_seq FROM messages WHERE id=? AND conversation_id=?').get(beforeMessageId,conversationId);
    if(beforeMessageId!==undefined&&!boundary) throw new Error('历史边界消息必须属于当前会话。');
    const rows = this.db.prepare(`SELECT m.id, m.conversation_id AS conversationId, m.role, m.text, m.created_at AS createdAt,
      m.pi_entry_id AS piEntryId, r.status AS runStatus, r.id AS runId, r.pi_session_file AS piSessionFile, d.status AS deliveryStatus,
      m.model_input_text AS modelInputText, m.external_event_id AS eventId, a.external_user_id AS senderId,
      m.sender_name AS senderName, d.external_message_id AS externalMessageId, m.actor_id AS actorId, m.message_kind AS messageKind, m.ingest_seq AS ingestSeq, m.sent_at AS sentAt
      FROM messages m LEFT JOIN memory_context_state s ON s.conversation_id = m.conversation_id
      LEFT JOIN agent_runs r ON r.input_message_id = m.id OR r.response_message_id = m.id
      LEFT JOIN messages input ON input.id = r.input_message_id LEFT JOIN actors inputactor ON inputactor.id = input.actor_id
      LEFT JOIN deliveries d ON d.message_id = m.id LEFT JOIN actors a ON a.id = m.actor_id
      WHERE m.conversation_id = ? AND m.rowid > COALESCE(s.history_after_rowid, 0) AND m.message_kind = 'chat'
        AND (? IS NULL OR (CASE WHEN m.role='assistant' THEN input.ingest_seq ELSE m.ingest_seq END) < ?)
        AND (r.id IS NULL OR (r.status = 'completed' AND input.rowid > COALESCE(s.history_after_rowid, 0)
          AND NOT EXISTS (SELECT 1 FROM memory_uses used JOIN memories memory ON memory.id = used.memory_id WHERE used.run_id = r.id
            AND (memory.status <> 'active' OR memory.is_current <> 1 OR memory.revision <> used.revision
              OR (memory.expires_at IS NOT NULL AND memory.expires_at <= ?)))))
        AND (? IS NULL OR r.id IS NULL OR inputactor.external_user_id = ?)
      ORDER BY m.ingest_seq DESC LIMIT ?`).all(conversationId, boundary?.ingest_seq??null, boundary?.ingest_seq??null, now(), senderId ?? null, senderId ?? null, limit);
    return rows.reverse().map(asMessage);
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
