import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ChannelHarness } from '../dist/channel-harness.js';
import { isPreparationRequest, preparationDelta, totalModelCalls } from './fixtures/turn-preparation.mjs';

test('搜索及后续网页核验不附网址，单独读取网页仍保留来源，实际工具参数与投递落库', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-channel-web-'));
  const requests = [], planningRequests = [], sent = [], nativeSearch = [], pageRequests = [], dnsRequests = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    if (isPreparationRequest(body)) {
      planningRequests.push(body);
      const delta = preparationDelta(`prepare-${planningRequests.length}`, planningRequests.length === 1
        ? { intent: 'research', mode: 'professional', progressText: '我先查找并核对资料。', updates: [] }
        : { intent: 'question', mode: 'casual', updates: [] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choices of [[{ index: 0, delta, finish_reason: null }], [{ index: 0, delta: {}, finish_reason: 'tool_calls' }]]) {
        response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
          model: 'test', choices })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
      return;
    }
    requests.push(body);
    const tool = requests.length === 1 ? 'web_search' : [2, 4].includes(requests.length) ? 'web_fetch' : undefined;
    const argumentsText = JSON.stringify(tool === 'web_search' ? { query: '与 example.com search-source 有关的资料' }
      : { url: requests.length === 2 ? 'https://example.com/search-source' : 'https://example.com/article' });
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function',
      function: { name: tool, arguments: argumentsText } }] } : { role: 'assistant', content: '离线回答。'.repeat(110) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choices of [[{ index: 0, delta, finish_reason: null }], [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }]]) {
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
        model: 'test', choices })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url) !== 'https://api.deepseek.com/anthropic/v1/messages') return originalFetch(url, options);
    nativeSearch.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ content: [
      { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.com/search-source', title: 'Search source' }] },
      { type: 'web_search_tool_result', content: [{ type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }] },
      { type: 'text', text: '这是搜索模型生成的摘要，而非网页原文：SUMMARY_MARKER' },
    ], usage: { input_tokens: 20, output_tokens: 10, server_tool_use: { web_search_requests: 2 } } }));
  };
  t.mock.method(https, 'request', (...args) => {
    const isUrl = args[0] instanceof URL;
    const url = isUrl ? args[0] : undefined;
    const options = isUrl ? args[1] : args[0];
    const callback = isUrl ? args[2] : args[1];
    const req = new EventEmitter(); req.destroy = () => {}; req.setTimeout = () => req;
    req.end = () => queueMicrotask(() => {
      let body;
      if (isUrl) {
        pageRequests.push({ url: url.href, options });
        assert.equal(options.rejectUnauthorized, true);
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.headers.Cookie, undefined);
        body = '公开网页正文：PAGE_MARKER';
      } else {
        dnsRequests.push(options);
        const type = new URL(options.path, 'https://cloudflare-dns.com').searchParams.get('type');
        body = JSON.stringify({ Status: 0, Answer: type === 'A' ? [{ type: 1, data: '93.184.216.34' }] : [] });
      }
      const response = Readable.from([Buffer.from(body)]);
      response.statusCode = 200; response.headers = { 'content-type': isUrl ? 'text/plain; charset=utf-8' : 'application/dns-json' };
      callback(response);
    });
    return req;
  });
  const route = { channel: 'qq', accountId: 'bot', roomId: 'group', roomType: 'group' };
  const config = { cwd: process.cwd(), dataDir: join(directory, 'data'), provider: 'test', model: 'test', apiKey: 'fixture-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 32768, maxOutputTokens: 1024, timeoutMs: 5000,
    search: { enabled: true, budgetId: 'test', model: 'deepseek-flash', maxRequests: 1, maxUses: 1, maxTokens: 1024, timeoutMs: 1000, maxResults: 5 },
    fetch: { enabled: true, publicDns: true, timeoutMs: 1000, maxResponseBytes: 1048576, maxTextChars: 8000 } };
  let event = 0;
  const harness = new ChannelHarness(config, [route], { send: async message => {
    sent.push(message); return { status: 'sent', externalMessageId: 'part-' + sent.length };
  } }, 0, { version: 1, ownerBindings: [] });
  t.after(async () => { globalThis.fetch = originalFetch; await harness.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const message = (text, mentioned = true) => ({ route, eventId: 'evt' + ++event, senderId: 'user', text, mentioned, sentAt: new Date().toISOString() });
  assert.equal(await harness.handle(message('搜一下和 https://example.com/search-source 有关的东西')), 'sent');
  assert.equal(nativeSearch.length, 1);
  assert.equal(pageRequests.length, 1);
  assert.equal(pageRequests[0].url, 'https://example.com/search-source');
  assert.equal(requests[0].tool_choice, 'auto');
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['read_history', 'web_search', 'web_fetch']);
  assert.ok(nativeSearch[0].messages[0].content[0].text.endsWith('Perform a web search for the query: 与 example.com search-source 有关的资料'));
  assert.deepEqual(requests[0].tools.find(tool => tool.function.name === 'web_search').function.parameters.required, ['query']);
  assert.match(JSON.stringify(requests[1].messages.filter(message => message.role === 'tool')), /SUMMARY_MARKER/);
  assert.match(JSON.stringify(requests[1].messages.filter(message => message.role === 'tool')), /https:\/\/example.com\/search-source/);
  assert.match(JSON.stringify(requests[2].messages.filter(message => message.role === 'tool')), /PAGE_MARKER/);
  assert.ok(sent.length > 1);
  assert.doesNotMatch(sent.map(part => part.text).join(''), /参考链接|https?:\/\//);
  assert.ok(sent.every(part => Buffer.byteLength(part.text) <= 1500));
  const previousSends = sent.length;
  assert.equal(await harness.handle(message('https://example.com/article')), 'sent');
  assert.equal(nativeSearch.length, 1);
  assert.equal(pageRequests.length, 2);
  assert.equal(dnsRequests.length, 4);
  assert.equal(requests[3].tool_choice, 'auto');
  assert.deepEqual(requests[3].tools.map(tool => tool.function.name), ['read_history', 'web_search', 'web_fetch']);
  assert.equal(pageRequests[1].url, 'https://example.com/article');
  assert.deepEqual(requests[3].tools.find(tool => tool.function.name === 'web_fetch').function.parameters.required, ['url']);
  assert.match(JSON.stringify(requests[4].messages.filter(message => message.role === 'tool')), /PAGE_MARKER/);
  assert.ok(sent.slice(previousSends).some(part => part.markdown && !Object.hasOwn(part,'buttons')));
  const reader = new DatabaseSync(join(config.dataDir, 'pa.sqlite'), { readOnly: true });
  let documents;
  try { documents = reader.prepare('SELECT rendered_body, summary, pages_json FROM answer_documents ORDER BY rowid').all(); }
  finally { reader.close(); }
  assert.equal(documents.length, 2);
  assert.equal(documents[0].summary,'');
  assert.equal(documents[0].pages_json,'[]');
  assert.doesNotMatch(documents[0].rendered_body, /参考链接|https?:\/\//);
  assert.match(documents[1].rendered_body, /\[参考链接\]\nhttps:\/\/example.com\/article$/);
  assert.equal(totalModelCalls(requests, planningRequests), 7);
  assert.equal(await harness.handle(message('https://example.com/no-mention', false)), 'observed');
  assert.equal(pageRequests.length, 2);
  await harness.close();
  const database = new DatabaseSync(join(config.dataDir, 'pa.sqlite'), { readOnly: true });
  try {
    const parts = database.prepare('SELECT text, status, external_message_id FROM delivery_parts ORDER BY rowid').all();
    const views = database.prepare('SELECT text, status, external_message_id FROM answer_page_views ORDER BY rowid').all();
    const progress = database.prepare('SELECT text, status, external_message_id FROM run_progress ORDER BY rowid').all();
    assert.deepEqual(progress.map(item => item.text), ['我先查找并核对资料。', '我看一下链接里的内容。']);
    assert.ok(progress.every(item => item.status === 'sent' && item.external_message_id));
    const progressIds = new Set(progress.map(item => item.external_message_id));
    const replySent = sent.filter((_message, index) => !progressIds.has('part-' + (index + 1)));
    assert.equal(views.length,0);
    assert.deepEqual(parts.map(part => part.text), replySent.map(part => part.text));
    assert.ok(parts.every(part => part.status === 'sent' && part.external_message_id));
    assert.doesNotMatch(parts.map(part => part.text).join(''), /https:\/\/example.com\/search-source/);
    assert.match(parts.map(part => part.text).join(''), /https:\/\/example.com\/article/);
  } finally { database.close(); }
});
