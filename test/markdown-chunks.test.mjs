import assert from 'node:assert/strict';
import test from 'node:test';
import { MARKDOWN_CHUNK_BYTES, splitMarkdown } from '../dist/markdown-chunks.js';

test('fenced code blocks close and reopen at boundaries while preserving code',()=>{
  for (const marker of ['```','~~~~']) {
    const code='console.log("你好😀");\n'.repeat(300);
    const chunks=splitMarkdown(`${marker}ts\n${code}${marker}\n`);
    assert.ok(chunks.length>1);
    assert.ok(chunks.every(chunk=>chunk.startsWith(`${marker}ts\n`) && chunk.trimEnd().endsWith(marker)));
    const restored=chunks.map(chunk=>chunk.replace(new RegExp(`^${marker}ts\\n`),'').replace(new RegExp(`\\n${marker}\\n?$`),'')).join('');
    assert.equal(restored,code.trimEnd());
    assert.ok(chunks.every(chunk=>Buffer.byteLength(chunk)<=MARKDOWN_CHUNK_BYTES));
  }
});
