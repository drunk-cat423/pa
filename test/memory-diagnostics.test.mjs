import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BackgroundMemory } from '../dist/auto-memory.js';
import { DiagnosticLog, DiagnosticPersistenceError } from '../dist/diagnostics.js';
import { ConversationStore } from '../dist/store.js';
import { emptyExtraction } from './fixtures/memory-output.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-memory-diagnostics-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const input = JSON.parse(body.messages.findLast(message => message.role === 'user').content);
    const selfProfile = input.selfProfile && !['messages', 'profiles', 'self'].includes(input.mode) ? { baseVersion: input.selfProfile.baseVersion,
      content: input.selfProfile.content, sourceMessageIds: ['m0'], pendingIds: [] } : undefined;
    const output = input.pipeline === 'compression' ? { continuationSummary: '继续对话' }
      : input.mode === 'self' ? { selfProfile } : input.mode === 'profiles' ? { profiles: [] } : {
      topics: [], profiles: [], continuationSummary: '继续对话', ...(selfProfile ? { selfProfile } : {}) };
    const content = JSON.stringify(output);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null },
      { index: 0, delta: {}, finish_reason: 'stop' }]) {
      response.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [choice] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: directory, provider: 'deepseek', model: 'fixture', apiKey: 'PRIVATE_FIXTURE_KEY',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 100000, maxOutputTokens: 2048, timeoutMs: 5000,
    memory: { enabled: true, maxCalls: 0, timeoutMs: 5000, maxOutputTokens: 8192 } };
  const store = new ConversationStore(join(directory, 'store.sqlite'));
  const conversation = store.ensureConversation('room', join(directory, 'session.jsonl'),
    { channel: 'qq', accountId: 'a', roomId: 'g', roomType: 'group' });
  store.recordInbound(conversation.id, '保留原文', { eventId: 'one', senderId: 'a', modelInputText: '保留原文' });
  const workers = [];
  t.after(async () => {
    for (const worker of workers) await worker.close();
    store.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const worker = (overrides = {}, provider) => {
    const value = new BackgroundMemory({ ...config, ...overrides }, store.autoMemory, conversation.id, provider);
    workers.push(value); return value;
  };
  return { config, store, conversation, requests, worker, log: new DiagnosticLog(directory) };
}

test('worker commit failure keeps SDK response and associates the final phase with the call', async t => {
  const f = await fixture(t);
  f.store.autoMemory.commit = () => { throw new Error('PRIVATE_COMMIT_ERROR'); };
  const worker = f.worker(); worker.start('capacity');
  await assert.rejects(worker.wait(undefined, 3000, 'compression'), /失败/);
  const [job] = f.store.autoMemory.listJobs();
  assert.equal(job.pipeline, 'compression');
  assert.equal(job.status, 'failed'); assert.ok(f.requests.length >= 1);
  const call = f.log.calls({ jobId: job.id }).find(item => item.phase === 'commit');
  assert.ok(call);
  assert.equal(call.status, 'failed'); assert.equal(call.phase, 'commit');
  assert.equal(call.traceId, job.id); assert.equal(call.taskId, job.id); assert.equal(call.attempt, 1);
  assert.ok(f.log.artifact(call.callId, 'response').content.length);
  assert.equal(f.log.artifact(call.callId, 'input').messages.length, 1);
  assert.equal(f.log.artifact(call.callId, 'input').pipeline, 'compression');
  const events = f.log.events({ jobId: job.id });
  assert.ok(events.some(event => event.phase === 'commit' && event.event === 'failed' && event.callId === call.callId));
  assert.ok(events.some(event => event.phase === 'claim'));
  assert.ok(events.some(event => event.phase === 'input'));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_COMMIT_ERROR|PRIVATE_FIXTURE_KEY/);
  worker.start(); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.requests.length, 1);
});

test('paused background and injected fake providers preserve scheduling while only real SDK calls create call records', async t => {
  const f = await fixture(t); let calls = 0;
  const provider = { extract: async input => {
    calls++;
    if (input.mode === 'self') return { selfProfile: { baseVersion: input.selfProfile.baseVersion,
      content: input.selfProfile.content, sourceMessageIds: input.selfProfile.sourceMessageIds, pendingIds: [] } };
    if (input.mode === 'profiles') return { profiles: input.profiles.map(profile => ({ ...profile, pendingResults: [] })) };
    return emptyExtraction(input, '继续对话');
  } };
  const paused = f.worker({ memory: { ...f.config.memory, enabled: false } }, provider);
  paused.start('capacity'); await paused.close(); assert.equal(calls, 0); assert.equal(f.requests.length, 0);
  const enabled = f.worker({}, provider); enabled.start('capacity'); await enabled.wait();
  assert.equal(calls, 1); assert.equal(f.log.calls().length, 0);
  assert.ok(f.log.events().some(event => event.phase === 'commit' && event.event === 'completed'));
});

for (const afterCommit of [false, true]) test(`diagnostic persistence failure ${afterCommit ? 'after' : 'before'} commit halts the worker without another call`, async t => {
  const f = await fixture(t);
  const original = DiagnosticLog.prototype.event;
  DiagnosticLog.prototype.event = function (context, phase, event, details, callId) {
    if (phase === 'commit' && event === (afterCommit ? 'completed' : 'started')) throw new DiagnosticPersistenceError();
    return original.call(this, context, phase, event, details, callId);
  };
  const worker = f.worker();
  try {
    worker.start('capacity'); await assert.rejects(worker.wait(undefined, 3000, 'compression'), /诊断持久化失败/);
    const [job] = f.store.autoMemory.listJobs();
    assert.equal(job.pipeline, 'compression');
    assert.equal(job.status, afterCommit ? 'done' : 'failed');
    assert.equal(f.requests.length, 1);
    f.store.recordInbound(f.conversation.id, '后续原文', { eventId: 'two', senderId: 'a', modelInputText: '后续原文' });
    worker.start('capacity'); worker.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.requests.length, 1);
    assert.throws(() => worker.retry(f.store.autoMemory.listJobs()[0].id), error => error instanceof DiagnosticPersistenceError);
  } finally { DiagnosticLog.prototype.event = original; }
});
