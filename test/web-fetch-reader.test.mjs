import assert from 'node:assert/strict';
import test from 'node:test';
import { WebFetchReader } from '../dist/web-fetch-reader.js';

const url = 'https://example.com/article';
const config = { enabled: true, timeoutMs: 1000, maxResponseBytes: 1048576, maxTextChars: 8000 };
const prefix = '候选网页证据：\n';
function fixture(text, overrides = {}, budget = {}) {
  let calls = 0;
  const document = { url, statusCode: 200, text, truncated: false, fetchedAt: '2026-10-19T00:00:00.000Z',
    dateEvidence: [{ kind: 'published', value: '2026-10-14', source: 'meta:article:published_time' }] };
  const reader = new WebFetchReader({ ...config, ...overrides },
    { maxResultBytes: 4096, maxReads: 40, maxTotalBytes: 160000, ...budget },
    async () => { calls++; return document; });
  return { reader, document, get calls() { return calls; } };
}
async function read(reader, cursor, target = url) {
  const result = await reader.read({ url: target, ...(cursor === undefined ? {} : { cursor }) }, prefix);
  return { raw: result.text, page: JSON.parse(result.text.slice(prefix.length)) };
}

test('长网页抓取一次，字节分页保留有效JSON与日期证据，续读重建完整中文、转义及emoji原文', async () => {
  const source = '正文😀"\\\n'.repeat(1800) + '后半部分_END';
  const f = fixture(source);
  let cursor, collected = '', end = 0, pages = 0;
  do {
    const { raw, page } = await read(f.reader, cursor);
    assert.ok(Buffer.byteLength(raw) <= 4096);
    for (const key of ['url', 'statusCode', 'fetchedAt', 'dateEvidence']) assert.deepEqual(page[key], f.document[key]);
    assert.equal(page.offset, end);
    assert.equal(page.totalChars, source.length);
    assert.equal(page.cached, pages > 0);
    assert.doesNotMatch(page.text, /^[\udc00-\udfff]|[\ud800-\udbff]$/u);
    collected += page.text; end = page.endOffset; pages++;
    assert.equal(page.hasMore, end < source.length);
    cursor = page.nextCursor;
  } while (cursor);
  assert.ok(pages > 2);
  assert.equal(collected, source);
  assert.equal(f.calls, 1);
});

test('字符分页限制独立于字节上限，相同URL及不同锚点重读复用缓存，不刷新抓取时间', async () => {
  const f = fixture('first second last', { maxTextChars: 6 });
  const first = (await read(f.reader)).page;
  const repeated = (await read(f.reader, undefined, url + '#section')).page;
  assert.equal(first.text, 'first ');
  assert.equal(repeated.text, first.text);
  assert.equal(repeated.cached, true);
  assert.equal(first.fetchedAt, repeated.fetchedAt);
  assert.equal((await read(f.reader, first.nextCursor)).page.text, 'second');
  assert.equal(f.calls, 1);
});

test('合法最小字符上限仍能逐个Unicode码点续读，emoji前后没有丢失或停滞', async () => {
  const f = fixture('a😀b', { maxTextChars: 1 });
  const first = (await read(f.reader)).page;
  const second = (await read(f.reader, first.nextCursor)).page;
  const third = (await read(f.reader, second.nextCursor)).page;
  assert.deepEqual([first.text, second.text, third.text], ['a', '😀', 'b']);
  assert.deepEqual([first.offset, second.offset, third.offset, third.endOffset], [0, 1, 3, 4]);
  assert.equal(third.hasMore, false);
  assert.equal(f.calls, 1);
});

test('游标不允许跨URL、跨任务、猜测或在释放后使用；无效原始地址不通过缓存绕过校验', async () => {
  const f = fixture('long body', { maxTextChars: 3 });
  const first = (await read(f.reader)).page;
  await assert.rejects(read(f.reader, first.nextCursor, 'https://example.com/other'), /游标无效/);
  await assert.rejects(read(f.reader, 'guessed'), /游标无效/);
  await assert.rejects(read(f.reader, undefined, url + '\n'), /地址无效/);
  const other = fixture('another task');
  await assert.rejects(read(other.reader, first.nextCursor), /游标无效/);
  assert.equal(other.calls, 0);
  f.reader.dispose();
  await assert.rejects(read(f.reader, first.nextCursor), /缓存已释放/);
  assert.equal(f.calls, 1);
});

test('重复读取与续读都计入次数和总字节预算，耗尽后不抓取新网页，不假称读完', async () => {
  const limited = fixture('long body', { maxTextChars: 3 }, { maxReads: 2 });
  const first = (await read(limited.reader)).page;
  const second = (await read(limited.reader, first.nextCursor)).page;
  assert.equal(second.hasMore, true);
  assert.equal(second.readBudgetExhausted, true);
  assert.equal(second.nextCursor, null);
  await assert.rejects(read(limited.reader, undefined, 'https://example.com/new'), /预算已用尽/);
  assert.equal(limited.calls, 1);
  const byteLimited = fixture('中文正文'.repeat(1000), {}, { maxResultBytes: 1024, maxTotalBytes: 1024 });
  const { raw, page } = await read(byteLimited.reader);
  assert.ok(Buffer.byteLength(raw) <= 1024);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextCursor, null);
  assert.equal(page.readBudgetExhausted, true);
  await assert.rejects(read(byteLimited.reader, undefined, 'https://example.com/new'), /预算/);
  assert.equal(byteLimited.calls, 1);
});

test('抓取失败缓存拒绝结果，不自动重试；并发相同URL只发一次请求', async () => {
  let calls = 0;
  const failing = new WebFetchReader(config, { maxResultBytes: 4096, maxReads: 4, maxTotalBytes: 16000 },
    async () => { calls++; throw new Error('fixture network failure'); });
  await assert.rejects(read(failing), /fixture network failure/);
  await assert.rejects(read(failing), /fixture network failure/);
  assert.equal(calls, 1);
  const f = fixture('short document');
  await Promise.all([read(f.reader), read(f.reader)]);
  assert.equal(f.calls, 1);
});

test('禁用、取消和处理中释放不返回缓存正文；元数据超限明确报错且不返回残缺JSON', async () => {
  const disabled = fixture('secret', { enabled: false });
  await assert.rejects(read(disabled.reader), /未启用/);
  assert.equal(disabled.calls, 0);
  const f = fixture('short'); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.reader.read({ url }, prefix, controller.signal), { name: 'AbortError' });
  assert.equal(f.calls, 0);
  const tiny = fixture('text', {}, { maxResultBytes: 5 });
  await assert.rejects(read(tiny.reader), /元数据超过/);
  const pending = read(f.reader);
  f.reader.dispose();
  await assert.rejects(pending, /缓存已释放/);
});
