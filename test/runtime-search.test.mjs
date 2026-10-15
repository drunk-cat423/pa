import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openConversation } from '../dist/runtime.js';
import { openRecordedConversation } from '../dist/conversation.js';

test('harness真实Pi自主工具循环、查询实参、普通聊天不自动调用、CLI禁工具、重启不重放搜索', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pa-search-runtime-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const search = requests.length === 1 && body.tools?.some(tool => tool.function.name === 'web_search');
    const delta = search ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_search_1', type: 'function',
      function: { name: 'web_search', arguments: JSON.stringify({ query: 'SQLite 官方文档', startDate: '2026-10-08', endDate: '2026-10-15' }) } }] } : { role: 'assistant', content: '检索完成' };
    for (const choices of [[{ index: 0, delta, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: search ? 'tool_calls' : 'stop' }]]) {
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
        model: 'test', choices })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const originalFetch = globalThis.fetch;
  const nativeQueries = [];
  globalThis.fetch = async (url, options) => {
    if (String(url) !== 'https://api.deepseek.com/anthropic/v1/messages') return originalFetch(url, options);
    const body = JSON.parse(options.body); nativeQueries.push(body);
    return new Response(JSON.stringify({ content: [{ type: 'web_search_tool_result', content: [
      { type: 'web_search_result', url: 'https://sqlite.org/', title: 'SQLite' },
    ] }, { type: 'text', citations: [{ url: 'https://sqlite.org/', cited_text: 'SQLite official documentation' }] }],
    usage: { input_tokens: 100, output_tokens: 10 } }));
  };
  const config = { cwd: process.cwd(), dataDir, provider: 'pa-test', model: 'test', apiKey: 'fixture-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 32768,
    maxOutputTokens: 512, timeoutMs: 5000,
    search: { enabled: true, budgetId: 'fixture', model: 'deepseek-flash', maxRequests: 1, maxUses: 1,
      maxTokens: 1024, timeoutMs: 1000, maxResults: 5 },
    fetch: { enabled: true, timeoutMs: 1000, maxResponseBytes: 1048576, maxTextChars: 8000 } };
  const opened = [];
  t.after(async () => { globalThis.fetch = originalFetch;
    await Promise.allSettled(opened.map(item => item.close())); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await rm(dataDir, { recursive: true, force: true }); });
  const route = { channel: 'fixture', accountId: 'bot', roomId: 'room', roomType: 'group' };
  const conversation = await openRecordedConversation(config, 'group-search', route); opened.push(conversation);
  const reply = await conversation.prompt('请搜索 SQLite 官方文档', { eventId: 'evt1', senderId: 'user',
    modelInputText: '请搜索 SQLite 官方文档' });
  assert.match(reply.text, /检索完成/);
  assert.equal(reply.referenceUrls, undefined);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['update_profile', 'read_history', 'answer_in_depth', 'web_search', 'web_fetch']);
  assert.equal(requests[0].tool_choice, 'auto');
  assert.equal(requests[1].tool_choice, 'auto');
  assert.equal(requests[1].messages.filter(message => message.role === 'tool').length, 1);
  assert.equal(nativeQueries.length, 1);
  const searchInput = nativeQueries[0].messages[0].content[0].text;
  assert.ok(searchInput.endsWith('Perform a web search for the query: SQLite 官方文档'));
  assert.deepEqual(JSON.parse(searchInput.split('\n')[1]).requestedDateRange, { startDate: '2026-10-08', endDate: '2026-10-15' });
  const toolText = requests[1].messages.find(message => message.role === 'tool').content;
  const toolOutput = JSON.parse(toolText.slice(toolText.lastIndexOf('\n') + 1));
  assert.deepEqual(toolOutput.freshness.requestedDateRange, { startDate: '2026-10-08', endDate: '2026-10-15' });
  assert.equal(toolOutput.freshness.dateFilterApplied, false);
  assert.equal(toolOutput.freshness.verification, 'unverified');
  assert.doesNotMatch(JSON.stringify(nativeQueries), /senderId|roomMemories|personId/);
  conversation.acknowledge(reply.deliveryId, 'sent', 'reply1');
  const db = new DatabaseSync(join(dataDir, 'pa.sqlite'), { readOnly: true });
  const file = db.prepare('SELECT pi_session_file FROM agent_runs WHERE id=?').get(reply.runId).pi_session_file;
  db.close();
  assert.match(await readFile(file, 'utf8'), /"role":"toolResult"/);
  await conversation.close();
  const reopened = await openRecordedConversation(config, 'group-search', route); opened.push(reopened);
  const normal = await reopened.prompt('你好', { eventId: 'evt2', senderId: 'user', modelInputText: '你好' });
  reopened.acknowledge(normal.deliveryId, 'sent', 'reply2');
  assert.equal(requests.length, 3);
  assert.ok(requests[2].tools.some(tool => tool.function.name === 'web_search'));
  assert.equal(nativeQueries.length, 1);
  const cli = await openConversation(config, 'cli'); opened.push(cli);
  await cli.prompt('搜索 SQLite', { searchQuery: 'SQLite' });
  assert.ok(!requests[3].tools?.length);
  assert.equal(nativeQueries.length, 1);
});
