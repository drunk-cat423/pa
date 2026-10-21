import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AutoMemoryMessage } from './auto-memory-types.js';
import { MemoryError } from './memory-types.js';
import { assertAiProfileEvidence, inferAiProfileEvidence, type ProfileSubjectEvidence } from './profile-attribution.js';

export interface SelfProfileSnapshot {
  protocol?: 2;
  baseVersion: number;
  content: string;
  /** Preserved only for offline decoding of legacy frozen inputs. */
  sourceMessageIds?: string[];
  pending: { id: string; content: string; sourceMessageId: string }[];
}

export interface SelfProfileProposal {
  protocol?: 2;
  baseVersion: number;
  content: string;
  sourceMessageIds?: string[];
  pendingIds: string[];
  updates?: ProfileSubjectEvidence[];
}

const timestamp = () => new Date().toISOString();
function assertPendingSource(source: Pick<AutoMemoryMessage, 'id' | 'role' | 'text'>, content: string): void {
  if (!source.text.includes(content)) throw new Error('自我建议必须连续摘录原始真人消息。');
  assertAiProfileEvidence(inferAiProfileEvidence(source.id, content), source);
}
export const selfProfileBytes = (snapshot: SelfProfileSnapshot): number => Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
export const selfProfileBudget = (contextWindow: number): number => Math.min(20000, Math.floor(contextWindow * 0.15));

function resultingSnapshot(snapshot: SelfProfileSnapshot, proposal: SelfProfileProposal): SelfProfileSnapshot {
  const changed = proposal.content !== snapshot.content;
  return { protocol: 2, baseVersion: snapshot.baseVersion + (changed ? 1 : 0), content: proposal.content,
    pending: snapshot.pending.filter(item => !proposal.pendingIds.includes(item.id)) };
}

const stringIds = (value: unknown): value is string[] => Array.isArray(value)
  && value.every(id => typeof id === 'string' && id.length > 0)
  && new Set(value).size === value.length;

export function validateSelfProfileProposal(value: unknown, snapshot: SelfProfileSnapshot,
  batchMessages: readonly AutoMemoryMessage[], maxBytes = 20000): asserts value is SelfProfileProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('自我档案产物结构无效。');
  const proposal = value as Record<string, unknown>;
  const legacy = snapshot.protocol === undefined && Array.isArray(snapshot.sourceMessageIds);
  const keys = legacy ? ['baseVersion', 'content', 'sourceMessageIds', 'pendingIds'] : ['protocol', 'baseVersion', 'content', 'pendingIds', 'updates'];
  if (Object.keys(proposal).some(key => !keys.includes(key))
    || !Number.isSafeInteger(proposal.baseVersion) || proposal.baseVersion !== snapshot.baseVersion
    || typeof proposal.content !== 'string' || [...proposal.content].length > 4000
    || (proposal.content.length > 0 && !proposal.content.trim())
    || (legacy ? !stringIds(proposal.sourceMessageIds) : proposal.protocol !== 2 || !Array.isArray(proposal.updates))
    || !stringIds(proposal.pendingIds)) throw new Error('自我档案产物结构或输入版本无效。');
  if (proposal.pendingIds.some(id => !snapshot.pending.some(item => item.id === id))) {
    throw new Error('自我档案只能归档已捕获的待整理建议。');
  }
  if (legacy) {
    const sources = proposal.sourceMessageIds as string[];
    const allowed = new Set([...(snapshot.sourceMessageIds ?? []), ...batchMessages.filter(message => message.role === 'user').map(message => message.id),
      ...snapshot.pending.map(pending => pending.sourceMessageId)]);
    if ((proposal.content.length > 0 && !sources.length) || sources.some(id => !allowed.has(id))) throw new Error('自我档案必须引用原始真人来源。');
    if (proposal.pendingIds.some(id => !sources.includes(snapshot.pending.find(item => item.id === id)!.sourceMessageId))) {
      throw new Error('自我档案只能归档已捕获且保留来源的待整理建议。');
    }
  } else {
    const updates = proposal.updates as ProfileSubjectEvidence[];
    for (const evidence of updates) {
      const source = batchMessages.find(message => message.id === evidence?.messageId && message.role === 'user');
      if (!source) throw new Error('自我档案更新必须引用本批原始真人来源。');
      assertAiProfileEvidence(evidence, source);
    }
    if (proposal.content !== snapshot.content && !proposal.pendingIds.length && !updates.length) {
      throw new Error('自我档案正文修改必须有本批有效来源或已处理建议。');
    }
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20000
    || selfProfileBytes(resultingSnapshot(snapshot, value as SelfProfileProposal)) > maxBytes) {
    throw new Error('自我档案产物超过完整画像容量上限，请缩短正文。');
  }
}

/** Called inside the conversation store's migration transaction. */
export function migrateSelfProfile(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE self_profile_revisions (
      revision INTEGER PRIMARY KEY CHECK (revision >= 0), content TEXT NOT NULL,
      source_message_ids_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE self_profile_pending (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, source_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
      created_at TEXT NOT NULL, archived_revision INTEGER REFERENCES self_profile_revisions(revision), archived_at TEXT);
    CREATE INDEX active_self_profile_pending ON self_profile_pending(archived_revision);
  `);
  db.prepare('INSERT INTO self_profile_revisions VALUES (0,?,?,?)').run('', '[]', timestamp());
}

/** Called once inside schema 23's migration transaction; historical revisions remain untouched. */
export function migrateSelfProfileUpdates(db: DatabaseSync): void {
  db.exec(`CREATE TABLE self_profile_updates (
    id TEXT PRIMARY KEY, revision INTEGER NOT NULL REFERENCES self_profile_revisions(revision),
    job_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('proposal','legacy_snapshot')), content TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE self_profile_update_sources (
      id INTEGER PRIMARY KEY, update_id TEXT NOT NULL REFERENCES self_profile_updates(id),
      message_id TEXT NOT NULL REFERENCES messages(id), pending_id TEXT REFERENCES self_profile_pending(id), evidence_json TEXT);
    CREATE INDEX self_profile_update_message ON self_profile_update_sources(message_id);`);
  for (const row of db.prepare('SELECT * FROM self_profile_revisions ORDER BY revision').all()) {
    const sources = JSON.parse(String(row.source_message_ids_json)) as string[];
    if (!sources.length) continue;
    const id = randomUUID();
    db.prepare('INSERT INTO self_profile_updates VALUES (?,?,?,?,?,?)')
      .run(id, Number(row.revision), null, 'legacy_snapshot', String(row.content), String(row.created_at));
    for (const source of sources) db.prepare('INSERT INTO self_profile_update_sources(update_id,message_id) VALUES (?,?)').run(id, source);
  }
}

export class SelfProfileStore {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(operation: () => T) => T) {}

  snapshot(): SelfProfileSnapshot {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT * FROM self_profile_revisions ORDER BY revision DESC LIMIT 1').get()!;
      return { protocol: 2, baseVersion: Number(current.revision), content: String(current.content),
        pending: this.db.prepare(`SELECT id,content,source_message_id FROM self_profile_pending p WHERE archived_revision IS NULL
          AND NOT EXISTS (SELECT 1 FROM self_profile_reclassifications r WHERE r.pending_id=p.id) ORDER BY rowid`)
          .all().map(row => ({ id: String(row.id), content: String(row.content), sourceMessageId: String(row.source_message_id) })) };
    });
  }

  private humanSource(id: string): Pick<AutoMemoryMessage, 'id' | 'role' | 'text'> | undefined {
    const row = this.db.prepare("SELECT m.id,m.text FROM messages m JOIN actors a ON a.id=m.actor_id WHERE m.id=? AND m.role='user'").get(id);
    return row ? { id: String(row.id), role: 'user', text: String(row.text) } : undefined;
  }

  addPending(sourceMessageId: string, content: string, maxBytes = 20000): void {
    if (typeof sourceMessageId !== 'string' || !sourceMessageId || typeof content !== 'string'
      || !content.trim() || [...content].length > 500) throw new MemoryError('自我建议不能为空，且不能超过 500 个 Unicode 字符。');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20000) throw new MemoryError('自我画像容量上限无效。');
    this.transaction(() => {
      const source = this.humanSource(sourceMessageId);
      if (!source) throw new MemoryError('自我建议必须来自原始真人消息。');
      try { assertPendingSource(source, content); }
      catch (error) { throw new MemoryError(error instanceof Error ? error.message : '自我建议来源未明确指向本AI。'); }
      if (this.db.prepare('SELECT id FROM self_profile_pending WHERE source_message_id=? AND content=?').get(sourceMessageId,content)) return;
      const bytes = Number(this.db.prepare(`SELECT COALESCE(SUM(length(CAST(content AS BLOB))),0) AS bytes FROM self_profile_pending p
        WHERE archived_revision IS NULL AND NOT EXISTS (SELECT 1 FROM self_profile_reclassifications r WHERE r.pending_id=p.id)`).get()!.bytes);
      if (bytes + Buffer.byteLength(content, 'utf8') > 12000) throw new MemoryError('待整理自我建议已达到 12000 字节上限。');
      const id = randomUUID();
      const next = this.snapshot();
      next.pending.push({ id, content, sourceMessageId });
      if (next.pending.length > 100 || selfProfileBytes(next) > maxBytes) {
        throw new MemoryError('待整理画像容量已满，请等待整理或缩短建议。');
      }
      this.db.prepare('INSERT INTO self_profile_pending(id,content,source_message_id,created_at) VALUES (?,?,?,?)')
        .run(id, content, sourceMessageId, timestamp());
    });
  }

  /** The enclosing auto-memory commit transaction also owns all other memory writes. */
  commit(snapshot: SelfProfileSnapshot, proposal: SelfProfileProposal, batchMessages: readonly AutoMemoryMessage[], maxBytes = 20000, jobId?: string): void {
    this.transaction(() => {
      if (snapshot.protocol !== 2 || snapshot.sourceMessageIds !== undefined || proposal.protocol !== 2) {
        throw new Error('自我档案协议版本已失效，旧冻结输入不能提交现场更新。');
      }
      validateSelfProfileProposal(proposal, snapshot, batchMessages, maxBytes);
      const updates = proposal.updates!;
      const pendingSources = proposal.pendingIds.map(id => snapshot.pending.find(item => item.id === id)!);
      if ([...updates.map(update => update.messageId), ...pendingSources.map(item => item.sourceMessageId)]
        .some(id => this.db.prepare('SELECT 1 FROM self_profile_reclassifications WHERE source_message_id=?').get(id))) {
        throw new Error('自我画像输入版本已失效：该来源已迁入群规则，不能重新写入AI画像。');
      }
      const current = this.db.prepare('SELECT * FROM self_profile_revisions ORDER BY revision DESC LIMIT 1').get()!;
      if (Number(current.revision) !== snapshot.baseVersion) throw new Error('全局自我档案版本冲突，请重读后重试。');
      if (current.content !== snapshot.content) {
        throw new Error('自我档案输入快照无效。');
      }
      for (const pending of snapshot.pending) {
        const row = this.db.prepare(`SELECT content,source_message_id FROM self_profile_pending p WHERE id=? AND archived_revision IS NULL
          AND NOT EXISTS (SELECT 1 FROM self_profile_reclassifications r WHERE r.pending_id=p.id)`).get(pending.id);
        if (!row || row.content !== pending.content || row.source_message_id !== pending.sourceMessageId) throw new Error('自我建议输入快照无效或已归档。');
      }
      for (const evidence of updates) {
        const source = this.humanSource(evidence.messageId);
        if (!source || !batchMessages.some(message => message.id === source.id && message.role === source.role && message.text === source.text)) {
          throw new Error('自我档案必须引用原始真人来源。');
        }
        assertAiProfileEvidence(evidence, source);
      }
      for (const pending of pendingSources) {
        const source = this.humanSource(pending.sourceMessageId);
        if (!source) throw new Error('自我档案必须引用原始真人来源。');
        assertPendingSource(source, pending.content);
      }
      if (selfProfileBytes(resultingSnapshot(this.snapshot(), proposal)) > maxBytes) {
        throw new Error('自我档案输入版本已变化，待整理画像容量不足，请重读后重试。');
      }
      const changed = proposal.content !== current.content;
      const revision = snapshot.baseVersion + (changed ? 1 : 0);
      if (changed) this.db.prepare('INSERT INTO self_profile_revisions VALUES (?,?,?,?)')
        .run(revision, proposal.content, '[]', timestamp());
      if (changed || updates.length || pendingSources.length) {
        const updateId = randomUUID();
        this.db.prepare('INSERT INTO self_profile_updates VALUES (?,?,?,?,?,?)')
          .run(updateId, revision, jobId ?? null, 'proposal', proposal.content, timestamp());
        for (const evidence of updates) this.db.prepare(`INSERT INTO self_profile_update_sources(update_id,message_id,evidence_json) VALUES (?,?,?)`)
          .run(updateId, evidence.messageId, JSON.stringify(evidence));
        for (const pending of pendingSources) this.db.prepare(`INSERT INTO self_profile_update_sources(update_id,message_id,pending_id) VALUES (?,?,?)`)
          .run(updateId, pending.sourceMessageId, pending.id);
      }
      for (const id of proposal.pendingIds) this.db.prepare('UPDATE self_profile_pending SET archived_revision=?,archived_at=? WHERE id=? AND archived_revision IS NULL')
        .run(revision, timestamp(), id);
    });
  }
}
