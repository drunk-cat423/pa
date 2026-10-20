import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { BackgroundMemory } from '../dist/auto-memory.js';
import { parseMemoryResponse } from '../dist/memory-provider.js';
import { emptyExtraction } from './fixtures/memory-output.mjs';

function fixture(t, roomType = 'group') {
  const dir = mkdtempSync(join(tmpdir(), 'pa-memory-pipelines-'));
  const path = join(dir, 'store.sqlite');
  const store = new ConversationStore(path);
  const room = store.ensureConversation('room', '/room.jsonl', {
    channel: 'qq', accountId: 'test', roomType, roomId: 'room',
  });
  let event = 0;
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    store, room,
    inbound(text, senderId = 'alice') {
      const external = { eventId: String(++event), senderId, senderName: senderId.toUpperCase(), modelInputText: text };
      store.recordInbound(room.id, text, external);
      return { ...external, existingMessageId: store.externalMessage(room.id, external.eventId).id };
    },
    queueCompression(beforeMessageId) {
      return store.autoMemory.reserveCompressionBatch(room.id, beforeMessageId);
    },
    queueMaterials(now = 1000) {
      assert.equal(store.autoMemory.reserveMaterialsIfDue(room.id, now), undefined);
      return store.autoMemory.reserveMaterialsIfDue(room.id, now + 600_000);
    },
  };
}

function config(maxCalls = 10) {
  return { contextWindow: 8192, memory: { enabled: true, maxCalls, timeoutMs: 1500 } };
}

function wire(input, value) {
  return parseMemoryResponse({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(value) }] }, input);
}

test('wire compression accepts only a continuation summary; materials rejects summaries and allows none', () => {
  const common = { extractionProtocol: 2, job: { messageIds: [] }, messages: [], profiles: [], roomType: 'group' };
  const compression = { ...common, pipeline: 'compression' };
  assert.equal(wire(compression, { continuationSummary: 'compressed' }).continuationSummary, 'compressed');
  for (const extra of [{ topics: [] }, { profiles: [] }]) {
    assert.throws(() => wire(compression, { continuationSummary: 'compressed', ...extra }));
  }

  const materials = { ...common, pipeline: 'materials' };
  assert.deepEqual(wire(materials, { topics: [], profiles: [] }).topics, []);
  assert.throws(() => wire(materials, { topics: [], profiles: [], continuationSummary: 'must not persist' }));
});

test('compression worker leaves existing Topics and profile untouched; materials leaves summary and context checkpoint untouched', async t => {
  const f = fixture(t);
  const source = f.inbound('我喜欢喝茶');
  const actorId = f.store.externalMessage(f.room.id, source.eventId).actorId;
  const personId = f.store.autoMemory.ensureActorPerson(actorId);
  f.store.autoMemory.addProfilePending(personId, source.existingMessageId, '我喜欢喝茶', 'third_party');

  const provider = { extract: async input => {
    if (input.pipeline === 'materials') {
      const base = emptyExtraction(input);
      base.topics = [{ summary: '长期讨论茶', messageIds: [] }];
      base.profiles = input.profiles.map(profile => ({
        personId: profile.personId,
        baseVersion: profile.baseVersion,
        facts: [{ content: '喜欢喝茶', sourceType: 'third_party', messageIds: [source.existingMessageId] }],
        pendingResults: [{ pendingId: profile.pending[0].id, status: 'merged', factIndex: 0 }],
      }));
      return base;
    }
    return emptyExtraction(input, '持续对话摘要');
  } };
  const worker = new BackgroundMemory(config(), f.store.autoMemory, f.room.id, provider);
  t.after(() => worker.close());

  const legacyCheckpointBefore = f.store.autoMemory.status(f.room.id).checkpoint;
  f.queueMaterials();
  worker.start();
  await worker.wait(undefined, 3000, 'materials');
  const materialsStatus = worker.info('materials');
  assert.equal(materialsStatus.hasSummary, false);
  assert.equal(f.store.autoMemory.status(f.room.id).checkpoint, legacyCheckpointBefore);

  const beforeTopic = f.store.autoMemory.searchTopics(f.room.id, { text: '茶' }).topics;
  const beforeProfile = f.store.autoMemory.profile(personId);
  assert.equal(beforeTopic.length, 1);
  assert.equal(beforeProfile.facts[0].content, '喜欢喝茶');

  f.inbound('还有一件事');
  worker.start('capacity');
  await worker.wait(undefined, 3000, 'compression');
  assert.deepEqual(f.store.autoMemory.searchTopics(f.room.id, { text: '茶' }).topics, beforeTopic);
  assert.deepEqual(f.store.autoMemory.profile(personId), beforeProfile);
  assert.equal(worker.info('compression').hasSummary, true);
});

test('a blocked materials provider does not hold up compression', async t => {
  const f = fixture(t);
  f.inbound('同一条消息进入两个独立快照');
  f.queueCompression();
  f.queueMaterials();
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const worker = new BackgroundMemory(config(), f.store.autoMemory, f.room.id, { extract: async input => {
    if (input.pipeline === 'materials') { markStarted(); await gate; return emptyExtraction(input); }
    return emptyExtraction(input, '压缩已完成');
  } });
  t.after(async () => { release(); await worker.close(); });

  worker.start();
  await started;
  await worker.wait(undefined, 3000, 'compression');
  assert.equal(worker.info('compression').completed, 1);
  assert.equal(worker.info('materials').running, 1);
  release();
  await worker.wait(undefined, 3000, 'materials');
});

test('materials failure does not block compression or make compression wait fail', async t => {
  const f = fixture(t);
  f.inbound('并行失败隔离');
  f.queueCompression();
  f.queueMaterials();
  let calls = 0;
  const worker = new BackgroundMemory(config(), f.store.autoMemory, f.room.id, { extract: async input => {
    calls++;
    if (input.pipeline === 'materials') throw new Error('materials provider failed');
    return emptyExtraction(input, 'compression succeeded');
  } });
  t.after(() => worker.close());

  worker.start();
  await worker.wait(undefined, 3000, 'compression');
  await assert.rejects(worker.wait(undefined, 3000, 'materials'), /后台整理失败/);
  assert.equal(worker.info('materials').failed, 1);
  assert.equal(worker.info('compression').completed, 1);
  await worker.wait(undefined, 3000, 'compression');
  worker.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2);
});

test('pipelines share maxCalls and failed work is not retried automatically', async t => {
  const f = fixture(t);
  f.inbound('调用预算共享');
  f.queueCompression();
  f.queueMaterials();
  const calls = [];
  const worker = new BackgroundMemory(config(2), f.store.autoMemory, f.room.id, { extract: async input => {
    calls.push(input.pipeline);
    if (input.pipeline === 'compression') throw new Error('compression failed once');
    return emptyExtraction(input);
  } });
  t.after(() => worker.close());

  worker.start();
  await assert.rejects(worker.wait(undefined, 3000, 'compression'), /后台整理失败/);
  await worker.wait(undefined, 3000, 'materials');
  assert.equal(worker.info().calls, 2);
  assert.deepEqual(calls.sort(), ['compression', 'materials']);
  worker.start();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(worker.info().calls, 2);
  assert.equal(f.store.autoMemory.listJobs().filter(job => job.status === 'failed').length, 1);
});
