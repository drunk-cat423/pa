import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { BackgroundMemory, validateExtract } from '../dist/auto-memory.js';
import { MemoryInputTooLargeError, prepareMemoryExtraction } from '../dist/memory-provider.js';
import { decodeMemoryWireResponse, memoryWireReferences } from '../dist/memory-wire.js';
import { accumulateProfileUpdates } from '../dist/profile-updates.js';
import { emptyExtraction } from './fixtures/memory-output.mjs';

const fact = (content, id, sourceType = 'self') => ({ content, sourceType, messageIds: [id] });
const evidence = (source, subjectKind = 'self', subjectQuote = '我') => ({ messageId: source.id, factQuote: source.text, subjectKind, subjectQuote });
const plan = updates => ({ intent: 'memory_update', mode: 'standard', updates });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pa-profile-subject-')), path = join(directory, 'pa.sqlite');
  const store = new ConversationStore(path), route = { channel: 'qq', accountId: 'bot', roomType: 'group', roomId: 'group' };
  const room = store.ensureConversation('group', '/group.jsonl', route);
  const policy = { version: 1, ownerBindings: [{ route, senderId: 'owner' }] };
  let seq = 0;
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const inspect = fn => { const db = new DatabaseSync(path); try { return fn(db); } finally { db.close(); } };
  function inbound(senderId, text, mentions = [], name = senderId === 'A' ? '阿甲' : senderId === 'B' ? '阿乙' : senderId) {
    const eventId = `event-${++seq}`;
    store.recordInbound(room.id, text, { eventId, senderId, senderName: name, modelInputText: text, mentionedSenderIds: mentions });
    const id = store.externalMessage(room.id, eventId).id;
    const actorId = inspect(db => db.prepare('SELECT actor_id FROM messages WHERE id=?').get(id).actor_id);
    return { id, text, actorId, personId: store.autoMemory.ensureActorPerson(actorId), role: 'user' };
  }
  const a = inbound('A', '大家好'), b = inbound('B', '大家好');
  function claim() {
    store.autoMemory.reserveMaterialsIfDue(room.id, 0);
    assert.ok(store.autoMemory.reserveMaterialsIfDue(room.id, 600000));
    const job = store.autoMemory.claimNext(room.id, { owner: 'test', leaseMs: 60000, pipeline: 'materials' });
    assert.ok(job); return { job, input: store.autoMemory.taskInput(job) };
  }
  const prepare = (source, updates, mentions = []) => store.prepareTurn(room.id, source.id, plan(updates), policy, mentions);
  return { store, path, room, policy, a, b, inbound, inspect, claim, prepare };
}

test('front preparation and direct pending share subject checks; A describing B cannot be saved as A self', t => {
  const f = fixture(t), bad = f.inbound('A', '阿乙不吃辣');
  const forged = { target: 'sender', content: bad.text, sourceType: 'self', subject: { subjectKind: 'self', subjectQuote: '我' } };
  assert.throws(() => f.prepare(bad, [forged]), /画像对象/);
  assert.throws(() => f.store.autoMemory.addProfilePending(f.a.personId, bad.id, bad.text, 'self'), /画像对象/);
  assert.equal(f.store.autoMemory.profile(f.a.personId).pending.length, 0);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM turn_preparations').get().n), 0);
  const own = f.inbound('A', '我不吃辣');
  assert.equal(f.prepare(own, [{ target: 'sender', content: own.text, sourceType: 'self' }]).saved[0].status, 'saved_pending');
  const saved = f.store.autoMemory.profile(f.a.personId).pending[0];
  assert.deepEqual(saved.subject, evidence(own));
  assert.equal(saved.sourceType, 'self');
  for (const [text, quote] of [['阿乙说：“我喜欢茶”', '我喜欢茶'], ['我觉得阿乙喜欢茶', '我觉得阿乙喜欢茶'],
    ['我的朋友喜欢茶', '我的朋友喜欢茶'], ['阿乙的自述：我不吃辣', '我不吃辣']]) {
    const source = f.inbound('A', text);
    assert.throws(() => f.prepare(source, [{ target: 'sender', content: quote, sourceType: 'self' }]), /画像对象/);
  }
  assert.equal(f.store.autoMemory.profile(f.a.personId).pending.length, 1);
});

test('front third-party updates require owner authorization and a real mention, preserving the target and speaker separately', t => {
  const f = fixture(t);
  const update = text => ({ target: 'mentioned_person', senderId: 'B', content: text,
    subject: { subjectKind: 'mention', subjectQuote: '<@B>' } });
  const member = f.inbound('A', '<@B>不吃辣', ['B']);
  assert.throws(() => f.prepare(member, [update(member.text)], ['B']), /没有管理/);
  const forgedMention = f.inbound('owner', '<@B>不吃辣');
  assert.throws(() => f.prepare(forgedMention, [update(forgedMention.text)]), /画像对象/);
  const owner = f.inbound('owner', '<@B>不吃辣', ['B']);
  f.prepare(owner, [update(owner.text)], ['B']);
  const pending = f.store.autoMemory.profile(f.b.personId).pending;
  assert.equal(pending.length, 1); assert.equal(pending[0].sourceType, 'third_party');
  assert.deepEqual(pending[0].subject, evidence(owner, 'mention', '<@B>'));
  assert.equal(f.store.autoMemory.profile(f.a.personId).pending.length, 0);
});

test('authorized third-party pending is processed, later pending survives, and the independent audit retains the actual speaker', t => {
  const f = fixture(t), owner = f.inbound('owner', '<@B>不吃辣', ['B']);
  f.prepare(owner, [{ target: 'mentioned_person', senderId: 'B', content: owner.text,
    subject: { subjectKind: 'mention', subjectQuote: '<@B>' } }], ['B']);
  const { job, input } = f.claim(), baseline = input.profiles.find(item => item.personId === f.b.personId);
  assert.equal(input.profileAttributionProtocol, 1); assert.equal(input.selfProfileProtocol, 2);
  const captured = baseline.pending[0], later = f.inbound('owner', '<@B>喜欢茶', ['B']);
  f.prepare(later, [{ target: 'mentioned_person', senderId: 'B', content: later.text,
    subject: { subjectKind: 'mention', subjectQuote: '<@B>' } }], ['B']);
  const output = { ...emptyExtraction(input), profiles: [{ personId: baseline.personId, baseVersion: baseline.baseVersion,
    facts: [fact('不吃辣', owner.id, 'third_party')], updates: [{ factIndex: 0, baselineFactIndexes: [], evidence: [captured.subject] }],
    pendingResults: [{ pendingId: captured.id, status: 'merged', factIndex: 0 }] }] };
  f.store.autoMemory.commit(job.id, job.leaseToken, validateExtract(output, input));
  const current = f.store.autoMemory.profile(f.b.personId);
  assert.deepEqual(current.facts.map(item => item.content), ['不吃辣']);
  assert.deepEqual(current.pending.map(item => item.sourceMessageId), [later.id]);
  f.inspect(db => {
    const audit = db.prepare('SELECT * FROM person_profile_subject_updates WHERE person_id=?').get(f.b.personId);
    assert.equal(audit.speaker_person_id, owner.personId); assert.equal(audit.message_id, owner.id);
    assert.equal(JSON.parse(audit.evidence_json).subjectKind, 'mention');
    assert.equal(db.prepare('SELECT count(*) n FROM person_profile_pending_results WHERE pending_id=?').get(captured.id).n, 1);
  });
});

test('background validator and direct commit both reject forged self or unauthorized third-party facts', t => {
  const f = fixture(t), source = f.inbound('A', '阿乙不吃辣'), { job, input } = f.claim();
  const outputs = [
    { personId: f.a.personId, baseVersion: 0, facts: [fact('不吃辣', source.id)],
      updates: [{ factIndex: 0, baselineFactIndexes: [], evidence: [evidence(source)] }] },
    { personId: f.b.personId, baseVersion: 0, facts: [fact('不吃辣', source.id, 'third_party')],
      updates: [{ factIndex: 0, baselineFactIndexes: [], evidence: [evidence(source, 'name', '阿乙')] }] },
  ];
  for (const profile of outputs) {
    const output = { ...emptyExtraction(input), profiles: [profile] };
    assert.throws(() => validateExtract(output, input), /画像对象|对象依据/);
    assert.throws(() => f.store.autoMemory.commit(job.id, job.leaseToken, output), /画像对象|对象依据/);
  }
  assert.equal(f.store.autoMemory.profile(f.a.personId).baseVersion, 0);
  assert.equal(f.store.autoMemory.profile(f.b.personId).baseVersion, 0);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM person_profile_subject_updates').get().n), 0);
});

function syntheticInput() {
  const messages = ['我喜欢茶', '我喜欢清淡饮食'].map((text, index) => ({ id: `message-${index}`, text, role: 'user',
    senderId: 'A', personId: 'person-A', conversationId: 'room', ingestSeq: index + 1, createdAt: `2026-10-21T00:00:0${index}Z` }));
  return { pipeline: 'materials', extractionProtocol: 2, profileProtocol: 2, profileBaselineProtocol: 1,
    profileAttributionProtocol: 1, selfProfileProtocol: 2, roomType: 'group', messages,
    profileSubjects: [{ personId: 'person-A', senderId: 'A', name: '阿甲' }, { personId: 'person-B', senderId: 'B', name: '阿乙' }],
    profiles: [{ personId: 'person-A', baseVersion: 1, facts: [], pending: [] }],
    job: { id: 'job', conversationId: 'room', pipeline: 'materials', reason: 'idle', status: 'running',
      startSeq: 1, endSeq: 2, messageIds: messages.map(item => item.id), attempts: 1 } };
}

test('unchanged baseline facts inherit without updates, but new conclusions need explicit subject evidence', () => {
  const input = syntheticInput(), baseline = input.profiles[0];
  baseline.facts = [fact('喜欢茶', 'old-source')];
  input.profileSources = [{ ...input.messages[0], id: 'old-source', text: '我喜欢茶' }];
  assert.doesNotThrow(() => validateExtract({ ...emptyExtraction(input), profiles: [{ ...baseline, updates: [] }] }, input));
  const changed = { ...baseline, facts: [fact('喜欢茶和清淡饮食', 'message-1')], updates: [] };
  assert.throws(() => validateExtract({ ...emptyExtraction(input), profiles: [changed] }, input), /对象依据/);
  changed.updates = [{ factIndex: 0, baselineFactIndexes: [], evidence: [evidence(input.messages[1])] }];
  assert.doesNotThrow(() => validateExtract({ ...emptyExtraction(input), profiles: [changed] }, input));
});

test('wire preserves platform mentions and decodes only evidence ID fields, rejecting invented references', () => {
  const input = syntheticInput();
  input.messages[0] = { ...input.messages[0], text: '<@B>不吃辣', mentionedSenderIds: ['B'] };
  input.profiles.push({ personId: 'person-B', baseVersion: 0, facts: [], pending: [] });
  const refs = memoryWireReferences(input), prepared = prepareMemoryExtraction(input, 1000000), view = JSON.parse(prepared.userContent);
  assert.deepEqual(view.messages[0].mentionedSenderIds, ['B']);
  assert.equal(view.profileAttributionProtocol, 1);
  assert.equal(view.profileSubjects.find(item => item.senderId === 'B').personId, refs.people.get('person-B'));
  const response = { topics: [], profiles: [{ personId: refs.people.get('person-A'), baseVersion: 1,
    facts: [fact('m0 is ordinary text', refs.messages.get('message-1'))], updates: [{ factIndex: 0, baselineFactIndexes: [],
      evidence: [{ ...evidence(input.messages[1]), messageId: refs.messages.get('message-1') }] }] }] };
  const decoded = decodeMemoryWireResponse(response, input);
  assert.equal(decoded.profiles[0].facts[0].content, 'm0 is ordinary text');
  assert.equal(decoded.profiles[0].updates[0].evidence[0].messageId, 'message-1');
  response.profiles[0].updates[0].evidence[0].messageId = 'm999';
  assert.throws(() => decodeMemoryWireResponse(response, input), error => error.code === 'model_contract');
});

function workerFixture(t, input, extract, saved) {
  let state = 'queued', progress = saved, completed;
  const failures = [], checkpoints = [];
  const store = { reserveBatch() {}, reserveCompressionBatch() {}, reserveMaterialsIfDue() {},
    claimNext(_id, options) { if (options.pipeline !== 'materials' || state !== 'queued') return;
      state = 'running'; return { ...input.job, leaseToken: 'lease' }; },
    taskInput() { return structuredClone(input); }, assertProfileEvidenceCurrent() {}, renewLease() {},
    loadProgress() { return progress === undefined ? undefined : structuredClone(progress); },
    saveProgress(_id, _lease, value) { progress = structuredClone(value); checkpoints.push(structuredClone(value)); },
    clearProgress() { progress = undefined; }, fail(_id, _lease, error) { state = 'failed'; failures.push(error); },
    commit(_id, _lease, value) { completed = structuredClone(value); state = 'done'; },
    status(_id, pipeline) { const current = pipeline === undefined || pipeline === 'materials';
      return { queued: Number(current && state === 'queued'), running: Number(current && state === 'running'),
        failed: Number(current && state === 'failed'), completed: Number(current && state === 'done') }; }, materialSchedule() { return {}; } };
  const worker = new BackgroundMemory({ contextWindow: 1000000, memory: { enabled: true, maxCalls: 0, timeoutMs: 1000 } }, store, 'room', { extract });
  t.after(() => worker.close());
  return { worker, failures, checkpoints, get progress() { return progress; }, get completed() { return completed; } };
}

test('old frozen inputs and progress markers stop the worker before any model call and preserve checkpoints', async t => {
  for (const marker of ['profileAttributionProtocol', 'selfProfileProtocol']) {
    const input = syntheticInput(); delete input[marker]; let calls = 0;
    const old = workerFixture(t, input, async () => { calls++; throw new Error('must not call'); });
    old.worker.start(); await assert.rejects(old.worker.wait(), /失败/);
    assert.equal(calls, 0); assert.equal(old.completed, undefined);
    assert.equal(old.progress, undefined);
  }
  const input = syntheticInput(), saved = { version: 3, profileBaselineProtocol: 1, remaining: [], profiles: input.profiles,
    extract: { topics: [], profiles: [], fragments: [], ignoredMessageIds: [], processedRanges: [] } };
  let calls = 0;
  const oldProgress = workerFixture(t, input, async () => { calls++; }, saved);
  oldProgress.worker.start(); await assert.rejects(oldProgress.worker.wait(), /失败/);
  assert.equal(calls, 0); assert.deepEqual(oldProgress.progress, saved); assert.deepEqual(oldProgress.checkpoints, []);
});

test('split worker composes each step evidence back to the immutable original baseline', async t => {
  const input = syntheticInput(); let calls = 0;
  const f = workerFixture(t, input, async chunk => {
    calls++;
    if (!chunk.mode) throw new MemoryInputTooLargeError('force independent steps before request');
    if (chunk.mode === 'messages') return emptyExtraction(chunk);
    if (chunk.messages.length > 1) throw new MemoryInputTooLargeError('force message split before request');
    const source = chunk.messages[0], baseline = chunk.profiles[0], first = source.id === 'message-0';
    const content = first ? '喜欢茶' : '喜欢茶，也偏好清淡饮食';
    const messageIds = first ? [source.id] : [...baseline.facts[0].messageIds, source.id];
    return { ...emptyExtraction(chunk), profiles: [{ personId: baseline.personId, baseVersion: baseline.baseVersion,
      facts: [{ content, sourceType: 'self', messageIds }], updates: [{ factIndex: 0,
        baselineFactIndexes: first ? [] : [0], evidence: [evidence(source)] }] }] };
  });
  f.worker.start(); await f.worker.wait();
  assert.equal(calls, 5);
  const final = f.completed.profiles[0];
  assert.deepEqual(final.updates[0].baselineFactIndexes, []);
  assert.deepEqual(new Set(final.updates[0].evidence.map(item => item.messageId)), new Set(['message-0', 'message-1']));
  assert.deepEqual(new Set(final.facts[0].messageIds), new Set(['message-0', 'message-1']));
  assert.equal(f.progress.profileAttributionProtocol, 1); assert.equal(f.progress.selfProfileProtocol, 2);
  assert.doesNotThrow(() => validateExtract(f.completed, input));
});

test('two steps may cite different excerpts from one original and retain both in the final audit', t => {
  const f = fixture(t), source = f.inbound('A', '我喜欢茶，也喜欢咖啡'), { job, input } = f.claim();
  const original = input.profiles.find(profile => profile.personId === f.a.personId);
  const firstEvidence = { ...evidence(source), factQuote: '我喜欢茶' };
  const secondEvidence = evidence(source);
  const firstInput = { ...input, mode: 'profiles', profiles: [original] };
  const first = validateExtract({ profiles: [{ personId: original.personId, baseVersion: original.baseVersion,
    facts: [fact('喜欢茶', source.id)], pendingResults: [],
    updates: [{ factIndex: 0, baselineFactIndexes: [], evidence: [firstEvidence] }] }] }, firstInput).profiles[0];
  const secondInput = { ...firstInput, profiles: [first] };
  const second = validateExtract({ profiles: [{ personId: original.personId, baseVersion: original.baseVersion,
    facts: [fact('喜欢茶和咖啡', source.id)], pendingResults: [],
    updates: [{ factIndex: 0, baselineFactIndexes: [0], evidence: [secondEvidence] }] }] }, secondInput).profiles[0];
  accumulateProfileUpdates(second, first, original);
  assert.deepEqual(second.updates[0].baselineFactIndexes, []);
  assert.deepEqual(new Set(second.updates[0].evidence.map(item => item.factQuote)), new Set(['我喜欢茶', source.text]));
  assert.equal(second.updates[0].evidence.length, 2);
  assert.ok(second.updates[0].evidence.every(item => item.messageId === source.id));
  const output = { ...emptyExtraction(input), profiles: [second] };
  const final = validateExtract(output, input);
  const duplicate = structuredClone(output);
  duplicate.profiles[0].updates[0].evidence.push({ ...firstEvidence });
  assert.throws(() => validateExtract(duplicate, input), /对象依据/);
  f.store.autoMemory.commit(job.id, job.leaseToken, final);
  const quotes = f.inspect(db => db.prepare('SELECT evidence_json FROM person_profile_subject_updates WHERE person_id=? AND message_id=?')
    .all(original.personId, source.id).map(row => JSON.parse(row.evidence_json).factQuote));
  assert.deepEqual(new Set(quotes), new Set(['我喜欢茶', source.text]));
});
