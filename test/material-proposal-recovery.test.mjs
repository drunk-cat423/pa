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
import { DiagnosticPersistenceError } from '../dist/diagnostics.js';
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

for (const kind of ['wire_subject', 'attribution', 'structure', 'model_json', 'model_empty', 'model_length']) {
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

for (const kind of ['version', 'live_binding', 'model_request', 'diagnostics', 'checkpoint', 'commit', 'budget', 'input_protocol',
  'saved_progress', 'final_validation', 'cancelled']) {
  test(`materials ${kind} failure remains blocking and never automatically defers`, async t => {
    const f = fixture(t), calls = [];
    if (kind === 'input_protocol') {
      const original = f.store.autoMemory.taskInput.bind(f.store.autoMemory);
      f.store.autoMemory.taskInput = job => ({ ...original(job), selfProfileProtocol: 1 });
    }
    if (kind === 'saved_progress') {
      const claimed = f.store.autoMemory.claimNext(f.conversation.id, { owner: 'fixture', leaseMs: 60000, pipeline: 'materials' });
      f.store.autoMemory.saveProgress(claimed.id, claimed.leaseToken, { version: 0 });
      f.store.autoMemory.fail(claimed.id, claimed.leaseToken, 'fixture saved protocol failure');
      f.store.autoMemory.retry(claimed.id);
    }
    if (kind === 'final_validation') {
      const save = f.store.autoMemory.saveProgress.bind(f.store.autoMemory);
      f.store.autoMemory.saveProgress = (id, lease, progress) => {
        if (!progress.remaining.length) progress.extract.topics[0].summary = '';
        save(id, lease, progress);
      };
    }
    const worker = f.start(async (input, signal) => {
      calls.push([input.job.id, input.mode]);
      if (kind === 'checkpoint' && input.mode === 'messages') f.inspect(db => db.exec(
        "CREATE TRIGGER reject_progress BEFORE UPDATE OF progress_json ON auto_memory_jobs BEGIN SELECT RAISE(ABORT,'fixture persistence failure'); END"));
      if (input.mode !== 'profiles') return valid(input);
      if (kind === 'model_request') throw new MemoryProviderError('model_request', 'upstream result unknown');
      if (kind === 'diagnostics') throw new DiagnosticPersistenceError();
      if (kind === 'cancelled') {
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(signal.aborted, true);
        throw new MemoryProviderError('model_json', 'response rejected after cancellation');
      }
      if (kind === 'commit') f.inspect(db => db.exec(
        "CREATE TRIGGER reject_commit BEFORE UPDATE OF status ON auto_memory_jobs WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END"));
      if (kind === 'live_binding') f.store.autoMemory.assertProfileEvidenceCurrent = () => { throw new Error('人物绑定版本冲突。'); };
      const proposal = valid(input);
      if (kind === 'version') proposal.profiles[0].baseVersion++;
      return proposal;
    }, kind === 'budget' ? { maxCalls: 1 } : kind === 'cancelled' ? { timeoutMs: 10 } : {});
    await assert.rejects(worker.wait());
    const jobs = f.store.autoMemory.listJobs();
    assert.equal(jobs.find(job => job.id === f.first.id).status, 'failed');
    assert.equal(jobs.find(job => job.id === f.first.id).deferred, undefined);
    assert.equal(jobs.find(job => job.id === f.second.id).status, 'queued');
    assert.equal(calls.some(([id]) => id === f.second.id), false);
    assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS count FROM auto_memory_job_deferrals').get().count), 0);
  });
}

for (const kind of ['deferral_transaction', 'expired_lease']) {
  test(`materials ${kind} cannot release FIFO or partially mark the failed proposal`, async t => {
    const f = fixture(t), calls = [];
    let frozen;
    const worker = f.start(async input => {
      calls.push(input.job.id);
      if (input.mode !== 'profiles') return valid(input);
      frozen = f.frozen();
      f.inspect(db => db.exec(kind === 'deferral_transaction'
        ? "CREATE TRIGGER reject_deferral BEFORE INSERT ON auto_memory_job_deferrals BEGIN SELECT RAISE(ABORT,'fixture audit failure'); END"
        : 'UPDATE auto_memory_jobs SET lease_until=0 WHERE status=\'running\''));
      return { profiles: 'invalid' };
    });
    await assert.rejects(worker.wait());
    assert.deepEqual(f.frozen(), frozen);
    const jobs = f.store.autoMemory.listJobs();
    assert.equal(jobs.find(job => job.id === f.first.id).status, 'running');
    assert.equal(jobs.find(job => job.id === f.first.id).deferred, undefined);
    assert.equal(jobs.find(job => job.id === f.second.id).status, 'queued');
    assert.equal(calls.includes(f.second.id), false);
    assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS count FROM auto_memory_job_deferrals').get().count), 0);
  });
}

test('unknown capacity-refinement request preserves the consumed opportunity and still blocks FIFO', async t => {
  const f = fixture(t), calls = [];
  const worker = f.start(async input => {
    calls.push([input.job.id, input.mode, Boolean(input.profileRefinement)]);
    if (input.profileRefinement) throw new MemoryProviderError('model_request', 'refinement result unknown');
    const proposal = valid(input);
    if (input.mode === 'profiles') {
      proposal.profiles[0].facts = [{ content: '阅读'.repeat(61), sourceType: 'self', messageIds: [f.source] }];
      proposal.profiles[0].updates = [{ factIndex: 0, baselineFactIndexes: [], evidence: [{ messageId: f.source,
        factQuote: '我喜欢阅读。', subjectKind: 'self', subjectQuote: '我' }] }];
    }
    return proposal;
  });
  await assert.rejects(worker.wait());
  const jobs = f.store.autoMemory.listJobs();
  assert.equal(jobs.find(job => job.id === f.first.id).status, 'failed');
  assert.equal(jobs.find(job => job.id === f.first.id).deferred, undefined);
  assert.match(jobs.find(job => job.id === f.first.id).error, /model_request/);
  assert.equal(jobs.find(job => job.id === f.second.id).status, 'queued');
  assert.equal(calls.filter(([, , refinement]) => refinement).length, 1);
  assert.equal(JSON.parse(f.frozen().progress_json).capacityRecovery.attemptedPersonIds.length, 1);
});
