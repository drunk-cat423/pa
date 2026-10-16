import assert from 'node:assert/strict';
import test from 'node:test';
import { boundWebFetchResult } from '../dist/runtime.js';

test('长网页只裁正文，JSON有效且抓取时间和全部日期证据保留在整体预算内', () => {
  const response = { url: 'https://example.test/article', statusCode: 200, text: '正文😀"\\\n'.repeat(10000), truncated: false,
    fetchedAt: '2026-10-16T00:00:00.000Z', dateEvidence: [
      { kind: 'published', value: '2026-10-14', source: 'meta:article:published_time' },
      { kind: 'modified', value: '2026-10-15', source: 'jsonld:dateModified' },
      { kind: 'http_last_modified', value: 'Thu, 15 Oct 2026 00:00:00 GMT', source: 'header:last-modified' },
    ] };
  const prefix = '网页证据：\n';
  const text = boundWebFetchResult(response, 4096, prefix);
  assert.ok(Buffer.byteLength(text) <= 4096);
  const parsed = JSON.parse(text.slice(prefix.length));
  for (const key of ['url', 'statusCode', 'fetchedAt', 'dateEvidence']) assert.deepEqual(parsed[key], response[key]);
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.text.length < response.text.length);
  assert.ok(response.text.startsWith(parsed.text));
  assert.doesNotMatch(parsed.text, /[\ud800-\udbff]$/u);
});

test('短网页保留原文；元数据自身超限时明确失败且不返回残缺JSON', () => {
  const response = { url: 'https://example.test', statusCode: 200, text: '短正文', truncated: true,
    fetchedAt: '2026-10-16T00:00:00.000Z', dateEvidence: [] };
  assert.deepEqual(JSON.parse(boundWebFetchResult(response, 4096)), response);
  assert.throws(() => boundWebFetchResult(response, 5), /元数据超过工具输出预算/);
});
