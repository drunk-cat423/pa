import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DiagnosticLog, DiagnosticPersistenceError } from '../dist/diagnostics.js';
import { parseSearchResponse, searchDeepSeek, WebSearchError } from '../dist/web-search.js';
import { replayDiagnosticCall } from '../dist/logs.js';

const responseBody = { content: [{ type: 'web_search_tool_result', content: [
  { type: 'web_search_result', url: 'https://example.com/source', title: '原始来源' },
] }], usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } } };

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pa-search-diagnostics-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { cwd: dataDir, dataDir, provider: 'deepseek', model: 'unused', apiKey: 'PRIVATE_SEARCH_KEY',
    contextWindow: 100000, maxOutputTokens: 1000, timeoutMs: 5000,
    search: { enabled: true, budgetId: 'search-diagnostics', maxRequests: 1, maxUses: 2,
      maxTokens: 1000, timeoutMs: 5000, model: 'deepseek-search', maxResults: 3 } };
  const budgetDirectory = join(dataDir, createHash('sha256').update(`web-search-budget:${config.search.budgetId}`).digest('hex'));
  return { config, log: new DiagnosticLog(dataDir),
    ledger: async () => (await readFile(join(budgetDirectory, 'search-attempts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse),
    evidence: (attemptId, kind) => readFile(join(budgetDirectory, `${attemptId}.${kind}.json`), 'utf8').then(JSON.parse) };
}

test('search JSON diagnostics correlate with caller and keep existing budget and evidence records', async t => {
  const f = await fixture(t);
  const context = { traceId: 'trace-search', taskId: 'task-search', runId: 'run-search', conversationId: 'room-search', attempt: 2 };
  let request, calls = 0;
  const result = await searchDeepSeek(f.config, '查找文档', undefined, async (endpoint, options) => {
    calls++; request = { endpoint, body: JSON.parse(options.body) };
    return Response.json(responseBody);
  }, undefined, context);
  assert.equal(calls, 1);
  const [call] = f.log.calls({ taskId: context.taskId });
  assert.equal(call.kind, 'search'); assert.equal(call.captureLevel, 'http-json');
  assert.equal(call.status, 'completed'); assert.equal(call.provider, 'deepseek'); assert.equal(call.model, f.config.search.model);
  assert.equal(call.usageSource, 'provider-json'); assert.equal(call.usage.input_tokens, 10);
  assert.equal(replayDiagnosticCall(f.log, call.callId).ok, true);
  for (const [key, value] of Object.entries(context)) assert.equal(call[key], value);
  assert.deepEqual(f.log.artifact(call.callId, 'request'), request);
  assert.deepEqual(f.log.artifact(call.callId, 'response'), responseBody);
  assert.deepEqual(f.log.artifact(call.callId, 'input'), { maxResults: 3 });
  assert.deepEqual(parseSearchResponse(f.log.artifact(call.callId, 'response'), 3).sources, result.sources);
  const events = f.log.events({ callId: call.callId });
  assert.ok(events.some(event => event.event === 'search_reserved' && event.details.attemptId === result.attemptId));
  assert.doesNotMatch(JSON.stringify(events) + JSON.stringify(f.log.artifact(call.callId, 'request')), /PRIVATE_SEARCH_KEY|Authorization|x-api-key/);
  assert.deepEqual((await f.ledger()).map(event => event.type), ['reserved', 'completed']);
  assert.deepEqual(await f.evidence(result.attemptId, 'request'), request);
  assert.deepEqual(await f.evidence(result.attemptId, 'response'), responseBody);
});

for (const mode of ['parse', 'http', 'request']) test(`search ${mode} failures have fixed diagnostic phases and do not retry`, async t => {
  const f = await fixture(t); let calls = 0;
  const failedBody = mode === 'http' ? { error: { message: 'PRIVATE_SEARCH_KEY provider-body' } } : { content: [], privateBody: 'PRIVATE_SEARCH_BODY' };
  await assert.rejects(searchDeepSeek(f.config, '查询', undefined, async () => {
    calls++;
    if (mode === 'request') throw new Error('PRIVATE_SEARCH_BODY PRIVATE_SEARCH_KEY');
    return Response.json(failedBody, { status: mode === 'http' ? 503 : 200 });
  }), error => error instanceof WebSearchError);
  assert.equal(calls, 1);
  const [call] = f.log.calls();
  const [reservation] = await f.ledger();
  assert.equal(call.traceId, reservation.attemptId);
  assert.equal(call.status, mode === 'request' ? 'unknown' : 'failed'); assert.equal(call.phase, mode);
  if (mode !== 'request') {
    const saved = f.log.artifact(call.callId, 'response');
    assert.ok(saved);
    if (mode === 'parse') assert.throws(() => parseSearchResponse(saved, 3), /没有网页搜索结果块/);
    assert.equal(replayDiagnosticCall(f.log, call.callId).ok, false);
    assert.doesNotMatch(JSON.stringify(saved), /PRIVATE_SEARCH_KEY/);
  }
  assert.deepEqual((await f.ledger()).map(event => event.type), ['reserved', 'failed']);
  assert.doesNotMatch(JSON.stringify(f.log.events()), /PRIVATE_SEARCH_BODY|PRIVATE_SEARCH_KEY|provider-body/);
});

test('pre-dispatch diagnostic failure propagates its class and retains the consumed reservation without sending', async t => {
  const f = await fixture(t); let calls = 0;
  const original = DiagnosticLog.prototype.startCall;
  DiagnosticLog.prototype.startCall = () => { throw new DiagnosticPersistenceError(); };
  try {
    await assert.rejects(searchDeepSeek(f.config, '查询', undefined, async () => { calls++; return Response.json(responseBody); }),
      error => error instanceof DiagnosticPersistenceError);
  } finally { DiagnosticLog.prototype.startCall = original; }
  assert.equal(calls, 0);
  assert.deepEqual((await f.ledger()).map(event => event.type), ['reserved']);
  await assert.rejects(searchDeepSeek(f.config, '继续查询', undefined, async () => { calls++; return Response.json(responseBody); }), /预算已用尽/);
  assert.equal(calls, 0);
});

test('response diagnostic failure propagates without normal search fallback or ledger retry', async t => {
  const f = await fixture(t); let calls = 0;
  const original = DiagnosticLog.prototype.saveResponse;
  DiagnosticLog.prototype.saveResponse = () => { throw new DiagnosticPersistenceError(); };
  try {
    await assert.rejects(searchDeepSeek(f.config, '查询', undefined, async () => { calls++; return Response.json(responseBody); }),
      error => error instanceof DiagnosticPersistenceError);
  } finally { DiagnosticLog.prototype.saveResponse = original; }
  assert.equal(calls, 1); assert.deepEqual((await f.ledger()).map(event => event.type), ['reserved']);
});

test('HTTP error capture respects the existing response-size bound', async t => {
  const f = await fixture(t); let reads = 0, cancelled = false;
  const stream = new ReadableStream({ pull(controller) { reads++; controller.enqueue(new Uint8Array(256 * 1024)); },
    cancel() { cancelled = true; } });
  await assert.rejects(searchDeepSeek(f.config, '查询', undefined, async () => new Response(stream, { status: 503 })), /HTTP 503/);
  assert.equal(cancelled, true); assert.ok(reads <= 6);
  const [call] = f.log.calls(); assert.equal(call.phase, 'http'); assert.equal(call.responseRef, undefined);
});
