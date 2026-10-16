import type { DatabaseSync } from 'node:sqlite';
import { isMemoryOwner, validateHarnessPolicy, type HarnessPolicy } from './harness-policy.js';
import { MemoryError } from './memory-types.js';
import type { SelfProfileSnapshot } from './self-profile-store.js';

export interface SelfProfileTermMove {
  pendingId: string;
  expectedContent: string;
  key: string;
}

/** Explicit local maintenance only; never exposed as a model or chat tool. */
export function reclassifySelfProfileTerms(db: DatabaseSync, snapshot: SelfProfileSnapshot,
  moves: readonly SelfProfileTermMove[], policy: HarnessPolicy, expectedVersion: number): {
    revision: number; moved: number;
  } {
  const checkedPolicy = validateHarnessPolicy(policy);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !Array.isArray(moves)
    || !moves.length || moves.length > 50 || new Set(moves.map(move => move?.pendingId)).size !== moves.length) {
    throw new MemoryError('术语迁移计划无效。');
  }
  const pending = [];
  for (const move of moves) {
    if (!move || typeof move.pendingId !== 'string' || typeof move.expectedContent !== 'string'
      || typeof move.key !== 'string' || !move.key.trim() || [...move.key].length > 80 || /[\x00-\x1f]/.test(move.key)) {
      throw new MemoryError('术语迁移条目无效。');
    }
    const key = move.key.normalize('NFKC').trim().toLocaleLowerCase('zh');
    const source = db.prepare(`SELECT p.content,p.source_message_id,p.archived_revision,m.text,m.conversation_id,
      a.external_user_id,r.channel,r.account,r.room_type,r.external_chat_id
      FROM self_profile_pending p JOIN messages m ON m.id=p.source_message_id
      JOIN actors a ON a.id=m.actor_id JOIN conversations c ON c.id=m.conversation_id JOIN rooms r ON r.id=c.room_id
      WHERE p.id=? AND m.role='user' AND a.room_id=r.id`).get(move.pendingId);
    if (!source || source.content !== move.expectedContent || !String(source.text).includes(move.expectedContent)) {
      throw new MemoryError('术语迁移来源或预期原文不匹配。');
    }
    if (source.room_type !== 'group' || !isMemoryOwner(checkedPolicy, {
      route: { channel: String(source.channel), accountId: String(source.account), roomType: 'group', roomId: String(source.external_chat_id) },
      senderId: String(source.external_user_id),
    })) throw new MemoryError('只有来源群中已绑定维护者的原始约定可迁入该群规则。');
    const previous = db.prepare('SELECT conversation_id,rule_key FROM self_profile_reclassifications WHERE pending_id=?').get(move.pendingId);
    if (previous) {
      if (previous.conversation_id !== source.conversation_id || previous.rule_key !== key) throw new MemoryError('该条目的历史迁移去向不匹配。');
      continue;
    }
    if (source.archived_revision !== null || snapshot.sourceMessageIds.includes(String(source.source_message_id))) {
      throw new MemoryError('该术语已有归档内容，需先明确逐段修订，不能自动改写旧画像。');
    }
    pending.push({ pendingId: move.pendingId, key, content: move.expectedContent,
      conversationId: String(source.conversation_id), sourceMessageId: String(source.source_message_id) });
  }
  if (!pending.length) return { revision: snapshot.baseVersion, moved: 0 };
  if (snapshot.baseVersion !== expectedVersion) throw new MemoryError('自我画像版本冲突，请重新核对迁移计划。');
  const revision = snapshot.baseVersion + 1;
  const createdAt = new Date().toISOString();
  // Even an unchanged archived body gets a revision: its active pending projection changed.
  db.prepare('INSERT INTO self_profile_revisions VALUES (?,?,?,?)')
    .run(revision, snapshot.content, JSON.stringify(snapshot.sourceMessageIds), createdAt);
  for (const move of pending) {
    const old = db.prepare(`SELECT revision,content FROM room_rule_revisions
      WHERE conversation_id=? AND rule_key=? ORDER BY revision DESC LIMIT 1`).get(move.conversationId, move.key);
    if (old && old.content !== move.content) throw new MemoryError('目标群规则已有不同的现行版本，拒绝用历史术语覆盖。');
    const ruleRevision = Number(old?.revision ?? 1);
    if (!old) db.prepare('INSERT INTO room_rule_revisions VALUES (?,?,?,?,?,?)')
      .run(move.conversationId, move.key, ruleRevision, move.content, move.sourceMessageId, createdAt);
    const rules = db.prepare(`SELECT rule_key,content FROM room_rule_revisions v WHERE conversation_id=?
      AND revision=(SELECT max(revision) FROM room_rule_revisions n WHERE n.conversation_id=v.conversation_id AND n.rule_key=v.rule_key)`)
      .all(move.conversationId).map(row => ({ key: row.rule_key, content: row.content }));
    if (rules.length > 50 || Buffer.byteLength(JSON.stringify(rules), 'utf8') > 12000) throw new MemoryError('本群规则容量已满。');
    db.prepare('INSERT INTO self_profile_reclassifications VALUES (?,?,?,?,?,?,?,?)')
      .run(move.pendingId, move.sourceMessageId, move.conversationId, move.key, ruleRevision, snapshot.baseVersion, revision, createdAt);
  }
  return { revision, moved: pending.length };
}
