import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownBodyPages,markdownDocument,displayedPage,PAGE_COMMAND } from '../dist/markdown-pages.js';

test('Unicode and pathological long lines stay within UTF8 bytes without losing content',()=>{
  for (const text of ['你好😀'.repeat(3000),'https://example.com/'+ 'a'.repeat(10000)]) {
    const pages=markdownBodyPages(text);
    assert.equal(pages.join(''),text);
    pages.forEach((page,index)=>assert.ok(Buffer.byteLength(displayedPage('',pages,index+1))<=1500));
  }
});

test('fenced code blocks close and reopen at boundaries and preserve complete code',()=>{
  for (const marker of ['```','~~~~']) {
    const code='console.log("你好😀");\n'.repeat(300);
    const pages=markdownBodyPages(`${marker}ts\n${code}${marker}\n`);
    assert.ok(pages.length>1);
    assert.ok(pages.every(page=>page.startsWith(`${marker}ts\n`) && page.trimEnd().endsWith(marker)));
    const restored=pages.map(page=>page.replace(new RegExp(`^${marker}ts\\n`),'').replace(new RegExp(`\\n${marker}\\n?$`),'')).join('');
    assert.equal(restored,code.trimEnd());
    assert.ok(pages.every(page=>Buffer.byteLength(page)<1500));
  }
});

test('summary uses only bounded first prose paragraph, other formats are labelled previews',()=>{
  assert.equal(markdownDocument('简短回答'),undefined);
  assert.match(markdownDocument('结论。\n\n'+'细节'.repeat(1000)).summary,/摘要.*\n\n结论。/s);
  assert.match(markdownDocument('# 标题\n\n'+'细节'.repeat(1000)).summary,/开头预览/);
  assert.match(markdownDocument('```ts\n'+'code'.repeat(1000)+'\n```').summary,/开头预览/);
  for (const command of ['/page fake 0','/page 123e4567-e89b-12d3-a456-426614174000 -1','讨论 /page 123e4567-e89b-12d3-a456-426614174000 0']) assert.equal(PAGE_COMMAND.test(command),false);
});

test('pathological closing fences remain balanced and bounded',()=>{
  const pages=markdownBodyPages('```ts\ncode\n'+'`'.repeat(5000)+'\n');
  assert.ok(pages.every(page=>Buffer.byteLength(page)<1500));
  assert.equal(pages.join(''),'```ts\ncode\n```\n');
});
