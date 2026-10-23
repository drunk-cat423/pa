import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import test from 'node:test';
import { DiagnosticLog } from '../dist/diagnostics.js';
import { openConversation } from '../dist/runtime.js';
import { WebFetchReader } from '../dist/web-fetch-reader.js';

async function fixture(t, respond, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-research-thinking-'));
  const requests = [], errors = [], runtimes = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw); requests.push(body);
      const step = await respond(body, requests.length);
      if (step.error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'fixture request failed' } })); return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'fixture',
        model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      for (const part of step.reasoning ?? []) emit({ reasoning_content: part });
      emit(step.delta ?? { role: 'assistant', content: step.answer ?? '阶段结果' });
      emit({}, step.delta?.tool_calls ? 'tool_calls' : step.finishReason ?? 'stop');
      response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [], usage: { prompt_tokens: 100,
        completion_tokens: 20, total_tokens: 120, completion_tokens_details: { reasoning_tokens: 12 } } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); response.writeHead(500); response.end('fixture failure'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'fixture', model: 'fixture',
    apiKey: 'local-fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    contextWindow: 131072, maxOutputTokens: 4096, timeoutMs: 5000,
    loop: { maxModelCalls: 4, maxToolCalls: 8 },
    search: { enabled: true }, fetch: { enabled: true, publicDns: true, timeoutMs: 1000,
      maxResponseBytes: 1048576, maxTextChars: 8000 }, ...overrides };
  t.after(async () => {
    await Promise.allSettled(runtimes.map(runtime => runtime.close()));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  return { config, requests, log: new DiagnosticLog(config.dataDir), async open(id, research) {
    const runtime = await openConversation(config, id, { enableSearch: true, ...(research ? { research } : {}) });
    runtimes.push(runtime); return runtime;
  } };
}

function assertThinking(body) {
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(Object.hasOwn(body, 'max_tokens'), false);
  assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
  assert.ok(['auto', 'none'].includes(body.tool_choice));
}

test('collect最后一次请求保持auto并执行整批真实抓取与材料工具，只发送一次请求', async t => {
  const url = 'https://example.com/source', events = [], final = [], reads = [];
  let fetches = 0;
  const f = await fixture(t, () => ({ reasoning: ['本次直接读取两份材料'], delta: { role: 'assistant', tool_calls: [
    { index: 0, id: 'fetch-final', type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url }) } },
    { index: 1, id: 'material-final', type: 'function', function: { name: 'read_research_material', arguments: '{"id":"e1"}' } },
  ] } }), { loop: { maxModelCalls: 1, maxToolCalls: 8 } });
  const reader = new WebFetchReader(f.config.fetch, { maxResultBytes: 16000, maxReads: 2, maxTotalBytes: 32000 },
    async () => { fetches++; return { url, text: '实际抓取器返回的原文' }; });
  t.after(() => reader.dispose());
  const runtime = await f.open('collect-one-call', { phase: 'collect', fetchReader: reader, maxToolCalls: 2,
    maxSearchCalls: 0, record: event => events.push(event), onFinalResponse: response => final.push(response),
    readMaterial(params) { reads.push(params); return { text: '绑定材料正文' }; } });
  assert.equal(await runtime.prompt('采集两份来源', { runId: 'collect-one-call' }), '');
  assert.equal(f.requests.length, 1); assertThinking(f.requests[0]); assert.equal(f.requests[0].tool_choice, 'auto');
  assert.equal(fetches, 1); assert.deepEqual(reads, [{ id: 'e1' }]);
  assert.deepEqual(events.filter(event => event.kind === 'tool_result').map(event => event.tool), ['web_fetch', 'read_research_material']);
  assert.deepEqual(final, [{ stopReason: 'toolUse' }]);
  assert.deepEqual(f.log.calls({ traceId: 'collect-one-call' }).map(call => call.status), ['completed']);
  const write = await f.open('write-clean-session', { phase: 'write', maxSearchCalls: 0, record() {} });
  // The fixture deliberately returns forbidden calls: write ends after one call and executes neither.
  await assert.rejects(write.prompt('仅依据正文材料写章节'));
  assert.equal(f.requests.length, 2); assert.deepEqual(f.requests[1].tools, []); assert.equal(f.requests[1].tool_choice, 'none');
  assert.ok(f.requests[1].messages.every(message => message.role !== 'tool' && !message.tool_calls));
  assert.equal(fetches, 1); assert.equal(reads.length, 1);
});
