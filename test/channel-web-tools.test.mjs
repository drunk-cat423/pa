import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChannelHarness } from '../dist/channel-harness.js';

test('搜索只传生成摘要+真实参考链接；直接贴链接只抓取，真实Pi循环及分段投递互斥', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-channel-web-'));
  const requests = [], sent = [], nativeSearch = [], pageRequests = [], dnsRequests = [];
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    const tool = typeof body.tool_choice === 'object' ? body.tool_choice.function.name : undefined;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function',
      function: { name: tool, arguments: '{}' } }] } : { role: 'assistant', content: '离线回答。'.repeat(110) };
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
  } }, 0);
  t.after(async () => { globalThis.fetch = originalFetch; await harness.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const message = (text, mentioned = true) => ({ route, eventId: 'evt' + ++event, senderId: 'user', text, mentioned, sentAt: new Date().toISOString() });
  assert.equal(await harness.handle(message('搜一下和 https://example.com/search-source 有关的东西')), 'sent');
  assert.equal(nativeSearch.length, 1);
  assert.equal(pageRequests.length, 0);
  assert.deepEqual(requests[0].tools.map(tool => tool.function.name), ['web_search']);
  assert.match(JSON.stringify(requests[1].messages.filter(message => message.role === 'tool')), /SUMMARY_MARKER/);
  assert.ok(sent.length > 1);
  assert.match(sent.map(part => part.text).join(''), /\[参考链接\]\nhttps:\/\/example.com\/search-source$/);
  assert.ok(sent.every(part => [...part.text].length <= 500));
  const previousSends = sent.length;
  assert.equal(await harness.handle(message('https://example.com/article')), 'sent');
  assert.equal(nativeSearch.length, 1);
  assert.equal(pageRequests.length, 1);
  assert.equal(dnsRequests.length, 2);
  assert.deepEqual(requests[2].tools.map(tool => tool.function.name), ['web_fetch']);
  assert.match(JSON.stringify(requests[3].messages.filter(message => message.role === 'tool')), /PAGE_MARKER/);
  assert.match(sent.slice(previousSends).map(part => part.text).join(''), /\[参考链接\]\nhttps:\/\/example.com\/article$/);
  assert.equal(await harness.handle(message('https://example.com/no-mention', false)), 'observed');
  assert.equal(pageRequests.length, 1);
  await harness.close();
});
