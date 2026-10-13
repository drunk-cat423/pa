import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { openRecordedConversation, PersistenceError } from '../dist/conversation.js';
import { openMemory } from '../dist/memory.js';
import { MemoryError } from '../dist/memory-types.js';
import { ConversationStore } from '../dist/store.js';

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
    const input = asText(body.messages.at(-1).content);
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
  return request.messages.filter(message => JSON.stringify(message.content).includes('用户明确保存的背景数据'));
}

function recalledItems(message) {
  const content = typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('');
  return JSON.parse(content.slice(content.indexOf('\n') + 1));
}

test('reset确认期间代次变化仍保留pending并停止模型，不以旧确认继续请求', async t => {
  const f = await fixture(t);
  const conversation = await f.conversation('CAS');
  const memory = conversation.remember({ content: 'CAS_INITIAL' }).memory;
  conversation.correctMemory(memory.id, { content: 'CAS_BEFORE_RESET' }, 1);
  const ack = ConversationStore.prototype.ackContextReset;
  try {
    ConversationStore.prototype.ackContextReset = function(id, generation) {
      this.correctMemory(id, memory.id, { content: 'CAS_CHANGED_DURING_RESET' }, 2);
      return ack.call(this, id, generation);
    };
    await assert.rejects(conversation.prompt('must stop'), PersistenceError);
  } finally { ConversationStore.prototype.ackContextReset = ack; }
  assert.equal(f.requests.length, 0);
  assert.equal(f.database().prepare('SELECT reset_required FROM memory_context_state').get().reset_required, 1);
  await conversation.close();
  const reopened = await f.conversation('CAS');
  await reopened.prompt('retry through a new message');
  assert.ok(JSON.stringify(f.requests.at(-1)).includes('CAS_CHANGED_DURING_RESET'));
  assert.ok(!JSON.stringify(f.requests.at(-1)).includes('CAS_BEFORE_RESET'));
});

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

test('离线四操作无模型配置、隔离会话、业务错误可继续，共享锁阻止在线与离线并发', async t => {
  const f = await fixture(t);
  const a = await f.memory('A');
  const saved = a.remember({ content: '  喜欢茶\n保留原文  ', kind: 'preference' });
  assert.equal(saved.memory.origin, 'explicit_user');
  assert.equal(saved.memory.sourceMessageId, null);
  assert.equal(saved.contextResetRequired, false);
  assert.deepEqual(a.query('喜欢').map(record => record.content), ['  喜欢茶\n保留原文  ']);
  assert.throws(() => a.correct(saved.memory.id, { content: '喜欢水' }, 99), MemoryError);
  const corrected = a.correct(saved.memory.id, { content: '喜欢水' }, 1);
  assert.equal(corrected.memory.revision, 2);
  assert.equal(corrected.contextResetRequired, true);
  const b = await f.memory('B');
  assert.deepEqual(b.query(), []);
  assert.throws(() => b.delete(saved.memory.id), MemoryError);
  assert.equal(a.delete(saved.memory.id, 2).contextResetRequired, true);
  assert.deepEqual(a.query(), []);
  await assert.rejects(f.conversation('A'), /锁定/);
  await assert.rejects(f.memory('A'), /锁定/);
  await a.close();
  const online = await f.conversation('A');
  await assert.rejects(f.memory('A'), /锁定/);
  const memory = online.remember({ content: '在线保存' });
  assert.equal(online.queryMemories()[0].id, memory.memory.id);
  assert.throws(() => online.remember({ content: '' }), MemoryError);
  assert.equal(online.queryMemories().length, 1);
  assert.equal(f.requests.length, 0);
  assert.equal(existsSync(online.info().sessionFile), false);
  await online.close();
  const offline = await f.memory('A');
  assert.equal(offline.query()[0].content, '在线保存');
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
  assert.equal(asText(f.requests[0].messages.at(-1).content), input);
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

test('纠正后仅新记忆进入实际请求，旧user/assistant/记忆均隐藏且重启不恢复；原始SQL保留', async t => {
  const f = await fixture(t);
  const conversation = await f.conversation('correct');
  const saved = conversation.remember({ content: 'old-secret-fact' });
  await conversation.prompt('old-secret-user');
  assert.match(JSON.stringify(f.requests[0]), /old-secret-fact/);
  const before = conversation.history().map(record => [record.id, record.text]);
  conversation.correctMemory(saved.memory.id, { content: 'new-fact' }, 1);
  assert.equal(f.requests.length, 1, 'memory management must not call a model');
  await conversation.prompt('fresh-question');
  assert.match(JSON.stringify(f.requests[1]), /new-fact/);
  assert.doesNotMatch(JSON.stringify(f.requests[1]), /old-secret/);
  assert.deepEqual(conversation.history().slice(0, 2).map(record => [record.id, record.text]), before);
  const file = conversation.info().sessionFile;
  const raw = await readFile(file, 'utf8');
  assert.match(raw, /old-secret-user/);
  assert.match(raw, /old-secret-fact/);
  assert.ok(SessionManager.open(file).buildSessionContext().messages.every(message => !JSON.stringify(message).includes('old-secret')));
  await conversation.close();
  const reopened = await f.conversation('correct');
  await reopened.prompt('after-restart');
  assert.doesNotMatch(JSON.stringify(f.requests[2]), /old-secret/);
  assert.match(JSON.stringify(f.requests[2]), /new-fact/);
  assert.equal(reopened.history().length, 6);
});

test('离线删除后聊天open恢复待重置，SQLquery与Pi活动上下文均无旧记忆而原始历史保留', async t => {
  const f = await fixture(t);
  const conversation = await f.conversation('delete');
  const memory = conversation.remember({ content: 'deleted-secret-fact' });
  await conversation.prompt('deleted-secret-user');
  const file = conversation.info().sessionFile;
  await conversation.close();
  const offline = await f.memory('delete');
  assert.equal(offline.delete(memory.memory.id).contextResetRequired, true);
  assert.deepEqual(offline.query(), []);
  assert.match(await readFile(file, 'utf8'), /deleted-secret-fact/, 'offline operation must not alter Pi');
  await offline.close();
  const reopened = await f.conversation('delete');
  assert.equal(reopened.history().length, 2);
  assert.deepEqual(SessionManager.open(file).buildSessionContext().messages.filter(message => message.role !== 'system'), []);
  await reopened.prompt('after-delete');
  assert.doesNotMatch(JSON.stringify(f.requests[1]), /deleted-secret/);
  assert.deepEqual(reopened.queryMemories(), []);
  await reopened.close();
  const again = await f.conversation('delete');
  await again.prompt('still-deleted');
  assert.doesNotMatch(JSON.stringify(f.requests[2]), /deleted-secret/);
  assert.match(await readFile(file, 'utf8'), /deleted-secret/);
});

test('Pi重置部分写入失败保持pending且禁用下一请求，重开幂等完成其余edit', async t => {
  const f = await fixture(t);
  const conversation = await f.conversation('pi-failure');
  const memory = conversation.remember({ content: 'obsolete-fact' });
  await conversation.prompt('obsolete-input');
  conversation.correctMemory(memory.memory.id, { content: 'current-fact' });
  const original = SessionManager.prototype.appendContextEdit;
  let edits = 0;
  SessionManager.prototype.appendContextEdit = function (...args) {
    if (++edits === 2) throw new Error('simulated Pi append failure');
    return original.apply(this, args);
  };
  try {
    await assert.rejects(conversation.prompt('blocked'), PersistenceError);
    await assert.rejects(conversation.prompt('still-blocked'), PersistenceError);
  } finally { SessionManager.prototype.appendContextEdit = original; }
  const db = f.database();
  assert.equal(db.prepare('SELECT reset_required FROM memory_context_state').get().reset_required, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n, 1);
  assert.equal(f.requests.length, 1);
  const file = conversation.info().sessionFile;
  const before = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(before.filter(entry => entry.type === 'context_edit').length, 1);
  await conversation.close();
  const reopened = await f.conversation('pi-failure');
  assert.equal(db.prepare('SELECT reset_required FROM memory_context_state').get().reset_required, 0);
  const after = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(new Set(after.filter(entry => entry.type === 'context_edit').map(entry => entry.targetId)).size, 3);
  await reopened.prompt('repaired');
  assert.doesNotMatch(JSON.stringify(f.requests[1]), /obsolete/);
  assert.match(JSON.stringify(f.requests[1]), /current-fact/);
});

test('SQL reset确认失败保留pending，无下一请求，重开重试不重复Pi edits', async t => {
  const f = await fixture(t);
  const conversation = await f.conversation('ack-failure');
  const memory = conversation.remember({ content: 'obsolete-fact' });
  await conversation.prompt('obsolete-input');
  conversation.deleteMemory(memory.memory.id);
  const db = f.database();
  db.exec("CREATE TRIGGER fail_ack BEFORE UPDATE OF reset_required ON memory_context_state WHEN NEW.reset_required = 0 BEGIN SELECT RAISE(ABORT, 'reset ack failure'); END");
  await assert.rejects(conversation.prompt('blocked'), PersistenceError);
  await assert.rejects(conversation.prompt('still-blocked'), PersistenceError);
  assert.equal(db.prepare('SELECT reset_required FROM memory_context_state').get().reset_required, 1);
  const file = conversation.info().sessionFile;
  const before = await readFile(file, 'utf8');
  assert.equal(f.requests.length, 1);
  db.exec('DROP TRIGGER fail_ack');
  await conversation.close();
  const reopened = await f.conversation('ack-failure');
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(db.prepare('SELECT reset_required FROM memory_context_state').get().reset_required, 0);
  await reopened.prompt('repaired');
  assert.doesNotMatch(JSON.stringify(f.requests[1]), /obsolete/);
});

test('无法公开编辑的历史摘要在重置前停止，pending与原历史保持', async t => {
  const f = await fixture(t);
  const conversation = await f.conversation('summary');
  const memory = conversation.remember({ content: 'fact' });
  await conversation.prompt('old-input');
  const file = conversation.info().sessionFile;
  await conversation.close();
  const manager = SessionManager.open(file);
  manager.branchWithSummary(manager.getLeafId(), 'old-summary-secret');
  const offline = await f.memory('summary');
  offline.correct(memory.memory.id, { content: 'new-fact' });
  await offline.close();
  const before = await readFile(file, 'utf8');
  await assert.rejects(f.conversation('summary'), error => error instanceof PersistenceError && /摘要/.test(error.message));
  assert.equal(f.database().prepare('SELECT reset_required FROM memory_context_state').get().reset_required, 1);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(f.requests.length, 1);
});

test('活动请求拒绝记忆修改且close取消后仍可重新打开', async t => {
  const f = await fixture(t);
  const conversation = await f.conversation('active');
  const memory = conversation.remember({ content: 'fact' });
  const pending = conversation.prompt('hang');
  const rejected = assert.rejects(pending, /取消/);
  const deadline = Date.now() + 3000;
  while (!f.requests.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.requests.length, 1);
  assert.throws(() => conversation.remember({ content: 'another' }), /正在处理/);
  assert.throws(() => conversation.correctMemory(memory.memory.id, { content: 'changed' }), /正在处理/);
  assert.throws(() => conversation.deleteMemory(memory.memory.id), /正在处理/);
  await conversation.close();
  await rejected;
  const reopened = await f.conversation('active');
  assert.equal(reopened.queryMemories()[0].content, 'fact');
});

test('offline SQL失败使session停止而普通MemoryError可恢复，close释放共享锁', async t => {
  const f = await fixture(t);
  const offline = await f.memory('sql-failure');
  assert.throws(() => offline.remember({ content: '' }), MemoryError);
  const saved = offline.remember({ content: 'saved' });
  const db = f.database();
  db.exec("CREATE TRIGGER fail_memory BEFORE UPDATE ON memories BEGIN SELECT RAISE(ABORT, 'memory SQL failure'); END");
  assert.throws(() => offline.correct(saved.memory.id, { content: 'changed' }), /持久化失败/);
  assert.throws(() => offline.query(), /持久化已失败/);
  db.exec('DROP TRIGGER fail_memory');
  await offline.close();
  const reopened = await f.memory('sql-failure');
  assert.equal(reopened.query()[0].content, 'saved');
  assert.equal(f.requests.length, 0);
});
