import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { validateExtract } from '../dist/auto-memory.js';
import { emptyExtraction } from './fixtures/memory-output.mjs';
import { MemoryError } from '../dist/memory-types.js';
import { SelfProfileStore, migrateSelfProfile, migrateSelfProfileUpdates, selfProfileBudget, selfProfileBytes, validateSelfProfileProposal } from '../dist/self-profile-store.js';
import { downgradeSchema10 } from './fixtures/legacy-schema.mjs';
import { inferAiProfileEvidence } from '../dist/profile-attribution.js';

const sourceTexts = new Map();

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'pa-self-profile-'));
  const path = join(directory, 'store.sqlite');
  let store = new ConversationStore(path);
  const rooms = ['one', 'two'].map(id => store.ensureConversation(id, `/${id}.jsonl`, {
    channel: 'qq', accountId: 'test', roomType: 'group', roomId: id,
  }));
  let event = 0;
  return { directory, path, rooms, get store() { return store; },
    inbound(text, room = rooms[0], senderId = 'member') {
      if (!text.startsWith('你')) text = `你以后回复时参考：${text}`;
      const external = { eventId: String(++event), senderId, modelInputText: text };
      store.recordInbound(room.id, text, external);
      const existingMessageId = store.externalMessage(room.id, external.eventId).id;
      sourceTexts.set(existingMessageId, text);
      return { ...external, existingMessageId };
    },
    claim(room = rooms[0]) {
      store.autoMemory.reserveBatch(room.id, 'capacity');
      return store.autoMemory.claimNext(room.id, { owner: 'test', leaseMs: 60000 });
    },
    restart() { store.close(); store = new ConversationStore(path); },
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
function inspect(f, operation) {
  const db = new DatabaseSync(f.path);
  try { return operation(db); } finally { db.close(); }
}
function extract(f, job, selfProfile, extra = {}) {
  const input = f.store.autoMemory.taskInput(job);
  return { ...emptyExtraction(input, '继续对话'), ...(selfProfile === undefined ? {} : { selfProfile }), ...extra };
}
function proposal(snapshot, content, sourceMessageIds = [], pendingIds = snapshot.pending.map(p => p.id)) {
  return { protocol: 2, baseVersion: snapshot.baseVersion, content,
    updates: sourceMessageIds.map(id => inferAiProfileEvidence(id, sourceTexts.get(id) ?? '你以后回复简洁')),
    pendingIds };
}

test('all members can add immediate global pending suggestions, persisted and source-content-idempotent even after archival', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.store.autoMemory.selfProfile.snapshot(), { protocol: 2, baseVersion: 0, content: '', pending: [] });
    const first = f.inbound('叫你初号机');
    const second = f.inbound('回答简洁', f.rooms[1], 'another');
    f.store.autoMemory.selfProfile.addPending(first.existingMessageId, first.modelInputText);
    f.store.autoMemory.selfProfile.addPending(second.existingMessageId, second.modelInputText);
    f.store.autoMemory.selfProfile.addPending(first.existingMessageId, first.modelInputText);
    const captured = f.store.autoMemory.selfProfile.snapshot();
    assert.equal(captured.baseVersion, 0);
    assert.deepEqual(captured.pending.map(p => p.content), [first.modelInputText, second.modelInputText]);
    f.restart();
    assert.deepEqual(f.store.autoMemory.selfProfile.snapshot(), captured);
    const job = f.claim();
    const input = f.store.autoMemory.taskInput(job);
    f.store.autoMemory.commit(job.id, job.leaseToken, extract(f, job,
      proposal(input.selfProfile, '名称初号机，回答简洁', [])));
    f.store.autoMemory.selfProfile.addPending(first.existingMessageId, first.modelInputText);
    assert.equal(f.store.autoMemory.selfProfile.snapshot().pending.length, 0);
    assert.equal(inspect(f, db => db.prepare('SELECT COUNT(*) AS n FROM self_profile_pending').get().n), 2);
  } finally { f.close(); }
});

test('pending validates original human source, Unicode length and aggregate UTF8 bytes', () => {
  const f = fixture();
  try {
    const source = f.inbound('suggestion');
    assert.throws(() => f.store.autoMemory.selfProfile.addPending('missing', 'name'), MemoryError);
    for (const value of ['', '   ', '😀'.repeat(501)]) {
      assert.throws(() => f.store.autoMemory.selfProfile.addPending(source.existingMessageId, value), MemoryError);
    }
    const run = f.store.beginRun(f.rooms[0].id, source.modelInputText, 'p', 'm', [], source);
    const reply = f.store.completeRun(run.id, 'self-generated identity');
    assert.throws(() => f.store.autoMemory.selfProfile.addPending(reply.messageId, 'name'), /原始真人/);
    for (let i = 0; i < 8; i++) {
      const content = '你要' + '中'.repeat(498), message = f.inbound(content);
      f.store.autoMemory.selfProfile.addPending(message.existingMessageId, content);
    }
    const overflow = '你要' + '中'.repeat(6), ninth = f.inbound(overflow);
    assert.throws(() => f.store.autoMemory.selfProfile.addPending(ninth.existingMessageId, overflow), /12000/);
    assert.equal(f.store.autoMemory.selfProfile.snapshot().pending.length, 8);
  } finally { f.close(); }
});

test('model-window budget and pending admission count exact JSON UTF8 bytes including IDs and metadata', () => {
  assert.equal(selfProfileBudget(1000), 150);
  assert.equal(selfProfileBudget(1000000), 20000);
  assert.equal(selfProfileBudget(1001), 150);
  const f = fixture();
  try {
    const budget = 800;
    let accepted = 0;
    for (let i = 0; i < 10; i++) {
      const content = '你要' + '简短'.repeat(10), source = f.inbound(content);
      const snapshot = f.store.autoMemory.selfProfile.snapshot();
      const candidate = { ...snapshot, pending: [...snapshot.pending,
        { id: '0'.repeat(36), content, sourceMessageId: source.existingMessageId }] };
      assert.equal(selfProfileBytes(candidate), Buffer.byteLength(JSON.stringify(candidate), 'utf8'));
      if (selfProfileBytes(candidate) > budget) {
        assert.throws(() => f.store.autoMemory.selfProfile.addPending(source.existingMessageId, content, budget), /待整理画像容量已满/);
        assert.deepEqual(f.store.autoMemory.selfProfile.snapshot(), snapshot);
        break;
      }
      f.store.autoMemory.selfProfile.addPending(source.existingMessageId, content, budget);
      accepted++;
      assert.ok(selfProfileBytes(f.store.autoMemory.selfProfile.snapshot()) <= budget);
    }
    assert.ok(accepted > 0 && accepted < 10);
    f.restart();
    assert.equal(f.store.autoMemory.selfProfile.snapshot().pending.length, accepted);
  } finally { f.close(); }
});

test('tiny suggestions are bounded to 100 pending entries even below content and serialized byte limits', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 100; i++) {
      const source = f.inbound(`你要简洁${i}`);
      f.store.autoMemory.selfProfile.addPending(source.existingMessageId, '你要简洁');
    }
    assert.ok(selfProfileBytes(f.store.autoMemory.selfProfile.snapshot()) < 20000);
    const extra = f.inbound('你要简洁extra');
    assert.throws(() => f.store.autoMemory.selfProfile.addPending(extra.existingMessageId, '你要简洁'), /待整理画像容量已满/);
    assert.equal(f.store.autoMemory.selfProfile.snapshot().pending.length, 100);
  } finally { f.close(); }
});

test('proposal evidence stays in audit storage and does not consume the current snapshot budget', () => {
  const f = fixture();
  try {
    const sources = Array.from({ length: 30 }, (_, i) => f.inbound(`source ${i}`).existingMessageId);
    const job = f.claim();
    const input = f.store.autoMemory.taskInput(job);
    const result = proposal(input.selfProfile, 'brief', sources, []);
    assert.doesNotThrow(() => validateSelfProfileProposal(result, input.selfProfile, input.messages, 800));
    f.store.autoMemory.selfProfile.commit(input.selfProfile, result, input.messages, 800, job.id);
    const current = f.store.autoMemory.selfProfile.snapshot();
    assert.equal(current.baseVersion, 1);
    assert.equal(Object.hasOwn(current, 'sourceMessageIds'), false);
    assert.ok(selfProfileBytes(current) < 800);
    assert.equal(inspect(f, db => db.prepare('SELECT COUNT(*) AS n FROM self_profile_update_sources').get().n), sources.length);
    assert.equal(inspect(f, db => db.prepare('SELECT job_id FROM self_profile_updates').get().job_id), job.id);
  } finally { f.close(); }
});

test('concurrent pending that overflows a proposed snapshot triggers input-version retry without losing suggestions', () => {
  const f = fixture();
  try {
    const budget = 600;
    const first = f.inbound('first');
    f.store.autoMemory.selfProfile.addPending(first.existingMessageId, first.modelInputText, budget);
    const job = f.claim();
    const input = f.store.autoMemory.taskInput(job);
    const result = proposal(input.selfProfile, 'x'.repeat(400), [first.existingMessageId]);
    assert.doesNotThrow(() => validateSelfProfileProposal(result, input.selfProfile, input.messages, budget));
    const concurrent = f.inbound('你要' + 'y'.repeat(100), f.rooms[1]);
    f.store.autoMemory.selfProfile.addPending(concurrent.existingMessageId, '你要' + 'y'.repeat(100), budget);
    const current = f.store.autoMemory.selfProfile.snapshot();
    assert.ok(selfProfileBytes(current) <= budget);
    assert.throws(() => f.store.autoMemory.commit(job.id, job.leaseToken, validateExtract(extract(f, job, result, {
      topics: [{ summary: 'name', messageIds: [] }],
    }), input), budget), /输入版本/);
    assert.deepEqual(f.store.autoMemory.selfProfile.snapshot(), current);
    assert.equal(inspect(f, db => db.prepare('SELECT COUNT(*) AS n FROM memory_topics').get().n), 0);
    f.store.autoMemory.clearProgress(job.id, job.leaseToken);
    const refreshed = f.store.autoMemory.taskInput(job).selfProfile;
    f.store.autoMemory.commit(job.id, job.leaseToken, extract(f, job,
      proposal(refreshed, 'brief', [])), budget);
    const committed = f.store.autoMemory.selfProfile.snapshot();
    assert.ok(selfProfileBytes(committed) <= budget);
    assert.equal(committed.pending.length, 0);
  } finally { f.close(); }
});

test('commit archives only requested captured pending and preserves omitted and concurrently added suggestions', () => {
  const f = fixture();
  try {
    const first = f.inbound('name');
    const omitted = f.inbound('style');
    f.store.autoMemory.selfProfile.addPending(first.existingMessageId, first.modelInputText);
    f.store.autoMemory.selfProfile.addPending(omitted.existingMessageId, omitted.modelInputText);
    const job = f.claim();
    const snapshot = f.store.autoMemory.taskInput(job).selfProfile;
    const concurrent = f.inbound('later', f.rooms[1]);
    f.store.autoMemory.selfProfile.addPending(concurrent.existingMessageId, concurrent.modelInputText);
    const concurrentId = f.store.autoMemory.selfProfile.snapshot().pending[2].id;
    assert.throws(() => f.store.autoMemory.commit(job.id, job.leaseToken,
      extract(f, job, proposal(snapshot, 'name', [first.existingMessageId], [concurrentId]))), /已捕获/);
    f.store.autoMemory.commit(job.id, job.leaseToken,
      extract(f, job, proposal(snapshot, 'name', [first.existingMessageId], [snapshot.pending[0].id])));
    const result = f.store.autoMemory.selfProfile.snapshot();
    assert.equal(result.baseVersion, 1);
    assert.deepEqual(result.pending.map(p => p.sourceMessageId), [omitted.existingMessageId, concurrent.existingMessageId]);
  } finally { f.close(); }
});

test('self profile, pending archival, Topics, person profiles and job completion roll back as one transaction', () => {
  const f = fixture();
  try {
    const source = f.inbound('I prefer a concise agent');
    f.store.autoMemory.selfProfile.addPending(source.existingMessageId, source.modelInputText);
    const job = f.claim();
    const input = f.store.autoMemory.taskInput(job);
    const data = validateExtract(extract(f, job, proposal(input.selfProfile, 'concise', [source.existingMessageId]), {
      topics: [{ summary: 'style request', messageIds: [] }],
      profiles: [{ ...input.profiles[0], facts: [{ content: 'concise preference', sourceType: 'self', messageIds: [source.existingMessageId] }] }],
    }), input);
    const foreign = f.inbound('foreign', f.rooms[1]);
    assert.throws(() => f.store.autoMemory.commit(job.id, job.leaseToken,
      { ...data, selfProfile: proposal(input.selfProfile, 'invented', [foreign.existingMessageId], []) }), /原始真人/);
    inspect(f, db => db.exec(`CREATE TRIGGER reject_self_job_completion BEFORE UPDATE OF status ON auto_memory_jobs
      WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'forced final write failure'); END;`));
    assert.throws(() => f.store.autoMemory.commit(job.id, job.leaseToken, data), /forced final write/);
    assert.deepEqual(f.store.autoMemory.selfProfile.snapshot(), input.selfProfile);
    assert.equal(f.store.autoMemory.profile(input.profiles[0].personId).baseVersion, 0);
    assert.equal(f.store.autoMemory.status(f.rooms[0].id).completed, 0);
    assert.equal(inspect(f, db => db.prepare('SELECT COUNT(*) AS n FROM memory_topics').get().n), 0);
    assert.equal(inspect(f, db => db.prepare('SELECT COUNT(*) AS n FROM self_profile_updates').get().n), 0);
    assert.equal(inspect(f, db => db.prepare('SELECT COUNT(*) AS n FROM self_profile_update_sources').get().n), 0);
    inspect(f, db => db.exec('DROP TRIGGER reject_self_job_completion'));
    f.store.autoMemory.commit(job.id, job.leaseToken, data);
    assert.equal(f.store.autoMemory.selfProfile.snapshot().baseVersion, 1);
    assert.equal(f.store.autoMemory.selfProfile.snapshot().pending.length, 0);
  } finally { f.close(); }
});

test('cross-room snapshots use global CAS; refreshed snapshot may retain previous human evidence without extra revisions', () => {
  const f = fixture();
  try {
    const first = f.inbound('name');
    f.inbound('other discussion', f.rooms[1]);
    const one = f.claim();
    const two = f.claim(f.rooms[1]);
    const firstInput = f.store.autoMemory.taskInput(one);
    const secondInput = f.store.autoMemory.taskInput(two);
    f.store.autoMemory.commit(one.id, one.leaseToken,
      extract(f, one, proposal(firstInput.selfProfile, 'name', [first.existingMessageId], [])));
    assert.throws(() => f.store.autoMemory.commit(two.id, two.leaseToken,
      extract(f, two, proposal(secondInput.selfProfile, '', [], []))), /版本冲突/);
    f.store.autoMemory.clearProgress(two.id, two.leaseToken);
    const refreshed = f.store.autoMemory.taskInput(two).selfProfile;
    assert.equal(refreshed.baseVersion, 1);
    f.store.autoMemory.commit(two.id, two.leaseToken,
      extract(f, two, proposal(refreshed, refreshed.content, [], [])));
    assert.equal(f.store.autoMemory.selfProfile.snapshot().baseVersion, 1);
    assert.equal(inspect(f, db => db.prepare('SELECT COUNT(*) AS n FROM self_profile_revisions').get().n), 2);
  } finally { f.close(); }
});

test('proposal evidence cannot come from assistant-only output or arbitrary sources; pure validator enforces exact shape and bounds', () => {
  const f = fixture();
  try {
    const source = f.inbound('human');
    const run = f.store.beginRun(f.rooms[0].id, source.modelInputText, 'p', 'm', [], source);
    const reply = f.store.completeRun(run.id, 'invented identity');
    f.store.ackDelivery(reply.deliveryId, 'sent');
    const job = f.claim();
    const input = f.store.autoMemory.taskInput(job);
    const valid = proposal(input.selfProfile, 'agent', [source.existingMessageId], []);
    for (const invalid of [
      { ...valid, updates: [{ ...valid.updates[0], messageId: reply.messageId }] }, { ...valid, updates: [] },
      { ...valid, sourceMessageIds: [source.existingMessageId] },
      { ...valid, baseVersion: -1 }, { ...valid, content: 'x'.repeat(4001) },
      { ...valid, content: '  ' }, { ...valid, actorId: 'arbitrary' },
      { ...valid, updates: [{ ...valid.updates[0], factQuote: '你以后虚构资料' }] },
    ]) assert.throws(() => validateSelfProfileProposal(invalid, input.selfProfile, input.messages));
    assert.doesNotThrow(() => validateSelfProfileProposal(valid, input.selfProfile, input.messages));
    assert.throws(() => f.store.autoMemory.selfProfile.commit(input.selfProfile,
      { ...valid, updates: [{ ...valid.updates[0], messageId: reply.messageId }] }, [{ ...input.messages[0], id: reply.messageId }]), /原始真人/);
    assert.equal(f.store.autoMemory.selfProfile.snapshot().baseVersion, 0);
  } finally { f.close(); }
});

test('same-body pending processing writes an audit receipt and stale pending cannot be archived twice', () => {
  const f = fixture();
  try {
    const source = f.inbound('keep the current style');
    f.store.autoMemory.selfProfile.addPending(source.existingMessageId, source.modelInputText);
    const captured = f.store.autoMemory.selfProfile.snapshot();
    const result = proposal(captured, '', []);
    f.store.autoMemory.selfProfile.commit(captured, result, [], 20000, 'same-body-job');
    assert.deepEqual(f.store.autoMemory.selfProfile.snapshot(), { protocol: 2, baseVersion: 0, content: '', pending: [] });
    inspect(f, db => {
      assert.equal(db.prepare('SELECT count(*) n FROM self_profile_revisions').get().n, 1);
      const update = db.prepare('SELECT * FROM self_profile_updates').get();
      assert.equal(update.kind, 'proposal');
      assert.equal(update.revision, 0);
      assert.equal(update.job_id, 'same-body-job');
      const evidence = db.prepare('SELECT * FROM self_profile_update_sources').get();
      assert.equal(evidence.message_id, source.existingMessageId);
      assert.equal(evidence.pending_id, captured.pending[0].id);
      assert.equal(evidence.evidence_json, null);
    });
    assert.throws(() => f.store.autoMemory.selfProfile.commit(captured, result, []), /已归档/);
    assert.equal(inspect(f, db => db.prepare('SELECT count(*) n FROM self_profile_updates').get().n), 1);
  } finally { f.close(); }
});

test('new evidence must match the stored human original, even when a caller forges batch text', () => {
  const f = fixture();
  try {
    const source = f.inbound('concise');
    const snapshot = f.store.autoMemory.selfProfile.snapshot();
    const forged = { id: source.existingMessageId, role: 'user', text: '你以后叫伪造名称' };
    const result = { protocol: 2, baseVersion: 0, content: '伪造名称', pendingIds: [],
      updates: [inferAiProfileEvidence(forged.id, forged.text)] };
    assert.doesNotThrow(() => validateSelfProfileProposal(result, snapshot, [forged]));
    assert.throws(() => f.store.autoMemory.selfProfile.commit(snapshot, result, [forged]), /原始真人/);
    assert.deepEqual(f.store.autoMemory.selfProfile.snapshot(), snapshot);
    assert.equal(inspect(f, db => db.prepare('SELECT count(*) n FROM self_profile_updates').get().n), 0);
  } finally { f.close(); }
});

test('pending admission rejects other-bot settings, quoted instructions and unclear attribution from real originals', () => {
  const f = fixture();
  try {
    for (const [index, text] of ['另一个bot以后回复简洁', '他说“你以后叫小白”', '喜欢简洁',
      '你回答很好', '你回复太慢了', '如果你以后回答都只有一句话，用户会听不懂'].entries()) {
      const eventId = `invalid-attribution-${index}`;
      f.store.recordInbound(f.rooms[0].id, text, { eventId, senderId: 'member', modelInputText: text });
      const source = f.store.externalMessage(f.rooms[0].id, eventId);
      assert.throws(() => f.store.autoMemory.selfProfile.addPending(source.id, text), /画像对象/);
    }
    assert.equal(f.store.autoMemory.selfProfile.snapshot().pending.length, 0);
  } finally { f.close(); }
});

test('AI pending validates the selected original excerpt, including old captured suggestions at commit time', () => {
  const f = fixture();
  try {
    const text = '你以后回复简洁。阿乙说：“你以后叫小坏”';
    const source = f.inbound(text);
    assert.throws(() => f.store.autoMemory.selfProfile.addPending(source.existingMessageId, '你以后叫小坏'), /画像对象/);
    assert.throws(() => f.store.autoMemory.selfProfile.addPending(source.existingMessageId, '你以后叫不存在'), /连续摘录/);
    const otherBot = f.inbound('另一个Bot的设定：你以后叫小坏');
    assert.throws(() => f.store.autoMemory.selfProfile.addPending(otherBot.existingMessageId, '你以后叫小坏'), /画像对象/);
    f.store.autoMemory.selfProfile.addPending(source.existingMessageId, '你以后回复简洁');
    const quoted = f.inbound(text);
    inspect(f, db => db.prepare('INSERT INTO self_profile_pending(id,content,source_message_id,created_at) VALUES (?,?,?,?)')
      .run('legacy-quoted-pending', '你以后叫小坏', quoted.existingMessageId, new Date().toISOString()));
    const captured = f.store.autoMemory.selfProfile.snapshot();
    const result = proposal(captured, '小坏', [], ['legacy-quoted-pending']);
    assert.throws(() => f.store.autoMemory.selfProfile.commit(captured, result, []), /画像对象/);
    assert.deepEqual(f.store.autoMemory.selfProfile.snapshot(), captured);
    inspect(f, db => {
      assert.equal(db.prepare('SELECT archived_revision FROM self_profile_pending WHERE id=?').get('legacy-quoted-pending').archived_revision, null);
      assert.equal(db.prepare('SELECT count(*) n FROM self_profile_updates').get().n, 0);
    });
  } finally { f.close(); }
});

test('migration preserves more than 500 legacy sources without projecting them or accepting legacy commits', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE messages(id TEXT PRIMARY KEY,actor_id TEXT,role TEXT,text TEXT);
      CREATE TABLE actors(id TEXT PRIMARY KEY);
      CREATE TABLE self_profile_revisions(revision INTEGER PRIMARY KEY,content TEXT,source_message_ids_json TEXT,created_at TEXT);
      CREATE TABLE self_profile_pending(id TEXT PRIMARY KEY,content TEXT,source_message_id TEXT,archived_revision INTEGER);
      CREATE TABLE self_profile_reclassifications(pending_id TEXT,source_message_id TEXT);`);
    const ids = Array.from({ length: 601 }, (_, i) => `legacy-source-${i}`);
    const insert = db.prepare('INSERT INTO messages VALUES (?,NULL,?,?)');
    for (const id of ids) insert.run(id, 'user', '旧原文');
    db.prepare('INSERT INTO self_profile_revisions VALUES (1,?,?,?)').run('旧画像', JSON.stringify(ids), '2026-10-01');
    const historical = db.prepare('SELECT * FROM self_profile_revisions').all();
    migrateSelfProfileUpdates(db);
    assert.deepEqual(db.prepare('SELECT * FROM self_profile_revisions').all(), historical);
    assert.equal(db.prepare('SELECT count(*) n FROM self_profile_update_sources').get().n, 601);
    assert.equal(db.prepare('SELECT kind FROM self_profile_updates').get().kind, 'legacy_snapshot');
    const store = new SelfProfileStore(db, fn => fn());
    assert.deepEqual(store.snapshot(), { protocol: 2, baseVersion: 1, content: '旧画像', pending: [] });
    const old = { baseVersion: 1, content: '旧画像', sourceMessageIds: ids, pending: [] };
    const oldProposal = { baseVersion: 1, content: '旧画像', sourceMessageIds: ids, pendingIds: [] };
    assert.doesNotThrow(() => validateSelfProfileProposal(oldProposal, old, []));
    assert.throws(() => store.commit(old, oldProposal, []), /旧冻结输入/);
    const messages = ids.map(id => ({ id, role: 'user', text: '你以后回答简洁' }));
    const result = { protocol: 2, baseVersion: 1, content: '新画像', pendingIds: [],
      updates: messages.map(message => inferAiProfileEvidence(message.id, message.text)) };
    assert.doesNotThrow(() => validateSelfProfileProposal(result, store.snapshot(), messages, 200));
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('live commits retain more than 500 update sources in audit while the active snapshot stays small', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE actors(id TEXT PRIMARY KEY);
      CREATE TABLE messages(id TEXT PRIMARY KEY,actor_id TEXT REFERENCES actors(id),role TEXT,text TEXT);
      CREATE TABLE self_profile_reclassifications(pending_id TEXT,source_message_id TEXT);
      INSERT INTO actors VALUES ('human');`);
    migrateSelfProfile(db);
    migrateSelfProfileUpdates(db);
    const messages = Array.from({ length: 601 }, (_, i) => ({ id: `source-${i}`, role: 'user', text: `你以后回答简洁，建议${i}` }));
    for (const message of messages) db.prepare('INSERT INTO messages VALUES (?,?,?,?)').run(message.id, 'human', message.role, message.text);
    let depth = 0;
    const transaction = fn => {
      if (depth) return fn();
      db.exec('BEGIN IMMEDIATE'); depth++;
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      finally { depth--; }
    };
    const store = new SelfProfileStore(db, transaction);
    const result = { protocol: 2, baseVersion: 0, content: '简洁回答', pendingIds: [],
      updates: messages.map(message => inferAiProfileEvidence(message.id, message.text)) };
    store.commit(store.snapshot(), result, messages, 200);
    assert.deepEqual(store.snapshot(), { protocol: 2, baseVersion: 1, content: '简洁回答', pending: [] });
    assert.ok(selfProfileBytes(store.snapshot()) < 200);
    assert.equal(db.prepare('SELECT count(*) n FROM self_profile_update_sources').get().n, 601);
    assert.equal(db.prepare('SELECT source_message_ids_json FROM self_profile_revisions WHERE revision=1').get().source_message_ids_json, '[]');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('old persisted task inputs cannot commit an uncaptured profile', () => {
  const f = fixture();
  try {
    f.inbound('legacy batch');
    const job = f.claim();
    const input = f.store.autoMemory.taskInput(job);
    delete input.selfProfile;
    inspect(f, db => db.prepare('UPDATE auto_memory_jobs SET input_json=? WHERE id=?').run(JSON.stringify(input), job.id));
    f.restart();
    assert.equal(f.store.autoMemory.taskInput(job).selfProfile, undefined);
    assert.throws(() => f.store.autoMemory.commit(job.id, job.leaseToken,
      extract(f, job, { baseVersion: 0, content: '', sourceMessageIds: [], pendingIds: [] })), /输入快照/);
    assert.equal(f.store.autoMemory.status(f.rooms[0].id).completed, 0);
  } finally { f.close(); }
});

test('v6 migration backs up original data and preserves frozen job input while isolating its old lease', () => {
  const f = fixture();
  try {
    const source = f.inbound('original chat');
    f.store.rememberMemory(f.rooms[0].id, { content: 'retained', sourceMessageId: source.existingMessageId });
    const job = f.claim();
    const oldInput = f.store.autoMemory.taskInput(job);
    delete oldInput.selfProfile;
    f.store.close();
    const tables = ['messages', 'memories', 'memory_revisions', 'memory_events', 'persons', 'actor_person_bindings', 'auto_memory_jobs', 'auto_memory_job_messages'];
    const before = inspect(f, db => {
      downgradeSchema10(db);
      db.exec(`PRAGMA foreign_keys=OFF;
        DROP TRIGGER history_message_insert; DROP TRIGGER history_message_update; DROP TRIGGER history_message_delete;
        DROP TABLE message_history_fts; DROP TABLE person_profile_pending; DROP TABLE profile_tool_receipts; DROP TABLE run_progress;
        DROP TABLE self_profile_pending; DROP TABLE self_profile_revisions;
        DROP TABLE delivery_parts; DROP INDEX delivery_conversation_identity;
        UPDATE memories SET content=NULL,status='deleted'; UPDATE memory_revisions SET content=NULL,status='deleted'; PRAGMA user_version=6;`);
      db.prepare('UPDATE auto_memory_jobs SET input_json=? WHERE id=?').run(JSON.stringify(oldInput), job.id);
      return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid,* FROM ${table}`).all().map(r => ({ ...r }))]));
    });
    f.restart();
    inspect(f, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version,23);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      for (const table of tables) assert.deepEqual(db.prepare(`SELECT rowid,* FROM ${table}`).all().map(({image_failure: _failure,...r}) => ({ ...r })), before[table]);
    });
    const backups = readdirSync(f.directory).filter(name => name.includes('.v6.') && name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(f.directory, backups[0]));
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 6);
      assert.equal(backup.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='self_profile_revisions'").get().n, 0);
      for (const table of tables) assert.deepEqual(backup.prepare(`SELECT rowid,* FROM ${table}`).all().map(r => ({ ...r })), before[table]);
    } finally { backup.close(); }
    assert.equal(f.store.externalMessage(f.rooms[0].id, source.eventId).id, source.existingMessageId);
    const frozen = inspect(f, db => db.prepare('SELECT input_json FROM auto_memory_jobs WHERE id=?').get(job.id));
    assert.equal(frozen.input_json, JSON.stringify(oldInput));
    assert.equal(JSON.parse(frozen.input_json).selfProfile, undefined);
    assert.throws(() => f.store.autoMemory.taskInput(job), /租约已失效/);
    assert.throws(() => f.store.autoMemory.retry(job.id), /隔离/);
    assert.equal(f.store.autoMemory.status(f.rooms[0].id).isolated, 1);
    assert.equal(f.store.autoMemory.listJobs().find(item => item.id === job.id).isolated, true);
  } finally { f.close(); }
});
