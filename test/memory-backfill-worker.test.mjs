import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../dist/store.js';
import { BackgroundMemory } from '../dist/auto-memory.js';
import { emptyExtraction } from './fixtures/memory-output.mjs';

function fixture(t, roomType = 'group') {
  const directory = mkdtempSync(join(tmpdir(), 'pa-backfill-worker-'));
  const path = join(directory, 'store.sqlite');
  let store = new ConversationStore(path);
  const room = store.ensureConversation('room', '/room.jsonl', {
    channel: 'qq', accountId: 'test', roomType, roomId: 'room',
  });
  let event = 0;
  t.after(async () => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    directory, path, get store() { return store; }, room,
    inbound(text, senderId = 'alice') {
      const external = { eventId: String(++event), senderId, senderName: senderId, modelInputText: text };
      store.recordInbound(room.id, text, external);
      return { ...external, existingMessageId: store.externalMessage(room.id, external.eventId).id };
    },
    reserve(reason = 'test backfill') { return store.autoMemory.reserveMaterialBackfill(room.id, { reason }); },
    run(runId) { return store.autoMemory.materialBackfillRun(runId); },
    worker(runId, extract, separateMaterialSteps = false) {
      return new BackgroundMemory({ contextWindow: 8192, memory: { enabled: true, maxCalls: 20, timeoutMs: 1000 } },
        store.autoMemory, room.id, { extract }, { pipeline: 'materials', jobIds: this.run(runId).jobIds, separateMaterialSteps });
    },
    restart() { store.close(); store = new ConversationStore(path); return store; },
  };
}

function emptyCommit(store, job) {
  store.autoMemory.commit(job.id, job.leaseToken, emptyExtraction(store.autoMemory.taskInput(job)));
}

test('scoped worker completes only its frozen run and preserves unrelated tasks and a new content clock', async t => {
  const f = fixture(t);
  f.inbound('first backfill source');
  const firstRunId = f.reserve();
  const firstRun = f.run(firstRunId);
  f.inbound('second run source');
  const secondRunId = f.reserve();
  const secondRun = f.run(secondRunId);
  f.inbound('new content clock');
  f.store.autoMemory.reserveMaterialsIfDue(f.room.id, 100);
  const compression = f.store.autoMemory.reserveCompressionBatch(f.room.id);
  const beforeJobs = f.store.autoMemory.listJobs().length;
  const worker = f.worker(firstRunId, async input => emptyExtraction(input));
  t.after(() => worker.close());

  assert.equal(worker.timer, undefined);
  worker.start();
  await worker.wait(undefined, 3000);
  assert.equal(f.run(firstRunId).status.completed, firstRun.jobIds.length);
  assert.equal(f.run(secondRunId).status.queued, secondRun.jobIds.length);
  assert.equal(f.store.autoMemory.status(f.room.id, 'compression').queued, 1);
  assert.equal(f.store.autoMemory.listJobs().length, beforeJobs);
  assert.equal(worker.info().completed, firstRun.jobIds.length);
  assert.equal(worker.info().queued, 0);
  assert.equal(Object.hasOwn(worker.info(), 'compression'), false);
  assert.equal(f.store.autoMemory.materialSchedule(f.room.id).firstContentAt, 100);
  assert.ok(compression);
});

test('scoped run cannot pass an earlier material job and its wait terminates without reserving more work', async t => {
  const f = fixture(t, 'private');
  f.inbound('automatic predecessor');
  f.store.autoMemory.reserveMaterialsIfDue(f.room.id, 0);
  const predecessor = f.store.autoMemory.reserveMaterialsIfDue(f.room.id, 600_000);
  f.inbound('manual backfill source');
  const runId = f.reserve();
  const run = f.run(runId);
  f.inbound('unreserved content');
  f.store.autoMemory.reserveMaterialsIfDue(f.room.id, 700_000);
  const beforeJobs = f.store.autoMemory.listJobs().length;
  const worker = f.worker(runId, async input => emptyExtraction(input));
  t.after(() => worker.close());

  worker.start();
  await assert.rejects(worker.wait(undefined, 100), /尚未完成/);
  assert.equal(f.store.autoMemory.status(f.room.id, 'materials', run.jobIds).queued, run.jobIds.length);
  assert.equal(f.store.autoMemory.status(f.room.id, 'materials', [predecessor.id]).queued, 1);
  assert.equal(f.store.autoMemory.listJobs().length, beforeJobs);
  assert.equal(f.store.autoMemory.materialSchedule(f.room.id).firstContentAt, 700_000);
});

test('scoped pending-only worker processes person and self pending while retaining original message', async t => {
  const f = fixture(t);
  const source = f.inbound('我喜欢乌龙茶，也建议回答简洁');
  f.store.autoMemory.reserveMaterialsIfDue(f.room.id, 0);
  const sourceJob = f.store.autoMemory.reserveMaterialsIfDue(f.room.id, 600_000);
  const sourceClaim = f.store.autoMemory.claimNext(f.room.id, { owner: 'fixture', leaseMs: 60_000, pipeline: 'materials' });
  assert.equal(sourceClaim.id, sourceJob.id);
  emptyCommit(f.store, sourceClaim);

  const actorId = f.store.findActor(f.room.id, 'alice');
  const personId = f.store.autoMemory.ensureActorPerson(actorId);
  f.store.autoMemory.addProfilePending(personId, source.existingMessageId, '喜欢乌龙茶', 'third_party');
  f.store.autoMemory.selfProfile.addPending(source.existingMessageId, '回答简洁');
  assert.equal(f.store.autoMemory.planMaterialBackfill(f.room.id).messageCount, 0);
  assert.equal(f.store.autoMemory.planMaterialBackfill(f.room.id).pendingCount, 2);
  const runId = f.reserve();
  const run = f.run(runId);
  assert.equal(run.jobs.length, 1);
  assert.equal(run.jobs[0].messageCount, 0);
  assert.equal(run.jobs[0].pendingCount, 2);

  let calls = 0;
  const worker = f.worker(runId, async input => {
    calls++;
    assert.equal(input.pipeline, 'materials');
    assert.equal(input.messages.length, 0);
    const result = emptyExtraction(input);
    if (input.mode === 'profiles') {
      assert.equal(input.profiles[0].pending.length, 1);
      const pending = input.profiles[0].pending[0];
      result.profiles = [{ personId: input.profiles[0].personId, baseVersion: input.profiles[0].baseVersion,
        facts: [{ content: '喜欢乌龙茶', sourceType: 'third_party', messageIds: [pending.sourceMessageId] }],
        pendingResults: [{ pendingId: pending.id, status: 'merged', factIndex: 0 }] }];
    } else {
      assert.equal(input.mode, 'self');
      assert.equal(input.selfProfile.pending.length, 1);
      const pending = input.selfProfile.pending[0];
      result.selfProfile = { baseVersion: input.selfProfile.baseVersion, content: '回答简洁',
        sourceMessageIds: [pending.sourceMessageId], pendingIds: [pending.id] };
    }
    return result;
  });
  t.after(() => worker.close());
  worker.start();
  await worker.wait(undefined, 3000);

  assert.equal(calls, 2);
  assert.equal(f.run(runId).status.completed, 1);
  assert.equal(f.store.autoMemory.profile(personId).pending.length, 0);
  assert.equal(f.store.autoMemory.profile(personId).facts[0].content, '喜欢乌龙茶');
  assert.equal(f.store.autoMemory.selfProfile.snapshot().pending.length, 0);
  assert.equal(f.store.autoMemory.selfProfile.snapshot().content, '回答简洁');
  const db = new DatabaseSync(f.path);
  try {
    const original = db.prepare('SELECT text FROM messages WHERE id=?').get(source.existingMessageId);
    assert.equal(original.text, '我喜欢乌龙茶，也建议回答简洁');
    assert.equal(db.prepare('SELECT count(*) AS count FROM messages').get().count, 1);
  } finally { db.close(); }
});

test('separate material steps persist before calling, remove AI messages from profile input, and resume saved progress without repeating Topics', async t => {
  const f = fixture(t, 'private');
  const sourceOne = f.inbound('我偏好乌龙茶');
  const sourceTwo = f.inbound('我平时喜欢简洁回答');
  const actorId = f.store.findActor(f.room.id, 'alice');
  const personId = f.store.autoMemory.ensureActorPerson(actorId);
  f.store.autoMemory.addProfilePending(personId, sourceOne.existingMessageId, '偏好乌龙茶', 'third_party');
  f.store.autoMemory.addProfilePending(personId, sourceTwo.existingMessageId, '喜欢简洁回答', 'third_party');

  f.store.autoMemory.reserveMaterialsIfDue(f.room.id, 0);
  const initialJob = f.store.autoMemory.reserveMaterialsIfDue(f.room.id, 600_000);
  const initialClaim = f.store.autoMemory.claimNext(f.room.id, { owner: 'seed', leaseMs: 60_000, pipeline: 'materials' });
  assert.equal(initialClaim.id, initialJob.id);
  const initialInput = f.store.autoMemory.taskInput(initialClaim);
  const initialProfile = initialInput.profiles[0];
  const initialOutput = emptyExtraction(initialInput);
  initialOutput.profiles = [{ personId, baseVersion: initialProfile.baseVersion,
    facts: initialProfile.pending.map(pending => ({ content: pending.content, sourceType: 'third_party',
      messageIds: [pending.sourceMessageId] })),
    pendingResults: initialProfile.pending.map((pending, index) => ({ pendingId: pending.id, status: 'merged', factIndex: index })) }];
  f.store.autoMemory.commit(initialClaim.id, initialClaim.leaseToken, initialOutput);
  const existingFacts = f.store.autoMemory.profile(personId).facts;

  const priorRun = f.store.beginRun(f.room.id, sourceOne.modelInputText, 'fixture', 'fixture-model', [], sourceOne);
  const delivered = f.store.completeRun(priorRun.id, 'assistant 提到一些不应作为画像证据的内容。', undefined, undefined);
  f.store.ackDelivery(delivered.deliveryId, 'sent');
  const newSource = f.inbound('补充新的长期偏好');
  const runId = f.reserve();
  const run = f.run(runId);
  assert.equal(run.jobs.length, 1);

  const calls = [];
  const firstWorker = f.worker(runId, async input => {
    calls.push(input.mode ?? 'all');
    if (calls.length === 1) {
      const persisted = f.store.autoMemory.loadProgress(input.job.id, input.job.leaseToken);
      assert.equal(persisted.version, 3);
      assert.equal(persisted.separateMaterialSteps, true);
      assert.deepEqual(persisted.remaining.map(item => item.mode), ['messages', 'profiles']);
      assert.equal(input.mode, 'messages');
      assert.equal(input.messages.some(message => message.role === 'assistant'), true);
      const output = emptyExtraction(input);
      output.topics = [{ summary: '用户讨论的有效话题', messageIds: [] }];
      return output;
    }
    assert.equal(input.mode, 'profiles');
    assert.equal(input.messages.some(message => message.role === 'assistant'), false);
    assert.deepEqual(input.messages.map(message => message.id), [newSource.existingMessageId]);
    assert.equal(input.profileSources.some(message => message.role === 'assistant'), false);
    assert.deepEqual(input.profiles[0].facts, existingFacts);
    assert.deepEqual(input.profiles[0].facts.flatMap(fact => fact.messageIds).sort(),
      [sourceOne.existingMessageId, sourceTwo.existingMessageId].sort());
    assert.deepEqual(input.profileSources.map(message => message.id).sort(),
      [sourceOne.existingMessageId, sourceTwo.existingMessageId].sort());
    throw new Error('profile step failed once');
  }, true);
  t.after(() => firstWorker.close());
  firstWorker.start();
  await assert.rejects(firstWorker.wait(undefined, 3000), /失败/);
  assert.deepEqual(calls, ['messages', 'profiles']);
  const failedJob = f.run(runId).jobs[0];
  const db = new DatabaseSync(f.path);
  let saved;
  try { saved = JSON.parse(db.prepare('SELECT progress_json FROM auto_memory_jobs WHERE id=?').get(failedJob.id).progress_json); }
  finally { db.close(); }
  assert.deepEqual(saved.remaining.map(item => item.mode), ['profiles']);
  assert.equal(saved.extract.topics.length, 1);
  assert.equal(saved.extract.processedRanges.length, 1);

  await firstWorker.close();
  f.restart();
  f.store.autoMemory.retry(failedJob.id);
  const resumedCalls = [];
  const resumedWorker = f.worker(runId, async input => {
    resumedCalls.push(input.mode ?? 'all');
    assert.equal(input.mode, 'profiles');
    assert.equal(input.messages.some(message => message.role === 'assistant'), false);
    assert.equal(input.profileSources.some(message => message.role === 'assistant'), false);
    const profile = input.profiles[0];
    return { ...emptyExtraction(input), profiles: [{ personId: profile.personId, baseVersion: profile.baseVersion,
      facts: profile.facts, pendingResults: profile.pending.map(pending => ({ pendingId: pending.id, status: 'deferred' })) }] };
  });
  t.after(() => resumedWorker.close());
  resumedWorker.start();
  await resumedWorker.wait(undefined, 3000);
  assert.deepEqual(resumedCalls, ['profiles']);
  assert.equal(f.run(runId).status.completed, 1);
  assert.equal(f.store.autoMemory.searchTopics(f.room.id, { text: '有效话题' }).topics.length, 1);
  assert.deepEqual(f.store.autoMemory.profile(personId).facts, existingFacts);
});
