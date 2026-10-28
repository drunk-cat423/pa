import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,  rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openRecordedConversation,  } from '../dist/conversation.js';
import { estimateContext, openConversation } from '../dist/runtime.js';

async function harness(t, { repeatedToolCall = false, truncatedSummary = false, includeSummary = false, contextWindow = 32768 } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pa-search-boundary-'));
  const requests = [];
  let callId = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const searchEnabled = body.tools?.some(tool => tool.function?.name === 'web_search');
    const preparing = body.tool_choice?.function?.name === 'prepare_turn';
    const emitToolCall = preparing || repeatedToolCall || (searchEnabled && !body.messages.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.function?.name === 'web_search')));
    const delta = emitToolCall
      ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_search_${++callId}`, type: 'function',
        function: preparing ? { name: 'prepare_turn', arguments: JSON.stringify({ intent: 'research', mode: 'professional', updates: [] }) } : { name: 'web_search', arguments: JSON.stringify({ query: 'SQLite' }) } }] }
      : { role: 'assistant', content: '本轮回答完成。' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choices of [[{ index: 0, delta, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: emitToolCall ? 'tool_calls' : 'stop' }]]) {
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
        model: 'test', choices })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  const originalFetch = globalThis.fetch;
  const nativeCalls = [];
  globalThis.fetch = async (url, options) => {
    if (String(url) !== 'https://api.deepseek.com/anthropic/v1/messages') return originalFetch(url, options);
    nativeCalls.push(JSON.parse(options.body));
    const results = Array.from({ length: 5 }, (_, index) => ({
      type: 'web_search_result', url: `https://example.test/${index}`, title: `Source ${index}`,
    }));
    const citations = results.map(item => ({ url: item.url, cited_text: 's'.repeat(1000) }));
    return new Response(JSON.stringify({ stop_reason: truncatedSummary ? 'max_tokens' : 'end_turn', content: [
      { type: 'web_search_tool_result', content: results },
      { type: 'text', citations, ...(truncatedSummary || includeSummary ? { text: 'SUMMARY'.repeat(1000) } : {}) },
    ], usage: { input_tokens: 100, output_tokens: 10 } }));
  };

  const config = { cwd: process.cwd(), dataDir, provider: 'pa-test', model: 'test', apiKey: 'fixture-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow,
    maxOutputTokens: 1024, timeoutMs: 5000, loop: { maxModelCalls: 3, maxToolCalls: 8 },
    search: { enabled: true, budgetId: 'boundary', model: 'deepseek-flash', maxRequests: 2, maxUses: 2,
      maxTokens: 2048, timeoutMs: 1000, maxResults: 5 } };
  const opened = [];
  t.after(async () => {
    globalThis.fetch = originalFetch;
    await Promise.allSettled(opened.map(conversation => conversation.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  return { config, requests, nativeCalls, open: async (id, roomType = 'group') => {
    const conversation = await openRecordedConversation(config, id,
      { channel: 'fixture', accountId: 'bot', roomId: id, roomType });
    opened.push(conversation);
    return conversation;
  } };
}

test('搜索结果使最终请求超过窗口时发送前硬检查仍拦截', async t => {
  const companionTools = { prepareTurn: p => ({ prepared: true, mode: p.mode, saved: [] }), readHistory: () => [] };
  // Include a valid search summary so the result request exceeds both stable
  // stage prompts, then place the unchanged hard limit inside that measured growth.
  const calibration = await harness(t, { contextWindow: 65536, includeSummary: true });
  const probe = await openConversation(calibration.config, 'calibration', { enableSearch: true });
  await probe.prompt('搜索', { runId: 'probe', companionTools });
  const sizes = calibration.requests.map(body => estimateContext(body, calibration.config.contextWindow, calibration.config.maxOutputTokens).inputTokens);
  assert.equal(sizes.length, 3);
  const largestBeforeResults = Math.max(sizes[0], sizes[1]);
  const growth = sizes[2] - largestBeforeResults;
  assert.ok(growth > 0, JSON.stringify(sizes));
  await probe.close();
  const fixture = await harness(t, { contextWindow: 65536, includeSummary: true });
  const runtime = await openConversation(fixture.config, 'final-context-limit', { enableSearch: true });
  try {
    const reserve = fixture.config.maxOutputTokens + Math.max(128, Math.ceil(fixture.config.contextWindow * 0.01));
    const memoryContext = 'x'.repeat(fixture.config.contextWindow - reserve - largestBeforeResults - Math.ceil(growth / 2));
    await assert.rejects(runtime.prompt('搜索', { runId: 'context', memoryContext, companionTools }));
    assert.equal(fixture.requests.length, 2);
    assert.ok(fixture.requests.every(body => estimateContext(body, fixture.config.contextWindow, fixture.config.maxOutputTokens).fits));
    assert.equal(fixture.nativeCalls.length, 1);
  } finally { await runtime.close(); }
});
