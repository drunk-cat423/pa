import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openRecordedConversation,  } from '../dist/conversation.js';
import { openMemory } from '../dist/memory.js';
import { requestText } from './fixtures/request-text.mjs';

const asText = content => typeof content === 'string' ? content : content.map(part => part.text ?? '').join('');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-memory-context-'));
  const cwd = join(directory, 'project');
  await mkdir(cwd);
  const requests = [];
  const resources = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const input = requestText(asText(body.messages.at(-1).content));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (input === 'hang') { response.flushHeaders(); return; }
    const answer = `answer:${input}`;
    for (const choices of [
      [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: 'stop' }],
    ]) response.write(`data: ${JSON.stringify({ id: 'memory-test', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {
    cwd, dataDir: join(directory, 'data'), provider: 'pa-memory-test', model: 'test-model',
    apiKey: 'local-test-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    contextWindow: 32768, maxOutputTokens: 512, timeoutMs: 5000,
  };
  const track = value => { resources.push(value); return value; };
  t.after(async () => {
    await Promise.allSettled(resources.reverse().map(value => Promise.resolve().then(() => value.close())));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return {
    config, requests,
    memory: async key => track(await openMemory(config.dataDir, key)),
    conversation: async key => track(await openRecordedConversation(config, key)),
    database: () => track(new DatabaseSync(join(config.dataDir, 'pa.sqlite'))),
  };
}

function memoryMessages(request) {
  return request.messages.filter(message => JSON.stringify(message.content).includes('已保存的候选背景数据'));
}

function recalledItems(message) {
  const content = typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('');
  return JSON.parse(content.slice(content.lastIndexOf('\n') + 1));
}

test('显式记忆到期后清旧Pi投影，既有记忆块和派生对话不继续载入', async t => {
  const f = await fixture(t);
  const conversation = await f.conversation('EXPIRY');
  const memory = conversation.remember({ content: 'EXPIRING_PLAN_SECRET', expiresAt: new Date(Date.now() + 60_000).toISOString() }).memory;
  await conversation.prompt('EXPIRY_FIRST_TURN');
  assert.ok(JSON.stringify(f.requests.at(-1)).includes('EXPIRING_PLAN_SECRET'));
  // Simulate reaching the recorded deadline without a real-time wait or API cost.
  const db = f.database();
  db.prepare('UPDATE memories SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', memory.id);
  await conversation.prompt('EXPIRY_NEW_TURN');
  const body = JSON.stringify(f.requests.at(-1));
  assert.ok(!body.includes('EXPIRING_PLAN_SECRET') && !body.includes('EXPIRY_FIRST_TURN'));
  assert.equal(db.prepare('SELECT content FROM memories WHERE id=?').get(memory.id).content, 'EXPIRING_PLAN_SECRET');
});

test('真实请求追加受限完整记忆、固定system不变、SQL usage只记录实际引用', async t => {
  const f = await fixture(t);
  const conversation = await f.conversation('recall');
  await conversation.prompt('before');
  for (let index = 0; index < 12; index++) conversation.remember({ content: `背景-${index}` });
  const expected = conversation.queryMemories(undefined, 8);
  const response = await conversation.prompt('整句未命中，仍应取最近记忆');
  const request = f.requests.at(-1);
  assert.deepEqual(request.messages[0], f.requests[0].messages[0]);
  assert.ok(!request.tools?.length);
  assert.equal(memoryMessages(request).length, 1);
  const items = recalledItems(memoryMessages(request)[0]);
  assert.equal(items.length, 8);
  assert.deepEqual(items.map(item => item.id), expected.map(item => item.id));
  const db = f.database();
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_uses WHERE run_id = ?').get(response.runId).n, 8);
  assert.deepEqual(db.prepare('SELECT memory_id AS id, revision FROM memory_uses WHERE run_id = ? ORDER BY memory_id').all(response.runId)
    .map(row => ({ ...row })), items.map(({ id, revision }) => ({ id, revision })).sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(conversation.history().length, 4, 'custom memory must not become a SQL user message');
  assert.equal(conversation.history()[2].text, '整句未命中，仍应取最近记忆');
  const entries = (await readFile(conversation.info().sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.filter(entry => entry.type === 'custom_message' && entry.customType === 'pa_memory').length, 1);
  await conversation.close();
  const reopened = await f.conversation('recall');
  assert.equal(reopened.history().length, 4, 'custom memory must not break Pi/SQL integrity');
});

test('JSON转义计入8000字符预算，不截断单条，长chat原文仍可请求', async t => {
  const f = await fixture(t);
  const conversation = await f.conversation('budget');
  for (let index = 0; index < 8; index++) conversation.remember({ content: `完整-${index}-${'"\\'.repeat(850)}` });
  const original = new Map(conversation.queryMemories().map(memory => [memory.id, memory.content]));
  const input = '长'.repeat(1200);
  await conversation.prompt(input);
  const recalled = memoryMessages(f.requests[0])[0];
  assert.ok(recalled.content.length <= 8000);
  const items = recalledItems(recalled);
  assert.ok(items.length > 0 && items.length < 8);
  assert.ok(items.every(item => item.content === original.get(item.id)));
  assert.equal(requestText(asText(f.requests[0].messages.at(-1).content)), input);
  assert.equal(conversation.history()[0].text, input);
});

test('当前问题子串命中时只召回命中记忆，外部会话与未命中记忆不进入请求', async t => {
  const f = await fixture(t);
  const other = await f.memory('other');
  other.remember({ content: '主题外部secret' });
  await other.close();
  const conversation = await f.conversation('keyword');
  const relevant = conversation.remember({ content: '主题是蓝色' });
  conversation.remember({ content: '无关secret' });
  const result = await conversation.prompt('主题');
  const items = recalledItems(memoryMessages(f.requests[0])[0]);
  assert.deepEqual(items.map(item => item.id), [relevant.memory.id]);
  assert.doesNotMatch(JSON.stringify(f.requests[0]), /secret/);
  assert.equal(f.database().prepare('SELECT COUNT(*) AS n FROM memory_uses WHERE run_id = ?').get(result.runId).n, 1);
});
