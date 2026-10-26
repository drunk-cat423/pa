import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { validateExtract, BackgroundMemory } from '../dist/auto-memory.js';
import { assertCurrentMemoryProtocol } from '../dist/auto-memory-store.js';
import { decodeMemoryWireResponse, memoryWireReferences, prepareMemoryWireExtraction } from '../dist/memory-wire.js';
import { ConversationStore } from '../dist/store.js';
import {profileOmissionIncidents} from './fixtures/production-incidents.mjs';

function inputWithFacts(count = 46) {
  const old = { id: 'old', conversationId: 'room', personId: 'alice', role: 'user', text: '我的稳定偏好',
    ingestSeq: 1, createdAt: '2026-10-01T00:00:00Z' };
  const message = { ...old, id: 'new', text: '我现在喜欢茶，也喜欢阅读', ingestSeq: 2, createdAt: '2026-10-02T00:00:00Z' };
  return { pipeline: 'materials', materialsProtocol: 3, profileProposalProtocol: 'delta-v1', extractionProtocol: 2,
    profileProtocol: 2, profileBaselineProtocol: 1, profileAttributionProtocol: 1, selfProfileProtocol: 2,
    job: { id: 'job', conversationId: 'room', messageIds: ['new'] }, mode: 'profiles', roomType: 'group',
    messages: [message], profileSources: [old], profiles: [{ personId: 'alice', baseVersion: 7,
      facts: Array.from({ length: count }, (_, index) => ({ content: `稳定偏好${index}`, sourceType: 'self', messageIds: ['old'] })),
      pending: [{ id: 'p0', content: '我现在喜欢茶', sourceMessageId: 'new', sourceType: 'self' },
        { id: 'p1', content: '也喜欢阅读', sourceMessageId: 'new', sourceType: 'self' }] }] };
}
const decode = (proposal, input) => decodeMemoryWireResponse(proposal, input);
const checked = (proposal, input) => validateExtract(decode(proposal, input), input);
const sourceRef = input => memoryWireReferences(input).messages.get('new');

test('五次历史画像遗漏事故按旧契约拒绝，新任务仅提交真实修改仍继承遗漏条目',()=>{
  for(const incident of profileOmissionIncidents) {
    const input=inputWithFacts(),legacy=structuredClone(input);delete legacy.profileProposalProtocol;
    const covered=new Set(incident.proposal.facts.flatMap(fact=>fact.keep?[fact.keep]:fact.replaces??[]));
    assert.deepEqual(input.profiles[0].facts.flatMap((_,index)=>covered.has(`f${index}`)?[]:[index]),[incident.omitted]);
    assert.throws(()=>decode(incident.proposal,legacy),/单人物画像提案/);
    // Explicitly translate the old proposal into a new-task delta; do not silently upgrade frozen jobs.
    const changes=incident.proposal.facts.filter(fact=>!fact.keep),replaced=new Set(changes.flatMap(fact=>fact.replaces));
    const result=checked({changes},input).profiles[0],inherited=input.profiles[0].facts.filter((_,index)=>!replaced.has(`f${index}`));
    assert.deepEqual(result.facts.slice(0,inherited.length),inherited,incident.id);
    assert.ok(result.facts.some(fact=>fact.content===input.profiles[0].facts[incident.omitted].content));
    assert.equal(result.facts.length,46);
    assert.deepEqual(result.facts.slice(inherited.length).map(fact=>fact.content),changes.map(fact=>fact.content));
  }
});

test('delta-v1无变更继承全部46条旧画像，旧冻结完整协议仍拒绝遗漏', () => {
  const input = inputWithFacts(), before = structuredClone(input);
  const result = checked({ changes: [] }, input).profiles[0];
  assert.deepEqual(result.facts, input.profiles[0].facts);
  assert.deepEqual(result.updates, []);
  assert.ok(result.pendingResults.every(item => item.status === 'deferred'));
  assert.deepEqual(input, before);
  const wire = prepareMemoryWireExtraction(input, 1000000);
  assert.equal(JSON.parse(wire.userContent).profileProposalProtocol, 'delta-v1');
  assert.match(wire.systemPrompt, /changes:\[\]/);
  const legacy = structuredClone(input); delete legacy.profileProposalProtocol;
  const omitted = { facts: legacy.profiles[0].facts.flatMap((_, index) => index === 44 ? [] : [{ keep: `f${index}` }]) };
  assert.throws(() => decode(omitted, legacy), /单人物画像提案/);
  assert.throws(() => decode({ changes: [] }, legacy), /单人物画像提案/);
  assert.throws(() => decode({ ...omitted, changes: [] }, input), /单人物画像提案/);
  assert.equal(checked({ facts: legacy.profiles[0].facts.map((_, index) => ({ keep: `f${index}` })) }, legacy).profiles[0].facts.length, 46);
});

test('delta-v1只纠正一项仍保留其他45条，pending只按显式q引用合并', () => {
  const input = inputWithFacts();
  const result = checked({ changes: [{ content: '现在喜欢茶', replaces: ['f24'], sources: ['q0'] }] }, input).profiles[0];
  assert.deepEqual(result.facts.slice(0, 45), input.profiles[0].facts.filter((_, index) => index !== 24));
  assert.equal(result.facts[45].content, '现在喜欢茶');
  assert.deepEqual(result.updates.map(item => [item.factIndex, item.baselineFactIndexes]), [[45, [24]]]);
  assert.deepEqual(result.pendingResults, [{ pendingId: 'p0', status: 'merged', factIndex: 45 }, { pendingId: 'p1', status: 'deferred' }]);
  const messageOnly = checked({ changes: [{ content: '现在喜欢茶', sources: [sourceRef(input)] }] }, input).profiles[0];
  assert.ok(messageOnly.pendingResults.every(item => item.status === 'deferred'));
});

test('delta-v1拒绝重复替换、非法引用、越界来源及版本，容量和恢复时间边界继续有效', () => {
  const input = inputWithFacts(), change = { content: '现在喜欢茶', replaces: ['f24'], sources: [sourceRef(input)] };
  for (const changes of [[change, change], [{ ...change, replaces: ['f46'] }], [{ ...change, replaces: ['c24'] }],
    [{ ...change, sources: ['m999'] }], [{ ...change, sources: ['q9'] }], [{ keep: 'f24' }]]) {
    assert.throws(() => decode({ changes }, input), /单人物画像提案/);
  }
  const foreign = { ...input.messages[0], id: 'foreign', conversationId: 'other' };
  input.messages.push(foreign);
  const foreignRef = memoryWireReferences(input).messages.get('foreign');
  assert.throws(() => decode({ changes: [{ ...change, sources: [foreignRef] }] }, input), /单人物画像提案/);
  const result = decode({ changes: [] }, input); result.profiles[0].baseVersion++;
  assert.throws(() => validateExtract(result, input), /版本/);
  assert.throws(() => checked({ changes: [{ content: '新事实', sources: [sourceRef(input)] }] }, inputWithFacts(80)), /容量/);
  const later = { ...input.profileSources[0], createdAt: '2026-10-03T00:00:00Z' };
  input.profileSources = [later];
  assert.throws(() => checked({ changes: [change] }, input), /较早来源|较新的/);
  assert.throws(() => assertCurrentMemoryProtocol({ ...input, profileProposalProtocol: 'unknown' }), /增量提案协议/);
});

test('delta-v1容量提炼继承候选新增facts、原基线updates和pending，cN合并不混用fN', () => {
  const input = inputWithFacts(79);
  const candidate = decode({ changes: [{ content: '喜欢茶', sources: ['q0'] }, { content: '喜欢阅读', sources: ['q1'] }] }, input).profiles[0];
  const refinement = { ...input, profileRefinement: { candidate } };
  const unchanged = decode({ changes: [] }, refinement).profiles[0];
  assert.deepEqual(unchanged.facts, candidate.facts);
  assert.deepEqual(unchanged.updates, candidate.updates);
  assert.deepEqual(unchanged.pendingResults, candidate.pendingResults);
  assert.throws(() => validateExtract({ profiles: [unchanged] }, refinement), /容量/);
  const result = checked({ changes: [{ content: '稳定偏好0和1', replaces: ['c0', 'c1'] }] }, refinement).profiles[0];
  assert.equal(result.facts.length, 80);
  assert.ok(result.facts.some(fact => fact.content === '喜欢茶'));
  assert.ok(result.facts.some(fact => fact.content === '喜欢阅读'));
  const compactedIndex = result.facts.findIndex(fact => fact.content === '稳定偏好0和1');
  assert.deepEqual(result.updates.find(item => item.factIndex === compactedIndex).baselineFactIndexes, [0, 1]);
  for (const outcome of result.pendingResults) assert.equal(result.facts[outcome.factIndex].content, outcome.pendingId === 'p0' ? '喜欢茶' : '喜欢阅读');
  const mergedNew = checked({ changes: [{ content: '喜欢茶和阅读', replaces: ['c79', 'c80'] }] }, refinement).profiles[0];
  assert.deepEqual(mergedNew.pendingResults.map(item => item.factIndex), [79, 79]);
  assert.deepEqual(mergedNew.updates[0].baselineFactIndexes, []);
  assert.equal(mergedNew.updates[0].evidence.length, 1);
  assert.throws(() => decode({ changes: [{ content: '混用引用', replaces: ['f0'] }] }, refinement), /单人物画像提案/);
  assert.throws(() => decode({ changes: [], discardPending: ['q0'] }, refinement), /单人物画像提案/);
  assert.throws(() => decode({ changes: [] }, { ...refinement, profileRefinement: { candidate: { ...candidate, baseVersion: 8 } } }), /单人物画像提案/);
  const wire = prepareMemoryWireExtraction(refinement, 1000000);
  assert.equal(JSON.parse(wire.userContent).candidate[80].id, 'c80');
});

test('新捕获与检查点保存delta-v1，恢复拒绝将旧进度混入新增量任务', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-delta-progress-')), path = join(dir, 'store.sqlite');
  const store = new ConversationStore(path), workers = [];
  t.after(async () => { await Promise.all(workers.map(worker => worker.close())); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const room = store.ensureConversation('room', '/unused.jsonl', { channel: 'qq', accountId: 'test', roomType: 'group', roomId: 'room' });
  store.recordInbound(room.id, '我喜欢茶', { eventId: '1', senderId: 'alice', modelInputText: '我喜欢茶' });
  const now = Date.now();
  store.autoMemory.reserveMaterialsIfDue(room.id, now);
  const job = store.autoMemory.reserveMaterialsIfDue(room.id, now + 600001); assert.ok(job);
  const claimed = store.autoMemory.claimNext(room.id, { owner: 'delta-test', leaseMs: 60000, pipeline: 'materials' });
  const input = store.autoMemory.taskInput(claimed); assert.equal(input.profileProposalProtocol, 'delta-v1');
  const checkpoint = { materialsProtocol: 3, version: 3, profileBaselineProtocol: 1, profileAttributionProtocol: 1, selfProfileProtocol: 2,
    remaining: [], profiles: input.profiles, extract: { topics: [], fragments: [], profiles: [], ignoredMessageIds: [], processedRanges: [] } };
  store.autoMemory.saveProgress(claimed.id, claimed.leaseToken, checkpoint);
  let calls = 0;
  const worker = new BackgroundMemory({ contextWindow: 1000000, memory: { enabled: true, timeoutMs: 1000, maxCalls: 1 } }, store.autoMemory, room.id,
    { extract: async () => { calls++; throw new Error('unexpected model call'); } }, { pipeline: 'materials', jobIds: [job.id] });
  workers.push(worker);
  assert.equal(worker.readProgress(claimed, input, undefined, true).profileProposalProtocol, 'delta-v1');
  assert.throws(() => worker.readProgress(claimed, input), /协议已变更/);
  assert.equal(calls, 0);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare('SELECT input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id);
    assert.equal(JSON.parse(row.input_json).profileProposalProtocol, 'delta-v1');
    assert.deepEqual(JSON.parse(row.progress_json), checkpoint);
  } finally { db.close(); }
  checkpoint.profileProposalProtocol = 'delta-v1';
  store.autoMemory.saveProgress(claimed.id, claimed.leaseToken, checkpoint);
  assert.equal(worker.readProgress(claimed, input).profileProposalProtocol, 'delta-v1');
});

test('delta-v1工作器容量提炼仅消费一次共享预算，保留候选新增事实和pending审计', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pa-delta-capacity-')), path = join(dir, 'store.sqlite');
  const store = new ConversationStore(path); let worker;
  t.after(async () => { await worker?.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const room = store.ensureConversation('room', '/unused.jsonl', { channel: 'qq', accountId: 'test', roomType: 'group', roomId: 'room' });
  store.recordInbound(room.id, '我喜欢茶和阅读', { eventId: '1', senderId: 'alice', modelInputText: '我喜欢茶和阅读' });
  const source = store.externalMessage(room.id, '1').id;
  const person = store.autoMemory.personForActor(store.findActor(room.id, 'alice'));
  store.autoMemory.addProfilePending(person, source, '我喜欢茶和阅读', 'self');
  const now = Date.now(); store.autoMemory.reserveMaterialsIfDue(room.id, now);
  const job = store.autoMemory.reserveMaterialsIfDue(room.id, now + 600001); assert.ok(job);
  const calls = [];
  worker = new BackgroundMemory({ contextWindow: 1000000, memory: { enabled: true, timeoutMs: 1000, maxCalls: 3 } }, store.autoMemory, room.id,
    { extract: async input => {
      calls.push(input.mode === 'profiles' ? input.profileRefinement ? 'refine' : 'profile' : input.mode);
      if (input.mode === 'messages') return { topics: [], fragments: [], profiles: [], ignoredMessageIds: [] };
      assert.equal(input.profileProposalProtocol, 'delta-v1');
      if (!input.profileRefinement) return decode({ changes: Array.from({ length: 81 }, (_, index) => ({
        content: `偏好${index}`, sources: [index === 0 ? 'q0' : memoryWireReferences(input).messages.get(source)],
      })) }, input);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const checkpoint = JSON.parse(db.prepare('SELECT progress_json FROM auto_memory_jobs WHERE id=?').get(job.id).progress_json);
        assert.equal(checkpoint.profileProposalProtocol, 'delta-v1');
        assert.deepEqual(checkpoint.capacityRecovery.attemptedPersonIds, [person]);
        assert.equal(checkpoint.capacityRecovery.result.profiles[0].facts.length, 81);
      } finally { db.close(); }
      return decode({ changes: [{ content: '偏好0和1', replaces: ['c0', 'c1'] }] }, input);
    } }, { pipeline: 'materials', jobIds: [job.id] });
  worker.start(); await worker.wait();
  assert.deepEqual(calls, ['messages', 'profile', 'refine']);
  assert.equal(store.autoMemory.listJobs().find(item => item.id === job.id).status, 'done');
  const profile = store.autoMemory.profile(person);
  assert.equal(profile.facts.length, 80);
  assert.ok(profile.facts.some(item => item.content === '偏好80'));
  assert.equal(profile.pending.length, 0);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT text FROM messages WHERE id=?').get(source).text, '我喜欢茶和阅读');
    const outcome = db.prepare('SELECT outcome,fact_index FROM person_profile_pending_results WHERE job_id=?').get(job.id);
    assert.equal(outcome.outcome, 'merged'); assert.equal(profile.facts[outcome.fact_index].content, '偏好0和1');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});
