import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { AutoMemoryMessage } from './auto-memory-types.js';
import { MemoryError } from './memory-types.js';

export interface SelfProfileSnapshot {
  baseVersion: number;
  content: string;
  sourceMessageIds: string[];
  pending: { id: string; content: string; sourceMessageId: string }[];
}

export interface SelfProfileProposal {
  baseVersion: number;
  content: string;
  sourceMessageIds: string[];
  pendingIds: string[];
}

const timestamp = () => new Date().toISOString();
export const selfProfileBytes = (snapshot: SelfProfileSnapshot): number => Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
export const selfProfileBudget = (contextWindow: number): number => Math.min(20000, Math.floor(contextWindow * 0.15));

function resultingSnapshot(snapshot: SelfProfileSnapshot, proposal: SelfProfileProposal): SelfProfileSnapshot {
  const sources = [...proposal.sourceMessageIds].sort();
  const changed = proposal.content !== snapshot.content
    || JSON.stringify(sources) !== JSON.stringify([...snapshot.sourceMessageIds].sort());
  return { baseVersion: snapshot.baseVersion + (changed ? 1 : 0), content: proposal.content,
    sourceMessageIds: sources, pending: snapshot.pending.filter(item => !proposal.pendingIds.includes(item.id)) };
}

const stringIds = (value: unknown): value is string[] => Array.isArray(value)
  && value.every(id => typeof id === 'string' && id.length > 0)
  && new Set(value).size === value.length;

export function validateSelfProfileProposal(value: unknown, snapshot: SelfProfileSnapshot,
  batchMessages: readonly AutoMemoryMessage[], maxBytes = 20000): asserts value is SelfProfileProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('自我档案产物结构无效。');
  const proposal = value as Record<string, unknown>;
  if (Object.keys(proposal).some(key => !['baseVersion', 'content', 'sourceMessageIds', 'pendingIds'].includes(key))
    || !Number.isSafeInteger(proposal.baseVersion) || proposal.baseVersion !== snapshot.baseVersion
    || typeof proposal.content !== 'string' || [...proposal.content].length > 4000
    || (proposal.content.length > 0 && !proposal.content.trim())
    || !stringIds(proposal.sourceMessageIds) || proposal.sourceMessageIds.length > 500
    || !stringIds(proposal.pendingIds)) throw new Error('自我档案产物结构或输入版本无效。');
  const allowedSources = new Set([...snapshot.sourceMessageIds,
    ...batchMessages.filter(message => message.role === 'user').map(message => message.id),
    ...snapshot.pending.map(pending => pending.sourceMessageId)]);
  if ((proposal.content.length > 0 && proposal.sourceMessageIds.length === 0)
    || proposal.sourceMessageIds.some(id => !allowedSources.has(id))) throw new Error('自我档案必须引用原始真人来源。');
  const sourceMessageIds = proposal.sourceMessageIds;
  if (proposal.pendingIds.some(id => {
    const pending = snapshot.pending.find(item => item.id === id);
    return !pending || !sourceMessageIds.includes(pending.sourceMessageId);
  })) throw new Error('自我档案只能归档已捕获且保留来源的待整理建议。');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20000
    || selfProfileBytes(resultingSnapshot(snapshot, value as SelfProfileProposal)) > maxBytes) {
    throw new Error('自我档案产物超过完整画像容量上限，请缩短正文或来源列表。');
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

export class SelfProfileStore {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(operation: () => T) => T) {}

  snapshot(): SelfProfileSnapshot {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT * FROM self_profile_revisions ORDER BY revision DESC LIMIT 1').get()!;
      return { baseVersion: Number(current.revision), content: String(current.content),
        sourceMessageIds: JSON.parse(String(current.source_message_ids_json)) as string[],
        pending: this.db.prepare('SELECT id,content,source_message_id FROM self_profile_pending WHERE archived_revision IS NULL ORDER BY rowid')
          .all().map(row => ({ id: String(row.id), content: String(row.content), sourceMessageId: String(row.source_message_id) })) };
    });
  }

  private humanSource(id: string): boolean {
    return this.db.prepare("SELECT m.id FROM messages m JOIN actors a ON a.id=m.actor_id WHERE m.id=? AND m.role='user'").get(id) !== undefined;
  }

  addPending(sourceMessageId: string, content: string, maxBytes = 20000): void {
    if (typeof sourceMessageId !== 'string' || !sourceMessageId || typeof content !== 'string'
      || !content.trim() || [...content].length > 500) throw new MemoryError('自我建议不能为空，且不能超过 500 个 Unicode 字符。');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20000) throw new MemoryError('自我画像容量上限无效。');
    this.transaction(() => {
      if (!this.humanSource(sourceMessageId)) throw new MemoryError('自我建议必须来自原始真人消息。');
      if (this.db.prepare('SELECT id FROM self_profile_pending WHERE source_message_id=? AND content=?').get(sourceMessageId,content)) return;
      const bytes = Number(this.db.prepare('SELECT COALESCE(SUM(length(CAST(content AS BLOB))),0) AS bytes FROM self_profile_pending WHERE archived_revision IS NULL').get()!.bytes);
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
  commit(snapshot: SelfProfileSnapshot, proposal: SelfProfileProposal, batchMessages: readonly AutoMemoryMessage[], maxBytes = 20000): void {
    this.transaction(() => {
      validateSelfProfileProposal(proposal, snapshot, batchMessages, maxBytes);
      const current = this.db.prepare('SELECT * FROM self_profile_revisions ORDER BY revision DESC LIMIT 1').get()!;
      if (Number(current.revision) !== snapshot.baseVersion) throw new Error('全局自我档案版本冲突，请重读后重试。');
      const currentSources = JSON.parse(String(current.source_message_ids_json)) as string[];
      if (current.content !== snapshot.content || JSON.stringify(currentSources) !== JSON.stringify(snapshot.sourceMessageIds)) {
        throw new Error('自我档案输入快照无效。');
      }
      for (const pending of snapshot.pending) {
        const row = this.db.prepare('SELECT content,source_message_id FROM self_profile_pending WHERE id=?').get(pending.id);
        if (!row || row.content !== pending.content || row.source_message_id !== pending.sourceMessageId) throw new Error('自我建议输入快照无效。');
      }
      if (proposal.sourceMessageIds.some(id => !this.humanSource(id))) throw new Error('自我档案必须引用原始真人来源。');
      if (selfProfileBytes(resultingSnapshot(this.snapshot(), proposal)) > maxBytes) {
        throw new Error('自我档案输入版本已变化，待整理画像容量不足，请重读后重试。');
      }
      const sources = [...proposal.sourceMessageIds].sort();
      const changed = proposal.content !== current.content || JSON.stringify(sources) !== JSON.stringify([...currentSources].sort());
      const revision = snapshot.baseVersion + (changed ? 1 : 0);
      if (changed) this.db.prepare('INSERT INTO self_profile_revisions VALUES (?,?,?,?)')
        .run(revision, proposal.content, JSON.stringify(sources), timestamp());
      for (const id of proposal.pendingIds) this.db.prepare('UPDATE self_profile_pending SET archived_revision=?,archived_at=? WHERE id=? AND archived_revision IS NULL')
        .run(revision, timestamp(), id);
    });
  }
}
