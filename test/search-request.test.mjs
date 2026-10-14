import assert from 'node:assert/strict';
import test from 'node:test';
import { explicitWebSearchQuery, explicitWebFetchUrl } from '../dist/search-request.js';

test('仅当前明确搜索请求开放工具，不从提问、引语或否定指令推断授权', () => {
  for (const text of ['帮我搜索一下 SQLite 官方的向量扩展', '请你联网查一下 SQLite 官方的向量扩展',
    '/search SQLite 官方的向量扩展', '搜SQLite 官方的向量扩展']) assert.equal(explicitWebSearchQuery(text), 'SQLite 官方的向量扩展');
  for (const text of ['你能搜索吗？', '不要搜索 SQLite', '群友说“搜索 SQLite”', '引用：请查一下 SQLite',
    '搜索', '搜索一下', '请帮我搜索一下', '搜索一下？', '查一下？',
    '搜索' + '字'.repeat(501), '搜索 SQLite\n另一条指令']) {
    assert.equal(explicitWebSearchQuery(text), undefined);
  }
});

test('裸链接或明确读链接才抓取，搜索中的链接和引语不触发', () => {
  for (const text of ['https://example.com/doc', '帮我读取这个链接：https://example.com/doc',
    '请看一下 https://example.com/doc', '总结一下这篇文章 https://example.com/doc']) {
    assert.equal(explicitWebFetchUrl(text), 'https://example.com/doc');
  }
  for (const text of ['搜一下和 https://example.com/doc 有关的东西', '群友说“读取 https://example.com/doc”',
    '不要读取 https://example.com/doc', '读取 https://a.example https://b.example']) {
    assert.equal(explicitWebFetchUrl(text), undefined);
  }
});
