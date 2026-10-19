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
import { isPreparationRequest, preparationDelta } from './fixtures/turn-preparation.mjs';

test('真实Pi用游标读到后半段，同任务重复URL不重抓，下一轮旧游标失效且重新抓取', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-fetch-pages-'));
  const url = 'https://example.com/long-article';
  const source = 'x'.repeat(8500) + '后半部分_TAIL_MARKER';
  const requests = [], delivered = [], pages = [];
  let turn = 0, step = 0, oldCursor, pageRequests = 0, budgetScenario = false;
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text); requests.push(body);
    let delta, tool = true;
    if (isPreparationRequest(body)) {
      turn++; step = 0;
      delta = preparationDelta('prepare-' + turn);
    } else {
      step++;
      const lastTool = body.messages.findLast(message => message.role === 'tool');
      let page;
      if (lastTool?.content?.includes('"endOffset"')) {
        page = JSON.parse(lastTool.content.slice(lastTool.content.indexOf('\n') + 1));
        pages.push({ turn, step, ...page });
        assert.ok(Buffer.byteLength(lastTool.content) <= 16000);
      }
      let args;
      if (budgetScenario) {
        if (step === 1) args = { url };
        else {
          assert.equal(page.hasMore, true);
          assert.equal(page.nextCursor, null);
          assert.equal(page.readBudgetExhausted, true);
          if (budgetScenario === 'batch') {
            const results = body.messages.filter(message => message.role === 'tool' && message.content?.includes('"endOffset"'));
            assert.equal(results.length, 2);
            for (const result of results) {
              const queuedPage = JSON.parse(result.content.slice(result.content.indexOf('\n') + 1));
              assert.equal(queuedPage.hasMore, true);
              assert.equal(queuedPage.nextCursor, null);
              assert.equal(queuedPage.readBudgetExhausted, true);
            }
          }
          delta = { role: 'assistant', content: '预算已到上限，后半部分尚未读完。' }; tool = false;
        }
      } else if (step === 1) args = turn === 1 ? { url } : { url, cursor: oldCursor };
      else if (step === 2) {
        if (turn === 1) {
          oldCursor = page.nextCursor;
          args = { url: url + '#another-section' };
        } else {
          assert.match(lastTool.content, /游标无效/);
          args = { url };
        }
      } else if (step === 3) {
        assert.ok(page.nextCursor);
        args = { url, cursor: page.nextCursor };
      } else {
        assert.equal(page.hasMore, false);
        assert.match(page.text, /后半部分_TAIL_MARKER/);
        delta = { role: 'assistant', content: '已读到后半部分_TAIL_MARKER。' }; tool = false;
      }
      if (args) delta = { role: 'assistant', tool_calls: [{ index: 0, id: `fetch-${turn}-${step}`,
        type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify(args) } }] };
      if (budgetScenario === 'batch' && step === 1) delta.tool_calls.push({ index: 1, id: `fetch-${turn}-${step}-second`,
        type: 'function', function: { name: 'web_fetch', arguments: JSON.stringify({ url: url + '?second' }) } });
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choices of [[{ index: 0, delta, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }]]) {
      response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'test', choices })}\n\n`);
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.mock.method(https, 'request', (...args) => {
    const isPage = args[0] instanceof URL;
    const options = isPage ? args[1] : args[0];
    const callback = isPage ? args[2] : args[1];
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, undefined);
    assert.equal(options.rejectUnauthorized, true);
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      if (isPage) { pageRequests++; assert.ok([url, url + '?second'].includes(args[0].href)); }
      const body = isPage ? source : JSON.stringify({ Status: 0, Answer:
        options.path.includes('type=A&') || options.path.endsWith('type=A') ? [{ type: 1, data: '93.184.216.34' }] : [] });
      const result = Readable.from([Buffer.from(body)]);
      result.statusCode = 200; result.headers = { 'content-type': isPage ? 'text/plain; charset=utf-8' : 'application/dns-json' };
      callback(result);
    });
    return req;
  });
  const route = { channel: 'qq', accountId: 'bot', roomId: 'group', roomType: 'group' };
  const config = { cwd: process.cwd(), dataDir: join(directory, 'data'), provider: 'fixture',
    model: 'test', apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    contextWindow: 131072, maxOutputTokens: 1024, timeoutMs: 10000,
    memory: { enabled: false, maxCalls: 0, timeoutMs: 1000 },
    fetch: { enabled: true, publicDns: true, timeoutMs: 1000, maxResponseBytes: 1048576, maxTextChars: 6000 } };
  const sender = { send: async message => { delivered.push(message); return { status: 'sent', externalMessageId: 'part-' + delivered.length }; } };
  const harness = new ChannelHarness(config, [route], sender, 0, { version: 1, ownerBindings: [] });
  t.after(async () => { await harness.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  for (let id = 1; id <= 2; id++) {
    assert.equal(await harness.handle({ route, eventId: 'evt-' + id, senderId: 'user', text: '读完 ' + url,
      mentioned: true, sentAt: new Date().toISOString() }), 'sent');
    assert.equal(pageRequests, id);
  }
  assert.equal(requests.length, 10);
  assert.ok(delivered.filter(message => message.text.includes('后半部分_TAIL_MARKER')).length === 2);
  const first = pages.filter(page => page.turn === 1);
  assert.equal(first[0].cached, false);
  assert.equal(first[1].cached, true);
  assert.equal(first[0].text, first[1].text);
  assert.equal(first[0].text + first[2].text, source);
  const second = pages.filter(page => page.turn === 2);
  assert.equal(second[0].cached, false);
  assert.equal(second[0].text + second[1].text, source);
  budgetScenario = true;
  for (const [name, loop] of [['tools', { maxModelCalls: 6, maxToolCalls: 2 }], ['model', { maxModelCalls: 3, maxToolCalls: 8 }],
    ['batch', { maxModelCalls: 3, maxToolCalls: 8 }]]) {
    budgetScenario = name;
    const limited = new ChannelHarness({ ...config, dataDir: join(directory, name), loop }, [route], sender, 0, { version: 1, ownerBindings: [] });
    try {
      assert.equal(await limited.handle({ route, eventId: 'evt-' + name, senderId: 'user', text: '读完 ' + url,
        mentioned: true, sentAt: new Date().toISOString() }), 'sent');
    } finally { await limited.close(); }
  }
  assert.equal(pageRequests, 6);
});
