import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { BackgroundMemory, validateExtract } from '../dist/auto-memory.js';
import { prepareMemoryExtraction, parseMemoryResponse, MemoryInputTooLargeError } from '../dist/memory-provider.js';
import { memoryWireReferences } from '../dist/memory-wire.js';
import { DiagnosticLog } from '../dist/diagnostics.js';
import { validateProfilePendingResults } from '../dist/profile-pending.js';
import { emptyExtraction } from './fixtures/memory-output.mjs';

const message = (id, text, ingestSeq = 1, personId = 'alice') => ({ id, text, ingestSeq, personId,
  conversationId: 'room', role: 'user', createdAt: '2026-10-20T00:00:00Z' });
const fact = (content, id, sourceType = 'self') => ({ content, sourceType, messageIds: [id] });
function inputFixture() {
  return { extractionProtocol: 2, profileProtocol: 2, profileBaselineProtocol: 1, pipeline: 'materials', roomType: 'group',
    job: { id: 'job', conversationId: 'room', reason: 'idle', status: 'running', startSeq: 10, endSeq: 10,
      messageIds: ['new'], attempts: 1 },
    messages: [message('new', '本批新增聊天', 10)],
    profiles: [{ personId: 'alice', baseVersion: 2,
      facts: [fact('喜欢茶', 'old-tea'), fact('喜欢清淡饮食', 'old-diet'), fact('可能喜欢阅读', 'old-inference', 'inference')],
      pending: [{ id: 'pending', content: '喜欢温水', sourceMessageId: 'pending-source', sourceType: 'self' }] },
      { personId: 'bob', baseVersion: 1, facts: [fact('喜欢咖啡', 'bob-source')], pending: [] }],
    profileSources: [message('old-tea', '旧茶原文不可重发'.repeat(1000), 3), message('old-diet', '旧饮食原文不可重发', 4),
      message('old-inference', '旧推测原文不可重发', 5), message('bob-source', '其他人物旧原文不可重发', 6, 'bob'),
      message('legacy-fragment', '历史片段原文不可重发', 7), message('pending-source', '待办原始自述', 2)],
    profileFragments: [{ personId: 'alice', content: '历史片段正文不可重发', sourceType: 'self', messageIds: ['legacy-fragment'] }] };
}
const prepare = input => prepareMemoryExtraction(input, 1_000_000);
const decode = (input, value) => parseMemoryResponse({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(value) }] }, input);

test('baseline projection sends complete current facts and pending originals, not archived evidence or legacy fragments', () => {
  const input = inputFixture(), original = structuredClone(input);
  const prepared = prepare(input), view = JSON.parse(prepared.userContent);
  assert.equal(view.profileBaselineProtocol, 1);
  assert.deepEqual(view.messages.map(item => item.text), ['本批新增聊天']);
  assert.deepEqual(view.profileSources.map(item => item.text), ['待办原始自述']);
  assert.equal(view.profileFragments, undefined);
  assert.deepEqual(view.profiles[0].facts.map(item => item.content), ['喜欢茶', '喜欢清淡饮食', '可能喜欢阅读']);
  assert.doesNotMatch(prepared.userContent, /不可重发/);
  assert.match(prepared.systemPrompt, /以输入当前画像为已归档基线/);
  assert.match(prepared.systemPrompt, /新增事实或纠正旧结论必须引用本批真人/);
  assert.deepEqual(input, original);
  const legacy = structuredClone(input); delete legacy.profileBaselineProtocol;
  assert.ok(prepare(legacy).userContent.length > prepared.userContent.length * 5);
  assert.match(prepare(legacy).userContent, /旧茶原文不可重发/);
  assert.equal(memoryWireReferences(input).messages.has('legacy-fragment'), false);
});

test('pending-only batches retain their original evidence and sources already in new messages are not duplicated', () => {
  const input = inputFixture();
  input.profiles[0].pending.push({ id: 'in-batch', content: '新增补充', sourceMessageId: 'new', sourceType: 'self' });
  input.profileSources.push(input.messages[0]);
  assert.deepEqual(JSON.parse(prepare(input).userContent).profileSources.map(item => item.text), ['待办原始自述']);
  input.messages = []; input.job.messageIds = [];
  assert.deepEqual(JSON.parse(prepare(input).userContent).profileSources.map(item => item.text), ['待办原始自述', '本批新增聊天']);
});

test('old facts can be compacted using baseline references without weakening cross-person or self-evidence checks', () => {
  const input = inputFixture(), refs = memoryWireReferences(input);
  const response = { topics: [], profiles: [{ personId: refs.people.get('alice'), baseVersion: 2,
    facts: [{ content: '饮食清淡，喜欢喝茶', sourceType: 'self', messageIds: ['old-tea', 'old-diet'].map(id => refs.messages.get(id)) }],
    pendingResults: [{ pendingId: refs.pending.get('pending'), status: 'deferred' }] }] };
  const valid = validateExtract(decode(input, response), input);
  assert.deepEqual(valid.profiles[0].facts[0].messageIds, ['old-tea', 'old-diet']);
  for (const source of ['bob-source', 'old-inference']) {
    const invalid = structuredClone(response); invalid.profiles[0].facts[0].messageIds = [refs.messages.get(source)];
    assert.throws(() => validateExtract(decode(input, invalid), input), /真人|自述/);
  }
  const invisible = structuredClone(response); invisible.profiles[0].facts[0].messageIds = ['m999'];
  assert.throws(() => decode(input, invisible), error => error.code === 'model_contract');
});

test('an unseen archived message cannot serve as a new correction that supersedes pending', () => {
  const input = inputFixture(), baseline = input.profiles[0];
  const result = { ...baseline, pendingResults: [{ pendingId: 'pending', status: 'superseded', replacementMessageId: 'old-tea' }] };
  assert.throws(() => validateProfilePendingResults(result, baseline, input), /待整理/);
  const legacy = structuredClone(input); delete legacy.profileBaselineProtocol;
  assert.doesNotThrow(() => validateProfilePendingResults(result, legacy.profiles[0], legacy));
  result.facts = [fact('改喝温水', 'new')]; result.pendingResults[0].replacementMessageId = 'new';
  assert.doesNotThrow(() => validateProfilePendingResults(result, baseline, input));
});

test('unknown or misplaced baseline protocols fail before preparing a request', () => {
  for (const changes of [{ profileBaselineProtocol: 2 }, { pipeline: 'compression' }, { profileProtocol: undefined }]) {
    assert.throws(() => prepare({ ...inputFixture(), ...changes }), /协议/);
  }
});

test('diagnostic artifacts replay baseline aliases offline while preserving evidence only in the internal input', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-baseline-replay-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = inputFixture(), refs = memoryWireReferences(input), prepared = prepare(input);
  const request = { messages: [{ role: 'system', content: prepared.systemPrompt }, { role: 'user', content: prepared.userContent }] };
  const response = { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ topics: [], profiles: [{
    personId: refs.people.get('alice'), baseVersion: 2,
    facts: [{ content: '饮食清淡，喜欢茶', sourceType: 'self', messageIds: [refs.messages.get('old-tea'), refs.messages.get('old-diet')] }],
    pendingResults: [{ pendingId: refs.pending.get('pending'), status: 'deferred' }],
  }] }) }] };
  const log = new DiagnosticLog(directory), callId = log.startCall({ traceId: 'trace', taskId: 'task', jobId: input.job.id,
    conversationId: input.job.conversationId, attempt: 1, kind: 'memory', provider: 'fixture', model: 'fixture', phase: 'extract' }, request, input);
  log.saveResponse(callId, response); log.finishCall(callId, 'completed', 'extract');
  const reopened = new DiagnosticLog(directory), saved = reopened.artifact(callId, 'input');
  assert.deepEqual(saved, input);
  assert.doesNotMatch(JSON.stringify(reopened.artifact(callId, 'request')), /不可重发/);
  assert.deepEqual(prepare(saved), prepared);
  const replayed = validateExtract(parseMemoryResponse(reopened.artifact(callId, 'response'), saved), saved);
  assert.deepEqual(replayed.profiles[0].facts[0].messageIds, ['old-tea', 'old-diet']);
  assert.equal(reopened.calls({ jobId: input.job.id }).length, 1);
});

function storeFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pa-profile-baseline-')), path = join(directory, 'test.sqlite');
  let store = new ConversationStore(path), event = 0, now = 0;
  const room = store.ensureConversation('room', '/room.jsonl', { channel: 'qq', accountId: 'test', roomType: 'group', roomId: 'room' });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { path, room, get store() { return store; },
    inbound(text, senderId = 'alice') {
      const external = { eventId: String(++event), senderId, modelInputText: text };
      store.recordInbound(room.id, text, external);
      return store.externalMessage(room.id, external.eventId).id;
    },
    inspect(fn) { const db = new DatabaseSync(path); try { return fn(db); } finally { db.close(); } },
    queue() { now += 700_000; store.autoMemory.reserveMaterialsIfDue(room.id, now);
      return store.autoMemory.reserveMaterialsIfDue(room.id, now + 600_000); },
    claim() { return store.autoMemory.claimNext(room.id, { owner: 'test', leaseMs: 60_000, pipeline: 'materials' }); },
    restart() { store.close(); store = new ConversationStore(path); },
  };
}
function archiveBaseline(f) {
  const source = f.inbound('不可重发的已归档原文：我不喜欢吃辣');
  f.queue(); const job = f.claim(), input = f.store.autoMemory.taskInput(job), baseline = input.profiles[0];
  const value = { ...emptyExtraction(input), profiles: [{ ...baseline,
    facts: [fact('不喜欢吃辣', source)], pendingResults: [] }] };
  f.store.autoMemory.commit(job.id, job.leaseToken, validateExtract(value, input));
  return { source, personId: baseline.personId };
}

test('durable material snapshots keep raw evidence for audit while later model requests and coverage stay incremental', t => {
  const f = storeFixture(t), archived = archiveBaseline(f);
  const before = f.inspect(db => ({ messages: db.prepare('SELECT * FROM messages ORDER BY rowid').all(),
    versions: db.prepare('SELECT * FROM person_profile_revisions ORDER BY rowid').all(),
    sources: db.prepare('SELECT * FROM person_profile_revision_sources ORDER BY rowid').all() }));
  const next = f.inbound('本批只聊新的问题'); f.queue(); const job = f.claim(), input = f.store.autoMemory.taskInput(job);
  assert.equal(input.profileBaselineProtocol, 1);
  assert.deepEqual(input.messages.map(item => item.id), [next]);
  assert.ok(input.profileSources.some(item => item.id === archived.source && item.text.includes('不可重发')));
  assert.doesNotMatch(prepare(input).userContent, /不可重发/);
  const frozen = f.inspect(db => db.prepare('SELECT input_json FROM auto_memory_jobs WHERE id=?').get(job.id).input_json);
  f.restart(); assert.equal(JSON.stringify(f.store.autoMemory.taskInput(job)), JSON.stringify(input));
  const rewritten = { ...emptyExtraction(input), profiles: input.profiles.map(profile => ({ ...profile,
    facts: [fact('饮食偏好清淡，不吃辣', archived.source)], pendingResults: [] })) };
  f.store.autoMemory.commit(job.id, job.leaseToken, validateExtract(rewritten, input));
  assert.equal(f.store.autoMemory.profile(archived.personId).facts[0].content, '饮食偏好清淡，不吃辣');
  const after = f.inspect(db => ({ messages: db.prepare('SELECT * FROM messages ORDER BY rowid').all(),
    versions: db.prepare('SELECT * FROM person_profile_revisions ORDER BY rowid').all(),
    sources: db.prepare('SELECT * FROM person_profile_revision_sources ORDER BY rowid').all() }));
  assert.deepEqual(after.messages.slice(0, before.messages.length), before.messages);
  assert.deepEqual(after.versions.slice(0, before.versions.length), before.versions);
  assert.deepEqual(after.sources.slice(0, before.sources.length), before.sources);
  assert.equal(f.inspect(db => db.prepare('SELECT input_json FROM auto_memory_jobs WHERE id=?').get(job.id).input_json), frozen);
  assert.equal(f.store.autoMemory.conversationContext(f.room.id).summaryVersion, 0);
});

test('hiding evidence in the wire does not hide a frozen third-party source identity change from commit', t => {
  const f = storeFixture(t);
  f.inbound('我是 Alice'); const bobSource = f.inbound('Alice 喜欢喝茶', 'bob');
  f.queue(); let job = f.claim(), input = f.store.autoMemory.taskInput(job);
  const alice = input.profiles.find(profile => profile.personId === input.messages[0].personId);
  f.store.autoMemory.commit(job.id, job.leaseToken, validateExtract({ ...emptyExtraction(input), profiles: [{ ...alice,
    facts: [fact('喜欢喝茶', bobSource, 'third_party')], pendingResults: [] }] }, input));
  f.inbound('Alice 的新聊天'); f.queue(); job = f.claim(); input = f.store.autoMemory.taskInput(job);
  assert.ok(input.profileSources.some(item => item.id === bobSource));
  assert.doesNotMatch(prepare(input).userContent, /Alice 喜欢喝茶/);
  const bobActor = f.inspect(db => db.prepare('SELECT actor_id FROM messages WHERE id=?').get(bobSource).actor_id);
  f.inspect(db => db.prepare('UPDATE actor_person_bindings SET person_id=? WHERE actor_id=?').run(alice.personId, bobActor));
  assert.throws(() => f.store.autoMemory.commit(job.id, job.leaseToken, emptyExtraction(input)), /绑定版本冲突/);
  assert.equal(f.store.autoMemory.profile(alice.personId).baseVersion, 1);
});

test('split steps retain the baseline protocol across a restart and do not replay completed message work', async t => {
  const f = storeFixture(t), archived = archiveBaseline(f);
  f.inbound('需要分步的新聊天'); f.queue();
  const settings = { contextWindow: 1_000_000, memory: { enabled: true, maxCalls: 20, timeoutMs: 1500 } };
  let fail = true, messageCalls = 0, profileCalls = 0;
  const provider = { extract: async input => {
    assert.equal(input.profileBaselineProtocol, 1);
    assert.doesNotMatch(prepare(input).userContent, /不可重发/);
    if (!input.mode) throw new MemoryInputTooLargeError('split before submission');
    if (input.mode === 'messages') { messageCalls++; return emptyExtraction(input); }
    profileCalls++; if (fail) { fail = false; throw new Error('preserve failed step'); }
    return { profiles: input.profiles.map(profile => ({ ...profile, pendingResults: [] })) };
  } };
  const first = new BackgroundMemory(settings, f.store.autoMemory, f.room.id, provider);
  first.start(); await assert.rejects(first.wait(undefined, 5000, 'materials'), /失败/); await first.close();
  const job = f.store.autoMemory.listJobs().find(item => item.status === 'failed');
  const saved = f.inspect(db => db.prepare('SELECT input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id));
  assert.equal(JSON.parse(saved.progress_json).profileBaselineProtocol, 1);
  f.restart(); const resumed = new BackgroundMemory(settings, f.store.autoMemory, f.room.id, provider);
  t.after(() => resumed.close()); resumed.retry(job.id); await resumed.wait(undefined, 5000, 'materials');
  assert.equal(messageCalls, 1); assert.equal(profileCalls, 2);
  assert.deepEqual(f.store.autoMemory.profile(archived.personId).facts[0].messageIds, [archived.source]);
  assert.equal(f.inspect(db => db.prepare('SELECT input_json FROM auto_memory_jobs WHERE id=?').get(job.id).input_json), saved.input_json);
});

test('a checkpoint with a mismatched baseline marker is preserved and rejected without calling a provider', async t => {
  const f = storeFixture(t); f.inbound('新消息'); const reserved = f.queue(), claimed = f.claim();
  const input = f.store.autoMemory.taskInput(claimed);
  const progress = { version: 3, remaining: [], profiles: input.profiles,
    extract: { topics: [], profiles: [], fragments: [], ignoredMessageIds: [], processedRanges: [] } };
  f.store.autoMemory.saveProgress(claimed.id, claimed.leaseToken, progress);
  f.store.autoMemory.fail(claimed.id, claimed.leaseToken, 'interrupted');
  let calls = 0;
  const worker = new BackgroundMemory({ contextWindow: 1_000_000, memory: { enabled: true, maxCalls: 5, timeoutMs: 1000 } },
    f.store.autoMemory, f.room.id, { extract: async () => { calls++; } });
  t.after(() => worker.close()); worker.retry(reserved.id);
  await assert.rejects(worker.wait(undefined, 5000, 'materials'), /失败/);
  assert.equal(calls, 0);
  assert.deepEqual(f.inspect(db => JSON.parse(db.prepare('SELECT progress_json FROM auto_memory_jobs WHERE id=?').get(claimed.id).progress_json)), progress);
});
