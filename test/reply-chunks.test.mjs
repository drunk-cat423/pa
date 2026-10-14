import assert from 'node:assert/strict';
import test from 'node:test';
import { appendReferenceUrls, splitReply } from '../dist/reply-chunks.js';

test('500 code points, paragraph and sentence boundaries preserve every original character', () => {
  for (const text of ['', '😀'.repeat(500), '😀'.repeat(501), '甲'.repeat(490) + '\n\n' + '乙'.repeat(600),
    '甲'.repeat(450) + '。' + '乙'.repeat(650), 'x'.repeat(460) + '\n' + 'y'.repeat(600)]) {
    const parts = splitReply(text);
    assert.equal(parts.join(''), text);
    assert.ok(parts.every(part => [...part].length <= 500));
    assert.ok(parts.every(part => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(part)));
  }
  assert.equal(splitReply('甲'.repeat(490) + '\n\n' + '乙'.repeat(600))[0], '甲'.repeat(490) + '\n\n');
});

test('URLs are kept whole when possible; an oversized URL is hard split without losing text', () => {
  const url = 'https://example.com/' + 'a'.repeat(90);
  const text = '甲'.repeat(470) + url + '正文'.repeat(400);
  const parts = splitReply(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.some(part => part.includes(url)));
  const huge = 'https://example.com/' + 'x'.repeat(1200);
  assert.equal(splitReply(huge).join(''), huge);
  assert.ok(splitReply(huge).every(part => [...part].length <= 500));
});

test('passive reply quota increases target size while preserving full content and at most five parts', () => {
  const text = ('😀'.repeat(320) + '\n\n').repeat(22);
  const parts = splitReply(text, 500, 5);
  assert.equal(parts.length, 5);
  assert.equal(parts.join(''), text);
});

test('verified references replace only a final explicit URL list, and are deduplicated', () => {
  assert.equal(appendReferenceUrls('正文\n\n[参考链接]\nhttps://forged.example/', ['https://real.example/', 'https://real.example/']),
    '正文\n\n[参考链接]\nhttps://real.example/');
  assert.equal(appendReferenceUrls('正文含[参考链接]这个词。', ['https://real.example/']),
    '正文含[参考链接]这个词。\n\n[参考链接]\nhttps://real.example/');
});
