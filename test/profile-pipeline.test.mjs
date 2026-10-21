import assert from 'node:assert/strict';
import test from 'node:test';
import { BackgroundMemory, validateExtract } from '../dist/auto-memory.js';
import { MemoryInputTooLargeError, prepareMemoryExtraction } from '../dist/memory-provider.js';

const fact = (content, id, sourceType = 'self') => ({ content, sourceType, messageIds: [id] });
const message = (id, personId = 'alice', ingestSeq = 1, role = 'user') => ({ id, personId, role, text: id,
  conversationId: 'room', ingestSeq, createdAt: '2026-10-16T00:00:00Z' });
const profile = (personId = 'alice', facts = []) => ({ personId, baseVersion: 1, facts });
const inputFor = (profiles = [profile()]) => ({ profileProtocol: 2, roomType: 'group',
  job: { id: 'job', conversationId: 'room', reason: 'capacity', status: 'running', startSeq: 1, endSeq: 1,
    messageIds: ['current'], attempts: 1 }, messages: [message('current')], profiles });
const ignored = input => ({ profiles: [], topics: [], fragments: [], ignoredMessageIds: input.messages.filter(item => item.role === 'user').map(item => item.id),
  ...(input.roomType === 'private' ? { continuationSummary: '继续处理已有决定。' } : {}) });

function workerFixture(t, input, extract, saved) {
  let state = 'queued';
  let progress = saved;
  let completed;
  const failures = [];
  const checkpoints = [];
  const store = {
    reserveBatch() {},
    reserveCompressionBatch() {},
    reserveMaterialsIfDue() {},
    claimNext(_conversationId, options) {
      if (options?.pipeline !== 'legacy' || state !== 'queued') return;
      state = 'running'; return { ...input.job, pipeline: 'legacy', leaseToken: 'lease' };
    },
    taskInput() { return structuredClone(input); },
    assertProfileEvidenceCurrent() {}, renewLease() {},
    loadProgress() { return progress === undefined ? undefined : structuredClone(progress); },
    saveProgress(_id, _lease, value) { progress = structuredClone(value); checkpoints.push(structuredClone(value)); },
    clearProgress() { progress = undefined; },
    fail(_id, _lease, error) { state = 'failed'; failures.push(error); },
    retry() { state = 'queued'; },
    commit(_id, _lease, value) { completed = structuredClone(value); state = 'done'; },
    status(_conversationId, pipeline) { if (pipeline && pipeline !== 'legacy') return { queued: 0, running: 0, failed: 0, completed: 0 };
      return { queued: Number(state === 'queued'), running: Number(state === 'running'), failed: Number(state === 'failed'),
      completed: Number(state === 'done') }; },
    materialSchedule() { return { reservedSeq: 0, completedSeq: 0 }; },
  };
  const worker = new BackgroundMemory({ contextWindow: 100000, memory: { enabled: true, maxCalls: 0, timeoutMs: 1000 } }, store, 'room', { extract });
  t.after(() => worker.close());
  return { worker, checkpoints, failures, get progress() { return progress; }, get completed() { return completed; } };
}

test('new profile protocol rewrites from all frozen personal facts and preserves hard capacity after deduplication', () => {
  const baseline = profile('alice', Array.from({ length: 60 }, (_, i) => fact(`历史事实${i}`, `old-${i}`)));
  const input = { ...inputFor([baseline]), profileSources: baseline.facts.map((_, i) => message(`old-${i}`)) };
  assert.throws(() => validateExtract(ignored(input), input), /遗漏/);
  const result = validateExtract({ ...ignored(input), profiles: [{ ...baseline, facts: [fact('合并后的稳定偏好', 'old-29')] }] }, input);
  assert.equal(result.profiles[0].facts.length, 1);
  assert.equal(result.profiles[0].facts[0].content, '合并后的稳定偏好');
  const crossPerson = { ...input, profiles: [...input.profiles, profile('bob', [fact('另一个人', 'bob-source')])],
    profileSources: [...input.profileSources, message('bob-source', 'bob')] };
  assert.throws(() => validateExtract({ ...ignored(input), profiles: [{ ...baseline, facts: [fact('借用他人的证据', 'bob-source', 'third_party')] }] }, crossPerson), /有效原始真人/);
  const mergedSources = { ...inputFor(), profileSources: Array.from({ length: 6 }, (_, i) => message(`source-${i}`)),
    profiles: [profile('alice', Array.from({ length: 6 }, (_, i) => fact(`旧${i}`, `source-${i}`)))] };
  const merged = validateExtract({ ...ignored(mergedSources), profiles: [profile('alice', Array.from({ length: 6 }, (_, i) => fact('同一事实', `source-${i}`)))] }, mergedSources);
  assert.equal(merged.profiles[0].facts.length, 1);
  assert.equal(merged.profiles[0].facts[0].messageIds.length, 6);
  assert.throws(() => validateExtract({ ...ignored(mergedSources), profiles: [profile('alice', [
    { ...fact('同一事实', 'source-0'), messageIds: [...merged.profiles[0].facts[0].messageIds, 'forged'] },
  ])] }, mergedSources), /有效原始真人/);
});

test('modes enforce independent message coverage, private fragments, and profiles-only results', () => {
  const input = { ...inputFor(), roomType: 'private', mode: 'profiles' };
  assert.equal(validateExtract({ profiles: [profile()] }, input).profiles.length, 1);
  assert.throws(() => validateExtract({ profiles: [] }, input), /遗漏/);
  assert.throws(() => validateExtract({ profiles: [profile()], topics: [{ summary: '不允许', messageIds: ['current'] }] }, input), /只能返回/);
  const messagesInput = { ...input, mode: 'messages' };
  assert.doesNotThrow(() => validateExtract(ignored(messagesInput), messagesInput));
  assert.throws(() => validateExtract({ ...ignored(messagesInput), profiles: [profile()] }, messagesInput), /消息任务/);
  assert.throws(() => validateExtract({ ...ignored(messagesInput), fragments: [{ personId: 'alice', ...fact('稳定偏好', 'current') }] }, messagesInput), /消息任务/);
  const prepared = prepareMemoryExtraction(input, 100000);
  assert.match(prepared.systemPrompt, /mode=profiles/);
  assert.match(prepared.systemPrompt, /完整最终facts/);
  assert.doesNotMatch(prepared.systemPrompt, /未给出的旧事实由/);
});

test('pending fact indices follow duplicate merging without accepting malformed original indices', () => {
  const baseline = { ...profile(), pending: [{ id: 'pending', sourceMessageId: 'current', content: '喜欢茶', sourceType: 'self' }] };
  const input = inputFor([baseline]);
  const proposal = { ...ignored(input), profiles: [{ ...profile('alice', [fact('喜欢茶', 'current'), fact('喜欢茶', 'current')]),
    pendingResults: [{ pendingId: 'pending', status: 'merged', factIndex: 1 }] }] };
  const result = validateExtract(proposal, input);
  assert.equal(result.profiles[0].facts.length, 1);
  assert.equal(result.profiles[0].pendingResults[0].factIndex, 0);
  proposal.profiles[0].pendingResults[0].factIndex = '0';
  assert.throws(() => validateExtract(proposal, input), /处理结果无效/);
});

test('profile rewrites cannot promote frozen third-party or inferred evidence to self statements', () => {
  const baseline = profile('alice', [fact('可能喜欢茶', 'old', 'inference')]);
  const input = { ...inputFor([baseline]), profileSources: [message('old')] };
  const proposed = { ...ignored(input), profiles: [profile('alice', [fact('喜欢茶', 'old')])] };
  assert.throws(() => validateExtract(proposed, input), /不能把旧转述或推断提升/);
  proposed.profiles[0].facts[0].messageIds = ['current'];
  assert.doesNotThrow(() => validateExtract(proposed, input));
});

test('normal batches make one combined call with complete facts; omitted mandatory compaction fails without retries', async t => {
  const baseline = profile('alice', Array.from({ length: 60 }, (_, i) => fact(`事实${i}`, 'old')));
  const input = { ...inputFor([baseline]), profileSources: [message('old')] };
  const calls = [];
  const f = workerFixture(t, input, async chunk => {
    calls.push(chunk);
    return { ...ignored(chunk), profiles: [profile('alice', [fact('精简事实', 'old')])] };
  });
  f.worker.start(); await f.worker.wait();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, undefined);
  assert.equal(calls[0].profiles[0].facts.length, 60);
  assert.equal(f.completed.profiles[0].facts.length, 1);
  let rejectedCalls = 0;
  const rejected = workerFixture(t, input, async chunk => { rejectedCalls++; return ignored(chunk); });
  rejected.worker.start(); await assert.rejects(rejected.worker.wait(), /失败/);
  assert.equal(rejectedCalls, 1);
  assert.equal(rejected.completed, undefined);
});

test('oversized batches split into durable message/profile work, retry only unfinished work, and relocate merged decisions', async t => {
  const alice = { ...profile('alice', [fact('喜欢茶', 'tea'), fact('喜欢书', 'books')]),
    pending: Array.from({ length: 4 }, (_, i) => ({ id: `pending-${i}`, content: `保存${i}`, sourceType: 'self', sourceMessageId: `pending-source-${i}` })) };
  const bob = profile('bob', [fact('喜欢花', 'flowers')]);
  const input = { ...inputFor([alice, bob]), profileSources: [message('tea'), message('books'), message('flowers', 'bob'),
    ...alice.pending.map((pending, i) => message(pending.sourceMessageId, 'alice', i + 2))] };
  const success = [];
  let failed = false;
  const f = workerFixture(t, input, async chunk => {
    if (!chunk.mode || (chunk.mode === 'profiles' && chunk.profiles.length > 1)) throw new MemoryInputTooLargeError('preflight');
    if (chunk.mode === 'messages') { success.push('messages'); return ignored(chunk); }
    const person = chunk.profiles[0];
    if ((person.pending ?? []).length > 2) throw new MemoryInputTooLargeError('pending split');
    if (person.personId === 'alice') assert.equal(person.facts.length, 2);
    const pendingIds = (person.pending ?? []).map(pending => pending.id);
    if (pendingIds.includes('pending-2') && !failed) { failed = true; throw new Error('explicit retry needed'); }
    success.push(person.personId + ':' + pendingIds.join(','));
    const facts = pendingIds.includes('pending-2') ? [...person.facts].reverse() : person.facts;
    return { profiles: [{ personId: person.personId, baseVersion: person.baseVersion, facts,
      pendingResults: pendingIds.map(pendingId => ({ pendingId, status: 'merged', factIndex: 0 })) }] };
  });
  f.worker.start(); await assert.rejects(f.worker.wait(), /失败/);
  assert.equal(f.progress.version, 2);
  assert.equal(f.progress.remaining[0].pendingIds.includes('pending-2'), true);
  assert.deepEqual(success, ['messages', 'alice:pending-0,pending-1']);
  f.worker.retry('job'); await f.worker.wait();
  assert.deepEqual(success, ['messages', 'alice:pending-0,pending-1', 'alice:pending-2,pending-3', 'bob:']);
  const result = f.completed.profiles.find(person => person.personId === 'alice');
  assert.deepEqual(result.pendingResults.map(outcome => outcome.factIndex), [0, 0, 1, 1]);
  assert.deepEqual(result.facts.map(item => item.content), ['喜欢书', '喜欢茶']);
  assert.equal(result.pending.length, 0);
  assert.equal(f.worker.info().calls, 5);
});

test('old frozen protocols/checkpoints and unfit whole profiles fail without changing stored progress', async t => {
  const legacy = inputFor(); delete legacy.profileProtocol;
  let calls = 0;
  const oldInput = workerFixture(t, legacy, async () => { calls++; });
  oldInput.worker.start(); await assert.rejects(oldInput.worker.wait(), /失败/);
  assert.equal(calls, 0);
  const saved = { remaining: [['current']], profiles: [], extract: { topics: [], profiles: [], fragments: [], ignoredMessageIds: [] } };
  const oldProgress = workerFixture(t, inputFor(), async () => { calls++; }, saved);
  oldProgress.worker.start(); await assert.rejects(oldProgress.worker.wait(), /失败/);
  assert.equal(calls, 0); assert.deepEqual(oldProgress.progress, saved);
  const unfit = workerFixture(t, inputFor(), async () => { calls++; throw new MemoryInputTooLargeError('too big'); });
  unfit.worker.start(); await assert.rejects(unfit.worker.wait(), /失败/);
  assert.equal(unfit.worker.info().calls, 0);
  assert.equal(unfit.completed, undefined);
});

test('later chunks cannot silently discard a previously merged pending binding', async t => {
  const baseline = { ...profile('alice', [fact('喜欢茶', 'old')]), pending: [0, 1].map(index => ({ id: `pending-${index}`,
    sourceMessageId: `pending-source-${index}`, content: `偏好${index}`, sourceType: 'self' })) };
  const input = { ...inputFor([baseline]), profileSources: [message('old'), message('pending-source-0'), message('pending-source-1')] };
  const f = workerFixture(t, input, async chunk => {
    if (!chunk.mode) throw new MemoryInputTooLargeError('combined preflight');
    if (chunk.mode === 'messages') return ignored(chunk);
    const person = chunk.profiles[0];
    if (person.pending.length > 1) throw new MemoryInputTooLargeError('pending preflight');
    const first = person.pending[0].id === 'pending-0';
    return { profiles: [{ ...profile('alice', [first ? fact('喜欢茶', 'old') : fact('喜欢新的东西', 'current')]),
      pendingResults: [{ pendingId: person.pending[0].id, status: 'merged', factIndex: 0 }] }] };
  });
  f.worker.start(); await assert.rejects(f.worker.wait(), /失败/);
  assert.equal(f.completed, undefined);
  assert.deepEqual(f.progress.remaining[0].pendingIds, ['pending-1']);
  assert.equal(f.progress.extract.profiles[0].facts[0].content, '喜欢茶');
  assert.deepEqual(f.progress.extract.profiles[0].pendingResults, [{ pendingId: 'pending-0', status: 'merged', factIndex: 0 }]);
});

test('a call marker prevents oversized-error splitting and keeps the consumed call budget', async t => {
  let calls = 0;
  const f = workerFixture(t, inputFor(), async (_input, _signal, options) => { calls++; options.onCall('actual-call'); throw new MemoryInputTooLargeError('after provider'); });
  f.worker.start(); await assert.rejects(f.worker.wait(), /失败/);
  assert.equal(calls, 1); assert.equal(f.worker.info().calls, 1);
  assert.equal(f.checkpoints.length, 0);
});
