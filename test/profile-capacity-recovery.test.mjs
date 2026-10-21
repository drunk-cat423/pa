import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { BackgroundMemory, validateExtract } from '../dist/auto-memory.js';
import { MemoryProviderError } from '../dist/memory-diagnostics.js';
import { PERSON_PROFILE_TARGET, profileCapacity } from '../dist/profile-limits.js';
import { emptyExtraction } from './fixtures/memory-output.mjs';

const config = (maxCalls = 0) => ({ contextWindow: 100_000,
  memory: { enabled: true, maxCalls, maxOutputTokens: 8192, timeoutMs: 3000 } });
const fact = (content, messageIds, sourceType = 'self') => ({ content, sourceType, messageIds });
const evidence = source => ({ messageId: source.id, factQuote: source.text, subjectKind: 'self', subjectQuote: '我' });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pa-profile-capacity-'));
  const path = join(directory, 'store.sqlite');
  let store = new ConversationStore(path), sequence = 0, scheduleTime = 1000;
  const route = { channel: 'qq', accountId: 'capacity-test', roomType: 'group', roomId: 'capacity-room' };
  const room = store.ensureConversation('capacity-room', '/capacity-room.jsonl', route);
  const workers = [];
  t.after(async () => { for (const worker of workers) await worker.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    path, room, get store() { return store; },
    inbound(text, senderId = 'alice') {
      const eventId = String(++sequence);
      store.recordInbound(room.id, text, { eventId, senderId, senderName: senderId, modelInputText: text });
      const id = store.externalMessage(room.id, eventId).id;
      const actor = store.findActor(room.id, senderId);
      return { id, text, personId: store.autoMemory.personForActor(actor), role: 'user' };
    },
    reserve() {
      const first = scheduleTime;
      scheduleTime += 700_000;
      store.autoMemory.reserveMaterialsIfDue(room.id, first);
      const job = store.autoMemory.reserveMaterialsIfDue(room.id, first + 600_000);
      assert.ok(job, 'expected a due materials batch');
      return job;
    },
    addPending(personId, source, content) {
      store.autoMemory.addProfilePending(personId, source.id, content, 'self');
    },
    inspect(action) { const db = new DatabaseSync(path); try { return action(db); } finally { db.close(); } },
    worker(jobId, provider, settings = config(), separateMaterialSteps = true) {
      const worker = new BackgroundMemory(settings, store.autoMemory, room.id, provider,
        { pipeline: 'materials', jobIds: [jobId], separateMaterialSteps });
      workers.push(worker); return worker;
    },
  };
}

function empty(input, summary) { return emptyExtraction(input, summary); }
function profileStep(input, profiles) { return { profiles }; }
function longText(suffix = '稳定偏好') { return `我长期喜欢${suffix}，并且在今后的生活中会继续保持这项偏好。${'长期'.repeat(55)}`; }
function tooLongFact(source) { return fact(source.text, [source.id]); }

function oversizedProposal(input, source, { keepPending = true } = {}) {
  return profileStep(input, input.profiles.map(baseline => ({
    ...baseline,
    facts: [...baseline.facts, tooLongFact(source)],
    updates: [{
      factIndex: baseline.facts.length,
      baselineFactIndexes: [],
      evidence: [evidence(source)],
    }],
    pendingResults: (baseline.pending ?? []).map(pending => ({
      pendingId: pending.id,
      status: keepPending ? 'deferred' : 'not_profile',
      ...(keepPending ? {} : { reason: 'not_personal' }),
    })),
  })));
}

function refinementProposal(input, { invalidBaselineIndex = false } = {}) {
  const baseline = input.profiles[0];
  const candidate = input.profileRefinement.candidate;
  const source = input.messages.find(message => candidate.facts.some(item => item.messageIds.includes(message.id)))
    ?? input.profileSources.find(message => candidate.facts.some(item => item.messageIds.includes(message.id)));
  const refined = {
    ...baseline,
    facts: [...baseline.facts, fact('长期喜欢徒步旅行', [source.id])],
    updates: [{ factIndex: baseline.facts.length, baselineFactIndexes: invalidBaselineIndex ? [0] : [],
      evidence: invalidBaselineIndex ? [] : [evidence(source)] }],
    pendingResults: (baseline.pending ?? []).map(pending => ({ pendingId: pending.id, status: 'deferred' })),
  };
  return profileStep(input, [refined]);
}

async function run(worker, timeout = 10_000) {
  worker.start();
  await worker.wait(undefined, timeout, 'materials');
}

async function seedBaseline(f, senderId = 'alice') {
  const source = f.inbound('我长期喜欢徒步', senderId);
  const job = f.reserve();
  const worker = f.worker(job.id, { extract: async (input, _signal, options) => {
    options.onCall(`seed-${input.mode}`);
    if (input.mode !== 'profiles') return empty(input);
    const baseline = input.profiles[0];
    return profileStep(input, [{ ...baseline, facts: [fact('长期喜欢徒步', [source.id])],
      updates: [{ factIndex: 0, baselineFactIndexes: [], evidence: [evidence(source)] }],
      pendingResults: (baseline.pending ?? []).map(pending => ({ pendingId: pending.id, status: 'deferred' })) }]);
  } });
  await run(worker);
  assert.equal(f.store.autoMemory.profile(source.personId).facts[0].content, '长期喜欢徒步');
  return source;
}

test('legal oversized live profile is refined once from the original baseline; topic, source, revision, and pending survive', async t => {
  const f = fixture(t);
  const priorSource = await seedBaseline(f);
  f.addPending(priorSource.personId, priorSource, '我长期喜欢徒步');
  const source = f.inbound(longText('徒步旅行'));
  const job = f.reserve();
  const profileInputs = [], calls = [];
  const worker = f.worker(job.id, { extract: async (input, _signal, options) => {
    options.onCall(`success-${calls.length}`); calls.push(input.profileRefinement ? 'refine' : input.mode ?? 'all');
    if (input.mode === 'messages') return { ...empty(input), topics: [{ summary: '徒步旅行计划', messageIds: [] }] };
    if (input.profileRefinement) {
      profileInputs.push(structuredClone(input));
      return refinementProposal(input);
    }
    profileInputs.push(structuredClone(input));
    return oversizedProposal(input, source);
  } });
  await run(worker);

  assert.deepEqual(calls, ['messages', 'profiles', 'refine']);
  assert.equal(profileInputs.length, 2);
  assert.equal(profileInputs[1].profiles[0].facts.length, 1, 'refinement profiles must be the trusted persisted baseline');
  assert.equal(profileInputs[1].profileRefinement.candidate.facts.length, 2, 'the oversized extraction is only a separate candidate');
  assert.ok(profileInputs[1].profileOutputTarget.maxFacts < PERSON_PROFILE_TARGET.maxFacts);
  assert.ok(profileInputs[1].profileOutputTarget.maxContentBytes < PERSON_PROFILE_TARGET.maxContentBytes);
  const finalProfile = f.store.autoMemory.profile(source.personId);
  assert.deepEqual(finalProfile.facts.map(item => item.content), ['长期喜欢徒步', '长期喜欢徒步旅行']);
  assert.equal(finalProfile.pending.length, 1, 'deferred pending remains active after refinement');
  assert.equal(finalProfile.baseVersion, 2);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM person_profile_revisions WHERE person_id=?').get(source.personId).n), 2);
  assert.equal(f.inspect(db => db.prepare('SELECT text FROM messages WHERE id=?').get(source.id).text), source.text);
  assert.equal(f.store.autoMemory.searchTopics(f.room.id, { text: '徒步旅行' }).topics.length, 1);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM memory_topic_scopes').get().n), 1);
});

test('all profile evidence and subjects validate before any over-capacity person is refined', async t => {
  const f = fixture(t), oldBobSource = await seedBaseline(f, 'bob');
  f.addPending(oldBobSource.personId, oldBobSource, '我长期喜欢徒步');
  const alice = f.inbound(longText('阅读'));
  f.inbound('我今天继续关注音乐', 'bob');
  const job = f.reserve(), refinementCalls = [];
  const worker = f.worker(job.id, { extract: async (input, _signal, options) => {
    options.onCall(`invalid-${input.mode}`);
    if (input.mode === 'messages') throw new Error('expected combined extraction');
    if (input.profileRefinement) { refinementCalls.push(input.profileRefinement.candidate.personId); return refinementProposal(input); }
    assert.equal(input.profiles.length, 2, 'both people must be checked in the same combined result');
    assert.equal(input.profiles.find(profile => profile.personId === oldBobSource.personId).pending.length, 1);
    const first = input.profiles.find(profile => profile.personId === alice.personId);
    const second = input.profiles.find(profile => profile.personId === oldBobSource.personId);
    return { ...empty(input), profiles: [
      { ...first, facts: [tooLongFact(alice)], updates: [{ factIndex: 0, baselineFactIndexes: [], evidence: [evidence(alice)] }], pendingResults: [] },
      { ...second, facts: second.facts },
    ] };
  } }, config(), false);
  await assert.rejects(run(worker), /失败/);
  assert.deepEqual(refinementCalls, []);
  assert.equal(f.store.autoMemory.status(f.room.id, 'materials', [job.id]).deferred, 0);
  const failed = f.inspect(db => db.prepare('SELECT error,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id));
  assert.match(failed.error, /\[profile_contract\]/);
  assert.ok(failed.progress_json === null || JSON.parse(failed.progress_json).capacityRecovery === undefined);
  assert.equal(f.store.autoMemory.profile(alice.personId).facts.length, 0);
  assert.equal(f.store.autoMemory.profile(oldBobSource.personId).baseVersion, 1);
  assert.deepEqual(f.store.autoMemory.profile(oldBobSource.personId).facts.map(item => item.content), ['长期喜欢徒步']);
  assert.equal(f.store.autoMemory.profile(oldBobSource.personId).pending.length, 1);
});

test('a crash after refined progress is durable resumes the pending commit without either model call', async t => {
  const f = fixture(t), source = f.inbound(longText('徒步')), job = f.reserve(), calls = [];
  const save = f.store.autoMemory.saveProgress.bind(f.store.autoMemory);
  let crashAfterRefineSave = true;
  f.store.autoMemory.saveProgress = (jobId, lease, progress) => {
    const saved = save(jobId, lease, progress);
    const refined = progress.capacityRecovery?.attemptedPersonIds.length > 0
      && progress.capacityRecovery.result.profiles.every(profile => !profileCapacity(profile).exceedsLimits);
    if (crashAfterRefineSave && refined) {
      crashAfterRefineSave = false;
      throw new Error('crash after durable refined checkpoint');
    }
    return saved;
  };
  const first = f.worker(job.id, { extract: async (input, _signal, options) => {
    options.onCall(`durable-first-${calls.length}`);
    calls.push(input.profileRefinement ? 'refine' : input.mode ?? 'combined');
    if (input.mode === 'messages') return { ...empty(input), topics: [{ summary: 'durable topic', messageIds: [] }] };
    return input.profileRefinement ? refinementProposal(input) : oversizedProposal(input, source);
  } });
  await assert.rejects(run(first), /失败/);
  const interrupted = f.inspect(db => db.prepare('SELECT status,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id));
  assert.equal(interrupted.status, 'failed');
  assert.ok(JSON.parse(interrupted.progress_json).capacityRecovery.result.profiles.every(profile => !profileCapacity(profile).exceedsLimits));
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM auto_memory_job_deferrals WHERE job_id=?').get(job.id).n), 0);

  const resumed = f.worker(job.id, { extract: async () => { calls.push('unexpected-call'); throw new Error('must resume from checkpoint'); } });
  resumed.retry(job.id);
  await resumed.wait(undefined, 10_000, 'materials');
  assert.deepEqual(calls, ['messages', 'profiles', 'refine']);
  assert.equal(f.store.autoMemory.status(f.room.id, 'materials', [job.id]).completed, 1);
  assert.equal(f.store.autoMemory.searchTopics(f.room.id, { text: 'durable topic' }).topics.length, 1);
  assert.deepEqual(f.store.autoMemory.profile(source.personId).facts.map(item => item.content), ['长期喜欢徒步旅行']);
});

test('a crash after marking refinement attempted never resends the unknown call on explicit retry', async t => {
  const f = fixture(t), source = f.inbound(longText('划船')), job = f.reserve(), calls = [];
  const first = f.worker(job.id, { extract: async (input, _signal, options) => {
    const mode = input.profileRefinement ? 'refine' : input.mode ?? 'combined';
    calls.push(mode); options.onCall(`unknown-crash-${calls.length}`);
    if (mode === 'messages') return empty(input);
    if (mode === 'refine') throw new Error('crash with unknown provider outcome');
    return oversizedProposal(input, source);
  } });
  await assert.rejects(run(first), /失败/);
  const attempted = f.inspect(db => db.prepare('SELECT status,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id));
  assert.equal(attempted.status, 'failed');
  assert.deepEqual(JSON.parse(attempted.progress_json).capacityRecovery.attemptedPersonIds, [source.personId]);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM auto_memory_job_deferrals WHERE job_id=?').get(job.id).n), 0);

  const retry = f.worker(job.id, { extract: async () => { calls.push('unexpected-retry'); throw new Error('unknown call must not be replayed'); } });
  retry.retry(job.id);
  await retry.wait(undefined, 10_000, 'materials');
  assert.deepEqual(calls, ['messages', 'profiles', 'refine']);
  assert.equal(f.store.autoMemory.status(f.room.id, 'materials', [job.id]).deferred, 1);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM auto_memory_job_deferrals WHERE job_id=?').get(job.id).n), 1);
  assert.deepEqual(JSON.parse(f.inspect(db => db.prepare('SELECT progress_json FROM auto_memory_jobs WHERE id=?').get(job.id)).progress_json)
    .capacityRecovery.attemptedPersonIds, [source.personId]);
});

test('exhausted refinement defers the frozen batch, preserves its state, and lets later materials complete', async t => {
  const f = fixture(t);
  const prior = await seedBaseline(f);
  f.addPending(prior.personId, prior, '我长期喜欢徒步');
  const source = f.inbound(longText('爬山'));
  const oldJob = f.reserve(), stale = {};
  const oldWorker = f.worker(oldJob.id, { extract: async (input, _signal, options) => {
    options.onCall(`exhaust-${input.mode}`);
    if (input.mode === 'messages') return { ...empty(input), topics: [{ summary: '原批次话题', messageIds: [] }] };
    if (input.profileRefinement) { stale.lease = input.job.leaseToken; return oversizedProposal(input, source); }
    stale.lease = input.job.leaseToken;
    return oversizedProposal(input, source);
  } });
  await run(oldWorker);

  const saved = f.inspect(db => db.prepare('SELECT status,input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(oldJob.id));
  const progress = JSON.parse(saved.progress_json);
  assert.equal(saved.status, 'failed');
  assert.deepEqual(progress.capacityRecovery.attemptedPersonIds, [source.personId]);
  assert.equal(progress.capacityRecovery.result.topics.length, 0);
  assert.equal(progress.extract.topics.length, 1);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM auto_memory_job_deferrals WHERE job_id=?').get(oldJob.id).n), 1);
  assert.equal(f.store.autoMemory.profile(source.personId).baseVersion, 1);
  assert.equal(f.store.autoMemory.profile(source.personId).pending.length, 1);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM memory_topic_scopes').get().n), 0);
  assert.throws(() => f.store.autoMemory.retry(oldJob.id), /搁置/);
  assert.throws(() => f.store.autoMemory.commit(oldJob.id, stale.lease, progress.capacityRecovery.result), /租约/);

  const later = f.inbound('今天继续整理新的事项');
  const nextJob = f.reserve();
  const laterWorker = f.worker(nextJob.id, { extract: async (input, _signal, options) => {
    options.onCall(`later-${input.mode}`);
    if (input.mode === 'messages') return { ...empty(input), topics: [{ summary: '后续批次话题', messageIds: [] }] };
    return profileStep(input, input.profiles.map(profile => ({ ...profile,
      pendingResults: (profile.pending ?? []).map(item => ({ pendingId: item.id, status: 'deferred' })) })));
  } });
  await run(laterWorker);
  assert.equal(f.store.autoMemory.status(f.room.id, 'materials', [nextJob.id]).completed, 1);
  assert.equal(f.store.autoMemory.profile(later.personId).baseVersion, 2);
  assert.equal(f.inspect(db => db.prepare('SELECT status,input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(oldJob.id)).input_json, saved.input_json);
  assert.deepEqual(JSON.parse(f.inspect(db => db.prepare('SELECT progress_json FROM auto_memory_jobs WHERE id=?').get(oldJob.id)).progress_json)
    .capacityRecovery.attemptedPersonIds, [source.personId]);
});

test('budget exhaustion saves the ready candidate and explicit retry calls only profile refinement', async t => {
  const f = fixture(t), source = f.inbound(longText('露营')), job = f.reserve(), modes = [];
  const first = f.worker(job.id, { extract: async (input, _signal, options) => {
    options.onCall(`budget-first-${modes.length}`); modes.push(input.mode ?? 'combined');
    if (input.mode === 'messages') return empty(input);
    return oversizedProposal(input, source);
  } }, config(2));
  await assert.rejects(run(first), /失败/);
  assert.deepEqual(modes, ['messages', 'profiles']);
  let saved = f.inspect(db => db.prepare('SELECT status,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id));
  assert.equal(saved.status, 'failed');
  assert.deepEqual(JSON.parse(saved.progress_json).capacityRecovery.attemptedPersonIds, []);

  const second = f.worker(job.id, { extract: async (input, _signal, options) => {
    options.onCall(`budget-retry-${modes.length}`); modes.push(input.profileRefinement ? 'refine' : input.mode ?? 'combined');
    return refinementProposal(input);
  } }, config());
  second.retry(job.id);
  await second.wait(undefined, 10_000, 'materials');
  assert.deepEqual(modes, ['messages', 'profiles', 'refine']);
  assert.equal(f.store.autoMemory.profile(source.personId).facts[0].content, '长期喜欢徒步旅行');
});

test('unknown refinement response is attempted once and its candidate checkpoint stays deferred', async t => {
  const f = fixture(t), source = f.inbound(longText('游泳')), job = f.reserve(), modes = [];
  const worker = f.worker(job.id, { extract: async (input, _signal, options) => {
    const mode = input.profileRefinement ? 'refine' : input.mode ?? 'combined';
    modes.push(mode); options.onCall(`unknown-${modes.length}`);
    if (mode === 'messages') return empty(input);
    if (mode === 'refine') throw new MemoryProviderError('model_request', 'request outcome unknown');
    return oversizedProposal(input, source);
  } });
  await run(worker);
  assert.deepEqual(modes, ['messages', 'profiles', 'refine']);
  const row = f.inspect(db => db.prepare('SELECT status,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id));
  assert.equal(row.status, 'failed');
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM auto_memory_job_deferrals WHERE job_id=?').get(job.id).n), 1);
  assert.deepEqual(JSON.parse(row.progress_json).capacityRecovery.attemptedPersonIds, [source.personId]);
  assert.throws(() => f.store.autoMemory.retry(job.id), /搁置/);
  assert.deepEqual(modes, ['messages', 'profiles', 'refine']);
});

test('a candidate cannot be cited as the trusted baseline to bypass source validation', async t => {
  const f = fixture(t), source = f.inbound(longText('钓鱼')), job = f.reserve(), modes = [];
  const worker = f.worker(job.id, { extract: async (input, _signal, options) => {
    const mode = input.profileRefinement ? 'refine' : input.mode ?? 'combined';
    modes.push(mode); options.onCall(`baseline-${modes.length}`);
    if (mode === 'messages') return empty(input);
    if (mode === 'refine') return refinementProposal(input, { invalidBaselineIndex: true });
    return oversizedProposal(input, source);
  } });
  await assert.rejects(run(worker), /失败/);
  assert.deepEqual(modes, ['messages', 'profiles', 'refine']);
  const row = f.inspect(db => db.prepare('SELECT status,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id));
  assert.equal(row.status, 'failed');
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM auto_memory_job_deferrals WHERE job_id=?').get(job.id).n), 0);
  assert.deepEqual(JSON.parse(row.progress_json).capacityRecovery.attemptedPersonIds, [source.personId]);
  assert.equal(f.store.autoMemory.profile(source.personId).facts.length, 0);
});
