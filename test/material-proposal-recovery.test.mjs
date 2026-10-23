import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { BackgroundMemory } from '../dist/auto-memory.js';
import { ConversationStore } from '../dist/store.js';
import { MemoryProviderError } from '../dist/memory-diagnostics.js';

import { parseMemoryResponse } from '../dist/memory-provider.js';
import { prepareMemoryWireExtraction } from '../dist/memory-wire.js';

function fixture(t, roomType = 'group') {
  const directory = mkdtempSync(join(tmpdir(), 'pa-material-proposal-'));
  const path = join(directory, 'store.sqlite');
  const store = new ConversationStore(path);
  const conversation = store.ensureConversation('room', '/unused.jsonl', { channel: 'qq', accountId: 'test', roomType, roomId: 'room' });
  let sequence = 0, clock = Date.now();
  const inspect = operation => { const db = new DatabaseSync(path); try { return operation(db); } finally { db.close(); } };
  function inbound(text) {
    const eventId = String(++sequence);
    store.recordInbound(conversation.id, text, { eventId, senderId: 'alice', modelInputText: text });
    return store.externalMessage(conversation.id, eventId).id;
  }
  function reserve() {
    store.autoMemory.reserveMaterialsIfDue(conversation.id, clock);
    const job = store.autoMemory.reserveMaterialsIfDue(conversation.id, clock + 600001);
    clock += 600002;
    assert.ok(job); return job;
  }
  const source = inbound('我喜欢阅读。');
  const personId = store.autoMemory.personForActor(store.findActor(conversation.id, 'alice'));
  store.autoMemory.addProfilePending(personId, source, '我喜欢阅读。', 'self');
  const question = inbound('讲一下示例工具是什么，有何用途？');
  const first = reserve();
  inbound('今天讨论了备份步骤。');
  const second = reserve();
  const history = () => inspect(db => ({
    messages: db.prepare('SELECT * FROM messages ORDER BY ingest_seq').all(),
    revisions: db.prepare('SELECT * FROM person_profile_revisions ORDER BY rowid').all(),
    pending: db.prepare('SELECT * FROM person_profile_pending ORDER BY rowid').all(),
    captured: db.prepare('SELECT * FROM auto_memory_material_job_pending ORDER BY rowid').all(),
  }));
  const frozen = () => inspect(db => db.prepare('SELECT input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(first.id));
  let worker;
  const start = (extract, overrides = {}) => {
    const config = { contextWindow: 1000000, memory: { enabled: true, timeoutMs: 5000, maxCalls: 20, ...overrides } };
    worker = new BackgroundMemory(config, store.autoMemory, conversation.id, { extract },
      { pipeline: 'materials', jobIds: [first.id, second.id], separateMaterialSteps: true });
    worker.start(); return worker;
  };
  t.after(async () => { await worker?.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, inspect, conversation, first, second, source, question, history, frozen, start };
}

function valid(input) {
  return input.mode === 'profiles'
    ? { profiles: input.profiles.map(profile => ({ personId: profile.personId, baseVersion: profile.baseVersion,
      facts: profile.facts, updates: [], pendingResults: (profile.pending ?? []).map(item => ({ pendingId: item.id, status: 'deferred' })) })) }
    : { topics: [{ summary: '本批讨论了工具与备份。', messageIds: [] }], fragments: [], profiles: [], ignoredMessageIds: [] };
}

for (const kind of ["wire_subject","attribution"]) {
  test(`materials ${kind} rejection preserves evidence and releases the next batch without covering its gap`, async t => {
    const f = fixture(t, kind === 'attribution' ? 'private' : 'group');
    const history = f.history(), calls = [];
    let frozen;
    const worker = f.start(async input => {
      calls.push([input.job.id, input.mode]);
      if (input.job.id !== f.first.id || input.mode !== 'profiles') return valid(input);
      frozen = f.frozen();
      assert.equal(JSON.parse(frozen.progress_json).extract.topics.length, 1);
      assert.match(prepareMemoryWireExtraction(input, 1000000).systemPrompt, /profileSubjects仅用于识别对象/);
      if (kind === 'wire_subject') return parseMemoryResponse({ stopReason: 'stop', content: [{ type: 'text', text:
        JSON.stringify({ profiles: [{ personId: 'p999', baseVersion: 0, facts: [], updates: [], pendingResults: [] }] }) }] }, input);
      if (kind === 'structure') return { profiles: 'invalid' };
      if (kind.startsWith('model_')) throw new MemoryProviderError(kind, 'fixture response rejected');
      const proposal = valid(input), profile = proposal.profiles[0];
      profile.facts = [{ content: '已经使用示例工具', sourceType: 'self', messageIds: [f.question] }];
      profile.updates = [{ factIndex: 0, baselineFactIndexes: [], evidence: [{ messageId: f.question,
        factQuote: '讲一下示例工具是什么，有何用途？', subjectKind: 'self', subjectQuote: '我' }] }];
      return proposal;
    });
    await worker.wait();
    const jobs = f.store.autoMemory.listJobs();
    assert.equal(jobs.find(job => job.id === f.first.id).status, 'failed');
    assert.equal(jobs.find(job => job.id === f.first.id).deferred, true);
    assert.match(jobs.find(job => job.id === f.first.id).error, /model_proposal_rejected/);
    assert.equal(jobs.find(job => job.id === f.second.id).status, 'done');
    assert.equal(f.store.autoMemory.status(f.conversation.id, 'materials').checkpoint, 0);
    assert.deepEqual(f.frozen(), frozen);
    // The later batch may append its own profile revision, but it cannot rewrite historical rows or failed pending.
    const after = f.history();
    assert.deepEqual(after.messages, history.messages);
    assert.deepEqual(after.pending, history.pending);
    assert.deepEqual(after.captured, history.captured);
    assert.deepEqual(after.revisions.slice(0, history.revisions.length), history.revisions);
    const deferral = f.inspect(db => db.prepare('SELECT * FROM auto_memory_job_deferrals WHERE job_id=?').get(f.first.id));
    const hash = text => createHash('sha256').update(text).digest('hex');
    assert.equal(deferral.input_hash, hash(frozen.input_json));
    assert.equal(deferral.progress_hash, hash(frozen.progress_json));
    assert.equal(calls.filter(([id, mode]) => id === f.first.id && mode === 'profiles').length, 1);
    assert.throws(() => f.store.autoMemory.retry(f.first.id), /搁置/);
    const lease = JSON.parse(frozen.input_json).job.leaseToken;
    assert.throws(() => f.store.autoMemory.commit(f.first.id, lease, {}), /租约/);
    assert.equal(f.store.autoMemory.status(f.conversation.id, 'compression').completed, 0);
  });
}
