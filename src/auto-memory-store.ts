import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { MemoryError, type PrimaryPerson } from './memory-types.js';
import type { AutoMemoryJob, AutoMemoryMessage, AutoMemoryPipeline, AutoMemoryReason, AutoMemoryTaskInput, MaterialBackfillBatch, MaterialBackfillLimits, MaterialBackfillPlan, MaterialBackfillRun, PersonProfile, PersonProfilePending, ProfileFact, TopicRecord, ValidatedExtract } from './auto-memory-types.js';
import { SelfProfileStore } from './self-profile-store.js';
import { memoryWords } from './memory-text.js';
import { assertProfileCapacity, profileCapacity } from './profile-limits.js';
import { assertProfileEvidenceStrength, assertLiveProfileProtocol, assertProfileProtocol, validateProfilePendingResults } from './profile-pending.js';
import { assertMemorySourceRange, assertProcessedRanges, COMPACT_TOPIC_LIMITS } from './memory-work.js';
import { memoryScheduleDue, noteMemoryContent } from './memory-schedule.js';
import { inferPersonProfileEvidence, resolveProfileSubject, type ProfileSubjectCandidate, type ProfileSubjectEvidence } from './profile-attribution.js';
import { validateProfileUpdates } from './profile-updates.js';

const timestamp = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
export const sameFact = (a:ProfileFact,b:ProfileFact) => a.content===b.content && a.sourceType===b.sourceType
  && (a.occurredAt??null)===(b.occurredAt??null) && (a.expiresAt??null)===(b.expiresAt??null)
  && JSON.stringify([...a.messageIds].sort())===JSON.stringify([...b.messageIds].sort());
export const sameFactContent = (a: ProfileFact, b: ProfileFact) => a.content.normalize('NFKC').trim() === b.content.normalize('NFKC').trim()
  && a.sourceType === b.sourceType && (a.occurredAt ?? null) === (b.occurredAt ?? null)
  && (a.expiresAt ?? null) === (b.expiresAt ?? null);

/** Called separately for each person; exact facts may share evidence, never identities or inferred meanings. */
export function mergeProfileFacts(facts: readonly ProfileFact[]): ProfileFact[] {
  const merged: ProfileFact[] = [];
  for (const fact of facts) {
    const existing = merged.find(old => sameFactContent(old, fact));
    if (existing) existing.messageIds = [...new Set([...existing.messageIds, ...fact.messageIds])];
    else merged.push({ ...fact, messageIds: [...fact.messageIds] });
  }
  return merged;
}

const samePending = (a: PersonProfilePending, b: PersonProfilePending) => a.id === b.id && a.content === b.content
  && a.sourceMessageId === b.sourceMessageId && a.sourceType === b.sourceType && JSON.stringify(a.subject) === JSON.stringify(b.subject);

export function migrateProfileAttribution(db: DatabaseSync): void {
  db.exec(`ALTER TABLE person_profile_pending ADD COLUMN subject_json TEXT;
    CREATE TABLE message_profile_context(message_id TEXT PRIMARY KEY REFERENCES messages(id), mentioned_sender_ids_json TEXT NOT NULL);
    CREATE TABLE person_profile_subject_updates(
      person_id TEXT NOT NULL, revision INTEGER NOT NULL, fact_index INTEGER NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(id), speaker_person_id TEXT NOT NULL,
      evidence_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(person_id,revision,fact_index,message_id,evidence_json),
      FOREIGN KEY(person_id,revision) REFERENCES person_profile_revisions(person_id,revision));`);
}

export class ObsoletePersonalMemoryError extends Error {
  constructor() {
    super('个人长期事件协议已过期；固定输入与进度已保留，需操作者处理。');
    this.name = 'ObsoletePersonalMemoryError';
  }
}

/** Old frozen personal-event work is kept for explicit operator handling, never reinterpreted as a profile. */
export function assertCurrentMemoryProtocol(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach(assertCurrentMemoryProtocol); return; }
  const object = value as Record<string, unknown>;
  if (object.extractionProtocol !== undefined && object.extractionProtocol !== 2) throw new Error('未知整理协议；固定输入与进度保持不变。');
  if (object.profileBaselineProtocol !== undefined && object.profileBaselineProtocol !== 1) throw new Error('未知画像基线协议；固定输入与进度保持不变。');
  if (object.profileAttributionProtocol !== undefined && object.profileAttributionProtocol !== 1) throw new Error('未知画像对象协议；固定输入与进度保持不变。');
  if (object.selfProfileProtocol !== undefined && object.selfProfileProtocol !== 2) throw new Error('未知AI画像协议；固定输入与进度保持不变。');
  if (object.purpose === 'memory' || object.memoryPending !== undefined || object.memoryArchives !== undefined) {
    throw new ObsoletePersonalMemoryError();
  }
  Object.values(object).forEach(assertCurrentMemoryProtocol);
}

/** Topic-only lexical index. The same SQL tokenizer is registered for every store connection. */
export function migrateMemoryRetrieval(db: DatabaseSync): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_topic_fts USING fts5(topic_id UNINDEXED, tokens, tokenize='unicode61');
    INSERT INTO memory_topic_fts(topic_id,tokens)
      SELECT id,history_tokens(summary) FROM memory_topics t
      WHERE NOT EXISTS(SELECT 1 FROM memory_topic_fts f WHERE f.topic_id=t.id);
    CREATE TRIGGER IF NOT EXISTS index_topic_insert AFTER INSERT ON memory_topics BEGIN
      INSERT INTO memory_topic_fts(topic_id,tokens) VALUES (NEW.id,history_tokens(NEW.summary));
    END;
    CREATE TRIGGER IF NOT EXISTS index_topic_update AFTER UPDATE OF summary ON memory_topics BEGIN
      DELETE FROM memory_topic_fts WHERE topic_id=OLD.id;
      INSERT INTO memory_topic_fts(topic_id,tokens) VALUES (NEW.id,history_tokens(NEW.summary));
    END;
    CREATE TRIGGER IF NOT EXISTS index_topic_delete AFTER DELETE ON memory_topics BEGIN
      DELETE FROM memory_topic_fts WHERE topic_id=OLD.id;
    END;
    CREATE INDEX IF NOT EXISTS person_fragment_identity_content ON person_fragments(person_id,source_type,content);
    CREATE TABLE IF NOT EXISTS topic_embedding_attempts (
      topic_id TEXT PRIMARY KEY REFERENCES memory_topics(id), model TEXT NOT NULL, dimensions INTEGER NOT NULL,
      input_version INTEGER NOT NULL, topic_version INTEGER NOT NULL, content_hash TEXT NOT NULL,
      error TEXT, created_at TEXT NOT NULL);
  `);
}

/** Called inside the conversation store's migration transaction. */
export function migrateAutoMemory(db: DatabaseSync): void {
  db.exec(`
    ALTER TABLE messages ADD COLUMN ingest_seq INTEGER;
    ALTER TABLE messages ADD COLUMN sent_at TEXT;
    CREATE TABLE message_ingest_order (seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id));
    INSERT INTO message_ingest_order (seq,message_id) SELECT rowid,id FROM messages ORDER BY rowid;
    UPDATE messages SET ingest_seq = (SELECT seq FROM message_ingest_order WHERE message_id = messages.id);
    CREATE UNIQUE INDEX message_ingest_sequence ON messages(ingest_seq);
    CREATE TRIGGER assign_message_sequence AFTER INSERT ON messages BEGIN
      INSERT INTO message_ingest_order(message_id) VALUES (NEW.id);
      UPDATE messages SET ingest_seq = last_insert_rowid() WHERE id = NEW.id;
    END;
    CREATE TABLE persons (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE person_bindings (
      channel TEXT NOT NULL, account TEXT NOT NULL, room_type TEXT NOT NULL, room_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      person_id TEXT NOT NULL REFERENCES persons(id), PRIMARY KEY(channel,account,room_type,room_id,sender_id));
    CREATE TABLE actor_person_bindings (actor_id TEXT PRIMARY KEY REFERENCES actors(id), person_id TEXT NOT NULL REFERENCES persons(id));
    CREATE TABLE person_profile_revisions (
      person_id TEXT NOT NULL REFERENCES persons(id), revision INTEGER NOT NULL, facts_json TEXT NOT NULL,
      job_id TEXT, created_at TEXT NOT NULL, PRIMARY KEY(person_id,revision));
    CREATE TABLE auto_memory_checkpoints (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), initial_seq INTEGER NOT NULL, completed_seq INTEGER NOT NULL,
      summary TEXT, summary_job_id TEXT);
    INSERT INTO auto_memory_checkpoints SELECT c.id, COALESCE(MAX(m.ingest_seq),0), COALESCE(MAX(m.ingest_seq),0),NULL,NULL
      FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.id GROUP BY c.id;
    CREATE TABLE auto_memory_jobs (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), reason TEXT NOT NULL CHECK(reason IN ('count','capacity')),
      status TEXT NOT NULL CHECK(status IN ('queued','running','failed','done')), start_seq INTEGER NOT NULL,end_seq INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_owner TEXT, lease_until INTEGER, error TEXT,input_json TEXT,progress_json TEXT,
      created_at TEXT NOT NULL, completed_at TEXT);
    CREATE INDEX auto_memory_jobs_order ON auto_memory_jobs(conversation_id,start_seq);
    CREATE TABLE auto_memory_job_messages (
      job_id TEXT NOT NULL REFERENCES auto_memory_jobs(id),message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
      ordinal INTEGER NOT NULL,PRIMARY KEY(job_id,message_id));
    CREATE TABLE memory_topics (
      id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),job_id TEXT NOT NULL REFERENCES auto_memory_jobs(id),
      summary TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,content_hash TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE memory_topic_messages (topic_id TEXT NOT NULL REFERENCES memory_topics(id),message_id TEXT NOT NULL REFERENCES messages(id),PRIMARY KEY(topic_id,message_id));
    CREATE TABLE person_fragments (
      id TEXT PRIMARY KEY,person_id TEXT NOT NULL REFERENCES persons(id),job_id TEXT NOT NULL REFERENCES auto_memory_jobs(id),
      topic_id TEXT REFERENCES memory_topics(id),content TEXT NOT NULL,source_type TEXT NOT NULL CHECK(source_type IN ('self','third_party','inference')),created_at TEXT NOT NULL);
    CREATE TABLE person_fragment_messages (fragment_id TEXT NOT NULL REFERENCES person_fragments(id),message_id TEXT NOT NULL REFERENCES messages(id),PRIMARY KEY(fragment_id,message_id));
    CREATE TABLE topic_embeddings (
      topic_id TEXT PRIMARY KEY REFERENCES memory_topics(id),model TEXT NOT NULL,dimensions INTEGER NOT NULL,input_version INTEGER NOT NULL,
      topic_version INTEGER NOT NULL,content_hash TEXT NOT NULL,vector_json TEXT NOT NULL,updated_at TEXT NOT NULL);
  `);
  const store = new AutoMemoryStore(db);
  const primary = db.prepare('SELECT DISTINCT person_id FROM primary_person_bindings').all();
  for (const row of primary) store.ensurePerson(String(row.person_id));
  db.exec('INSERT INTO person_bindings SELECT * FROM primary_person_bindings');
  for (const row of db.prepare('SELECT id FROM actors').all()) store.ensureActorPerson(String(row.id));
  db.exec(`UPDATE memories SET person_id=(SELECT person_id FROM actor_person_bindings WHERE actor_id=memories.subject_actor_id)
    WHERE person_id IS NULL AND scope_type='actor';`);
  for (const row of db.prepare(`SELECT DISTINCT person_id FROM memories WHERE person_id IS NOT NULL`).all()) store.ensurePerson(String(row.person_id));
  store.syncExplicitProfiles();
}

/** Visibility order is independent of ingest order: a late delivery always appends. */
export function migrateRollingContext(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE conversation_context_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
      conversation_id TEXT NOT NULL REFERENCES conversations(id));
    CREATE INDEX context_messages_room ON conversation_context_messages(conversation_id,seq);
    INSERT INTO conversation_context_messages(message_id,conversation_id)
      SELECT m.id,m.conversation_id FROM messages m
      LEFT JOIN agent_runs r ON r.response_message_id=m.id LEFT JOIN deliveries d ON d.message_id=m.id
      WHERE m.message_kind='chat' AND (m.role='user' OR (r.status='completed' AND d.status='sent'))
      ORDER BY CASE WHEN m.role='assistant' THEN d.updated_at ELSE m.created_at END,m.ingest_seq;
    CREATE TABLE conversation_context_state (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), cursor INTEGER NOT NULL DEFAULT 0,
      completed_seq INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0, summary TEXT);
    -- A legacy summary may omit historical initial/deferred ranges. Keep every original
    -- visible until the first complete rolling snapshot succeeds.
    INSERT INTO conversation_context_state(conversation_id,summary)
      SELECT conversation_id,summary FROM auto_memory_checkpoints;
    CREATE TABLE auto_memory_context_jobs (
      job_id TEXT PRIMARY KEY REFERENCES auto_memory_jobs(id), base_revision INTEGER NOT NULL,
      start_cursor INTEGER NOT NULL, end_cursor INTEGER NOT NULL, previous_summary TEXT);
    CREATE TABLE auto_memory_context_job_messages (
      job_id TEXT NOT NULL REFERENCES auto_memory_jobs(id), message_id TEXT NOT NULL REFERENCES messages(id),
      ordinal INTEGER NOT NULL, PRIMARY KEY(job_id,message_id));
    CREATE TRIGGER context_inbound_insert AFTER INSERT ON messages WHEN NEW.role='user' AND NEW.message_kind='chat' BEGIN
      INSERT INTO conversation_context_messages(message_id,conversation_id) VALUES(NEW.id,NEW.conversation_id);
    END;
    CREATE TRIGGER context_delivery_sent AFTER UPDATE OF status ON deliveries WHEN NEW.status='sent' BEGIN
      INSERT OR IGNORE INTO conversation_context_messages(message_id,conversation_id)
        SELECT m.id,m.conversation_id FROM messages m JOIN agent_runs r ON r.response_message_id=m.id
        WHERE m.id=NEW.message_id AND m.message_kind='chat' AND r.status='completed';
    END;
  `);
}

/** Preserve frozen work while separating context compression from material extraction. */
export function migrateMemoryPipelines(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE auto_memory_jobs_v21 (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      reason TEXT NOT NULL CHECK(reason IN ('count','capacity','idle','interval')),
      status TEXT NOT NULL CHECK(status IN ('queued','running','failed','done')),
      start_seq INTEGER NOT NULL,end_seq INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,lease_owner TEXT,lease_until INTEGER,error TEXT,input_json TEXT,progress_json TEXT,
      created_at TEXT NOT NULL,completed_at TEXT,
      pipeline TEXT NOT NULL DEFAULT 'legacy' CHECK(pipeline IN ('legacy','compression','materials')));
    INSERT INTO auto_memory_jobs_v21(rowid,id,conversation_id,reason,status,start_seq,end_seq,attempts,
      lease_token,lease_owner,lease_until,error,input_json,progress_json,created_at,completed_at)
      SELECT rowid,id,conversation_id,reason,status,start_seq,end_seq,attempts,
      lease_token,lease_owner,lease_until,error,input_json,progress_json,created_at,completed_at FROM auto_memory_jobs;
    DROP TABLE auto_memory_jobs;
    ALTER TABLE auto_memory_jobs_v21 RENAME TO auto_memory_jobs;
    CREATE INDEX auto_memory_jobs_order ON auto_memory_jobs(conversation_id,pipeline,start_seq);
    CREATE TABLE auto_memory_legacy_isolations (
      job_id TEXT PRIMARY KEY REFERENCES auto_memory_jobs(id),reason TEXT NOT NULL,created_at TEXT NOT NULL,
      input_hash TEXT,progress_hash TEXT);
    CREATE TABLE auto_memory_material_state (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),observed_seq INTEGER NOT NULL DEFAULT 0,
      first_content_at INTEGER,last_content_at INTEGER,reserved_seq INTEGER NOT NULL DEFAULT 0,completed_seq INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE auto_memory_material_jobs (job_id TEXT PRIMARY KEY REFERENCES auto_memory_jobs(id));
    CREATE TABLE auto_memory_material_job_messages (
      job_id TEXT NOT NULL REFERENCES auto_memory_jobs(id),message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
      ordinal INTEGER NOT NULL,PRIMARY KEY(job_id,message_id));
    CREATE TABLE auto_memory_material_legacy_messages (
      message_id TEXT PRIMARY KEY REFERENCES messages(id),job_id TEXT NOT NULL REFERENCES auto_memory_jobs(id),
      disposition TEXT NOT NULL CHECK(disposition IN ('done','isolated')));
    INSERT OR IGNORE INTO auto_memory_material_legacy_messages
      SELECT message_id,id,CASE WHEN status='done' THEN 'done' ELSE 'isolated' END FROM (
        SELECT jm.message_id,j.id,j.status,j.rowid AS job_rowid FROM auto_memory_job_messages jm JOIN auto_memory_jobs j ON j.id=jm.job_id
        UNION ALL SELECT jm.message_id,j.id,j.status,j.rowid AS job_rowid FROM auto_memory_context_job_messages jm JOIN auto_memory_jobs j ON j.id=jm.job_id)
      ORDER BY status='done' DESC,job_rowid;
    CREATE TABLE auto_memory_material_observed_pending (
      kind TEXT NOT NULL CHECK(kind IN ('person','self')),pending_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),observed_at INTEGER NOT NULL,
      assigned_job_id TEXT REFERENCES auto_memory_jobs(id),blocked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(kind,pending_id));
    CREATE TABLE auto_memory_material_job_pending (
      job_id TEXT NOT NULL REFERENCES auto_memory_jobs(id),kind TEXT NOT NULL CHECK(kind IN ('person','self')),
      pending_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(job_id,kind,pending_id));
    INSERT INTO auto_memory_material_observed_pending(kind,pending_id,conversation_id,observed_at,blocked)
      SELECT 'person',p.id,m.conversation_id,0,1 FROM person_profile_pending p JOIN messages m ON m.id=p.source_message_id
      WHERE EXISTS(SELECT 1 FROM auto_memory_material_legacy_messages l WHERE l.message_id=m.id AND l.disposition='isolated');
    INSERT INTO auto_memory_material_observed_pending(kind,pending_id,conversation_id,observed_at,blocked)
      SELECT 'self',p.id,m.conversation_id,0,1 FROM self_profile_pending p JOIN messages m ON m.id=p.source_message_id
      WHERE EXISTS(SELECT 1 FROM auto_memory_material_legacy_messages l WHERE l.message_id=m.id AND l.disposition='isolated');
  `);
  const observeCaptured=(kind:'person'|'self',id:string,jobId:string,blocked:boolean)=>{
    db.prepare(`INSERT OR IGNORE INTO auto_memory_material_observed_pending
      (kind,pending_id,conversation_id,observed_at,assigned_job_id,blocked) SELECT ?,p.id,m.conversation_id,0,?,?
      FROM ${kind==='person'?'person_profile_pending':'self_profile_pending'} p JOIN messages m ON m.id=p.source_message_id WHERE p.id=?`)
      .run(kind,jobId,blocked?1:0,id);
    if(blocked) db.prepare('UPDATE auto_memory_material_observed_pending SET blocked=1,assigned_job_id=? WHERE kind=? AND pending_id=?')
      .run(jobId,kind,id);
  };
  for(const row of db.prepare('SELECT id,status,input_json FROM auto_memory_jobs WHERE input_json IS NOT NULL').all()) {
    // Migration never rewrites or interprets a frozen protocol as current work.
    // Read only captured queue IDs; malformed/unknown payloads remain preserved.
    try {
      const input=parse<AutoMemoryTaskInput>(row.input_json);
      for(const profile of input.profiles??[]) for(const pending of profile.pending??[]) observeCaptured('person',pending.id,String(row.id),row.status!=='done');
      for(const pending of input.selfProfile?.pending??[]) observeCaptured('self',pending.id,String(row.id),row.status!=='done');
    } catch { /* Opaque historical input remains isolated with its original hash. */ }
  }
  for(const row of db.prepare(`SELECT DISTINCT r.pending_id,r.job_id,j.status FROM person_profile_pending_results r
    JOIN auto_memory_jobs j ON j.id=r.job_id`).all()) observeCaptured('person',String(row.pending_id),String(row.job_id),row.status!=='done');
  for (const row of db.prepare("SELECT * FROM auto_memory_jobs WHERE status<>'done'").all()) {
    db.prepare('INSERT INTO auto_memory_legacy_isolations VALUES (?,?,?,?,?)').run(String(row.id),
      '旧混合整理任务已隔离；固定输入、进度和租约保留，需操作者处理。',timestamp(),
      row.input_json==null?null:hash(String(row.input_json)),row.progress_json==null?null:hash(String(row.progress_json)));
  }
}

/** Manual backfills create new material work; legacy records remain immutable evidence. */
export function migrateMaterialBackfill(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE auto_memory_jobs_v22 (
      id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),
      reason TEXT NOT NULL CHECK(reason IN ('count','capacity','idle','interval','backfill')),
      status TEXT NOT NULL CHECK(status IN ('queued','running','failed','done')),
      start_seq INTEGER NOT NULL,end_seq INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      lease_token TEXT,lease_owner TEXT,lease_until INTEGER,error TEXT,input_json TEXT,progress_json TEXT,
      created_at TEXT NOT NULL,completed_at TEXT,
      pipeline TEXT NOT NULL DEFAULT 'legacy' CHECK(pipeline IN ('legacy','compression','materials')));
    INSERT INTO auto_memory_jobs_v22(rowid,id,conversation_id,reason,status,start_seq,end_seq,attempts,
      lease_token,lease_owner,lease_until,error,input_json,progress_json,created_at,completed_at,pipeline)
      SELECT rowid,id,conversation_id,reason,status,start_seq,end_seq,attempts,
      lease_token,lease_owner,lease_until,error,input_json,progress_json,created_at,completed_at,pipeline FROM auto_memory_jobs;
    DROP TABLE auto_memory_jobs;
    ALTER TABLE auto_memory_jobs_v22 RENAME TO auto_memory_jobs;
    CREATE INDEX auto_memory_jobs_order ON auto_memory_jobs(conversation_id,pipeline,start_seq);
    CREATE TABLE material_backfill_runs (
      id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),reason TEXT NOT NULL,
      cutoff_context_seq INTEGER NOT NULL,plan_hash TEXT NOT NULL,plan_json TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX material_backfill_runs_room ON material_backfill_runs(conversation_id,created_at);
    CREATE TABLE material_backfill_jobs (
      run_id TEXT NOT NULL REFERENCES material_backfill_runs(id),job_id TEXT NOT NULL UNIQUE REFERENCES auto_memory_jobs(id),
      ordinal INTEGER NOT NULL,batch_json TEXT NOT NULL,PRIMARY KEY(run_id,ordinal));
    CREATE TABLE material_backfill_pending_audit (
      run_id TEXT NOT NULL REFERENCES material_backfill_runs(id),job_id TEXT NOT NULL REFERENCES auto_memory_jobs(id),
      kind TEXT NOT NULL CHECK(kind IN ('person','self')),pending_id TEXT NOT NULL,
      previous_observed_at INTEGER,previous_assigned_job_id TEXT REFERENCES auto_memory_jobs(id),previous_blocked INTEGER,
      created_at TEXT NOT NULL,PRIMARY KEY(job_id,kind,pending_id));
  `);
}

export class AutoMemoryStore {
  readonly selfProfile: SelfProfileStore;
  constructor(private readonly db: DatabaseSync, private readonly transaction?: <T>(operation: () => T) => T) {
    this.selfProfile = new SelfProfileStore(db, operation => this.atomic(operation));
  }
  private atomic<T>(operation: () => T): T {
    if (this.transaction) return this.transaction(operation);
    this.db.exec('SAVEPOINT auto_memory_operation');
    try { const result = operation(); this.db.exec('RELEASE SAVEPOINT auto_memory_operation'); return result; }
    catch (error) { this.db.exec('ROLLBACK TO SAVEPOINT auto_memory_operation; RELEASE SAVEPOINT auto_memory_operation'); throw error; }
  }
  ensurePerson(id: string): void {
    this.db.prepare('INSERT OR IGNORE INTO persons(id,created_at) VALUES (?,?)').run(id,timestamp());
  }
  ensureActorPerson(actorId: string): string {
    const existing = this.personForActor(actorId);
    if (existing) return existing;
    const actor = this.db.prepare(`SELECT b.person_id FROM actors a LEFT JOIN rooms r ON r.id=a.room_id
      LEFT JOIN person_bindings b ON b.channel=r.channel AND b.account=r.account AND b.room_type=r.room_type
      AND b.room_id=r.external_chat_id AND b.sender_id=a.external_user_id WHERE a.id=?`).get(actorId);
    if (!actor) throw new Error('人物身份不存在。');
    const personId = actor.person_id == null ? `actor:${actorId}` : String(actor.person_id);
    this.ensurePerson(personId);
    this.db.prepare('INSERT INTO actor_person_bindings VALUES (?,?)').run(actorId,personId);
    return personId;
  }
  personForActor(actorId: string): string | undefined {
    const row = this.db.prepare('SELECT person_id FROM actor_person_bindings WHERE actor_id=?').get(actorId);
    return row ? String(row.person_id) : undefined;
  }
  configurePersons(persons: readonly PrimaryPerson[]): void {
    const keys = new Set<string>();
    for (const person of persons) {
      if (!person || typeof person.id !== 'string' || !person.id.trim() || person.id.length>512 || !Array.isArray(person.bindings)) throw new Error('人物配置无效。');
      for (const binding of person.bindings) {
        const r = binding?.route;
        if (!r || ![r.channel,r.accountId,r.roomId,binding.senderId].every(v=>typeof v==='string' && v.length>0 && v.length<=512) || !['group','private'].includes(r.roomType)) throw new Error('人物绑定无效。');
        const key=JSON.stringify([r.channel,r.accountId,r.roomType,r.roomId,binding.senderId]);
        if(keys.has(key)) throw new Error('人物绑定不能重复。'); keys.add(key);
      }
    }
    this.atomic(()=>{
      this.db.exec('DROP INDEX active_person_profile');
      this.db.exec('DELETE FROM person_bindings');
      for (const person of persons) {
        this.ensurePerson(person.id);
        for(const b of person.bindings) this.db.prepare('INSERT INTO person_bindings VALUES (?,?,?,?,?,?)').run(b.route.channel,b.route.accountId,b.route.roomType,b.route.roomId,b.senderId,person.id);
      }
      for(const a of this.db.prepare(`SELECT a.id,b.person_id FROM actors a LEFT JOIN rooms r ON r.id=a.room_id LEFT JOIN person_bindings b
        ON b.channel=r.channel AND b.account=r.account AND b.room_type=r.room_type AND b.room_id=r.external_chat_id AND b.sender_id=a.external_user_id`).all()) {
        const id=String(a.id); const previous=this.personForActor(id); const next=a.person_id==null?`actor:${id}`:String(a.person_id);
        this.ensurePerson(next);
        this.db.prepare('INSERT INTO actor_person_bindings VALUES (?,?) ON CONFLICT(actor_id) DO UPDATE SET person_id=excluded.person_id').run(id,next);
        if(previous===`actor:${id}` && next!==previous) {
          this.db.prepare('UPDATE memories SET person_id=? WHERE subject_actor_id=? AND person_id=?').run(next,id,previous);
          this.db.prepare('UPDATE person_profile_pending SET person_id=? WHERE person_id=? AND archived_revision IS NULL').run(next,previous);
          this.db.prepare('UPDATE person_fragments SET person_id=? WHERE person_id=?').run(next,previous);
          const old=this.profile(previous); const target=this.profile(next);
          const transferable=old.facts.filter(f=>!target.facts.some(current=>sameFact(current,f)));
          if(transferable.length) this.writeProfile({...target,facts:[...target.facts,...transferable]},null);
        }
      }
      const seen=new Set<string>();
      for(const row of this.db.prepare(`SELECT id,person_id,profile_field FROM memories WHERE person_id IS NOT NULL AND status='active'
        AND is_current=1 AND profile_field IS NOT NULL AND writer_actor_id=subject_actor_id ORDER BY updated_at DESC,rowid DESC`).all()) {
        const key=JSON.stringify([row.person_id,row.profile_field]);
        if(seen.has(key)) {
          this.db.prepare('UPDATE memories SET is_current=0 WHERE id=?').run(String(row.id));
          this.db.prepare("UPDATE memory_revisions SET status='superseded' WHERE memory_id=? AND status='active'").run(String(row.id));
        } else seen.add(key);
      }
      this.db.exec(`CREATE UNIQUE INDEX active_person_profile ON memories(person_id, profile_field)
        WHERE status='active' AND is_current=1 AND person_id IS NOT NULL AND profile_field IS NOT NULL AND writer_actor_id=subject_actor_id`);
    });
  }
  syncExplicitProfiles(): void {
    // Existing explicit records were migrated to archived facts once. New saves are pending.
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE name='person_profile_pending'").get()) return;
    for(const r of this.db.prepare(`SELECT * FROM memories WHERE person_id IS NOT NULL AND profile_field IS NOT NULL
      AND writer_actor_id=subject_actor_id AND profile_source_self=1 AND source_message_id IS NOT NULL AND status='active' AND is_current=1
      ORDER BY updated_at,rowid`).all()) {
      const fact:ProfileFact={content:String(r.content),field:String(r.profile_field),sourceType:'self',messageIds:[String(r.source_message_id)],
        occurredAt:r.occurred_at==null?null:String(r.occurred_at),expiresAt:r.expires_at==null?null:String(r.expires_at)};
      const profile=this.profile(String(r.person_id));
      const current=profile.facts.find(f=>f.field===fact.field);
      if(!profile.facts.some(f=>sameFact(f,fact)) && (!current||this.evidenceSequence(fact.messageIds)>=this.evidenceSequence(current.messageIds))) {
        this.writeProfile({...profile,facts:[...profile.facts.filter(old=>old.field!==fact.field),fact]},null,true);
      }
    }
  }
  private checkpoint(conversationId: string): Record<string,unknown> {
    if(!this.db.prepare('SELECT id FROM conversations WHERE id=?').get(conversationId)) throw new Error('会话不存在。');
    this.db.prepare('INSERT OR IGNORE INTO auto_memory_checkpoints VALUES (?,0,0,NULL,NULL)').run(conversationId);
    return this.db.prepare('SELECT * FROM auto_memory_checkpoints WHERE conversation_id=?').get(conversationId)!;
  }
  private roomType(conversationId: string): 'group'|'private' {
    const row=this.db.prepare('SELECT r.room_type FROM conversations c JOIN rooms r ON r.id=c.room_id WHERE c.id=?').get(conversationId);
    if(!row) throw new Error('会话不存在。'); return row.room_type as 'group'|'private';
  }
  private job(row: Record<string,unknown>): AutoMemoryJob {
    const rolling=Boolean(this.db.prepare('SELECT 1 FROM auto_memory_context_jobs WHERE job_id=?').get(String(row.id)));
    return {id:String(row.id),conversationId:String(row.conversation_id),pipeline:(row.pipeline??'legacy') as AutoMemoryPipeline,reason:row.reason as AutoMemoryReason,status:row.status as AutoMemoryJob['status'],
      startSeq:Number(row.start_seq),endSeq:Number(row.end_seq),attempts:Number(row.attempts),
      messageIds:this.db.prepare(`SELECT message_id FROM ${row.pipeline==='materials'?'auto_memory_material_job_messages':rolling?'auto_memory_context_job_messages':'auto_memory_job_messages'} WHERE job_id=? ORDER BY ordinal`).all(String(row.id)).map(m=>String(m.message_id)),
      ...(row.lease_token==null?{}:{leaseToken:String(row.lease_token),leaseOwner:String(row.lease_owner),leaseUntil:Number(row.lease_until)}),
      ...(row.error==null?{}:{error:String(row.error)})};
  }
  private contextState(conversationId:string): Record<string,unknown> {
    this.checkpoint(conversationId);
    this.db.prepare(`INSERT OR IGNORE INTO conversation_context_state(conversation_id,summary)
      SELECT conversation_id,summary FROM auto_memory_checkpoints WHERE conversation_id=?`).run(conversationId);
    return this.db.prepare('SELECT * FROM conversation_context_state WHERE conversation_id=?').get(conversationId)!;
  }
  private contextBoundary(conversationId:string,beforeMessageId?:string): number | undefined {
    if(beforeMessageId===undefined) return undefined;
    const row=this.db.prepare('SELECT seq FROM conversation_context_messages WHERE message_id=? AND conversation_id=?').get(beforeMessageId,conversationId);
    if(!row) throw new Error('上下文边界消息必须属于当前会话且已可见。');
    return Number(row.seq);
  }
  private deferredContextIds(conversationId:string): Set<string> {
    return new Set(this.db.prepare(`SELECT message_id FROM auto_memory_job_messages jm
      JOIN auto_memory_jobs j ON j.id=jm.job_id JOIN auto_memory_job_deferrals d ON d.job_id=j.id WHERE j.conversation_id=? AND j.pipeline<>'materials'
      AND NOT EXISTS(SELECT 1 FROM auto_memory_job_retirements r WHERE r.job_id=j.id)
      UNION SELECT message_id FROM auto_memory_context_job_messages jm
      JOIN auto_memory_jobs j ON j.id=jm.job_id JOIN auto_memory_job_deferrals d ON d.job_id=j.id WHERE j.conversation_id=? AND j.pipeline<>'materials'
      AND NOT EXISTS(SELECT 1 FROM auto_memory_job_retirements r WHERE r.job_id=j.id)`)
      .all(conversationId,conversationId).map(row=>String(row.message_id)));
  }
  private reserveContextBatch(conversationId:string,beforeMessageId?:string,pipeline:AutoMemoryPipeline='legacy'): AutoMemoryJob | undefined {
    const state=this.contextState(conversationId);
    const boundary=this.contextBoundary(conversationId,beforeMessageId);
    // A pending snapshot owns its whole immutable suffix. Repeated capacity signals
    // cannot queue overlapping work or silently retry a failed/unknown call.
    if(this.nextPending(conversationId,pipeline)) return undefined;
    const deferred=this.deferredContextIds(conversationId);
    const rows=this.db.prepare(`SELECT seq,message_id FROM conversation_context_messages WHERE conversation_id=? AND seq>?
      AND (? IS NULL OR seq<?) ORDER BY seq`).all(conversationId,Number(state.cursor),boundary??null,boundary??null);
    const selected=rows.filter(row=>!deferred.has(String(row.message_id)));
    if(!selected.length) return undefined;
    const ids=selected.map(row=>String(row.message_id));
    const messages=this.messages(ids); const id=randomUUID();
    const start=messages.reduce((seq,message)=>Math.min(seq,message.ingestSeq),Infinity);
    const end=messages.reduce((seq,message)=>Math.max(seq,message.ingestSeq),0);
    this.db.prepare(`INSERT INTO auto_memory_jobs(id,conversation_id,reason,status,start_seq,end_seq,created_at,pipeline) VALUES (?,?,'capacity','queued',?,?,?,?)`)
      .run(id,conversationId,start,end,timestamp(),pipeline);
    this.db.prepare('INSERT INTO auto_memory_context_jobs VALUES (?,?,?,?,?)')
      .run(id,Number(state.revision),Number(state.cursor),Number(rows.at(-1)!.seq),state.summary==null?null:String(state.summary));
    ids.forEach((messageId,index)=>this.db.prepare('INSERT INTO auto_memory_context_job_messages VALUES (?,?,?)').run(id,messageId,index));
    return this.job(this.db.prepare('SELECT * FROM auto_memory_jobs WHERE id=?').get(id)!);
  }
  reserveCompressionBatch(conversationId:string,beforeMessageId?:string): AutoMemoryJob | undefined {
    return this.atomic(()=>this.reserveContextBatch(conversationId,beforeMessageId,'compression'));
  }
  private materialState(conversationId:string): Record<string,unknown> {
    this.checkpoint(conversationId);
    if(this.db.prepare('INSERT OR IGNORE INTO auto_memory_material_state(conversation_id) VALUES (?)').run(conversationId).changes)
      this.advanceMaterialCheckpoint(conversationId);
    return this.db.prepare('SELECT * FROM auto_memory_material_state WHERE conversation_id=?').get(conversationId)!;
  }
  /** These two informational watermarks use ingest_seq; snapshot ordinals use visibility order. */
  materialSchedule(conversationId:string): {firstContentAt?:number;lastContentAt?:number;reservedSeq:number;completedSeq:number} {
    return this.atomic(()=>{
      const row=this.materialState(conversationId);
      return {reservedSeq:Number(row.reserved_seq),completedSeq:Number(row.completed_seq),
        ...(row.first_content_at==null?{}:{firstContentAt:Number(row.first_content_at),lastContentAt:Number(row.last_content_at)})};
    });
  }
  private activeMaterialPending(conversationId:string): {kind:'person'|'self';id:string;payload:Record<string,unknown>}[] {
    const people=this.db.prepare(`SELECT p.id,p.person_id,p.content,p.source_message_id,p.source_type,p.subject_json FROM person_profile_pending p
      JOIN messages m ON m.id=p.source_message_id WHERE m.conversation_id=? AND p.archived_revision IS NULL AND p.purpose='profile' ORDER BY p.rowid`)
      .all(conversationId).map(row=>({kind:'person' as const,id:String(row.id),payload:{id:String(row.id),personId:String(row.person_id),
        content:String(row.content),sourceMessageId:String(row.source_message_id),sourceType:String(row.source_type),
        ...(row.subject_json==null?{}:{subject:parse<ProfileSubjectEvidence>(row.subject_json)})}}));
    const self=this.db.prepare(`SELECT p.id,p.content,p.source_message_id FROM self_profile_pending p JOIN messages m ON m.id=p.source_message_id
      WHERE m.conversation_id=? AND p.archived_revision IS NULL
      AND NOT EXISTS(SELECT 1 FROM self_profile_reclassifications r WHERE r.pending_id=p.id) ORDER BY p.rowid`)
      .all(conversationId).map(row=>({kind:'self' as const,id:String(row.id),payload:{id:String(row.id),content:String(row.content),sourceMessageId:String(row.source_message_id)}}));
    return [...people,...self];
  }
  private materialBackfillPlan(conversationId:string,requested:Partial<MaterialBackfillLimits>={}) {
    if(!this.db.prepare('SELECT id FROM conversations WHERE id=?').get(conversationId)) throw new Error('会话不存在。');
    const limits:MaterialBackfillLimits={maxMessages:requested.maxMessages??100,maxBytes:requested.maxBytes??65536,maxPending:requested.maxPending??20};
    if(Object.values(limits).some(value=>!Number.isSafeInteger(value)||value<1)) throw new Error('回填批次限制必须为正整数。');
    const cutoffContextSeq=Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM conversation_context_messages WHERE conversation_id=?')
      .get(conversationId)!.seq);
    const visible=this.db.prepare(`SELECT c.message_id,
      (EXISTS(SELECT 1 FROM auto_memory_job_messages jm JOIN auto_memory_jobs j ON j.id=jm.job_id
        WHERE jm.message_id=c.message_id AND j.pipeline='legacy' AND j.status='done')
      OR EXISTS(SELECT 1 FROM auto_memory_context_job_messages jm JOIN auto_memory_jobs j ON j.id=jm.job_id
        WHERE jm.message_id=c.message_id AND j.pipeline='legacy' AND j.status='done')) AS legacy_done,
      EXISTS(SELECT 1 FROM auto_memory_material_job_messages jm WHERE jm.message_id=c.message_id) AS material_owned
      FROM conversation_context_messages c JOIN messages m ON m.id=c.message_id
      WHERE c.conversation_id=? AND c.seq<=? AND m.message_kind='chat' ORDER BY c.seq`).all(conversationId,cutoffContextSeq);
    const excluded={legacyDoneMessages:visible.filter(row=>Boolean(row.legacy_done)).length,
      materialMessages:visible.filter(row=>!row.legacy_done&&Boolean(row.material_owned)).length,materialPending:0};
    const messages=this.messages(visible.filter(row=>!row.legacy_done&&!row.material_owned).map(row=>String(row.message_id)));
    const pending=this.activeMaterialPending(conversationId).filter(item=>{
      const owned=this.db.prepare(`SELECT 1 FROM auto_memory_material_job_pending p JOIN auto_memory_jobs j ON j.id=p.job_id
        WHERE p.kind=? AND p.pending_id=? AND j.pipeline='materials' LIMIT 1`).get(item.kind,item.id);
      if(owned) excluded.materialPending++;
      return !owned;
    });
    const batches:{messages:AutoMemoryMessage[];pending:typeof pending;summary:MaterialBackfillBatch}[]=[];
    let currentMessages:AutoMemoryMessage[]=[],currentBytes=0;
    const addMessages=()=>{
      if(!currentMessages.length) return;
      const humanCount=currentMessages.filter(message=>message.role==='user').length;
      batches.push({messages:currentMessages,pending:[],summary:{ordinal:batches.length,messageCount:currentMessages.length,humanCount,
        assistantCount:currentMessages.length-humanCount,pendingCount:0,bytes:currentBytes,oversized:currentBytes>limits.maxBytes}});
      currentMessages=[];currentBytes=0;
    };
    for(const message of messages) {
      const bytes=Buffer.byteLength(JSON.stringify(message));
      if(currentMessages.length&&(currentMessages.length>=limits.maxMessages||currentBytes+bytes>limits.maxBytes)) addMessages();
      currentMessages.push(message);currentBytes+=bytes;
      if(bytes>limits.maxBytes) addMessages();
    }
    addMessages();
    // Keep queue batches independent: the live profile baseline is read only when
    // its batch reaches the front of the material lane.
    let currentPending:typeof pending=[];currentBytes=0;
    const addPending=()=>{
      if(!currentPending.length) return;
      batches.push({messages:[],pending:currentPending,summary:{ordinal:batches.length,messageCount:0,humanCount:0,assistantCount:0,
        pendingCount:currentPending.length,bytes:currentBytes,oversized:currentBytes>limits.maxBytes}});
      currentPending=[];currentBytes=0;
    };
    for(const item of pending) {
      const bytes=Buffer.byteLength(JSON.stringify(item.payload));
      if(currentPending.length&&(currentPending.length>=limits.maxPending||currentBytes+bytes>limits.maxBytes)) addPending();
      currentPending.push(item);currentBytes+=bytes;
      if(bytes>limits.maxBytes) addPending();
    }
    addPending();
    const planHash=hash(JSON.stringify({conversationId,cutoffContextSeq,limits,
      messages:messages.map(message=>({id:message.id,hash:hash(JSON.stringify(message))})),pending,batches:batches.map(batch=>batch.summary)}));
    const humanCount=messages.filter(message=>message.role==='user').length;
    const plan:MaterialBackfillPlan={conversationId,cutoffContextSeq,planHash,limits,messageCount:messages.length,humanCount,
      assistantCount:messages.length-humanCount,pendingCount:pending.length,personPendingCount:pending.filter(item=>item.kind==='person').length,
      selfPendingCount:pending.filter(item=>item.kind==='self').length,bytes:batches.reduce((total,batch)=>total+batch.summary.bytes,0),
      batchCount:batches.length,oversizedMessages:messages.filter(message=>Buffer.byteLength(JSON.stringify(message))>limits.maxBytes).length,
      excluded,batches:batches.map(batch=>batch.summary)};
    return {plan,batches};
  }
  /** A read-only, consistent snapshot; this never starts a timer or creates a queue row. */
  planMaterialBackfill(conversationId:string,limits:Partial<MaterialBackfillLimits>={}): MaterialBackfillPlan {
    return this.atomic(()=>this.materialBackfillPlan(conversationId,limits).plan);
  }
  reserveMaterialBackfill(conversationId:string,options:Partial<MaterialBackfillLimits>&{reason:string}): string | undefined {
    if(typeof options.reason!=='string'||!options.reason.trim()||options.reason.length>4000) throw new Error('回填原因无效。');
    return this.atomic(()=>{
      const {plan,batches}=this.materialBackfillPlan(conversationId,options);
      if(!batches.length) return undefined;
      const runId=randomUUID(),createdAt=timestamp();
      this.db.prepare('INSERT INTO material_backfill_runs VALUES (?,?,?,?,?,?,?)')
        .run(runId,conversationId,options.reason,plan.cutoffContextSeq,plan.planHash,JSON.stringify(plan),createdAt);
      const state=this.materialState(conversationId);
      let reservedSeq=Number(state.reserved_seq);
      for(const batch of batches) {
        const id=randomUUID(),start=batch.messages.reduce((value,message)=>Math.min(value,message.ingestSeq),batch.messages.length?Infinity:reservedSeq);
        const end=batch.messages.reduce((value,message)=>Math.max(value,message.ingestSeq),batch.messages.length?0:reservedSeq);
        this.db.prepare(`INSERT INTO auto_memory_jobs(id,conversation_id,reason,status,start_seq,end_seq,created_at,pipeline)
          VALUES (?,?,'backfill','queued',?,?,?,'materials')`).run(id,conversationId,start,end,createdAt);
        this.db.prepare('INSERT INTO auto_memory_material_jobs VALUES (?)').run(id);
        this.db.prepare('INSERT INTO material_backfill_jobs VALUES (?,?,?,?)').run(runId,id,batch.summary.ordinal,JSON.stringify(batch.summary));
        batch.messages.forEach((message,index)=>this.db.prepare('INSERT INTO auto_memory_material_job_messages VALUES (?,?,?)').run(id,message.id,index));
        for(const item of batch.pending) {
          const previous=this.db.prepare('SELECT * FROM auto_memory_material_observed_pending WHERE kind=? AND pending_id=?').get(item.kind,item.id);
          this.db.prepare('INSERT INTO material_backfill_pending_audit VALUES (?,?,?,?,?,?,?,?)').run(runId,id,item.kind,item.id,
            previous?.observed_at??null,previous?.assigned_job_id??null,previous?.blocked??null,createdAt);
          this.db.prepare('INSERT INTO auto_memory_material_job_pending VALUES (?,?,?,?)').run(id,item.kind,item.id,JSON.stringify(item.payload));
          this.db.prepare(`INSERT INTO auto_memory_material_observed_pending(kind,pending_id,conversation_id,observed_at,assigned_job_id,blocked)
            VALUES (?,?,?,?,?,0) ON CONFLICT(kind,pending_id) DO UPDATE SET assigned_job_id=excluded.assigned_job_id`)
            .run(item.kind,item.id,conversationId,Date.now(),id);
        }
        reservedSeq=Math.max(reservedSeq,end);
      }
      const observedSeq=Number(this.db.prepare('SELECT COALESCE(MAX(ingest_seq),0) AS seq FROM messages WHERE conversation_id=?').get(conversationId)!.seq);
      this.db.prepare(`UPDATE auto_memory_material_state SET observed_seq=MAX(observed_seq,?),reserved_seq=?,first_content_at=NULL,last_content_at=NULL
        WHERE conversation_id=?`).run(observedSeq,reservedSeq,conversationId);
      return runId;
    });
  }
  materialBackfillRun(runId:string): MaterialBackfillRun | undefined {
    return this.atomic(()=>{
      const row=this.db.prepare('SELECT * FROM material_backfill_runs WHERE id=?').get(runId);
      if(!row) return undefined;
      const plan=parse<MaterialBackfillPlan>(row.plan_json);
      const jobs=this.db.prepare(`SELECT b.*,j.status,j.attempts,j.error,
        EXISTS(SELECT 1 FROM auto_memory_job_deferrals d WHERE d.job_id=j.id) AS deferred,
        EXISTS(SELECT 1 FROM auto_memory_job_retirements r WHERE r.job_id=j.id) AS retired,
        EXISTS(SELECT 1 FROM auto_memory_legacy_isolations i WHERE i.job_id=j.id) AS isolated
        FROM material_backfill_jobs b JOIN auto_memory_jobs j ON j.id=b.job_id WHERE b.run_id=? ORDER BY b.ordinal`).all(runId)
        .map(item=>({...parse<MaterialBackfillBatch>(item.batch_json),id:String(item.job_id),status:item.status as AutoMemoryJob['status'],
          attempts:Number(item.attempts),...(item.error==null?{}:{error:String(item.error)}),
          ...(item.deferred?{deferred:true}:{}),...(item.retired?{retired:true}:{}),...(item.isolated?{isolated:true}:{})}));
      const status={queued:0,running:0,failed:0,completed:0,deferred:0,retired:0,isolated:0};
      for(const job of jobs) status[job.isolated?'isolated':job.retired?'retired':job.deferred?'deferred':job.status==='done'?'completed':job.status]++;
      const retainedPending=Number(this.db.prepare(`SELECT COUNT(*) AS count FROM auto_memory_material_job_pending p JOIN material_backfill_jobs b ON b.job_id=p.job_id
        WHERE b.run_id=? AND ((p.kind='person' AND EXISTS(SELECT 1 FROM person_profile_pending live WHERE live.id=p.pending_id AND live.archived_revision IS NULL AND live.purpose='profile'))
          OR (p.kind='self' AND EXISTS(SELECT 1 FROM self_profile_pending live WHERE live.id=p.pending_id AND live.archived_revision IS NULL
            AND NOT EXISTS(SELECT 1 FROM self_profile_reclassifications r WHERE r.pending_id=live.id))))`).get(runId)!.count);
      return {...plan,runId,reason:String(row.reason),createdAt:String(row.created_at),jobIds:jobs.map(job=>job.id),jobs,status,
        remainingMessages:jobs.filter(job=>job.status!=='done').reduce((count,job)=>count+job.messageCount,0),
        remainingPending:jobs.filter(job=>job.status!=='done').reduce((count,job)=>count+job.pendingCount,0),retainedPending};
    });
  }
  listMaterialBackfillRuns(conversationId?:string,limit=100): MaterialBackfillRun[] {
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000) throw new Error('回填查询数量无效。');
    return this.atomic(()=>this.db.prepare(`SELECT id FROM material_backfill_runs WHERE (? IS NULL OR conversation_id=?) ORDER BY rowid DESC LIMIT ?`)
      .all(conversationId??null,conversationId??null,limit).map(row=>this.materialBackfillRun(String(row.id))!));
  }
  private advanceMaterialCheckpoint(conversationId:string): void {
    let completed=0;
    for(const row of this.db.prepare(`SELECT m.ingest_seq,
      (EXISTS(SELECT 1 FROM auto_memory_material_legacy_messages l WHERE l.message_id=m.id AND l.disposition='done')
      OR EXISTS(SELECT 1 FROM auto_memory_material_job_messages jm JOIN auto_memory_jobs j ON j.id=jm.job_id
        WHERE jm.message_id=m.id AND j.status='done')) AS covered
      FROM messages m WHERE m.conversation_id=? AND m.role='user' AND m.message_kind='chat' ORDER BY m.ingest_seq`).all(conversationId)) {
      if(!row.covered) break;
      completed=Number(row.ingest_seq);
    }
    this.db.prepare('UPDATE auto_memory_material_state SET completed_seq=? WHERE conversation_id=?').run(completed,conversationId);
  }
  reserveMaterialsIfDue(conversationId:string,now=Date.now()): AutoMemoryJob | undefined {
    // Validate even empty polls; invalid clocks cannot become persisted schedule state.
    noteMemoryContent(undefined,now);
    return this.atomic(()=>{
      const state=this.materialState(conversationId);
      const newHuman=this.db.prepare(`SELECT 1 FROM messages m WHERE m.conversation_id=? AND m.role='user' AND m.message_kind='chat'
        AND m.ingest_seq>? AND NOT EXISTS(SELECT 1 FROM auto_memory_material_legacy_messages l WHERE l.message_id=m.id)
        AND NOT EXISTS(SELECT 1 FROM auto_memory_material_job_messages jm WHERE jm.message_id=m.id) LIMIT 1`)
        .get(conversationId,Number(state.observed_seq));
      const highest=Number(this.db.prepare('SELECT COALESCE(MAX(ingest_seq),0) AS seq FROM messages WHERE conversation_id=?').get(conversationId)!.seq);
      let newContent=Boolean(newHuman);
      const pending=this.activeMaterialPending(conversationId);
      for(const item of pending) {
        const blocked=Boolean(this.db.prepare(`SELECT 1 FROM auto_memory_material_legacy_messages WHERE message_id=? AND disposition='isolated'`)
          .get(String(item.payload.sourceMessageId)));
        const inserted=this.db.prepare(`INSERT OR IGNORE INTO auto_memory_material_observed_pending
          (kind,pending_id,conversation_id,observed_at,blocked) VALUES (?,?,?,?,?)`).run(item.kind,item.id,conversationId,now,blocked?1:0);
        if(inserted.changes&&!blocked) newContent=true;
      }
      let window=state.first_content_at==null?undefined:{firstContentAt:Number(state.first_content_at),lastContentAt:Number(state.last_content_at)};
      if(newContent) window=noteMemoryContent(window,now);
      this.db.prepare('UPDATE auto_memory_material_state SET observed_seq=?,first_content_at=?,last_content_at=? WHERE conversation_id=?')
        .run(highest,window?.firstContentAt??null,window?.lastContentAt??null,conversationId);
      const reason=memoryScheduleDue(window,now);
      if(!reason) return undefined;
      // Membership, rather than a max end_seq, owns coverage. Late delivered AI messages
      // therefore remain eligible even when their ingest sequence is below reserved_seq.
      const members=this.db.prepare(`SELECT c.message_id,m.ingest_seq FROM conversation_context_messages c JOIN messages m ON m.id=c.message_id
        WHERE c.conversation_id=? AND NOT EXISTS(SELECT 1 FROM auto_memory_material_legacy_messages l WHERE l.message_id=c.message_id)
        AND NOT EXISTS(SELECT 1 FROM auto_memory_material_job_messages jm WHERE jm.message_id=c.message_id) ORDER BY c.seq`).all(conversationId);
      const captured=pending.filter(item=>Boolean(this.db.prepare(`SELECT 1 FROM auto_memory_material_observed_pending o
        WHERE kind=? AND pending_id=? AND blocked=0 AND (assigned_job_id IS NULL
          OR EXISTS(SELECT 1 FROM auto_memory_jobs j WHERE j.id=o.assigned_job_id AND j.status='done'))`).get(item.kind,item.id)));
      // Clear both clocks at reservation. Completion never touches this state, so
      // content arriving during execution owns the next window across restarts.
      this.db.prepare('UPDATE auto_memory_material_state SET first_content_at=NULL,last_content_at=NULL WHERE conversation_id=?').run(conversationId);
      if(!members.length&&!captured.length) return undefined;
      const id=randomUUID(),seqs=members.map(row=>Number(row.ingest_seq));
      const start=seqs.reduce((a,b)=>Math.min(a,b),seqs.length?Infinity:Number(state.reserved_seq));
      const end=seqs.reduce((a,b)=>Math.max(a,b),Number(state.reserved_seq));
      this.db.prepare(`INSERT INTO auto_memory_jobs(id,conversation_id,reason,status,start_seq,end_seq,created_at,pipeline)
        VALUES (?,?,?,'queued',?,?,?,'materials')`).run(id,conversationId,reason,start,end,timestamp());
      this.db.prepare('INSERT INTO auto_memory_material_jobs VALUES (?)').run(id);
      members.forEach((row,index)=>this.db.prepare('INSERT INTO auto_memory_material_job_messages VALUES (?,?,?)').run(id,String(row.message_id),index));
      for(const item of captured) {
        this.db.prepare('INSERT INTO auto_memory_material_job_pending VALUES (?,?,?,?)').run(id,item.kind,item.id,JSON.stringify(item.payload));
        this.db.prepare('UPDATE auto_memory_material_observed_pending SET assigned_job_id=? WHERE kind=? AND pending_id=?').run(id,item.kind,item.id);
      }
      this.db.prepare('UPDATE auto_memory_material_state SET reserved_seq=MAX(reserved_seq,?) WHERE conversation_id=?').run(end,conversationId);
      return this.job(this.db.prepare('SELECT * FROM auto_memory_jobs WHERE id=?').get(id)!);
    });
  }
  reserveBatch(conversationId: string, reason: AutoMemoryReason, batchSize=50, excludeMessageId?: string): AutoMemoryJob | undefined {
    if(!['count','capacity'].includes(reason)||!Number.isSafeInteger(batchSize)||batchSize<1) throw new Error('整理批次参数无效。');
    return this.atomic(()=>{
      if(reason==='capacity') return this.reserveContextBatch(conversationId,excludeMessageId);
      const checkpoint=this.checkpoint(conversationId); const roomType=this.roomType(conversationId);
      const before=excludeMessageId===undefined?undefined:this.db.prepare('SELECT ingest_seq FROM messages WHERE id=? AND conversation_id=?').get(excludeMessageId,conversationId);
      if(excludeMessageId!==undefined&&!before) throw new Error('整理边界消息必须属于当前会话。');
      const users=this.db.prepare(`SELECT m.id,m.ingest_seq,r.id AS run_id,r.status,r.response_message_id,d.status AS delivery_status,response.ingest_seq AS response_seq
        FROM messages m LEFT JOIN agent_runs r ON r.input_message_id=m.id LEFT JOIN messages response ON response.id=r.response_message_id
        LEFT JOIN deliveries d ON d.run_id=r.id WHERE m.conversation_id=? AND m.role='user' AND m.message_kind='chat' AND m.ingest_seq>?
        AND (? IS NULL OR m.ingest_seq<?) AND NOT EXISTS(SELECT 1 FROM auto_memory_job_messages assigned WHERE assigned.message_id=m.id)
        ORDER BY m.ingest_seq`).all(conversationId,Number(checkpoint.initial_seq),before?.ingest_seq??null,before?.ingest_seq??null);
      const eligible=roomType==='group'?users:users.filter(r=>r.status==='completed'&&r.delivery_status==='sent');
      if(reason==='count'&&eligible.length<batchSize) return undefined;
      const selected=eligible.slice(0,batchSize);
      if(!selected.length) return undefined;
      const members=new Map<string,number>();
      for(const row of selected) {
        members.set(String(row.id),Number(row.ingest_seq));
        if(row.status==='completed'&&row.delivery_status==='sent') members.set(String(row.response_message_id),Number(row.response_seq));
      }
      const ordered=[...members].sort((a,b)=>a[1]-b[1]); const id=randomUUID();
      this.db.prepare(`INSERT INTO auto_memory_jobs(id,conversation_id,reason,status,start_seq,end_seq,created_at) VALUES (?,?,?,'queued',?,?,?)`)
        .run(id,conversationId,reason,ordered[0]![1],ordered[ordered.length-1]![1],timestamp());
      ordered.forEach(([messageId],index)=>this.db.prepare('INSERT INTO auto_memory_job_messages VALUES (?,?,?)').run(id,messageId,index));
      return this.job(this.db.prepare('SELECT * FROM auto_memory_jobs WHERE id=?').get(id)!);
    });
  }
  claimNext(conversationId: string, options: {owner:string;leaseMs:number;now?:number;pipeline?:AutoMemoryPipeline;jobIds?:readonly string[]}): AutoMemoryJob | undefined {
    if(!options.owner||!Number.isSafeInteger(options.leaseMs)||options.leaseMs<1) throw new Error('整理租约无效。');
    return this.atomic(()=>{
      const current=options.now??Date.now();
      const row=this.nextPending(conversationId,options.pipeline);
      if(!row||(options.jobIds!==undefined&&!options.jobIds.includes(String(row.id)))||row.status==='failed'
        ||(row.status==='running'&&Number(row.lease_until)>current)) return undefined;
      if (row.status === 'running') {
        this.db.prepare("UPDATE auto_memory_jobs SET status='failed',error=?,lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE id=?")
          .run('[interrupted] phase=recover; 先前调用结果未知，固定批次和检查点保留，需显式重试。', String(row.id));
        return undefined;
      }
      this.db.prepare(`UPDATE auto_memory_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_owner=?,lease_until=?,error=NULL WHERE id=?`)
        .run(randomUUID(),options.owner,current+options.leaseMs,String(row.id));
      const job=this.job(this.db.prepare('SELECT * FROM auto_memory_jobs WHERE id=?').get(String(row.id))!);
      this.taskInput(job); return job;
    });
  }
  private nextPending(conversationId:string,pipeline:AutoMemoryPipeline='legacy'): Record<string,unknown> | undefined {
    return this.db.prepare(`SELECT j.* FROM auto_memory_jobs j WHERE j.conversation_id=? AND j.pipeline=? AND j.status<>'done'
      AND NOT EXISTS(SELECT 1 FROM auto_memory_job_deferrals d WHERE d.job_id=j.id)
      AND NOT EXISTS(SELECT 1 FROM auto_memory_job_retirements r WHERE r.job_id=j.id)
      AND NOT EXISTS(SELECT 1 FROM auto_memory_legacy_isolations i WHERE i.job_id=j.id) ORDER BY j.rowid LIMIT 1`).get(conversationId,pipeline);
  }
  private active(jobId:string,leaseToken:string): Record<string,unknown> {
    const row=this.db.prepare(`SELECT * FROM auto_memory_jobs WHERE id=? AND status='running' AND lease_token=? AND lease_until>?
      AND NOT EXISTS(SELECT 1 FROM auto_memory_job_deferrals d WHERE d.job_id=auto_memory_jobs.id)
      AND NOT EXISTS(SELECT 1 FROM auto_memory_job_retirements r WHERE r.job_id=auto_memory_jobs.id)
      AND NOT EXISTS(SELECT 1 FROM auto_memory_legacy_isolations i WHERE i.job_id=auto_memory_jobs.id)`).get(jobId,leaseToken,Date.now());
    if(!row) throw new Error('整理租约已失效。'); return row;
  }
  private messages(ids: readonly string[]): AutoMemoryMessage[] {
    return ids.map(id=>{
      const r=this.db.prepare(`SELECT m.*,p.person_id,r.status AS run_status,d.status AS delivery_status,input.ingest_seq AS turn_input_seq,
        context.seq AS context_seq,a.external_user_id AS sender_id,inputa.external_user_id AS reply_sender_id,r.input_message_id FROM messages m
        LEFT JOIN actor_person_bindings p ON p.actor_id=m.actor_id LEFT JOIN agent_runs r ON r.input_message_id=m.id OR r.response_message_id=m.id
        LEFT JOIN messages input ON input.id=r.input_message_id LEFT JOIN deliveries d ON d.message_id=m.id
        LEFT JOIN actors a ON a.id=m.actor_id LEFT JOIN actors inputa ON inputa.id=input.actor_id
        LEFT JOIN conversation_context_messages context ON context.message_id=m.id WHERE m.id=?`).get(id)!;
      const images=this.db.prepare('SELECT metadata_json FROM message_images WHERE message_id=? ORDER BY ordinal').all(id)
        .map(row=>parse<import('./image-context.js').MessageImage>(row.metadata_json));
      const context=this.db.prepare('SELECT mentioned_sender_ids_json FROM message_profile_context WHERE message_id=?').get(id);
      return {id:String(r.id),conversationId:String(r.conversation_id),role:r.role as 'user'|'assistant',text:String(r.text),ingestSeq:Number(r.ingest_seq),createdAt:String(r.created_at),
        ...(images.length?{images}:{}),
        ...(context?{mentionedSenderIds:parse<string[]>(context.mentioned_sender_ids_json)}:{}),
        ...(r.image_failure==null?{}:{imageFailure:String(r.image_failure)}),
        ...(r.turn_input_seq==null?{}:{turnInputSeq:Number(r.turn_input_seq)}),
        ...(r.context_seq==null?{}:{contextSeq:Number(r.context_seq)}),
        ...(r.sender_id==null?{}:{senderId:String(r.sender_id)}),...(r.sender_name==null?{}:{senderName:String(r.sender_name)}),
        ...(r.role!=='assistant'||r.input_message_id==null?{}:{replyToMessageId:String(r.input_message_id),
          ...(r.reply_sender_id==null?{}:{replyToSenderId:String(r.reply_sender_id)})}),
        ...(r.actor_id==null?{}:{actorId:String(r.actor_id)}),...(r.person_id==null?{}:{personId:String(r.person_id)}),...(r.sent_at==null?{}:{sentAt:String(r.sent_at)}),
        ...(r.run_status==null?{}:{runStatus:String(r.run_status)}),...(r.delivery_status==null?{}:{deliveryStatus:String(r.delivery_status)})};
    });
  }
  profile(personId:string): PersonProfile {
    const person=this.db.prepare('SELECT revision FROM persons WHERE id=?').get(personId);
    if(!person) throw new Error('人物不存在。');
    const baseVersion=Number(person.revision); const row=this.db.prepare('SELECT facts_json FROM person_profile_revisions WHERE person_id=? AND revision=?').get(personId,baseVersion);
    const facts=row?parse<ProfileFact[]>(row.facts_json):[];
    const at=timestamp();
    const pending = this.db.prepare("SELECT name FROM sqlite_master WHERE name='person_profile_pending'").get()
      ? this.db.prepare("SELECT id,content,source_message_id,source_type,subject_json FROM person_profile_pending WHERE person_id=? AND archived_revision IS NULL AND purpose='profile' ORDER BY rowid").all(personId)
        .map(row=>({id:String(row.id),content:String(row.content),sourceMessageId:String(row.source_message_id),sourceType:row.source_type as ProfileFact['sourceType'],
          ...(row.subject_json==null?{}:{subject:parse<ProfileSubjectEvidence>(row.subject_json)})})) : [];
    return {personId,baseVersion,facts:facts.filter(f=>!f.expiresAt||f.expiresAt>at),pending};
  }
  profileForActors(currentActorId:string,mentionedActorIds:readonly string[]=[]): PersonProfile[] {
    const people=new Set([currentActorId,...mentionedActorIds].map(id=>this.personForActor(id)).filter((id):id is string=>id!==undefined));
    return [...people].map(id=>this.profile(id));
  }
  profileSubjectCandidates(conversationId: string): ProfileSubjectCandidate[] {
    return this.db.prepare(`SELECT b.person_id,a.external_user_id,
      (SELECT sender_name FROM messages m WHERE m.actor_id=a.id AND m.sender_name IS NOT NULL ORDER BY ingest_seq DESC LIMIT 1) AS name
      FROM actors a JOIN conversations c ON c.room_id=a.room_id JOIN actor_person_bindings b ON b.actor_id=a.id
      WHERE c.id=? ORDER BY a.id`).all(conversationId).map(row=>({personId:String(row.person_id),senderId:String(row.external_user_id),
        ...(row.name==null?{}:{name:String(row.name)})}));
  }
  roomRules(conversationId:string): {key:string;content:string}[] {
    if(this.roomType(conversationId)!=='group') return [];
    return this.db.prepare(`SELECT rule_key,content FROM room_rule_revisions v WHERE conversation_id=?
      AND revision=(SELECT max(revision) FROM room_rule_revisions n WHERE n.conversation_id=v.conversation_id AND n.rule_key=v.rule_key)
      ORDER BY created_at,rule_key`).all(conversationId).map(r=>({key:String(r.rule_key),content:String(r.content)}));
  }
  taskInput(job:AutoMemoryJob): AutoMemoryTaskInput {
    if(!job.leaseToken) throw new Error('整理任务尚未领取。');
    const row=this.active(job.id,job.leaseToken);
    if(row.input_json!==null) return {...parse<AutoMemoryTaskInput>(row.input_json),job:this.job(row)};
    const canonical=this.job(row); const messages=this.messages(canonical.messageIds); const cp=this.checkpoint(canonical.conversationId);
    const contextJob=this.db.prepare('SELECT * FROM auto_memory_context_jobs WHERE job_id=?').get(job.id);
    const previousSummary=contextJob?contextJob.previous_summary:cp.summary;
    if(canonical.pipeline==='compression') {
      const input:AutoMemoryTaskInput={pipeline:'compression',contextProtocol:1,extractionProtocol:2,profileProtocol:2,
        job:canonical,roomType:this.roomType(canonical.conversationId),messages,profiles:[],
        ...(previousSummary==null?{}:{previousSummary:String(previousSummary)})};
      this.db.prepare('UPDATE auto_memory_jobs SET input_json=? WHERE id=? AND lease_token=?').run(JSON.stringify(input),job.id,job.leaseToken);
      return input;
    }
    const materialPending=canonical.pipeline==='materials'?this.db.prepare('SELECT kind,payload_json FROM auto_memory_material_job_pending WHERE job_id=? ORDER BY rowid')
      .all(job.id).map(item=>({kind:String(item.kind),payload:parse<PersonProfilePending & {personId?:string}>(item.payload_json)})):[];
    const people=new Set(messages.flatMap(m=>m.personId?[m.personId]:[]));
    if(canonical.pipeline==='materials') {
      for(const item of materialPending) if(item.kind==='person'&&item.payload.personId) people.add(item.payload.personId);
    } else for (const pending of this.db.prepare(`SELECT DISTINCT p.person_id FROM person_profile_pending p
      JOIN messages source ON source.id=p.source_message_id
      WHERE source.conversation_id=? AND source.ingest_seq<=? AND p.archived_revision IS NULL AND p.purpose='profile'`)
      .all(canonical.conversationId,canonical.endSeq)) people.add(String(pending.person_id));
    let profiles=[...people].map(personId=>this.profile(personId));
    if(canonical.pipeline==='materials') profiles=profiles.map(profile=>({...profile,pending:materialPending
      .filter(item=>item.kind==='person'&&item.payload.personId===profile.personId).map(item=>{
        const {personId:_,...pending}=item.payload;return pending;
      })}));
    const profileFragments: NonNullable<AutoMemoryTaskInput['profileFragments']> = [];
    let fragmentBytes = 0;
    for (const personId of people) for (const fragment of this.db.prepare(`SELECT id,content,source_type FROM person_fragments
      WHERE person_id=? ORDER BY rowid DESC LIMIT 200`).all(personId)) {
      const item = { personId, content: String(fragment.content), sourceType: fragment.source_type as ProfileFact['sourceType'],
        messageIds: this.db.prepare('SELECT message_id FROM person_fragment_messages WHERE fragment_id=? ORDER BY message_id')
          .all(String(fragment.id)).map(row => String(row.message_id)) };
      const bytes = Buffer.byteLength(JSON.stringify(item));
      if (fragmentBytes + bytes > 12000) continue;
      fragmentBytes += bytes; profileFragments.push(item);
    }
    const excludedProfileSourceIds = [...this.excludedProfileSources([...new Set([
      ...messages.map(message => message.id), ...profiles.flatMap(profile => [...profile.facts.flatMap(fact => fact.messageIds),
        ...(profile.pending ?? []).map(pending => pending.sourceMessageId)]),
      ...profileFragments.flatMap(fragment => fragment.messageIds),
    ])])];
    const excluded = new Set(excludedProfileSourceIds);
    profiles = profiles.map(profile => ({ ...profile, pending: (profile.pending ?? []).filter(pending => !excluded.has(pending.sourceMessageId)) }));
    for (let i = profileFragments.length - 1; i >= 0; i--) {
      if (profileFragments[i]!.messageIds.some(id => excluded.has(id))) profileFragments.splice(i, 1);
    }
    const profileSources=this.messages([...new Set([...profiles.flatMap(p=>(p.pending??[]).map(item=>item.sourceMessageId)),
      ...profiles.flatMap(profile => profile.facts.flatMap(fact => fact.messageIds)),
      ...profileFragments.flatMap(fragment => fragment.messageIds)])]);
    const deferredRanges=canonical.pipeline==='materials'?[]:this.deferredRanges(canonical.conversationId);
    const selfProfile=this.selfProfile.snapshot();
    if(canonical.pipeline==='materials') selfProfile.pending=materialPending.filter(item=>item.kind==='self').map(item=>({
      id:item.payload.id,content:item.payload.content,sourceMessageId:item.payload.sourceMessageId}));
    const input:AutoMemoryTaskInput={...(canonical.pipeline==='materials'?{pipeline:'materials' as const,extractionProtocol:2 as const,profileBaselineProtocol:1 as const,
      profileAttributionProtocol:1 as const,selfProfileProtocol:2 as const,profileSubjects:this.profileSubjectCandidates(canonical.conversationId)}
      :contextJob?{contextProtocol:1 as const,extractionProtocol:2 as const}:{}),profileProtocol:2,profileSources,profileFragments,
      ...(excludedProfileSourceIds.length?{excludedProfileSourceIds}:{}),...(deferredRanges.length?{deferredRanges}:{}),roomRules:this.roomRules(canonical.conversationId),
      job:canonical,roomType:this.roomType(canonical.conversationId),messages,profiles,selfProfile,
      ...(canonical.pipeline==='materials'||previousSummary==null?{}:{previousSummary:String(previousSummary)})};
    this.db.prepare('UPDATE auto_memory_jobs SET input_json=? WHERE id=? AND lease_token=?').run(JSON.stringify(input),job.id,job.leaseToken);
    return input;
  }
  /** Resolve preserved legacy purpose rows, including archived rows, before reusing profile evidence. */
  assertProfileEvidenceCurrent(input: AutoMemoryTaskInput, extract?: Pick<ValidatedExtract, 'profiles'> & Partial<Pick<ValidatedExtract, 'fragments'>>): void {
    const ids = new Set([
      ...input.messages.map(message => message.id), ...(input.profileSources ?? []).map(message => message.id),
      ...(input.profileFragments ?? []).flatMap(fragment => fragment.messageIds),
      ...input.profiles.flatMap(profile => [...profile.facts.flatMap(fact => fact.messageIds),
        ...(profile.pending ?? []).map(pending => pending.sourceMessageId)]),
      ...(extract?.profiles ?? []).flatMap(profile => profile.facts.flatMap(fact => fact.messageIds)),
      ...(extract?.fragments ?? []).flatMap(fragment => fragment.messageIds),
    ]);
    const excluded = this.excludedProfileSources([...ids]);
    if ((input.profileFragments ?? []).some(fragment => fragment.messageIds.some(id => excluded.has(id)))
      || input.profiles.some(profile => (profile.pending ?? []).some(pending => excluded.has(pending.sourceMessageId)))
      || (extract?.fragments ?? []).some(fragment => fragment.messageIds.some(id => excluded.has(id)))
      || (extract?.profiles ?? []).some(profile => profile.facts.some(fact =>
        !input.profiles.find(baseline => baseline.personId === profile.personId)?.facts.some(old => sameFact(old, fact))
        && fact.messageIds.some(id => excluded.has(id))))) throw new ObsoletePersonalMemoryError();
  }
  private excludedProfileSources(ids: readonly string[]): Set<string> {
    const statement = this.db.prepare("SELECT 1 FROM person_profile_pending WHERE purpose='memory' AND source_message_id=? LIMIT 1");
    return new Set(ids.filter(id => statement.get(id) !== undefined));
  }
  addProfilePending(personId:string,sourceMessageId:string,content:string,sourceType:ProfileFact['sourceType']='third_party',
    options: { allowThirdParty?: boolean; subject?: Omit<ProfileSubjectEvidence,'messageId'|'factQuote'>; mentionedSenderIds?: readonly string[] } = {}): void {
    if(typeof content!=='string'||!content.trim()||[...content].length>4000||!['self','third_party','inference'].includes(sourceType)) throw new MemoryError('待整理人物内容无效。');
    this.atomic(()=>{
      const source=this.db.prepare("SELECT actor_id,conversation_id FROM messages WHERE id=? AND role='user' AND actor_id IS NOT NULL").get(sourceMessageId);
      if ('purpose' in options) throw new MemoryError('待整理人物资料仅支持画像。');
      const samePerson = source && this.personForActor(String(source.actor_id))===personId;
      const sameRoom = source && this.db.prepare(`SELECT a.id FROM actors a JOIN actor_person_bindings b ON b.actor_id=a.id
        JOIN conversations c ON c.room_id=a.room_id WHERE c.id=? AND b.person_id=? LIMIT 1`).get(String(source.conversation_id),personId);
      if(!source||(!samePerson&&!(options.allowThirdParty===true&&sourceType==='third_party'&&sameRoom))) throw new MemoryError('待整理资料必须属于实际发送者或同房间明确第三方。');
      const message=this.messages([sourceMessageId])[0]!;
      if(options.mentionedSenderIds) message.mentionedSenderIds=[...options.mentionedSenderIds];
      const candidates=this.profileSubjectCandidates(String(source.conversation_id));
      let evidence:ProfileSubjectEvidence;
      try {
        if(!message.text.includes(content)) throw new MemoryError('保存内容必须来自原始真人消息。');
        evidence=options.subject?{...options.subject,messageId:sourceMessageId,
          factQuote:content.includes(options.subject.subjectQuote)?content:message.text}
          :inferPersonProfileEvidence(message,content,candidates,personId);
        const subject=resolveProfileSubject(evidence,message,candidates);
        if(subject.personId!==personId||(sourceType==='self'&&subject.sourceType!=='self')) throw new MemoryError('画像对象与实际描述人物不一致。');
      } catch(error) {throw new MemoryError(error instanceof Error?error.message:'画像对象无法确认。');}
      const profile=this.profile(personId);
      if((profile.pending??[]).some(item=>item.sourceMessageId===sourceMessageId&&item.content===content&&item.sourceType===sourceType)) return;
      const pending=profile.pending??[];
      if(pending.length>=100||pending.reduce((bytes,item)=>bytes+Buffer.byteLength(item.content),0)+Buffer.byteLength(content)>12000
        ||Buffer.byteLength(JSON.stringify({personId,baseVersion:profile.baseVersion,pending:[...pending,{id:randomUUID(),content,sourceMessageId,sourceType}]}))>20000) throw new MemoryError('待整理人物画像容量已满，请等待归档或缩短内容。');
      this.db.prepare('INSERT INTO person_profile_pending(id,person_id,content,source_message_id,source_type,created_at,purpose,subject_json) VALUES (?,?,?,?,?,?,?,?)')
        .run(randomUUID(),personId,content,sourceMessageId,sourceType,timestamp(),'profile',JSON.stringify(evidence));
    });
  }
  private writeProfile(profile:PersonProfile,jobId:string|null,legacyMigration=false): void {
    const facts=mergeProfileFacts(profile.facts);
    if(legacyMigration&&Number(this.db.prepare('PRAGMA user_version').get()?.user_version)>=6) throw new Error('历史画像迁移阶段无效。');
    if(!legacyMigration) assertProfileCapacity({...profile,baseVersion:profile.baseVersion+1,facts});
    const previousRow=legacyMigration?undefined:this.db.prepare('SELECT facts_json FROM person_profile_revisions WHERE person_id=? AND revision=?')
      .get(profile.personId,profile.baseVersion);
    const previousFacts=previousRow?parse<ProfileFact[]>(previousRow.facts_json):[];
    const revision=profile.baseVersion+1;
    if(this.db.prepare('UPDATE persons SET revision=? WHERE id=? AND revision=?').run(revision,profile.personId,profile.baseVersion).changes!==1) throw new Error('人物画像版本冲突，请重读后重试。');
    this.db.prepare('INSERT INTO person_profile_revisions VALUES (?,?,?,?,?)').run(profile.personId,revision,JSON.stringify(facts),jobId,timestamp());
    if(!legacyMigration) facts.forEach((fact,index)=>{
      const sources=new Set(fact.messageIds);
      previousFacts.forEach((old,oldIndex)=>{
        // A single message may contain unrelated facts. Only identical facts inherit
        // supplementary evidence; rewrites keep their prior evidence in the old revision.
        if(sameFactContent(old,fact)) {
          old.messageIds.forEach(messageId=>sources.add(messageId));
          for(const row of this.db.prepare('SELECT message_id FROM person_profile_revision_sources WHERE person_id=? AND revision=? AND fact_index=?')
            .all(profile.personId,profile.baseVersion,oldIndex)) sources.add(String(row.message_id));
        }
      });
      sources.forEach(messageId=>this.db.prepare('INSERT OR IGNORE INTO person_profile_revision_sources VALUES (?,?,?,?)')
        .run(profile.personId,revision,index,messageId));
    });
  }
  private evidenceSequence(ids:readonly string[]):number {
    return ids.reduce((highest,id)=>Math.max(highest,Number(this.db.prepare('SELECT ingest_seq FROM messages WHERE id=?').get(id)?.ingest_seq??0)),0);
  }
  commit(jobId:string,leaseToken:string,extract:ValidatedExtract,selfBudget?:number): void {
    this.atomic(()=>{
      const row=this.active(jobId,leaseToken); const job=this.job(row); const input=this.taskInput(job); assertCurrentMemoryProtocol(input); assertProfileProtocol(input); assertCurrentMemoryProtocol(extract); this.assertProfileEvidenceCurrent(input,extract); const owned=new Set(job.messageIds);
      assertLiveProfileProtocol(input);
      if([...(input.profileSources??[]),...input.messages].some(m=>m.actorId!==undefined&&this.personForActor(m.actorId)!==m.personId)) throw new Error('人物绑定版本冲突，请重读后重试。');
      const first=this.nextPending(job.conversationId,job.pipeline);
      if(first?.id!==jobId) throw new Error('同房间整理必须按批次顺序提交。');
      if(!Array.isArray(extract.topics)||!Array.isArray(extract.fragments)||!Array.isArray(extract.profiles)) throw new Error('整理产物结构无效。');
      if(job.pipeline==='compression'&&(input.pipeline!=='compression'||extract.topics.length||extract.fragments.length||extract.profiles.length
        ||extract.selfProfile!==undefined)) throw new Error('上下文压缩只能提交续聊摘要和完成回执。');
      if(job.pipeline==='materials'&&(input.pipeline!=='materials'||extract.continuationSummary!==undefined))
        throw new Error('资料整理不能提交上下文压缩摘要。');
      const sourceRooms = new Map([...input.messages,...(input.profileSources??[])].map(message=>[message.id,message.conversationId]));
      const evidence=(ids:string[],sourceType?:string,personId?:string)=>{
        const sources = new Map(input.messages.map(message => [message.id,message]));
        if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!owned.has(id))) throw new Error('整理证据必须属于固定批次。');
        if(sourceType!==undefined&&!['self','third_party','inference'].includes(sourceType)) throw new Error('证据类型无效。');
        if(sourceType!==undefined&&ids.some(id=>sources.get(id)?.role!=='user')) throw new Error('Bot回复不能作为人物事实的原始证据。');
        if(sourceType==='self'&&ids.some(id=>sources.get(id)?.personId!==personId)) throw new Error('自述证据身份不匹配。');
      };
      const content=(s:string)=>{if(typeof s!=='string'||!s.trim()||s.length>32000) throw new Error('整理正文无效。');};
      if(!Array.isArray(extract.ignoredMessageIds)||new Set(extract.ignoredMessageIds).size!==extract.ignoredMessageIds.length
        ||extract.ignoredMessageIds.some(id=>!input.messages.some(m=>m.id===id&&m.role==='user'))) throw new Error('无价值消息归属无效。');
      if (input.extractionProtocol === 2) {
        if (!this.db.prepare('SELECT 1 FROM auto_memory_context_jobs WHERE job_id=?').get(job.id)
          && !this.db.prepare('SELECT 1 FROM auto_memory_material_jobs WHERE job_id=?').get(job.id)) throw new Error('范围整理协议必须对应固定快照。');
        if (extract.ignoredMessageIds.length || extract.fragments.length) throw new Error('新整理协议不接受逐条覆盖清单或人物事件片段。');
        if(job.pipeline==='materials'&&job.messageIds.length===0) {
          if(!Array.isArray(extract.processedRanges)||extract.processedRanges.length) throw new Error('空消息快照只能提交空完成回执。');
        } else assertProcessedRanges(extract.processedRanges, job.messageIds.length);
      } else {
        const covered=new Set([...extract.ignoredMessageIds,...extract.topics.flatMap(t=>t.messageIds),...extract.fragments.flatMap(f=>f.messageIds)]);
        if(input.messages.some(m=>m.role==='user'&&!covered.has(m.id))) throw new Error('整理结果未覆盖所有真人消息。');
      }
      if(input.pipeline==='materials') { /* Materials never update conversation context. */ }
      else if(input.roomType==='private'||input.contextProtocol===1) content(extract.continuationSummary!);
      else if(extract.continuationSummary!==undefined) throw new Error('群聊不能提交私聊续聊摘要。');
      const topicIds=extract.topics.map(topic=>{
        content(topic.summary);
        if (input.extractionProtocol === 2) {
          if (topic.messageIds.length || [...topic.summary].length > COMPACT_TOPIC_LIMITS.characters) throw new Error('Topic只能包含有界摘要，来源范围由程序记录。');
          assertMemorySourceRange(topic.sourceRange!, job.messageIds.length);
          if (!extract.processedRanges!.some(range => range.startOrdinal === topic.sourceRange!.startOrdinal
            && range.endOrdinal === topic.sourceRange!.endOrdinal)) throw new Error('Topic来源没有对应的整理完成回执。');
        } else evidence(topic.messageIds);
        const id=randomUUID();
        if (topic.messageIds.some(messageId=>sourceRooms.get(messageId)!==job.conversationId)) throw new Error('Topic来源必须属于当前会话。');
        this.db.prepare('INSERT INTO memory_topics(id,conversation_id,job_id,summary,content_hash,created_at) VALUES (?,?,?,?,?,?)').run(id,job.conversationId,jobId,topic.summary,hash(topic.summary),timestamp());
        if (input.extractionProtocol === 2) this.db.prepare('INSERT INTO memory_topic_scopes VALUES (?,?,?)')
          .run(id,topic.sourceRange!.startOrdinal,topic.sourceRange!.endOrdinal);
        else topic.messageIds.forEach(messageId=>this.db.prepare('INSERT INTO memory_topic_messages VALUES (?,?)').run(id,messageId));
        return id;
      });
      for(const fragment of extract.fragments) {
        if(!['self','third_party','inference'].includes(fragment.sourceType)) throw new Error('证据类型无效。');
        content(fragment.content);evidence(fragment.messageIds,fragment.sourceType,fragment.personId);
        if(input.roomType==='private' && ![...(input.profiles.find(profile=>profile.personId===fragment.personId)?.facts??[]),
          ...extract.profiles.filter(profile=>profile.personId===fragment.personId).flatMap(profile=>profile.facts)]
          .some(fact=>sameFactContent(fact,fragment)&&fragment.messageIds.every(id=>fact.messageIds.includes(id)))) {
          throw new Error('私聊人物片段只能保存稳定画像证据。');
        }
        if(!input.profiles.some(p=>p.personId===fragment.personId)) throw new Error('人物片段目标不属于本批次人物。');
        if(fragment.topicIndex!==undefined&&(!Number.isSafeInteger(fragment.topicIndex)||!topicIds[fragment.topicIndex])) throw new Error('人物片段Topic关联无效。');
        const existing = this.db.prepare('SELECT id,content FROM person_fragments WHERE person_id=? AND source_type=?')
          .all(fragment.personId,fragment.sourceType).find(row => String(row.content).normalize('NFKC').trim() === fragment.content.normalize('NFKC').trim());
        const id = existing ? String(existing.id) : randomUUID();
        if (!existing) this.db.prepare('INSERT INTO person_fragments VALUES (?,?,?,?,?,?,?)').run(id,fragment.personId,jobId,fragment.topicIndex===undefined?null:topicIds[fragment.topicIndex]!,fragment.content,fragment.sourceType,timestamp());
        fragment.messageIds.forEach(messageId=>this.db.prepare('INSERT OR IGNORE INTO person_fragment_messages VALUES (?,?)').run(id,messageId));
      }
      const updated=new Set<string>();
      for(const profile of extract.profiles) {
        if(updated.has(profile.personId)||!Array.isArray(profile.facts)) throw new Error('人物画像产物无效。'); updated.add(profile.personId);
        const baseline=input.profiles.find(p=>p.personId===profile.personId);
        if(!baseline||baseline.baseVersion!==profile.baseVersion) throw new Error('人物画像输入版本不匹配。');
        validateProfileUpdates(profile,baseline,input);
        for(const fact of profile.facts) {
          content(fact.content);
          if(!['self','third_party','inference'].includes(fact.sourceType)||!Array.isArray(fact.messageIds)) throw new Error('画像事实证据无效。');
          const inherited=baseline.facts.some(old=>sameFact(old,fact));
          if(!inherited) {
            assertProfileEvidenceStrength(fact,baseline,input);
            if(fact.field!==undefined) throw new Error('新画像事实不能输出旧分类字段。');
          }
          const captured=baseline.pending??[];
          const priorIds = new Set([...(input.profileFragments ?? []).filter(fragment => fragment.personId === profile.personId).flatMap(fragment => fragment.messageIds),
            ...baseline.facts.flatMap(old => old.messageIds)]);
          const allowed=new Map([...input.messages,...(input.profileSources??[]).filter(message=>captured.some(item=>item.sourceMessageId===message.id)||priorIds.has(message.id)),
            ...this.messages([...priorIds])].map(message=>[message.id,message]));
          if(!fact.messageIds.length||new Set(fact.messageIds).size!==fact.messageIds.length
            ||fact.messageIds.some(id=>!allowed.has(id)||allowed.get(id)!.role!=='user')
            ||(fact.sourceType==='self'&&fact.messageIds.some(id=>allowed.get(id)!.personId!==profile.personId))) throw new Error('人物画像必须引用有效真人来源，且自述必须属于本人。');
        }
        const current=this.profile(profile.personId);
        if(current.baseVersion!==baseline.baseVersion||JSON.stringify(current.facts)!==JSON.stringify(baseline.facts)) throw new Error('人物画像版本冲突，请重读后重试。');
        const pendingResults=validateProfilePendingResults(profile,baseline,input);
        for(const result of pendingResults) {
          const captured=baseline.pending!.find(item=>item.id===result.pendingId)!;
          const live=current.pending?.find(item=>item.id===result.pendingId);
          if(!live||!samePending(captured,live)) throw new Error('只能处理本次捕获且未经改变的人物待整理条目。');
        }
        // Validate the deduplicated final result, not just each model chunk.
        assertProfileCapacity({...profile,facts:mergeProfileFacts(profile.facts)});
        this.writeProfile(profile,jobId);
        for(const update of profile.updates??[]) for(const evidence of update.evidence) {
          const source=[...input.messages,...(input.profileSources??[])].find(message=>message.id===evidence.messageId)!;
          const target=mergeProfileFacts(profile.facts).findIndex(fact=>sameFactContent(fact,profile.facts[update.factIndex]!));
          this.db.prepare('INSERT OR IGNORE INTO person_profile_subject_updates VALUES (?,?,?,?,?,?,?)')
            .run(profile.personId,profile.baseVersion+1,target,evidence.messageId,source.personId!,JSON.stringify(evidence),timestamp());
        }
        for(const result of pendingResults) {
          const captured=baseline.pending!.find(item=>item.id===result.pendingId)!;
          const mergedFact=result.status==='merged'?profile.facts[result.factIndex]:undefined;
          const normalizedIndex=mergedFact?mergeProfileFacts(profile.facts).findIndex(fact=>sameFactContent(fact,mergedFact)):null;
          this.db.prepare(`INSERT INTO person_profile_pending_results
            (job_id,pending_id,person_id,source_message_id,source_type,content_hash,outcome,profile_revision,fact_index,replacement_message_id,reason,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(jobId,captured.id,profile.personId,captured.sourceMessageId,captured.sourceType,hash(captured.content),result.status,
            profile.baseVersion+1,normalizedIndex,result.status==='superseded'?result.replacementMessageId:null,result.status==='not_profile'?result.reason:null,timestamp());
          if(result.status==='merged') this.db.prepare('INSERT OR IGNORE INTO person_profile_revision_sources VALUES (?,?,?,?)')
            .run(profile.personId,profile.baseVersion+1,normalizedIndex!,captured.sourceMessageId);
          if(result.status==='merged'&&captured.subject) {
            const speaker=[...input.messages,...(input.profileSources??[])].find(message=>message.id===captured.sourceMessageId)!;
            this.db.prepare('INSERT OR IGNORE INTO person_profile_subject_updates VALUES (?,?,?,?,?,?,?)')
              .run(profile.personId,profile.baseVersion+1,normalizedIndex!,captured.sourceMessageId,speaker.personId!,JSON.stringify(captured.subject),timestamp());
          }
          if(result.status!=='deferred') {
            // Internal acknowledged-queue cleanup only. Original messages, revisions and the receipt remain.
            const removed=this.db.prepare("DELETE FROM person_profile_pending WHERE id=? AND person_id=? AND archived_revision IS NULL AND purpose='profile'")
              .run(captured.id,profile.personId);
            if(removed.changes!==1) throw new Error('人物待整理队列发生并发变更。');
          }
        }
      }
      if(input.profiles.some(profile=>(profileCapacity(profile).needsConsolidation||profileCapacity(profile).exceedsLimits||(profile.pending?.length??0)>0)
        &&!updated.has(profile.personId))) throw new Error('本批次遗漏了需要收敛或处理待整理条目的人物画像。');
      if (extract.selfProfile !== undefined) {
        if (input.selfProfile === undefined) throw new Error('自我档案产物缺少已捕获的输入快照。');
        this.selfProfile.commit(input.selfProfile, extract.selfProfile, input.messages, selfBudget, jobId);
      }
      // Check again after all writes; the transaction rolls everything back if the lease expired.
      this.active(jobId,leaseToken);
      const contextJob=this.db.prepare('SELECT * FROM auto_memory_context_jobs WHERE job_id=?').get(jobId);
      if(contextJob) {
        const state=this.contextState(job.conversationId);
        if(Number(state.revision)!==Number(contextJob.base_revision)||Number(state.cursor)!==Number(contextJob.start_cursor))
          throw new Error('续聊摘要输入版本冲突。');
        const deferred=this.deferredContextIds(job.conversationId);
        const gap=this.db.prepare('SELECT seq,message_id FROM conversation_context_messages WHERE conversation_id=? AND seq<=? ORDER BY seq')
          .all(job.conversationId,Number(contextJob.end_cursor)).find(row=>deferred.has(String(row.message_id)));
        const completed=gap?Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM conversation_context_messages WHERE conversation_id=? AND seq<?')
          .get(job.conversationId,Number(gap.seq))!.seq):Number(contextJob.end_cursor);
        this.db.prepare('UPDATE conversation_context_state SET cursor=?,completed_seq=?,revision=revision+1,summary=? WHERE conversation_id=?')
          .run(Number(contextJob.end_cursor),completed,extract.continuationSummary!,job.conversationId);
      }
      this.db.prepare("UPDATE auto_memory_jobs SET status='done',completed_at=?,lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE id=?").run(timestamp(),jobId);
      if(job.pipeline==='materials') {
        this.advanceMaterialCheckpoint(job.conversationId);
        return;
      }
      if(job.pipeline==='compression') return;
      const checkpoint=this.checkpoint(job.conversationId);
      const pending=this.db.prepare(`SELECT MIN(m.ingest_seq) AS seq FROM messages m WHERE m.conversation_id=? AND m.role='user'
        AND m.message_kind='chat' AND m.ingest_seq>? AND NOT EXISTS(SELECT 1 FROM auto_memory_job_messages jm
          JOIN auto_memory_jobs j ON j.id=jm.job_id WHERE jm.message_id=m.id AND j.status='done')`).get(job.conversationId,Number(checkpoint.initial_seq));
      const highestDone=Number(this.db.prepare("SELECT MAX(end_seq) AS seq FROM auto_memory_jobs WHERE conversation_id=? AND status='done'").get(job.conversationId)?.seq??checkpoint.initial_seq);
      const completedSeq=Number(this.db.prepare(`SELECT COALESCE(MAX(ingest_seq),?) AS seq FROM messages WHERE conversation_id=?
        AND ingest_seq<=? AND (? IS NULL OR ingest_seq<?)`)
        .get(Number(checkpoint.initial_seq),job.conversationId,highestDone,pending?.seq??null,pending?.seq??null)?.seq);
      this.db.prepare(`UPDATE auto_memory_checkpoints SET completed_seq=MAX(completed_seq,?),summary=COALESCE(?,summary),
        summary_job_id=CASE WHEN ? IS NULL THEN summary_job_id ELSE ? END WHERE conversation_id=?`)
        .run(completedSeq,extract.continuationSummary??null,extract.continuationSummary??null,jobId,job.conversationId);
      if(!contextJob&&extract.continuationSummary!==undefined) this.db.prepare(`UPDATE conversation_context_state SET summary=?
        WHERE conversation_id=? AND revision=0`).run(extract.continuationSummary,job.conversationId);
    });
  }
  fail(jobId:string,leaseToken:string,error:string): void {
    this.atomic(()=>{this.active(jobId,leaseToken);this.db.prepare("UPDATE auto_memory_jobs SET status='failed',error=?,lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE id=?").run(error,jobId);});
  }
  retry(jobId:string): void {
    this.atomic(()=>{
      if(this.db.prepare('SELECT 1 FROM auto_memory_legacy_isolations WHERE job_id=?').get(jobId)) throw new Error('已隔离的旧整理任务不能重试。');
      const frozen = this.db.prepare('SELECT input_json,error FROM auto_memory_jobs WHERE id=?').get(jobId);
      if(frozen?.input_json) assertLiveProfileProtocol(parse<AutoMemoryTaskInput>(frozen.input_json));
      if (frozen?.input_json && String(frozen.error).includes('[profile_conflict]')
        && parse<AutoMemoryTaskInput>(frozen.input_json).extractionProtocol === 2) {
        throw new Error('范围整理任务的版本冲突不能按旧输入重试；请先保留并搁置该任务，再创建新快照。');
      }
      if(this.db.prepare('SELECT job_id FROM auto_memory_job_retirements WHERE job_id=?').get(jobId)) throw new Error('已退役的整理任务不能重试。');
      if(this.db.prepare('SELECT job_id FROM auto_memory_job_deferrals WHERE job_id=?').get(jobId)) throw new Error('已搁置的整理任务不能重试。');
      if(this.db.prepare("UPDATE auto_memory_jobs SET status='queued',error=NULL WHERE id=? AND status='failed'").run(jobId).changes!==1) throw new Error('任务不处于失败状态。');
    });
  }
  defer(jobId:string,reason:string): void {
    if(typeof reason!=='string'||!reason.trim()||reason.length>4000) throw new Error('整理搁置原因无效。');
    this.atomic(()=>{
      if(this.db.prepare('SELECT job_id FROM auto_memory_job_retirements WHERE job_id=?').get(jobId)) throw new Error('已退役的整理任务不能搁置。');
      const row=this.db.prepare('SELECT * FROM auto_memory_jobs WHERE id=?').get(jobId);
      if(!row||row.status!=='failed'||row.lease_token!=null||row.lease_owner!=null||row.lease_until!=null) throw new Error('只能搁置无租约的失败整理任务。');
      const existing=this.db.prepare('SELECT reason FROM auto_memory_job_deferrals WHERE job_id=?').get(jobId);
      if(existing) {
        if(existing.reason!==reason) throw new Error('整理任务已搁置，不能改写原搁置原因。');
        return;
      }
      this.db.prepare('INSERT INTO auto_memory_job_deferrals(job_id,reason,created_at,input_hash,progress_hash) VALUES (?,?,?,?,?)')
        .run(jobId,reason,timestamp(),row.input_json==null?null:hash(String(row.input_json)),row.progress_json==null?null:hash(String(row.progress_json)));
    });
  }
  /** Retire only the legacy executor; the first rolling snapshot still owns all original messages. */
  retireLegacyCountJobs(conversationId:string,reason:string): string[] {
    if(typeof reason!=='string'||!reason.trim()||reason.length>4000) throw new Error('整理退役原因无效。');
    return this.atomic(()=>{
      if(!this.db.prepare('SELECT id FROM conversations WHERE id=?').get(conversationId)) throw new Error('会话不存在。');
      const rows=this.db.prepare(`SELECT j.* FROM auto_memory_jobs j WHERE j.conversation_id=? AND j.reason='count' AND j.status<>'done'
        AND NOT EXISTS(SELECT 1 FROM auto_memory_job_retirements r WHERE r.job_id=j.id) ORDER BY j.rowid`).all(conversationId);
      if(!rows.length) return [];
      if(rows.some(row=>!['queued','failed'].includes(String(row.status))||row.lease_token!=null||row.lease_owner!=null||row.lease_until!=null)
        ||this.db.prepare("SELECT 1 FROM auto_memory_jobs WHERE conversation_id=? AND status='running'").get(conversationId))
        throw new Error('旧 count 退役要求任务均为无租约的 queued/failed，且会话没有运行中的整理任务。');
      const state=this.db.prepare('SELECT cursor,revision FROM conversation_context_state WHERE conversation_id=?').get(conversationId);
      if((state&&(Number(state.cursor)!==0||Number(state.revision)!==0))
        ||this.db.prepare(`SELECT 1 FROM auto_memory_context_jobs cj JOIN auto_memory_jobs j ON j.id=cj.job_id
          WHERE j.conversation_id=?`).get(conversationId))
        throw new Error('旧 count 只能在首次 rolling 快照创建前退役。');
      const createdAt=timestamp();
      for(const row of rows) this.db.prepare(`INSERT INTO auto_memory_job_retirements(job_id,reason,created_at,input_hash,progress_hash)
        VALUES (?,?,?,?,?)`).run(String(row.id),reason,createdAt,row.input_json==null?null:hash(String(row.input_json)),
          row.progress_json==null?null:hash(String(row.progress_json)));
      return rows.map(row=>String(row.id));
    });
  }
  deferredRanges(conversationId:string): {startSeq:number;endSeq:number}[] {
    return this.db.prepare(`SELECT j.start_seq,j.end_seq FROM auto_memory_jobs j JOIN auto_memory_job_deferrals d ON d.job_id=j.id
      WHERE j.conversation_id=? AND j.pipeline<>'materials' AND NOT EXISTS(SELECT 1 FROM auto_memory_job_retirements r WHERE r.job_id=j.id)
      ORDER BY j.start_seq,j.rowid`).all(conversationId)
      .map(row=>({startSeq:Number(row.start_seq),endSeq:Number(row.end_seq)}));
  }
  renewLease(jobId:string,leaseToken:string,leaseMs:number):void {
    if(!Number.isSafeInteger(leaseMs)||leaseMs<1) throw new Error('整理租约时长无效。');
    this.atomic(()=>{this.active(jobId,leaseToken);this.db.prepare('UPDATE auto_memory_jobs SET lease_until=? WHERE id=?').run(Date.now()+leaseMs,jobId);});
  }
  saveProgress(jobId:string,leaseToken:string,progress:unknown):void {
    const serialized=JSON.stringify(progress);
    if(serialized===undefined) throw new Error('整理进度必须可序列化。');
    this.atomic(()=>{this.active(jobId,leaseToken);this.db.prepare('UPDATE auto_memory_jobs SET progress_json=? WHERE id=?').run(serialized,jobId);});
  }
  loadProgress(jobId:string,leaseToken:string):unknown {
    const row=this.active(jobId,leaseToken);return row.progress_json==null?undefined:parse<unknown>(row.progress_json);
  }
  clearProgress(jobId:string,leaseToken:string):void {
    this.atomic(()=>{this.active(jobId,leaseToken);this.db.prepare('UPDATE auto_memory_jobs SET progress_json=NULL,input_json=NULL WHERE id=?').run(jobId);});
  }
  pendingConversations(): string[] {
    return this.db.prepare(`SELECT c.id AS conversation_id FROM conversations c WHERE
      EXISTS(SELECT 1 FROM auto_memory_jobs j WHERE j.conversation_id=c.id AND j.status IN ('queued','running')
        AND NOT EXISTS(SELECT 1 FROM auto_memory_job_retirements r WHERE r.job_id=j.id)
        AND NOT EXISTS(SELECT 1 FROM auto_memory_legacy_isolations i WHERE i.job_id=j.id)
        AND NOT EXISTS(SELECT 1 FROM auto_memory_job_deferrals d WHERE d.job_id=j.id))
      OR EXISTS(SELECT 1 FROM auto_memory_material_state s WHERE s.conversation_id=c.id AND s.first_content_at IS NOT NULL)
      OR EXISTS(SELECT 1 FROM messages m WHERE m.conversation_id=c.id AND m.role='user' AND m.message_kind='chat'
        AND m.ingest_seq>COALESCE((SELECT observed_seq FROM auto_memory_material_state s WHERE s.conversation_id=c.id),0)
        AND NOT EXISTS(SELECT 1 FROM auto_memory_material_legacy_messages l WHERE l.message_id=m.id)
        AND NOT EXISTS(SELECT 1 FROM auto_memory_material_job_messages jm WHERE jm.message_id=m.id))
      OR EXISTS(SELECT 1 FROM person_profile_pending p JOIN messages m ON m.id=p.source_message_id
        WHERE m.conversation_id=c.id AND p.archived_revision IS NULL AND p.purpose='profile'
        AND NOT EXISTS(SELECT 1 FROM auto_memory_material_observed_pending o WHERE o.kind='person' AND o.pending_id=p.id))
      OR EXISTS(SELECT 1 FROM self_profile_pending p JOIN messages m ON m.id=p.source_message_id
        WHERE m.conversation_id=c.id AND p.archived_revision IS NULL
        AND NOT EXISTS(SELECT 1 FROM self_profile_reclassifications r WHERE r.pending_id=p.id)
        AND NOT EXISTS(SELECT 1 FROM auto_memory_material_observed_pending o WHERE o.kind='self' AND o.pending_id=p.id))`)
      .all().map(r=>String(r.conversation_id));
  }
  listJobs(limit=100): {id:string;conversationId:string;pipeline:AutoMemoryPipeline;status:string;reason:string;attempts:number;error:string|null;deferred?:true;deferredReason?:string;retired?:true;retiredReason?:string;isolated?:true;isolatedReason?:string}[] {
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000) throw new Error('任务查询数量无效。');
    return this.db.prepare(`SELECT j.id,j.conversation_id,j.pipeline,j.status,j.reason,j.attempts,j.error,d.reason AS deferred_reason,r.reason AS retired_reason,i.reason AS isolated_reason
      FROM auto_memory_jobs j LEFT JOIN auto_memory_job_deferrals d ON d.job_id=j.id
      LEFT JOIN auto_memory_job_retirements r ON r.job_id=j.id LEFT JOIN auto_memory_legacy_isolations i ON i.job_id=j.id ORDER BY j.rowid DESC LIMIT ?`).all(limit)
      .map(r=>({id:String(r.id),conversationId:String(r.conversation_id),pipeline:r.pipeline as AutoMemoryPipeline,
        status:String(r.status),reason:String(r.reason),attempts:Number(r.attempts),error:r.error==null?null:String(r.error),
        ...(r.deferred_reason==null?{}:{deferred:true as const,deferredReason:String(r.deferred_reason)}),
        ...(r.retired_reason==null?{}:{retired:true as const,retiredReason:String(r.retired_reason)}),
        ...(r.isolated_reason==null?{}:{isolated:true as const,isolatedReason:String(r.isolated_reason)})}));
  }
  status(conversationId:string,pipeline?:AutoMemoryPipeline,jobIds?:readonly string[]): {queued:number;running:number;failed:number;deferred:number;retired?:number;isolated?:number;completed:number;checkpoint:number;summary?:string} {
    const cp=this.checkpoint(conversationId);const result:ReturnType<AutoMemoryStore['status']>={queued:0,running:0,failed:0,deferred:0,completed:0,checkpoint:Number(cp.completed_seq),...(cp.summary==null?{}:{summary:String(cp.summary)})};
    const context=this.db.prepare(`SELECT s.* FROM conversation_context_state s WHERE s.conversation_id=?
      AND EXISTS(SELECT 1 FROM auto_memory_context_jobs cj JOIN auto_memory_jobs j ON j.id=cj.job_id WHERE j.conversation_id=s.conversation_id)`).get(conversationId);
    if(context&&pipeline!=='materials') {result.checkpoint=Number(context.completed_seq); if(context.summary!=null) result.summary=String(context.summary);}
    if(pipeline==='materials') {result.checkpoint=this.materialSchedule(conversationId).completedSeq;delete result.summary;}
    for(const r of this.db.prepare(`SELECT CASE WHEN i.job_id IS NOT NULL THEN 'isolated' WHEN r.job_id IS NOT NULL THEN 'retired' WHEN d.job_id IS NOT NULL THEN 'deferred' ELSE j.status END AS status,COUNT(*) AS count
      FROM auto_memory_jobs j LEFT JOIN auto_memory_job_deferrals d ON d.job_id=j.id
      LEFT JOIN auto_memory_job_retirements r ON r.job_id=j.id LEFT JOIN auto_memory_legacy_isolations i ON i.job_id=j.id
      WHERE j.conversation_id=? AND (? IS NULL OR j.pipeline=?)
      AND (? IS NULL OR j.id IN (SELECT value FROM json_each(?))) GROUP BY 1`)
      .all(conversationId,pipeline??null,pipeline??null,jobIds===undefined?null:JSON.stringify(jobIds),jobIds===undefined?null:JSON.stringify(jobIds))) {
      const key=r.status==='done'?'completed':r.status as 'queued'|'running'|'failed'|'deferred'|'retired'|'isolated';result[key]=Number(r.count);
    } return result;
  }
  contextAfterCheckpoint(conversationId:string,excludeMessageId?:string): AutoMemoryMessage[] {
    return this.conversationContext(conversationId,excludeMessageId).messages;
  }
  conversationContext(conversationId:string,beforeMessageId?:string): {
    summary?:string; checkpoint:number; summaryCursor:number; summaryVersion:number;
    messages:AutoMemoryMessage[]; deferredRanges?:{startSeq:number;endSeq:number}[];
  } {
    return this.atomic(()=>{
      const state=this.contextState(conversationId),boundary=this.contextBoundary(conversationId,beforeMessageId);
      // If a caller asks for an older boundary than the committed summary, the
      // complete raw prefix is the only valid projection for that boundary.
      const canUseSummary=boundary===undefined||Number(state.cursor)<boundary;
      const cursor=canUseSummary?Number(state.cursor):0;
      const deferred=this.deferredContextIds(conversationId);
      const rows=this.db.prepare(`SELECT message_id,seq FROM conversation_context_messages WHERE conversation_id=?
        AND (? IS NULL OR seq<?) ORDER BY seq`).all(conversationId,boundary??null,boundary??null)
        .filter(row=>Number(row.seq)>cursor||deferred.has(String(row.message_id)));
      const ranges=this.deferredRanges(conversationId);
      return {checkpoint:canUseSummary?Number(state.completed_seq):0,summaryCursor:cursor,summaryVersion:canUseSummary?Number(state.revision):0,
        ...(canUseSummary&&state.summary!=null?{summary:String(state.summary)}:{}),
        messages:this.messages(rows.map(row=>String(row.message_id))),...(ranges.length?{deferredRanges:ranges}:{})};
    });
  }
  private topic(row:Record<string,unknown>):TopicRecord {
    const scope = this.db.prepare('SELECT start_ordinal,end_ordinal FROM memory_topic_scopes WHERE topic_id=?').get(String(row.id));
    return {id:String(row.id),conversationId:String(row.conversation_id),jobId:String(row.job_id),summary:String(row.summary),version:Number(row.version),contentHash:String(row.content_hash),
      ...(scope ? { sourceRange: { startOrdinal: Number(scope.start_ordinal), endOrdinal: Number(scope.end_ordinal) } } : {}),
      messageIds:this.db.prepare('SELECT message_id FROM memory_topic_messages WHERE topic_id=?').all(String(row.id)).map(r=>String(r.message_id))};
  }
  /** A range is coarse provenance, not evidence that every message supports the Topic. */
  topicTouchesSources(topic: TopicRecord, messageIds: readonly string[]): boolean {
    if (!messageIds.length) return false;
    if (!topic.sourceRange) return topic.messageIds.some(id => messageIds.includes(id));
    return Boolean(this.db.prepare(`SELECT 1 FROM (SELECT * FROM auto_memory_context_job_messages UNION ALL SELECT * FROM auto_memory_material_job_messages) jm
      WHERE jm.job_id=? AND jm.ordinal BETWEEN ? AND ? AND jm.message_id IN (SELECT value FROM json_each(?)) LIMIT 1`)
      .get(topic.jobId, topic.sourceRange.startOrdinal, topic.sourceRange.endOrdinal, JSON.stringify(messageIds)));
  }
  searchTopics(conversationId: string, query: { text: string; limit?: number }):
    { status: 'ready'; topics: (TopicRecord & { score: number })[] } {
    const limit = query.limit ?? 5;
    if (typeof query.text !== 'string' || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Topic查询参数无效。');
    const words = [...new Set(memoryWords(query.text.slice(0, 8000)))].slice(0, 64);
    const match = words.map(word => `"${word.replaceAll('"', '""')}"`).join(' OR ');
    // Scope candidates before ranking and limiting; Topic facts retain only evidence from this room.
    const lexical = match ? this.db.prepare(`SELECT t.*,bm25(memory_topic_fts) AS lexical_score
      FROM memory_topic_fts JOIN memory_topics t ON t.id=memory_topic_fts.topic_id
      WHERE t.conversation_id=? AND memory_topic_fts MATCH ?
      ORDER BY lexical_score,t.id LIMIT ?`).all(conversationId,match,limit)
      .map(row => ({ ...this.topic(row), score: -Number(row.lexical_score) })) : [];
    const topics = lexical.map(topic => {
      if (topic.sourceRange) return { ...topic, facts: [] };
      const facts = this.db.prepare(`SELECT DISTINCT f.id,f.person_id,f.content,f.source_type FROM person_fragments f
        JOIN person_fragment_messages fm ON fm.fragment_id=f.id JOIN memory_topic_messages tm ON tm.message_id=fm.message_id
        JOIN memory_topics scoped ON scoped.id=tm.topic_id WHERE scoped.id=? AND scoped.conversation_id=?
        ORDER BY f.created_at DESC,f.id LIMIT 5`).all(topic.id,conversationId).map(row => ({
          personId: String(row.person_id), content: String(row.content), sourceType: row.source_type as ProfileFact['sourceType'],
          messageIds: this.db.prepare(`SELECT fm.message_id FROM person_fragment_messages fm
            JOIN memory_topic_messages tm ON tm.message_id=fm.message_id WHERE fm.fragment_id=? AND tm.topic_id=? ORDER BY fm.message_id`)
            .all(String(row.id),topic.id).map(message => String(message.message_id)),
        }));
      return { ...topic, facts };
    });
    return { status: 'ready', topics };
  }
}
