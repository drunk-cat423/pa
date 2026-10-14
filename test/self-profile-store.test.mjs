import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { MemoryError } from '../dist/memory-types.js';
import { selfProfileBudget, selfProfileBytes, validateSelfProfileProposal } from '../dist/self-profile-store.js';

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
      const external = { eventId: String(++event), senderId, modelInputText: text };
      store.recordInbound(room.id, text, external);
      return { ...external, existingMessageId: store.externalMessage(room.id, external.eventId).id };
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
  return { ignoredMessageIds: input.messages.filter(m => m.role === 'user').map(m => m.id),
    topics: [], fragments: [], profiles: [], ...(selfProfile === undefined ? {} : { selfProfile }), ...extra };
}
function proposal(snapshot, content, sourceMessageIds, pendingIds = snapshot.pending.map(p => p.id)) {
  return { baseVersion: snapshot.baseVersion, content, sourceMessageIds, pendingIds };
}

test('all members can add immediate global pending suggestions, persisted and source-idempotent even after archival', () => {
  const f = fixture();
  try {
    assert.deepEqual(f.store.autoMemory.selfProfile.snapshot(), { baseVersion: 0, content: '', sourceMessageIds: [], pending: [] });
    const first = f.inbound('叫你初号机');
    const second = f.inbound('回答简洁', f.rooms[1], 'another');
    f.store.autoMemory.selfProfile.addPending(first.existingMessageId, '名称：初号机');
    f.store.autoMemory.selfProfile.addPending(second.existingMessageId, '回答简洁');
    f.store.autoMemory.selfProfile.addPending(first.existingMessageId, '重复内容不得改写');
    const captured = f.store.autoMemory.selfProfile.snapshot();
    assert.equal(captured.baseVersion, 0);
    assert.deepEqual(captured.pending.map(p => p.content), ['名称：初号机', '回答简洁']);
    f.restart();
    assert.deepEqual(f.store.autoMemory.selfProfile.snapshot(), captured);
    const job = f.claim();
    const input = f.store.autoMemory.taskInput(job);
    f.store.autoMemory.commit(job.id, job.leaseToken, extract(f, job,
      proposal(input.selfProfile, '名称初号机，回答简洁', [first.existingMessageId, second.existingMessageId])));
    f.store.autoMemory.selfProfile.addPending(first.existingMessageId, '归档后仍幂等');
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
    const run = f.store.beginRun(f.rooms[0].id, 'suggestion', 'p', 'm', [], source);
    const reply = f.store.completeRun(run.id, 'self-generated identity');
    assert.throws(() => f.store.autoMemory.selfProfile.addPending(reply.messageId, 'name'), /原始真人/);
    for (let i = 0; i < 8; i++) {
      const message = f.inbound(`suggestion ${i}`);
      f.store.autoMemory.selfProfile.addPending(message.existingMessageId, '中'.repeat(500));
    }
    const ninth = f.inbound('overflow');
    assert.throws(() => f.store.autoMemory.selfProfile.addPending(ninth.existingMessageId, '中'), /12000/);
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
      const source = f.inbound(`suggestion ${i}`);
      const snapshot = f.store.autoMemory.selfProfile.snapshot();
      const content = '简短'.repeat(10);
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
      const source = f.inbound(String(i));
      f.store.autoMemory.selfProfile.addPending(source.existingMessageId, 'x');
    }
    assert.ok(selfProfileBytes(f.store.autoMemory.selfProfile.snapshot()) < 20000);
    const extra = f.inbound('extra');
    assert.throws(() => f.store.autoMemory.selfProfile.addPending(extra.existingMessageId, 'x'), /待整理画像容量已满/);
    assert.equal(f.store.autoMemory.selfProfile.snapshot().pending.length, 100);
  } finally { f.close(); }
});

test('proposal source metadata can exceed the full budget and rolls back other memory writes', () => {
  const f = fixture();
  try {
    const sources = Array.from({ length: 30 }, (_, i) => f.inbound(`source ${i}`).existingMessageId);
    const job = f.claim();
    const input = f.store.autoMemory.taskInput(job);
    const result = proposal(input.selfProfile, 'brief', sources, []);
    assert.throws(() => validateSelfProfileProposal(result, input.selfProfile, input.messages, 800), /容量/);
    assert.throws(() => f.store.autoMemory.commit(job.id, job.leaseToken, extract(f, job, result, {
      topics: [{ summary: 'source discussion', messageIds: sources }],
    }), 800), /容量/);
    assert.equal(f.store.autoMemory.selfProfile.snapshot().baseVersion, 0);
    assert.equal(inspect(f, db => db.prepare('SELECT COUNT(*) AS n FROM memory_topics').get().n), 0);
    assert.equal(f.store.autoMemory.status(f.rooms[0].id).completed, 0);
  } finally { f.close(); }
});

test('concurrent pending that overflows a proposed snapshot triggers input-version retry without losing suggestions', () => {
  const f = fixture();
  try {
    const budget = 600;
    const first = f.inbound('first');
    f.store.autoMemory.selfProfile.addPending(first.existingMessageId, 'name', budget);
    const job = f.claim();
    const input = f.store.autoMemory.taskInput(job);
    const result = proposal(input.selfProfile, 'x'.repeat(400), [first.existingMessageId]);
    assert.doesNotThrow(() => validateSelfProfileProposal(result, input.selfProfile, input.messages, budget));
    const concurrent = f.inbound('later', f.rooms[1]);
    f.store.autoMemory.selfProfile.addPending(concurrent.existingMessageId, 'y'.repeat(100), budget);
    const current = f.store.autoMemory.selfProfile.snapshot();
    assert.ok(selfProfileBytes(current) <= budget);
    assert.throws(() => f.store.autoMemory.commit(job.id, job.leaseToken, extract(f, job, result, {
      topics: [{ summary: 'name', messageIds: [first.existingMessageId] }],
    }), budget), /输入版本/);
    assert.deepEqual(f.store.autoMemory.selfProfile.snapshot(), current);
    assert.equal(inspect(f, db => db.prepare('SELECT COUNT(*) AS n FROM memory_topics').get().n), 0);
    f.store.autoMemory.clearProgress(job.id, job.leaseToken);
    const refreshed = f.store.autoMemory.taskInput(job).selfProfile;
    f.store.autoMemory.commit(job.id, job.leaseToken, extract(f, job,
      proposal(refreshed, 'brief', [first.existingMessageId, concurrent.existingMessageId])), budget);
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
    f.store.autoMemory.selfProfile.addPending(first.existingMessageId, 'name');
    f.store.autoMemory.selfProfile.addPending(omitted.existingMessageId, 'style');
    const job = f.claim();
    const snapshot = f.store.autoMemory.taskInput(job).selfProfile;
    const concurrent = f.inbound('later', f.rooms[1]);
    f.store.autoMemory.selfProfile.addPending(concurrent.existingMessageId, 'later');
    const invalid = proposal(snapshot, 'name', [first.existingMessageId], [snapshot.pending[1].id]);
    assert.throws(() => f.store.autoMemory.commit(job.id, job.leaseToken, extract(f, job, invalid)), /保留来源/);
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
    f.store.autoMemory.selfProfile.addPending(source.existingMessageId, 'concise');
    const job = f.claim();
    const input = f.store.autoMemory.taskInput(job);
    const data = extract(f, job, proposal(input.selfProfile, 'concise', [source.existingMessageId]), {
      ignoredMessageIds: [], topics: [{ summary: 'style request', messageIds: [source.existingMessageId] }],
      profiles: [{ ...input.profiles[0], facts: [{ content: 'concise preference', sourceType: 'self', messageIds: [source.existingMessageId] }] }],
    });
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
      extract(f, two, proposal(refreshed, refreshed.content, refreshed.sourceMessageIds, [])));
    assert.equal(f.store.autoMemory.selfProfile.snapshot().baseVersion, 1);
    assert.equal(inspect(f, db => db.prepare('SELECT COUNT(*) AS n FROM self_profile_revisions').get().n), 2);
  } finally { f.close(); }
});

test('proposal evidence cannot come from assistant-only output or arbitrary sources; pure validator enforces exact shape and bounds', () => {
  const f = fixture();
  try {
    const source = f.inbound('human');
    const run = f.store.beginRun(f.rooms[0].id, 'human', 'p', 'm', [], source);
    const reply = f.store.completeRun(run.id, 'invented identity');
    f.store.ackDelivery(reply.deliveryId, 'sent');
    const job = f.claim();
    const input = f.store.autoMemory.taskInput(job);
    const valid = proposal(input.selfProfile, 'agent', [source.existingMessageId], []);
    for (const invalid of [
      { ...valid, sourceMessageIds: [reply.messageId] }, { ...valid, sourceMessageIds: [] },
      { ...valid, sourceMessageIds: [source.existingMessageId, source.existingMessageId] },
      { ...valid, baseVersion: -1 }, { ...valid, content: 'x'.repeat(4001) },
      { ...valid, content: '  ' }, { ...valid, actorId: 'arbitrary' },
      { ...valid, sourceMessageIds: Array.from({ length: 501 }, (_, i) => String(i)) },
    ]) assert.throws(() => validateSelfProfileProposal(invalid, input.selfProfile, input.messages));
    assert.doesNotThrow(() => validateSelfProfileProposal(valid, input.selfProfile, input.messages));
    assert.throws(() => f.store.autoMemory.selfProfile.commit(input.selfProfile,
      { ...valid, sourceMessageIds: [reply.messageId] }, [{ ...input.messages[0], id: reply.messageId }]), /原始真人/);
    assert.equal(f.store.autoMemory.selfProfile.snapshot().baseVersion, 0);
  } finally { f.close(); }
});

test('old persisted task inputs without selfProfile remain usable and cannot commit an uncaptured profile', () => {
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
    f.store.autoMemory.commit(job.id, job.leaseToken, extract(f, job));
    assert.equal(f.store.autoMemory.status(f.rooms[0].id).completed, 1);
  } finally { f.close(); }
});

test('v6 migration backs up the original database and preserves chats, tombstones, evidence and queued job input', () => {
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
      db.exec(`PRAGMA foreign_keys=OFF; DROP TABLE self_profile_pending; DROP TABLE self_profile_revisions;
        DROP TABLE delivery_parts; DROP INDEX delivery_conversation_identity;
        UPDATE memories SET content=NULL,status='deleted'; UPDATE memory_revisions SET content=NULL,status='deleted'; PRAGMA user_version=6;`);
      db.prepare('UPDATE auto_memory_jobs SET input_json=? WHERE id=?').run(JSON.stringify(oldInput), job.id);
      return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid,* FROM ${table}`).all().map(r => ({ ...r }))]));
    });
    f.restart();
    inspect(f, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      for (const table of tables) assert.deepEqual(db.prepare(`SELECT rowid,* FROM ${table}`).all().map(r => ({ ...r })), before[table]);
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
    assert.equal(f.store.autoMemory.taskInput(job).selfProfile, undefined);
  } finally { f.close(); }
});
