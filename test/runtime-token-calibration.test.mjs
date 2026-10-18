import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { openConversation, estimateContext } from '../dist/runtime.js';
import { DiagnosticLog } from '../dist/diagnostics.js';

const background = '固定完整历史'.repeat(1500);
const sdkUsage = (input = 2500) => ({ prompt_tokens: input, completion_tokens: 20, total_tokens: input + 20,
  prompt_tokens_details: { cached_tokens: 300, cache_write_tokens: 200 }, completion_tokens_details: { reasoning_tokens: 5 } });
async function fixture(t, respond = () => ({}), overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-token-calibration-'));
  const requests = [], runtimes = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const next = respond(body, requests.length);
    if (next.error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture failed' } })); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const preparing = body.tool_choice?.function?.name === 'prepare_turn';
    const delta = preparing ? { role: 'assistant', tool_calls: [{ index: 0, id: 'prepare', type: 'function', function: {
      name: 'prepare_turn', arguments: JSON.stringify({ intent: 'question', mode: 'standard', updates: [] }),
    } }] } : { role: 'assistant', content: '回答' };
    for (const [part, reason] of [[delta, null], [{}, preparing ? 'tool_calls' : 'stop']]) {
      response.write(`data: ${JSON.stringify({ id: 'fixture', model: 'model', choices: [{ index: 0, delta: part, finish_reason: reason }] })}\n\n`);
    }
    if (!next.omitUsage) response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [], usage: next.usage ?? sdkUsage() })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'fixture', model: 'model',
    apiKey: 'PRIVATE_MODEL_KEY', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    contextWindow: 32768, maxOutputTokens: 512, timeoutMs: 5000, ...overrides };
  const open = async (id, scope = 'room', changes = {}) => {
    const runtime = await openConversation({ ...config, ...changes }, id, { contextCalibrationScope: scope });
    runtimes.push(runtime); return runtime;
  };
  t.after(async () => {
    await Promise.allSettled(runtimes.map(runtime => runtime.close()));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { config, open, requests, log: new DiagnosticLog(config.dataDir) };
}

test('real SDK SSE cache usage calibrates immediately; byte-oversized requests pass both projection and final gate', async t => {
  const f = await fixture(t);
  const runtime = await f.open('task-one');
  assert.equal(runtime.estimate('first', undefined, { conversationContext: background }).method, 'utf8-byte-estimate');
  await runtime.prompt('first', { runId: 'first', conversationContext: background });
  const [call] = f.log.calls();
  assert.deepEqual([call.usage.input, call.usage.cacheRead, call.usage.cacheWrite, call.usage.totalTokens], [2000, 300, 200, 2520]);
  const text = 'new text '.repeat(1200);
  const estimate = runtime.estimate(text);
  assert.equal(estimate.method, 'usage-calibrated');
  assert.equal(estimate.calibration.sampleInputTokens, 2500);
  assert.ok(estimate.inputTokens >= 2500 + Buffer.byteLength(text));
  assert.equal(estimate.fits, true);
  await runtime.prompt(text);
  assert.equal(f.requests.length, 2);
  assert.equal(estimateContext(f.requests[1], 32768, 512).fits, false);
  assert.doesNotMatch(JSON.stringify(call.contextCalibration), /PRIVATE_MODEL_KEY|固定完整历史|127\.0\.0\.1/);
});

test('new task and new process restore matching metadata without reading full request/response artifacts', async t => {
  const f = await fixture(t);
  const first = await f.open('task-one');
  await first.prompt('first', { runId: 'first', conversationContext: background });
  await first.close();
  const readArtifact = DiagnosticLog.prototype.artifact;
  DiagnosticLog.prototype.artifact = () => { throw new Error('calibration must not read artifacts'); };
  let next;
  try { next = await f.open('task-two'); } finally { DiagnosticLog.prototype.artifact = readArtifact; }
  const estimate = next.estimate('second', undefined, { conversationContext: background });
  assert.equal(estimate.method, 'usage-calibrated');
  assert.equal(estimate.calibration.sampleInputTokens, 2500);
  await next.close();
  const code = `import {openConversation} from './dist/runtime.js';
    const runtime=await openConversation(JSON.parse(process.argv[1]),'task-three',{contextCalibrationScope:'room'});
    try { console.log(JSON.stringify(runtime.estimate('third',undefined,{conversationContext:process.argv[2]}))); }
    finally { await runtime.close(); }`;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(f.config), background],
    { cwd: join(import.meta.dirname, '..') });
  assert.equal(JSON.parse(result.stdout).method, 'usage-calibrated');
});

test('endpoint, model, provider and room isolation keep unrelated requests conservative; resetting summaries drops the match', async t => {
  const f = await fixture(t);
  const first = await f.open('task-one');
  await first.prompt('first', { runId: 'first', conversationContext: background });
  for (const [id, scope, changes] of [
    ['other-room', 'other-room', {}], ['other-endpoint', 'room', { baseUrl: f.config.baseUrl + '/other' }],
    ['other-model', 'room', { model: 'other-model' }], ['other-provider', 'room', { provider: 'other-provider' }],
  ]) {
    const runtime = await f.open(id, scope, changes);
    assert.equal(runtime.estimate('next', undefined, { conversationContext: background }).method, 'utf8-byte-estimate');
  }
  first.resetContext();
  assert.equal(first.estimate('new turn', undefined, { conversationContext: '压缩后的短摘要' }).method, 'utf8-byte-estimate');
});

test('busy unrelated rooms and ineligible calls cannot evict a quiet room calibration before SQL LIMIT', async t => {
  const f = await fixture(t);
  const first = await f.open('quiet-room-first');
  await first.prompt('first', { runId: 'first', conversationContext: background });
  await first.close();
  const [sample] = f.log.calls();
  const key = sample.contextCalibration.key;
  for (let index = 0; index < 104; index++) {
    const category = index % 4;
    const callId = f.log.startCall({ traceId: `noise-${index}`, provider: 'fixture', model: 'model', phase: 'request',
      kind: category === 1 ? 'memory' : 'chat', captureLevel: category === 3 ? 'http-json' : 'sdk-normalized',
      contextCalibration: { ...sample.contextCalibration, key: category === 0 ? '0'.repeat(64) : key },
    }, { messages: [] });
    f.log.saveResponse(callId, { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } });
    f.log.finishCall(callId, category === 2 ? 'unknown' : 'completed', 'response');
  }
  assert.equal(f.log.calls({ limit: 100 }).some(call => call.callId === sample.callId), false);
  assert.deepEqual(f.log.calibrationCalls(key).map(call => call.callId), [sample.callId]);
  for (const invalid of ['', 'x'.repeat(64), "' OR 1=1 --"]) assert.throws(() => f.log.calibrationCalls(invalid), /校准/);
  for (const invalid of [0, -1, 1.5, 10001, NaN]) assert.throws(() => f.log.calibrationCalls(key, invalid), /limit/);

  const original = DiagnosticLog.prototype.artifact;
  DiagnosticLog.prototype.artifact = () => { throw new Error('calibration must not scan payload artifacts'); };
  try {
    const next = await f.open('quiet-room-next');
    const text = 'new text '.repeat(1200);
    const estimate = next.estimate(text, undefined, { conversationContext: background });
    assert.equal(estimate.method, 'usage-calibrated');
    assert.equal(estimate.calibration.sampleInputTokens, 2500);
    assert.equal(estimate.fits, true);
    await next.prompt(text, { runId: 'next', conversationContext: background });
  } finally { DiagnosticLog.prototype.artifact = original; }
  assert.equal(f.requests.length, 2);
  assert.equal(estimateContext(f.requests[1], 32768, 512).fits, false);
});

test('successful prepare usage is learned before answer payload is sent in the same tool loop', async t => {
  const f = await fixture(t, () => ({}), { contextWindow: 290000 });
  const runtime = await f.open('tool-loop');
  let learnedInTool = false;
  await runtime.prompt('问题', { runId: 'tool-loop', conversationContext: background.repeat(10), companionTools: {
    prepareTurn: plan => {
      learnedInTool = runtime.estimate('next', undefined, { channel: true }).method === 'usage-calibrated';
      return { prepared: true, mode: plan.mode, saved: [], extra: 'receipt'.repeat(3000) };
    }, readHistory: () => [],
  } });
  assert.equal(learnedInTool, true);
  assert.equal(f.requests.length, 2);
  assert.equal(estimateContext(f.requests[1], 290000, 512).fits, false,
    JSON.stringify(f.requests.map(body => estimateContext(body, 290000, 512))));
  assert.equal(f.log.calls().every(call => call.status === 'completed'), true);
});

test('new higher observed input wins and a calibrated over-window request is rejected before HTTP dispatch', async t => {
  const f = await fixture(t, (_body, number) => ({ usage: sdkUsage(number === 1 ? 2500 : 31900) }));
  const runtime = await f.open('high-usage');
  await runtime.prompt('first', { runId: 'first', conversationContext: background });
  await runtime.prompt('second');
  const estimate = runtime.estimate('x'.repeat(1000));
  assert.equal(estimate.method, 'usage-calibrated');
  assert.equal(estimate.calibration.sampleInputTokens, 31900);
  assert.equal(estimate.fits, false);
  await assert.rejects(runtime.prompt('x'.repeat(1000)), /上下文窗口/);
  assert.equal(f.requests.length, 2);
});

test('missing/zero/fractional usage and failed responses never teach a new runtime; old unbound logs remain conservative', async t => {
  for (const invalid of [{ omitUsage: true }, { usage: { prompt_tokens: 0, completion_tokens: 0 } },
    { usage: { prompt_tokens: 1000.5, completion_tokens: 20 } }, { error: true }]) {
    const f = await fixture(t, () => invalid);
    const first = await f.open('old-task');
    const result = first.prompt('first', { runId: 'first', conversationContext: background });
    if (invalid.error) await assert.rejects(result, /模型请求失败/); else await result;
    const next = await f.open('next-task');
    assert.equal(next.estimate('next', undefined, { conversationContext: background }).method, 'utf8-byte-estimate');
  }
  const f = await fixture(t);
  const callId = f.log.startCall({ traceId: 'old-trace', kind: 'chat', provider: 'fixture', model: 'model', phase: 'request' }, { messages: [] });
  f.log.saveResponse(callId, { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } });
  f.log.finishCall(callId, 'completed', 'response');
  const runtime = await f.open('legacy');
  assert.equal(runtime.estimate('next').method, 'utf8-byte-estimate');
});
