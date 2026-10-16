import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openRecordedConversation, PersistenceError } from '../dist/conversation.js';
import { estimateContext, openConversation } from '../dist/runtime.js';

async function harness(t, { repeatedToolCall = false, truncatedSummary = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pa-search-boundary-'));
  const requests = [];
  let callId = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const searchEnabled = body.tools?.some(tool => tool.function?.name === 'web_search');
    const emitToolCall = repeatedToolCall || (searchEnabled && !body.messages.some(message => message.role === 'tool'));
    const delta = emitToolCall
      ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_search_${++callId}`, type: 'function',
        function: { name: 'web_search', arguments: JSON.stringify({ query: 'SQLite' }) } }] }
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
      { type: 'text', citations, ...(truncatedSummary ? { text: 'SUMMARY'.repeat(1000) } : {}) },
    ], usage: { input_tokens: 100, output_tokens: 10 } }));
  };

  const config = { cwd: process.cwd(), dataDir, provider: 'pa-test', model: 'test', apiKey: 'fixture-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 32768,
    maxOutputTokens: 1024, timeoutMs: 5000, loop: { maxModelCalls: 2, maxToolCalls: 8 },
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

test('模型忽略 tool_choice none 时最多发两次主请求、调用一次原生搜索，不能把 toolUse 当成功', async t => {
  const fixture = await harness(t, { repeatedToolCall: true });
  const conversation = await fixture.open('ignores-none');
  await assert.rejects(conversation.prompt('请搜索 SQLite 官方文档', {
    eventId: 'search-event', senderId: 'user', modelInputText: '请搜索 SQLite 官方文档',
  }));

  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.requests[0].tool_choice, 'auto');
  assert.equal(fixture.requests[1].tool_choice, 'none');
  assert.equal(fixture.nativeCalls.length, 1);
});

test('长工具结果裁剪仍先保留摘要截断标记，不自动续搜或追加收尾调用', async t => {
  const fixture = await harness(t, { truncatedSummary: true });
  const conversation = await fixture.open('truncated-summary');
  await conversation.prompt('查询', { eventId: 'event', senderId: 'user', modelInputText: '查询' });
  assert.equal(fixture.nativeCalls.length, 1);
  assert.equal(fixture.requests.length, 2);
  const content = fixture.requests[1].messages.find(message => message.role === 'tool').content;
  assert.match(content, /"summaryTruncated":true/);
  assert.match(content, /\[工具结果已截断\]/);
});

test('搜索结果使最终主模型请求超过上下文时不再发送第二个主模型请求', async t => {
  const calibration = await harness(t);
  const calibrationRuntime = await openConversation(calibration.config, 'calibration', { enableSearch: true });
  const emptyEstimate = calibrationRuntime.estimate('搜索', '');
  await calibrationRuntime.prompt('搜索', { runId: 'probe', memoryContext: '' });
  const calibrationFirst = estimateContext(calibration.requests[0], calibration.config.contextWindow, calibration.config.maxOutputTokens);
  const calibrationSecond = estimateContext(calibration.requests[1], calibration.config.contextWindow, calibration.config.maxOutputTokens);
  const resultGrowth = calibrationSecond.inputTokens - calibrationFirst.inputTokens;
  assert.ok(resultGrowth > 0, 'mock search results should enlarge the follow-up request');
  await calibrationRuntime.close();

  const fixture = await harness(t);
  const runtime = await openConversation(fixture.config, 'final-context-limit', { enableSearch: true });
  try {
    // Match the direct runtime estimate to a real empty-payload request, then
    // leave less room than the independently measured mock search-result growth.
    const estimateOffset = calibrationFirst.inputTokens - emptyEstimate.inputTokens;
    const headroom = Math.max(1, Math.floor(resultGrowth / 2));
    let low = 0, high = fixture.config.contextWindow;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      const estimate = runtime.estimate('搜索', 'x'.repeat(middle));
      const used = estimate.inputTokens + estimate.reservedOutputTokens + estimate.safetyTokens;
      if (used + estimateOffset <= fixture.config.contextWindow - headroom) low = middle;
      else high = middle;
    }
    const memoryContext = 'x'.repeat(low);
    const initialEstimate = runtime.estimate('搜索', memoryContext);
    assert.ok(initialEstimate.inputTokens + initialEstimate.reservedOutputTokens + initialEstimate.safetyTokens
      + estimateOffset <= fixture.config.contextWindow);
    assert.ok(fixture.config.contextWindow - initialEstimate.inputTokens
      - initialEstimate.reservedOutputTokens - initialEstimate.safetyTokens - estimateOffset < resultGrowth);
    await assert.rejects(runtime.prompt('搜索', { runId: 'context', memoryContext }));
    assert.equal(fixture.requests.length, 1);
    assert.equal(estimateContext(fixture.requests[0], fixture.config.contextWindow, fixture.config.maxOutputTokens).fits, true);
    assert.equal(fixture.requests[0].tool_choice, 'auto');
    assert.equal(fixture.nativeCalls.length, 1);
  } finally { await runtime.close(); }
});

test('搜索账本持久化失败停止会话，不能作为普通工具错误继续模型或下一轮', async t => {
  const fixture = await harness(t);
  const conversation = await fixture.open('fatal-ledger');
  const budgetDirectory = join(fixture.config.dataDir, createHash('sha256')
    .update('web-search-budget:' + fixture.config.search.budgetId).digest('hex'));
  await mkdir(join(budgetDirectory, 'search-attempts.jsonl'), { recursive: true });
  await assert.rejects(conversation.prompt('请搜索 SQLite', { eventId: 'evt1', senderId: 'user',
    modelInputText: '请搜索 SQLite' }), PersistenceError);
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.nativeCalls.length, 0);
  await assert.rejects(conversation.prompt('你好', { eventId: 'evt2', senderId: 'user', modelInputText: '你好' }));
  assert.equal(fixture.requests.length, 1);
});
