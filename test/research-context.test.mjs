import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { compactResearchContext, researchContextReference } from '../dist/research-context.js';
import { openConversation } from '../dist/runtime.js';

const body = '保存的原文😀'.repeat(900);
const assistant = (id, tool = 'web_fetch') => ({ role: 'assistant', content: [
  { type: 'thinking', thinking: '不能删除的思考', thinkingSignature: 'reasoning_content' },
  { type: 'toolCall', id, name: tool, arguments: { url: 'https://example.com' } },
], timestamp: 1 });
const result = (id, extra = {}) => ({ role: 'toolResult', toolCallId: id, toolName: 'web_fetch',
  content: [{ type: 'text', text: body }], isError: false, timestamp: 1, ...extra });
const fetched = { url: 'https://example.com', coverage: { offset: 0, end: 500, totalChars: 900, contentHash: 'hash' },
  text: '未核验材料：\n' + JSON.stringify({ url: 'https://example.com', text: body, hasMore: true,
    nextCursor: 'real-cursor', offset: 0, endOffset: 500, totalChars: 900, readBudgetExhausted: false }) };

test('旧正文投影保留精确材料编号、来源、覆盖游标与字面摘录', () => {
  const reference = researchContextReference('web_fetch', { url: fetched.url }, fetched, 'e12');
  const projected = JSON.parse(reference.text);
  assert.equal(projected.id, 'e12'); assert.equal(projected.url, fetched.url);
  assert.equal(projected.nextCursor, 'real-cursor'); assert.equal(projected.hasMore, true);
  assert.deepEqual(projected.coverage, fetched.coverage);
  assert.equal(projected.endOffset, 500); assert.equal(projected.bodyOmitted, true);
  assert.equal(projected.excerpt, [...body].slice(0, 240).join(''));
  assert.match(projected.notice, /read_research_material/);
  assert.equal(researchContextReference('web_fetch', {}, fetched, 'invented-id'), undefined);
  assert.equal(researchContextReference('web_fetch', {}, { originalRead: false, code: 'network' }, 'e1'), undefined);
  assert.equal(researchContextReference('web_fetch', {}, { text: '残缺JSON{' }, 'e1'), undefined);
});

test('只压缩有引用及合法配对的旧结果，最新整批/错误/非文本/未知工具完整保留且不改变原数组', () => {
  const messages = [assistant('old'), result('old'), assistant('error'), result('error', { isError: true }),
    assistant('image'), result('image', { content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }] }),
    assistant('unmapped'), result('unmapped'), assistant('mismatch', 'other_tool'), result('mismatch'),
    { ...assistant('latest1'), content: [...assistant('latest1').content, ...assistant('latest2').content] },
    result('latest1'), result('latest2')];
  const before = structuredClone(messages);
  const reference = researchContextReference('web_fetch', {}, fetched, 'e12');
  const refs = new Map(['old', 'error', 'image', 'mismatch', 'latest1', 'latest2'].map(id => [id, reference]));
  const projected = compactResearchContext(messages, refs);
  assert.deepEqual(messages, before); assert.notDeepEqual(projected[1], messages[1]);
  assert.equal(projected[1].toolCallId, 'old'); assert.equal(projected[1].isError, false);
  for (let index = 0; index < messages.length; index++) if (index !== 1) assert.equal(projected[index], messages[index]);
  assert.equal(compactResearchContext([], refs).length, 0);
  assert.deepEqual(compactResearchContext([result('orphan')], refs), [result('orphan')]);
});

for (const enabled of [false, true]) test(`本地HTTP采集循环：轻量投影${enabled ? '启用' : '关闭'}，完整思考与原始Pi记录保留`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-context-'));
  const requests = [], errors = [], recorded = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) raw += part;
      const payload = JSON.parse(raw); requests.push(payload);
      const number = requests.length;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'fixture',
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      emit({ role: 'assistant', reasoning_content: `完整思考${number}` });
      if (number < 4) emit({ tool_calls: [{ index: 0, id: `read-${number}`, type: 'function', function: {
        name: 'read_research_material', arguments: JSON.stringify({ id: 'e1', offset: number }),
      } }] });
      else emit({ content: '完成采集' });
      emit({}, number < 4 ? 'tool_calls' : 'stop'); response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let runtime;
  t.after(async () => { await runtime?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true }); assert.deepEqual(errors, []); });
  runtime = await openConversation({ cwd: directory, dataDir: join(directory, 'data'), provider: 'fixture', model: 'fixture',
    apiKey: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 131072,
    maxOutputTokens: 4096, timeoutMs: 5000, loop: { maxModelCalls: 4, maxToolCalls: 8 },
  }, 'collect', { research: { phase: 'collect', compactResearchContext: enabled, maxSearchCalls: 0,
    record: event => recorded.push(event), readMaterial: input => ({ id: input.id, text: body, offset: input.offset,
      nextOffset: 2500, totalChars: 5000 }),
    resolveMaterialReference(tool, input, value) {
      assert.ok(recorded.some(event => event.tool === tool && event.input === input && event.result === value));
      return { id: value.id };
    },
  } });
  await runtime.prompt('采集材料'); assert.equal(requests.length, 4);
  const thirdTools = requests[2].messages.filter(message => message.role === 'tool');
  assert.equal(thirdTools.length, 2);
  assert.equal(thirdTools[0].content.includes('saved_research_material'), enabled);
  assert.ok(thirdTools[1].content.includes(body.slice(0, 900)));
  assert.equal(requests[2].messages.find(message => message.role === 'assistant').reasoning_content, '完整思考1');
  assert.deepEqual(thirdTools.map(message => message.tool_call_id), ['read-1', 'read-2']);
  const files = await readdir(join(directory, 'data'), { recursive: true });
  const sessions = files.filter(file => file.endsWith('session.jsonl'));
  assert.equal(sessions.length, 1);
  const session = await readFile(join(directory, 'data', sessions[0]), 'utf8');
  // Pi already bounds tool output before saving; this projection must not alter
  // that original bounded output or the independently recorded full material.
  assert.ok(session.includes(body.slice(0, 900))); assert.equal(session.includes('saved_research_material'), false);
  assert.ok(recorded.filter(event => event.kind === 'tool_result').every(event => event.result.text === body));
});
