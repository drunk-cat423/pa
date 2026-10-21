import { downgradeSchema14 } from './fixtures/legacy-schema.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { emptyExtraction } from './fixtures/memory-output.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-person-profile-policy-'));
  const path = join(dir, 'store.sqlite');
  let store = new ConversationStore(path);
  const route = { channel: 'qq', accountId: 'test', roomType: 'group', roomId: 'policy-room' };
  const room = store.ensureConversation('policy-room', '/policy-room.jsonl', route);
  let sequence = 0;
  return {
    dir, path, route, room,
    get store() { return store; },
    inbound(text, senderId = 'alice') {
      const external = { eventId: String(++sequence), senderId, modelInputText: text, sentAt: '2026-01-01T00:00:00Z' };
      store.recordInbound(room.id, text, external);
      return { ...external, existingMessageId: store.externalMessage(room.id, external.eventId).id };
    },
    inspect(fn) { const db = new DatabaseSync(path); try { return fn(db); } finally { db.close(); } },
    restart() { store.close(); store = new ConversationStore(path); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function batch(f) {
  f.store.autoMemory.reserveBatch(f.room.id, 'capacity');
  const job = f.store.autoMemory.claimNext(f.room.id, { owner: 'policy-test', leaseMs: 60000 });
  assert.ok(job);
  return { job, input: f.store.autoMemory.taskInput(job) };
}
function personFor(f, senderId = 'alice') {
  return f.store.autoMemory.personForActor(f.store.findActor(f.room.id, senderId));
}
function extract(input, profiles) {
  const updated = profiles.map(profile => {
    const baseline = input.profiles.find(item => item.personId === profile.personId);
    const updates = [];
    profile.facts.forEach((fact, factIndex) => {
      const baselineFactIndexes = baseline?.facts.flatMap((previous, index) => previous.content === fact.content
        && previous.sourceType === fact.sourceType ? [index] : []) ?? [];
      const evidence = fact.messageIds.flatMap(messageId => {
        const source = [...input.messages, ...(input.profileSources ?? [])].find(message => message.id === messageId);
        if (!source || source.role !== 'user' || !/^\s*(?:我|本人)/u.test(source.text)) return [];
        return [{ messageId, factQuote: source.text, subjectKind: 'self', subjectQuote: source.text.trim().startsWith('本人') ? '本人' : '我' }];
      });
      if (baselineFactIndexes.length || evidence.length) updates.push({ factIndex, baselineFactIndexes, evidence });
    });
    return { ...profile, updates };
  });
  return { ...emptyExtraction(input), profiles: updated };
}
function hash(value) { return createHash('sha256').update(value).digest('hex'); }

test('over-capacity commit rolls back raw messages, profile revision, pending queue, and job state', () => {
  const f = fixture();
  try {
    const source = f.inbound('我喜欢茶');
    const personId = personFor(f);
    f.store.autoMemory.addProfilePending(personId, source.existingMessageId, '喜欢茶', 'self');
    const { job, input } = batch(f);
    const baseline = input.profiles.find(profile => profile.personId === personId);
    const oversized = Array.from({ length: 81 }, (_, index) => ({
      content: `偏好${index}`,
      sourceType: 'self',
      messageIds: [source.existingMessageId],
    }));
    const before = f.inspect(db => ({
      messages: db.prepare('SELECT * FROM messages ORDER BY ingest_seq').all(),
      pending: db.prepare('SELECT * FROM person_profile_pending ORDER BY id').all(),
      revisions: db.prepare('SELECT * FROM person_profile_revisions ORDER BY revision').all(),
      job: db.prepare('SELECT status,input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id),
    }));
    assert.throws(() => f.store.autoMemory.commit(job.id, job.leaseToken, extract(input, [{
      personId, baseVersion: baseline.baseVersion, facts: oversized,
      pendingResults: baseline.pending.map(item => ({ pendingId: item.id, status: 'deferred' })),
    }])), /容量/);
    assert.deepEqual(f.inspect(db => ({
      messages: db.prepare('SELECT * FROM messages ORDER BY ingest_seq').all(),
      pending: db.prepare('SELECT * FROM person_profile_pending ORDER BY id').all(),
      revisions: db.prepare('SELECT * FROM person_profile_revisions ORDER BY revision').all(),
      job: db.prepare('SELECT status,input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id),
    })), before);
    assert.equal(f.store.autoMemory.profile(personId).baseVersion, 0);
  } finally { f.close(); }
});

test('merged pending is physically removed with a hash and source receipt while prior revision remains unchanged', () => {
  const f = fixture();
  try {
    const original = f.inbound('我喜欢茶');
    const personId = personFor(f);
    let current = batch(f);
    f.store.autoMemory.commit(current.job.id, current.job.leaseToken, extract(current.input, [{
      personId, baseVersion: 0,
      facts: [{ content: '喜欢茶', sourceType: 'self', messageIds: [original.existingMessageId] }],
    }]));
    const oldRevision = f.inspect(db => db.prepare('SELECT * FROM person_profile_revisions WHERE person_id=? AND revision=1').get(personId));
    const oldSources = f.inspect(db => db.prepare('SELECT * FROM person_profile_revision_sources WHERE person_id=? AND revision=1 ORDER BY fact_index,message_id').all(personId));

    const pendingSource = f.inbound('我一直喜欢乌龙茶');
    f.store.autoMemory.addProfilePending(personId, pendingSource.existingMessageId, '喜欢乌龙茶', 'self');
    current = batch(f);
    const baseline = current.input.profiles.find(profile => profile.personId === personId);
    const pending = baseline.pending[0];
    f.store.autoMemory.commit(current.job.id, current.job.leaseToken, extract(current.input, [{
      personId, baseVersion: baseline.baseVersion,
      facts: [{ content: '喜欢茶', sourceType: 'self', messageIds: [original.existingMessageId, pendingSource.existingMessageId] }],
      pendingResults: [{ pendingId: pending.id, status: 'merged', factIndex: 0 }],
    }]));

    assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM person_profile_pending WHERE id=?').get(pending.id).n), 0);
    const receipt = f.inspect(db => db.prepare('SELECT * FROM person_profile_pending_results WHERE job_id=? AND pending_id=?').get(current.job.id, pending.id));
    assert.equal(receipt.person_id, personId);
    assert.equal(receipt.source_message_id, pendingSource.existingMessageId);
    assert.equal(receipt.source_type, 'self');
    assert.equal(receipt.content_hash, hash(pending.content));
    assert.equal(receipt.outcome, 'merged');
    assert.equal(receipt.profile_revision, 2);
    assert.deepEqual(f.inspect(db => db.prepare('SELECT * FROM person_profile_revisions WHERE person_id=? AND revision=1').get(personId)), oldRevision);
    assert.deepEqual(f.inspect(db => db.prepare('SELECT * FROM person_profile_revision_sources WHERE person_id=? AND revision=1 ORDER BY fact_index,message_id').all(personId)), oldSources);
    assert.deepEqual(f.inspect(db => db.prepare('SELECT message_id FROM person_profile_revision_sources WHERE person_id=? AND revision=2 ORDER BY message_id').all(personId).map(row => row.message_id)),
      [original.existingMessageId, pendingSource.existingMessageId].sort());
  } finally { f.close(); }
});

test('deferred result keeps active pending and is recorded without counting as a processed outcome', () => {
  const f = fixture();
  try {
    const source = f.inbound('我喜欢散步');
    const personId = personFor(f);
    f.store.autoMemory.addProfilePending(personId, source.existingMessageId, '喜欢散步', 'self');
    const { job, input } = batch(f);
    const baseline = input.profiles.find(profile => profile.personId === personId);
    const pending = baseline.pending[0];
    f.store.autoMemory.commit(job.id, job.leaseToken, extract(input, [{
      personId, baseVersion: baseline.baseVersion, facts: baseline.facts,
      pendingResults: [{ pendingId: pending.id, status: 'deferred' }],
    }]));
    assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM person_profile_pending WHERE id=? AND archived_revision IS NULL').get(pending.id).n), 1);
    assert.equal(f.inspect(db => db.prepare("SELECT count(*) n FROM person_profile_pending_results WHERE outcome!='deferred'").get().n), 0);
    assert.equal(f.inspect(db => db.prepare("SELECT outcome FROM person_profile_pending_results WHERE pending_id=?").get(pending.id).outcome), 'deferred');
    const next = f.inbound('我还喜欢公园');
    assert.doesNotThrow(() => f.store.autoMemory.addProfilePending(personId, next.existingMessageId, '喜欢公园', 'self'));
    assert.equal(f.store.autoMemory.profile(personId).pending.length, 2);
  } finally { f.close(); }
});

test('rejects cross-person, fabricated, and post-capture pending IDs', () => {
  for (const attack of ['cross-person', 'fabricated', 'late']) {
    const f = fixture();
    try {
      const aliceSource = f.inbound('我喜欢茶', 'alice');
      const bobSource = f.inbound('我喜欢咖啡', 'bob');
      const alice = personFor(f, 'alice');
      const bob = personFor(f, 'bob');
      f.store.autoMemory.addProfilePending(alice, aliceSource.existingMessageId, '喜欢茶', 'self');
      f.store.autoMemory.addProfilePending(bob, bobSource.existingMessageId, '喜欢咖啡', 'self');
      const { job, input } = batch(f);
      const baseline = input.profiles.find(profile => profile.personId === alice);
      const bobPending = input.profiles.find(profile => profile.personId === bob).pending[0];
      let resultId = baseline.pending[0].id;
      if (attack === 'cross-person') resultId = bobPending.id;
      if (attack === 'fabricated') resultId = 'invented-pending-id';
      if (attack === 'late') {
        const later = f.inbound('我又喜欢绿茶', 'alice');
        f.store.autoMemory.addProfilePending(alice, later.existingMessageId, '喜欢绿茶', 'self');
        resultId = f.store.autoMemory.profile(alice).pending.at(-1).id;
      }
      assert.throws(() => f.store.autoMemory.commit(job.id, job.leaseToken, extract(input, [{
        personId: alice, baseVersion: baseline.baseVersion, facts: baseline.facts,
        pendingResults: [{ pendingId: resultId, status: 'deferred' }],
      }])), /待整理|捕获/);
      assert.equal(f.store.autoMemory.profile(alice).baseVersion, 0);
      assert.equal(f.inspect(db => db.prepare('SELECT status FROM auto_memory_jobs WHERE id=?').get(job.id).status), 'running');
    } finally { f.close(); }
  }
});

test('a later message from the same person can supersede pending; a third party cannot replace it', () => {
  const f = fixture();
  try {
    const original = f.inbound('我以前喜欢茶', 'alice');
    const personId = personFor(f, 'alice');
    f.store.autoMemory.addProfilePending(personId, original.existingMessageId, '以前喜欢茶', 'self');
    const correction = f.inbound('我现在更喜欢咖啡', 'alice');
    const thirdParty = f.inbound('Alice现在喜欢果汁', 'bob');
    const { job, input } = batch(f);
    const baseline = input.profiles.find(profile => profile.personId === personId);
    const pending = baseline.pending[0];
    const facts = [{ content: '现在喜欢咖啡', sourceType: 'self', messageIds: [correction.existingMessageId] }];
    const rejected = extract(input, [{ personId, baseVersion: baseline.baseVersion, facts,
      pendingResults: [{ pendingId: pending.id, status: 'superseded', replacementMessageId: thirdParty.existingMessageId }] }]);
    assert.throws(() => f.store.autoMemory.commit(job.id, job.leaseToken, rejected), /无效|待整理/);
    f.store.autoMemory.commit(job.id, job.leaseToken, extract(input, [{ personId, baseVersion: baseline.baseVersion, facts,
      pendingResults: [{ pendingId: pending.id, status: 'superseded', replacementMessageId: correction.existingMessageId }] }]));
    assert.equal(f.store.autoMemory.profile(personId).facts[0].content, '现在喜欢咖啡');
    assert.equal(f.inspect(db => db.prepare('SELECT outcome FROM person_profile_pending_results WHERE pending_id=?').get(pending.id).outcome), 'superseded');
    assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM person_profile_pending WHERE id=?').get(pending.id).n), 0);
  } finally { f.close(); }
});

test('many captured pending sources join one fact without exceeding active source limits', () => {
  const f = fixture();
  try {
    const sources = Array.from({ length: 6 }, (_, index) => f.inbound(`我一直喜欢茶${index}`, 'alice'));
    const personId = personFor(f, 'alice');
    for (const source of sources) f.store.autoMemory.addProfilePending(personId, source.existingMessageId, '喜欢茶', 'self');
    const { job, input } = batch(f);
    const baseline = input.profiles.find(profile => profile.personId === personId);
    const pendingResults = baseline.pending.map(item => ({ pendingId: item.id, status: 'merged', factIndex: 0 }));
    const factSources = sources.slice(0, 5).map(source => source.existingMessageId);
    f.store.autoMemory.commit(job.id, job.leaseToken, extract(input, [{ personId, baseVersion: baseline.baseVersion,
      facts: [{ content: '喜欢茶', sourceType: 'self', messageIds: factSources }], pendingResults }]));
    const profile = f.store.autoMemory.profile(personId);
    assert.equal(profile.facts.length, 1);
    assert.ok(profile.facts[0].messageIds.length <= 5);
    assert.deepEqual(f.inspect(db => db.prepare('SELECT message_id FROM person_profile_revision_sources WHERE person_id=? AND revision=1 ORDER BY message_id').all(personId).map(row => row.message_id)),
      sources.map(source => source.existingMessageId).sort());
    assert.equal(f.inspect(db => db.prepare("SELECT count(*) n FROM person_profile_pending_results WHERE job_id=? AND outcome='merged'").get(job.id).n), 6);
  } finally { f.close(); }
});

test('source inheritance uses original fact indexes and exact fact identity without cross-contamination', () => {
  const f = fixture();
  try {
    const expiredSource = f.inbound('我曾有一条旧过期证据');
    const sharedSource = f.inbound('我提供事实A和事实B共享的代表来源');
    const aOnlySource = f.inbound('我提供事实A仅属于A的额外来源');
    const personId = personFor(f);
    f.store.autoMemory.addProfilePending(personId, aOnlySource.existingMessageId, '事实A', 'self');
    let current = batch(f);
    const initial = current.input.profiles.find(profile => profile.personId === personId);
    f.store.autoMemory.commit(current.job.id, current.job.leaseToken, extract(current.input, [{
      personId, baseVersion: 0,
      facts: [
        { content: '已过期事实', sourceType: 'self', messageIds: [expiredSource.existingMessageId], expiresAt: '2020-01-01T00:00:00Z' },
        { content: '事实A', sourceType: 'self', messageIds: [sharedSource.existingMessageId] },
        { content: '事实B', sourceType: 'self', messageIds: [sharedSource.existingMessageId] },
      ],
      pendingResults: [{ pendingId: initial.pending[0].id, status: 'merged', factIndex: 1 }],
    }]));

    f.inbound('触发下一版整理');
    current = batch(f);
    const baseline = current.input.profiles.find(profile => profile.personId === personId);
    assert.deepEqual(baseline.facts.map(fact => fact.content), ['事实A', '事实B']);
    f.store.autoMemory.commit(current.job.id, current.job.leaseToken, extract(current.input, [{
      personId, baseVersion: baseline.baseVersion,
      facts: [
        { content: '事实A', sourceType: 'self', messageIds: [sharedSource.existingMessageId] },
        { content: '事实B', sourceType: 'self', messageIds: [sharedSource.existingMessageId] },
      ],
    }]));

    const sources = f.inspect(db => db.prepare('SELECT fact_index,message_id FROM person_profile_revision_sources WHERE person_id=? AND revision=2 ORDER BY fact_index,message_id').all(personId));
    assert.deepEqual(sources.filter(row => row.fact_index === 0).map(row => row.message_id).sort(),
      [sharedSource.existingMessageId, aOnlySource.existingMessageId].sort());
    assert.deepEqual(sources.filter(row => row.fact_index === 1).map(row => row.message_id), [sharedSource.existingMessageId]);
    assert.ok(!sources.some(row => row.message_id === expiredSource.existingMessageId));
  } finally { f.close(); }
});

test('v13 migration backup preserves archived legacy pending rows and current database advances to v23', () => {
  const f = fixture();
  try {
    const source = f.inbound('我喜欢读书，也有旧版已归档提醒');
    const personId = personFor(f);
    let current = batch(f);
    f.store.autoMemory.commit(current.job.id, current.job.leaseToken, extract(current.input, [{ personId, baseVersion: 0,
      facts: [{ content: '喜欢读书', sourceType: 'self', messageIds: [source.existingMessageId] }] }]));
    f.store.autoMemory.addProfilePending(personId, source.existingMessageId, '旧版已归档提醒', 'self');
    const archived = f.store.autoMemory.profile(personId).pending[0];
    f.inspect(db => db.prepare('UPDATE person_profile_pending SET archived_revision=1,archived_at=? WHERE id=?').run('2026-10-16T00:00:00Z', archived.id));
    f.store.close();
    f.inspect(db => {
      downgradeSchema14(db);db.exec('DROP TABLE person_profile_pending_results; DROP TABLE person_profile_revision_sources; PRAGMA user_version=13;');
    });
    f.restart();
    assert.equal(f.inspect(db => db.prepare('PRAGMA user_version').get().user_version),23);
    assert.deepEqual({ ...f.inspect(db => db.prepare('SELECT id,person_id,source_message_id,archived_revision,archived_at FROM person_profile_pending WHERE id=?').get(archived.id)) }, {
      id: archived.id, person_id: personId, source_message_id: source.existingMessageId, archived_revision: 1, archived_at: '2026-10-16T00:00:00Z',
    });
    const backups = readdirSync(f.dir).filter(name => name.includes('.v13.') && name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(f.dir, backups[0]), { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 13);
      assert.deepEqual({ ...backup.prepare('SELECT id,person_id,source_message_id,archived_revision,archived_at FROM person_profile_pending WHERE id=?').get(archived.id) }, {
        id: archived.id, person_id: personId, source_message_id: source.existingMessageId, archived_revision: 1, archived_at: '2026-10-16T00:00:00Z',
      });
      assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name='person_profile_pending_results'").get(), undefined);
      assert.deepEqual(backup.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { backup.close(); }
  } finally { f.close(); }
});

test('not-profile cleanup leaves an auditable hash and never fabricates a profile fact', () => {
  const f = fixture();
  try {
    const source = f.inbound('我今晚临时吃火锅');
    const personId = personFor(f);
    f.store.autoMemory.addProfilePending(personId, source.existingMessageId, '今晚临时吃火锅', 'self');
    const { job, input } = batch(f);
    const baseline = input.profiles.find(profile => profile.personId === personId);
    f.store.autoMemory.commit(job.id, job.leaseToken, extract(input, [{ personId, baseVersion: baseline.baseVersion,
      facts: [], pendingResults: [{ pendingId: baseline.pending[0].id, status: 'not_profile', reason: 'temporary' }] }]));
    assert.deepEqual(f.store.autoMemory.profile(personId).facts, []);
    assert.deepEqual(f.store.autoMemory.profile(personId).pending, []);
    const receipt = f.inspect(db => db.prepare('SELECT * FROM person_profile_pending_results WHERE job_id=?').get(job.id));
    assert.equal(receipt.outcome, 'not_profile'); assert.equal(receipt.reason, 'temporary');
    assert.equal(receipt.content_hash, hash('今晚临时吃火锅'));
    assert.equal(f.store.externalMessage(f.room.id, source.eventId).text, '我今晚临时吃火锅');
    assert.equal(Object.hasOwn(receipt, 'content'), false);
  } finally { f.close(); }
});

test('successful cleanup removes captured pending only and keeps a new in-flight update', () => {
  const f = fixture();
  try {
    const source = f.inbound('我喜欢读书');
    const personId = personFor(f);
    f.store.autoMemory.addProfilePending(personId, source.existingMessageId, '喜欢读书', 'self');
    const { job, input } = batch(f);
    const baseline = input.profiles.find(profile => profile.personId === personId);
    const later = f.inbound('我也喜欢画画');
    f.store.autoMemory.addProfilePending(personId, later.existingMessageId, '喜欢画画', 'self');
    f.store.autoMemory.commit(job.id, job.leaseToken, extract(input, [{ personId, baseVersion: baseline.baseVersion,
      facts: [{ content: '喜欢读书', sourceType: 'self', messageIds: [source.existingMessageId] }],
      pendingResults: [{ pendingId: baseline.pending[0].id, status: 'merged', factIndex: 0 }] }]));
    assert.deepEqual(f.store.autoMemory.profile(personId).pending.map(item => item.content), ['喜欢画画']);
    assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM person_profile_pending_results WHERE job_id=?').get(job.id).n), 1);
    assert.equal(f.store.externalMessage(f.room.id, later.eventId).text, '我也喜欢画画');
  } finally { f.close(); }
});
