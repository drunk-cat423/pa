import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openConversation } from '../dist/runtime.js';
import { DiagnosticLog, DiagnosticPersistenceError } from '../dist/diagnostics.js';
import { replayDiagnosticCall } from '../dist/logs.js';

async function fixture(t, mode = 'normal') {
  const directory = await mkdtemp(join(tmpdir(), 'pa-chat-diagnostics-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-request' });
    response.flushHeaders();
    if (mode === 'hang') return;
    const prepare = body.tool_choice?.function?.name === 'prepare_turn';
    const delta = prepare && mode !== 'bad-prepare'
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'prepare', type: 'function', function: {
        name: 'prepare_turn', arguments: JSON.stringify({ intent: 'social', mode: 'standard', updates: [] }) } }] }
      : { role: 'assistant', content: '正常回复' };
    for (const [part, reason] of [[delta, null], [{}, prepare && mode !== 'bad-prepare' ? 'tool_calls' : 'stop']]) {
      response.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'fixture',
        choices: [{ index: 0, delta: part, finish_reason: reason }] })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'fixture', model: 'fixture',
    apiKey: 'PRIVATE_MODEL_KEY', baseUrl: `http://127.0.0.1:${server.address().port}`, contextWindow: 32768,
    maxOutputTokens: 512, timeoutMs: mode === 'hang' ? 500 : 5000 };
  const runtime = await openConversation(config, 'fixture');
  t.after(async () => {
    await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { runtime, requests, log: new DiagnosticLog(config.dataDir) };
}
const metadata = { runId: 'run-1', taskId: 'task-1', conversationId: 'business-conversation', companionTools: {
  prepareTurn: plan => ({ prepared: true, mode: plan.mode, saved: [] }), readHistory: () => [],
} };

test('final prepare/answer SDK payloads and responses are correlated to the original task without credentials', async t => {
  const f = await fixture(t);
  assert.equal(await f.runtime.prompt('你好', metadata), '正常回复');
  assert.equal(f.requests.length, 2);
  const calls = f.log.calls({ taskId: 'task-1' }); assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.traceId, 'run-1'); assert.equal(call.runId, 'run-1');
    assert.equal(call.conversationId, 'business-conversation'); assert.equal(call.status, 'completed');
    const payload = f.log.artifact(call.callId, 'request');
    assert.ok(f.requests.some(request => JSON.stringify(request) === JSON.stringify(payload)));
    assert.ok(f.log.artifact(call.callId, 'response').content.length);
    assert.equal(replayDiagnosticCall(f.log, call.callId).ok, true);
    assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_MODEL_KEY/);
  }
  const events = f.log.events({ taskId: 'task-1' });
  assert.ok(events.some(event => event.event === 'tool.finished'));
  assert.ok(events.some(event => event.event === 'turn.completed' && event.details.modelCalls === 2));
});

test('a rejected preparation preserves evidence and does not dispatch an answer or execute preparation', async t => {
  const f = await fixture(t, 'bad-prepare'); let saves = 0;
  await assert.rejects(f.runtime.prompt('你好', { ...metadata, companionTools: { ...metadata.companionTools,
    prepareTurn: () => { saves++; return { prepared: true, mode: 'standard', saved: [] }; } } }), /准备协议|准备/);
  assert.equal(f.requests.length, 1); assert.equal(saves, 0);
  const [call] = f.log.calls({ taskId: 'task-1' });
  assert.equal(replayDiagnosticCall(f.log, call.callId).ok, false);
  assert.ok(f.log.events({ taskId: 'task-1' }).some(event => event.phase === 'prepare' && event.event === 'turn.failed'));
});

test('failed request evidence persistence stops HTTP dispatch and leaves the conversation fatal', async t => {
  const f = await fixture(t);
  const original = DiagnosticLog.prototype.startCall;
  DiagnosticLog.prototype.startCall = () => { throw new DiagnosticPersistenceError(); };
  try {
    await assert.rejects(f.runtime.prompt('你好', metadata), /诊断|持久化/);
    await assert.rejects(f.runtime.prompt('后续'), /诊断|持久化/);
    assert.equal(f.requests.length, 0);
  } finally { DiagnosticLog.prototype.startCall = original; }
});

test('request timeout remains unknown and does not retry the provider', async t => {
  const f = await fixture(t, 'hang');
  await assert.rejects(f.runtime.prompt('你好', metadata), /超时/);
  assert.equal(f.requests.length, 1);
  const [call] = f.log.calls({ taskId: 'task-1' }); assert.equal(call.status, 'unknown');
  assert.ok(f.log.events({ taskId: 'task-1' }).some(event => event.event === 'turn.failed' && event.details.code === 'timeout'));
});

test('a response evidence write failure makes the live conversation fatal without another provider call', async t => {
  const f = await fixture(t);
  const original = DiagnosticLog.prototype.saveResponse;
  DiagnosticLog.prototype.saveResponse = () => { throw new DiagnosticPersistenceError(); };
  try {
    await assert.rejects(f.runtime.prompt('你好', metadata), /诊断|持久化/);
    await assert.rejects(f.runtime.prompt('后续'), /诊断|持久化/);
    assert.equal(f.requests.length, 1);
  } finally { DiagnosticLog.prototype.saveResponse = original; }
});
