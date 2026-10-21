import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
