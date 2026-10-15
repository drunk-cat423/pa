import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { searchDeepSeek, parseSearchResponse, WebSearchError, WebSearchPersistenceError } from '../dist/web-search.js';

const nativeResponse = (content = [{ type: 'web_search_tool_result', content: [
  { type: 'web_search_result', url: 'https://example.com/article', title: 'Example', page_age: '2 days ago' },
] }], usage = {}) => new Response(JSON.stringify({ content, usage }), { status: 200 });

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pa-web-search-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return {
    cwd: process.cwd(), dataDir, provider: 'deepseek', model: 'unused', apiKey: 'fixture-key',
    contextWindow: 1000, maxOutputTokens: 100, timeoutMs: 1000,
    search: { enabled: true, budgetId: 'test-budget', maxRequests: 3, maxUses: 2,
      maxTokens: 400, timeoutMs: 1000, model: 'deepseek-chat', maxResults: 5 },
    ...overrides,
  };
}

test('调用固定 DeepSeek 搜索端点，提取原生来源、引用片段和 usage，并持久化预算', async t => {
  const config = await fixture(t);
  let request;
  const result = await searchDeepSeek(config, '最新官方文档', undefined, async (url, options) => {
    request = { url, options };
    return nativeResponse([
      { type: 'text', text: '忽略模型生成回答', citations: [{ url: 'https://example.com/article', cited_text: '原文摘录'.repeat(300) }] },
      { type: 'web_search_tool_result', content: [
        { type: 'web_search_result', url: 'https://example.com/article', title: 'Example', page_age: '2 days ago' },
        { type: 'web_search_result', url: 'javascript:alert(1)', title: 'unsafe' },
        { type: 'web_search_result', url: 'https://example.com/second' },
      ] },
    ], { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3,
      cache_creation_input_tokens: 2, server_tool_use: { web_search_requests: 2 } });
  });
  assert.equal(request.url, 'https://api.deepseek.com/anthropic/v1/messages');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.headers['x-api-key'], 'fixture-key');
  assert.equal(request.options.headers.Authorization, 'Bearer fixture-key');
  assert.equal(request.options.headers['anthropic-version'], '2023-06-01');
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.tools[0].max_uses, 2);
  assert.equal(payload.max_tokens, 400);
  assert.match(payload.messages[0].content[0].text, /最新官方文档/);
  assert.deepEqual(result.sources.map(source => source.url), ['https://example.com/article', 'https://example.com/second']);
  assert.equal(result.sources[0].snippet.length, 1000);
  assert.equal(result.sources[0].pageUpdatedAt, '2 days ago');
  assert.equal(result.sources[0].publishedAt, undefined);
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3,
    cacheWriteTokens: 2, totalTokens: 19, serverSearches: 2 });
  const dirs = await readdir(config.dataDir);
  const ledgerText = await readFile(join(config.dataDir, dirs[0], 'search-attempts.jsonl'), 'utf8');
  const events = ledgerText.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), ['reserved', 'completed']);
  assert.equal(events[0].query, '最新官方文档');
  assert.deepEqual(events[1].sources, result.sources);
});

test('搜索助手接收当前北京时间及软日期范围，不添加未支持的API过滤参数', async t => {
  const config = await fixture(t);
  const before = Date.now();
  let payload, calls = 0;
  const range = { startDate: '2026-10-08', endDate: '2026-10-15' };
  const output = await searchDeepSeek(config, '近期更新', undefined, async (_url, options) => {
    calls++; payload = JSON.parse(options.body); return nativeResponse();
  }, range);
  const context = JSON.parse(payload.messages[0].content[0].text.split('\n')[1]);
  assert.equal(context.timeZone, 'Asia/Shanghai');
  assert.ok(Date.parse(context.currentTime) >= Math.floor(before / 1000) * 1000);
  assert.ok(Date.parse(context.currentTime) <= Date.now());
  assert.deepEqual(context.requestedDateRange, range);
  assert.deepEqual(Object.keys(payload).sort(), ['max_tokens', 'messages', 'model', 'tools']);
  assert.deepEqual(Object.keys(payload.tools[0]).sort(), ['max_uses', 'name', 'type']);
  assert.deepEqual(output.freshness, { searchedAt: context.currentTime, timeZone: 'Asia/Shanghai',
    requestedDateRange: range, dateFilterApplied: false, verification: 'unverified' });
  assert.equal(calls, 1);
});

test('非法日期与倒置范围在预算预留前拒绝，无范围不擅自限制历史搜索', async t => {
  const config = await fixture(t);
  let calls = 0;
  const fetcher = async () => { calls++; return nativeResponse(); };
  for (const range of [{ startDate: '2026-02-29' }, { endDate: '2026-10-32' },
    { startDate: 'today' }, { startDate: '2026-10-16', endDate: '2026-10-15' }]) {
    await assert.rejects(searchDeepSeek(config, '历史', undefined, fetcher, range), WebSearchError);
  }
  assert.equal(calls, 0);
  assert.deepEqual(await readdir(config.dataDir), []);
  const result = await searchDeepSeek(config, '历史', undefined, fetcher);
  assert.equal(result.freshness.requestedDateRange, null);
  assert.equal(result.freshness.verification, 'unverified');
  const leap = await searchDeepSeek(config, '闰年', undefined, fetcher, { startDate: '2024-02-29' });
  assert.deepEqual(leap.freshness.requestedDateRange, { startDate: '2024-02-29' });
});

test('旧publishedAt账本仍计入原有预算，不会因日期字段修正重置调用上限', async t => {
  const config = await fixture(t);
  config.search.maxRequests = 1;
  await searchDeepSeek(config, '历史调用', undefined, async () => nativeResponse());
  const directory = join(config.dataDir, createHash('sha256').update('web-search-budget:test-budget').digest('hex'));
  const path = join(directory, 'search-attempts.jsonl');
  const events = (await readFile(path, 'utf8')).trim().split('\n').map(JSON.parse);
  events[1].sources[0].publishedAt = events[1].sources[0].pageUpdatedAt;
  delete events[1].sources[0].pageUpdatedAt;
  await writeFile(path, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  await assert.rejects(searchDeepSeek(config, '继续', undefined, async () => { throw Error('must not dispatch'); }), /预算已用尽/);
});

test('摘录按同一页面关联：忽略URL锚点但不合并不同查询参数，不采信生成回答', () => {
  const result = parseSearchResponse({ content: [
    { type: 'web_search_tool_result', content: [
      { type: 'web_search_result', url: 'https://example.com/article?id=1#main-container' },
      { type: 'web_search_result', url: 'https://example.com/article?id=2' },
      { type: 'web_search_result', url: 'https://docs.example/#/guide-a' },
      { type: 'web_search_result', url: 'https://docs.example/#!/guide-a' },
    ] },
    { type: 'text', text: 'Generated answer is not a source excerpt.', citations: [
      { url: 'https://example.com/article?id=1', cited_text: '原文引用' },
      { url: 'https://unreturned.example.com/', cited_text: '不是原生结果中的来源' },
      { url: 'https://docs.example/#/guide-b', cited_text: '不同页面不应关联' },
      { url: 'https://docs.example/#!/guide-b', cited_text: '不同页面不应关联' },
    ] },
  ] }, 5);
  assert.equal(result.sources[0].snippet, '原文引用');
  assert.equal(result.sources[1].snippet, undefined);
  assert.equal(result.sources[2].snippet, undefined);
  assert.equal(result.sources[3].snippet, undefined);
  assert.equal(result.sources.length, 4);
});

test('原始请求/响应本地留证不含认证头或key，保留未解析字段用于离线诊断', async t => {
  const config = await fixture(t);
  const result = await searchDeepSeek(config, 'public query', undefined, async () => nativeResponse([
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result',
      url: 'https://example.com/article', extra: 'unparsed field' }] },
    { type: 'text', text: 'fixture-key', citations: [] },
  ], { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } }));
  const directory = join(config.dataDir, createHash('sha256').update('web-search-budget:' + config.search.budgetId).digest('hex'));
  const request = await readFile(join(directory, result.attemptId + '.request.json'), 'utf8');
  const response = await readFile(join(directory, result.attemptId + '.response.json'), 'utf8');
  assert.doesNotMatch(request + response, /fixture-key|Authorization|x-api-key/);
  assert.match(response, /unparsed field/);
  assert.match(response, /\[redacted\]/);
  assert.equal(JSON.parse(response).usage.input_tokens, 10);
});

test('损坏账本和没有对应预留的终结事件会 fail closed', async t => {
  const config = await fixture(t, { search: { enabled: true, budgetId: 'corrupt-ledger', maxRequests: 2,
    maxUses: 1, maxTokens: 100, timeoutMs: 1000, model: 'deepseek-chat', maxResults: 2 } });
  const directory = join(config.dataDir, createHash('sha256').update('web-search-budget:corrupt-ledger').digest('hex'));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'search-attempts.jsonl'), `${JSON.stringify({ type: 'completed',
    attemptId: '00000000-0000-4000-8000-000000000001', timestamp: new Date().toISOString(), sources: [],
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, serverSearches: null } })}\n`);
  await assert.rejects(searchDeepSeek(config, 'query', undefined, async () => nativeResponse()), WebSearchPersistenceError);
});

test('预算在重复调用与重建调用方后持续消耗，失败请求同样占用额度', async t => {
  const config = await fixture(t, { search: { enabled: true, budgetId: 'persistent', maxRequests: 1,
    maxUses: 1, maxTokens: 100, timeoutMs: 1000, model: 'deepseek-chat', maxResults: 2 } });
  const reject = () => nativeResponse([{ type: 'text', text: '我搜到了来源：https://example.com' }]);
  await assert.rejects(searchDeepSeek(config, '一次', undefined, reject), WebSearchError);
  await assert.rejects(searchDeepSeek({ ...config }, '重启后仍耗尽', undefined, reject), /预算已用尽/);
});

test('零配额不限累计请求与服务端搜索次数，仍记录账本且省略 max_uses', async t => {
  const capped = await fixture(t, { search: { enabled: true, budgetId: 'unlimited', maxRequests: 1,
    maxUses: 1, maxTokens: 100, timeoutMs: 1000, model: 'deepseek-flash', maxResults: 2 } });
  const payloads = [];
  await searchDeepSeek(capped, '原有有限配额', undefined, async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return nativeResponse(undefined, { input_tokens: 10, output_tokens: 2,
      server_tool_use: { web_search_requests: 2 } });
  });
  const unlimited = { ...capped, search: { ...capped.search, maxRequests: 0, maxUses: 0 } };
  for (const query of ['二次', '三次']) {
    await searchDeepSeek(unlimited, query, undefined, async (_url, options) => {
      payloads.push(JSON.parse(options.body));
      return nativeResponse(undefined, { input_tokens: 10, output_tokens: 2,
        server_tool_use: { web_search_requests: 2 } });
    });
  }
  assert.equal(payloads.length, 3);
  assert.equal(payloads[0].tools[0].max_uses, 1);
  assert.ok(payloads.slice(1).every(payload => !('max_uses' in payload.tools[0])));
  const dirs = await readdir(capped.dataDir);
  const events = (await readFile(join(capped.dataDir, dirs[0], 'search-attempts.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.type === 'reserved').length, 3);
  assert.equal(events.filter(event => event.type === 'completed').length, 3);
});

test('搜索工具错误和没有原生结果块不会采信模型生成的链接', async t => {
  const config = await fixture(t);
  await assert.rejects(searchDeepSeek(config, 'query', undefined,
    async () => nativeResponse([{ type: 'text', text: 'Found https://invented.example' }])), /没有网页搜索结果块/);
  await assert.rejects(searchDeepSeek(config, 'query', undefined,
    async () => nativeResponse([{ type: 'web_search_tool_error', error_code: 'untrusted detail' }])), /工具执行失败/);
  assert.throws(() => parseSearchResponse({ content: [
    { type: 'web_search_tool_result', content: [{ type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }] },
    { type: 'text', text: '没有成功检索时的总结' },
  ] }, 5), /工具执行失败/);
  const partial = parseSearchResponse({ content: [
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://example.com/' }] },
    { type: 'web_search_tool_result', content: [{ type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' }] },
    { type: 'text', text: '保留已有结果的总结' },
  ] }, 5);
  assert.equal(partial.summary, '保留已有结果的总结');
  assert.equal(partial.sources.length, 1);
});

test('服务端报告超出max_uses后同一预算暂停；缺失usage不记为零token', async t => {
  const config = await fixture(t, { search: { enabled: true, budgetId: 'overrun', maxRequests: 3,
    maxUses: 1, maxTokens: 100, timeoutMs: 1000, model: 'deepseek-flash', maxResults: 2 } });
  const result = await searchDeepSeek(config, '一次', undefined, async () => nativeResponse(undefined,
    { input_tokens: 100, output_tokens: 20, server_tool_use: { web_search_requests: 2 } }));
  assert.equal(result.usage.serverSearches, 2);
  await assert.rejects(searchDeepSeek(config, '不再请求', undefined,
    async () => { throw new Error('must not dispatch'); }), /此预算已暂停/);
  const unknown = await searchDeepSeek({ ...config, search: { ...config.search, budgetId: 'unknown' } },
    '无usage', undefined, async () => nativeResponse());
  assert.equal(unknown.usage.totalTokens, null);
});

test('并发调用拒绝占用中的预算；取消信号会中止 provider 请求并留下失败记录', async t => {
  const config = await fixture(t);
  let releaseFetch;
  const first = searchDeepSeek(config, 'first', undefined, () => new Promise(resolve => { releaseFetch = resolve; }));
  while (!releaseFetch) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(searchDeepSeek(config, 'second', undefined, async () => nativeResponse()), /其他请求占用/);
  releaseFetch(nativeResponse());
  await first;

  const controller = new AbortController();
  let seenSignal;
  const cancelled = searchDeepSeek(config, 'cancel me', controller.signal, async (_url, options) => {
    seenSignal = options.signal;
    return await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  });
  while (!seenSignal) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort();
  await assert.rejects(cancelled, /已取消/);
  assert.equal(seenSignal.aborted, true);
});

test('预留账本期间收到取消时不发送请求，仍记录消耗的预算', async t => {
  const config = await fixture(t);
  let reads = 0;
  const signal = {
    get aborted() { reads += 1; return reads >= 4; },
    addEventListener() {},
    removeEventListener() {},
  };
  let dispatched = false;
  await assert.rejects(searchDeepSeek(config, 'cancel before dispatch', signal,
    async () => { dispatched = true; return nativeResponse(); }), /已取消/);
  assert.equal(dispatched, false);
  const dirs = await readdir(config.dataDir);
  const events = (await readFile(join(config.dataDir, dirs[0], 'search-attempts.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.type), ['reserved', 'failed']);
});
