import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openRecordedConversation, PersistenceError } from '../dist/conversation.js';
import { openConversation } from '../dist/runtime.js';
import { ConversationStore } from '../dist/store.js';
import { requestText } from './fixtures/request-text.mjs';

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(predicate(), 'local model request did not arrive');
}

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-conversation-'));
  const cwd = join(directory, 'project');
  await mkdir(cwd);
  const requests = [];
  const resources = [];
  let onRequest;
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      const asText = content => typeof content === 'string' ? content : content.map(part => part.text ?? '').join('');
      const users = body.messages.filter(message => message.role === 'user').map(message => requestText(asText(message.content)));
      const text = users.at(-1);
      onRequest?.(text);
      if (text === 'error') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'local-test-key local model failure', type: 'server_error' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (text === 'hang') { response.flushHeaders(); return; }
      const answer = `reply:${users.join('|')}`;
      for (const choices of [
        [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        [{ index: 0, delta: { content: answer }, finish_reason: null }],
        [{ index: 0, delta: {}, finish_reason: text === 'length' ? 'length' : 'stop' }],
      ]) response.write(`data: ${JSON.stringify({ id: 'local-response', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {
    cwd, dataDir: join(directory, 'data'), provider: 'pa-test', model: 'test-model', apiKey: 'local-test-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 32768,
    maxOutputTokens: 512, timeoutMs: 5000, ...overrides,
  };
  async function conversation(key) {
    const value = await openRecordedConversation(config, key);
    resources.push(value); return value;
  }
  async function crashWindow(key, input, piInput = input) {
    const runtime = await openConversation(config, key);
    resources.push(runtime);
    const store = new ConversationStore(join(config.dataDir, 'pa.sqlite'));
    resources.push(store);
    const record = store.ensureConversation(key, runtime.info().sessionFile);
    const run = store.beginRun(record.id, input, config.provider, config.model);
    if (piInput !== null) await runtime.prompt(piInput, { runId: run.id });
    const turns = runtime.recordedTurns();
    await runtime.close(); store.close();
    return { run, turns };
  }
  function database() {
    const db = new DatabaseSync(join(config.dataDir, 'pa.sqlite'));
    resources.push(db); return db;
  }
  t.after(async () => {
    await Promise.allSettled(resources.reverse().map(resource => Promise.resolve().then(() => resource.close())));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { config, conversation, crashWindow, database, requests, onRequest: callback => { onRequest = callback; } };
}

test('原文先落 SQLite，成功回复和 Pi ID 完成后返回；会话隔离与投递确认', async t => {
  const f = await fixture(t);
  const a = await f.conversation('A');
  const b = await f.conversation('B');
  const db = f.database();
  f.onRequest(text => {
    const stored = db.prepare('SELECT m.text, r.status FROM messages m JOIN agent_runs r ON r.input_message_id = m.id WHERE m.text = ?').get(text);
    assert.equal(stored.text, text);
    assert.equal(stored.status, 'running');
  });
  const input = '  原文\n第二行  ';
  const first = await a.prompt(input);
  assert.equal(first.text, `reply:${input}`);
  assert.ok(first.runId && first.deliveryId);
  const history = a.history();
  assert.deepEqual(history.map(message => [message.role, message.text, message.runStatus]), [
    ['user', input, 'completed'], ['assistant', `reply:${input}`, 'completed'],
  ]);
  assert.ok(history.every(message => message.piEntryId));
  assert.equal(history[1].deliveryStatus, 'pending');
  a.acknowledge(first.deliveryId, 'sent');
  assert.equal(a.history()[1].deliveryStatus, 'sent');
  const pending = await a.prompt('length');
  assert.equal(pending.text, `reply:${input}|length`);
  const other = await b.prompt('other');
  assert.equal(other.text, 'reply:other');
  assert.equal(b.history().length, 2);
  const sessionFile = a.info().sessionFile;
  const entries = (await readFile(sessionFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(entries.find(entry => entry.type === 'custom' && entry.data?.runId === first.runId)?.customType, 'pa_run');
  assert.doesNotMatch(JSON.stringify(f.requests), /pa_run/);
  assert.ok(f.requests.every(request => !JSON.stringify(request).includes(first.runId)));
  await a.close();
  const reopened = await f.conversation('A');
  assert.equal(f.requests.length, 3);
  assert.equal(reopened.history().length, 4);
  assert.deepEqual(reopened.history().filter(message => message.role === 'assistant').map(message => message.deliveryStatus), ['sent', 'uncertain']);
  assert.equal(b.history()[1].deliveryStatus, 'pending', 'only the reopened conversation changes');
  await reopened.close();
  const again = await f.conversation('A');
  assert.equal(again.history().length, 4);
});

test('模型失败和超时留下真实 user 与运行状态，错误精确脱敏，无假 assistant', async t => {
  const f = await fixture(t, { timeoutMs: 250 });
  const conversation = await f.conversation('errors');
  await assert.rejects(conversation.prompt('error'), error => {
    assert.match(error.message, /local model failure/);
    assert.doesNotMatch(error.message, /local-test-key/);
    return true;
  });
  await assert.rejects(conversation.prompt('hang'), /模型请求超时/);
  const history = conversation.history();
  assert.deepEqual(history.map(message => [message.role, message.text, message.runStatus]), [
    ['user', 'error', 'failed'], ['user', 'hang', 'interrupted'],
  ]);
  const runs = f.database().prepare('SELECT status, error_kind, error_message FROM agent_runs ORDER BY rowid').all();
  assert.equal(runs[0].error_kind, 'error');
  assert.match(runs[0].error_message, /\[redacted\]/);
  assert.doesNotMatch(runs[0].error_message, /local-test-key/);
  assert.equal(runs[1].error_kind, 'timeout');
  assert.equal(f.requests.length, 2);
});

test('Pi 已生成但 SQLite 未完成的运行可恢复，重开不出网、不重复、投递 uncertain', async t => {
  const f = await fixture(t);
  const { run, turns } = await f.crashWindow('recover', 'saved');
  const conversation = await f.conversation('recover');
  assert.equal(f.requests.length, 1);
  const history = conversation.history();
  assert.deepEqual(history.map(message => [message.role, message.text]), [['user', 'saved'], ['assistant', 'reply:saved']]);
  assert.equal(history[0].piEntryId, turns[0].user.entryId);
  assert.equal(history[1].piEntryId, turns[0].assistant.entryId);
  assert.equal(history[1].deliveryStatus, 'uncertain');
  const row = f.database().prepare('SELECT status, recovered FROM agent_runs WHERE id = ?').get(run.id);
  assert.equal(row.status, 'completed'); assert.equal(row.recovered, 1);
  await conversation.close();
  const again = await f.conversation('recover');
  assert.equal(again.history().length, 2);
  assert.equal(f.requests.length, 1);
});

test('无 Pi 回复及关联原文不匹配都标 interrupted，不自动重发', async t => {
  const f = await fixture(t);
  await f.crashWindow('missing', 'unanswered', null);
  const missing = await f.conversation('missing');
  assert.deepEqual(missing.history().map(message => [message.role, message.text, message.runStatus]), [['user', 'unanswered', 'interrupted']]);
  assert.equal(f.requests.length, 0);
  await f.crashWindow('mismatch', 'SQL original', 'different Pi original');
  const mismatch = await f.conversation('mismatch');
  assert.deepEqual(mismatch.history().map(message => [message.role, message.text, message.runStatus]), [['user', 'SQL original', 'interrupted']]);
  assert.equal(f.requests.length, 1);
});

test('无 marker 的旧 Pi 历史保留上下文且不伪造业务记录，后续无 marker 不借用前轮回复', async t => {
  const f = await fixture(t);
  const runtime = await openConversation(f.config, 'legacy');
  try {
    await runtime.prompt('old');
    assert.deepEqual(runtime.recordedTurns(), []);
    await runtime.prompt('marked', { runId: 'recorded-only' });
    await runtime.prompt('unmarked');
    assert.equal(runtime.recordedTurns()[0].assistant.text, 'reply:old|marked');
  } finally { await runtime.close(); }
  const conversation = await f.conversation('legacy');
  assert.deepEqual(conversation.history(), []);
  assert.equal((await conversation.prompt('new')).text, 'reply:old|marked|unmarked|new');
  assert.equal(conversation.history().length, 2);
});

test('成功 Pi 回复的 SQLite complete 失败致命，保留 running，下次按 Pi 恢复', async t => {
  const f = await fixture(t);
  const conversation = await f.conversation('complete-failure');
  const db = f.database();
  db.exec("CREATE TRIGGER fail_reply BEFORE INSERT ON messages WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'sqlite complete failure local-test-key private input'); END");
  await assert.rejects(conversation.prompt('private input'), error => {
    assert.ok(error instanceof PersistenceError);
    assert.match(error.message, /sqlite complete failure/);
    assert.doesNotMatch(error.message, /local-test-key|private input/);
    assert.doesNotMatch(error.cause.message, /local-test-key|private input/);
    return true;
  });
  assert.equal(db.prepare('SELECT status FROM agent_runs').get().status, 'running');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  await assert.rejects(conversation.prompt('forbidden'), PersistenceError);
  assert.equal(f.requests.length, 1);
  db.exec('DROP TRIGGER fail_reply');
  await conversation.close();
  const recovered = await f.conversation('complete-failure');
  assert.equal(recovered.history()[1].text, 'reply:private input');
  assert.equal(recovered.history()[1].deliveryStatus, 'uncertain');
  assert.equal(f.requests.length, 1);
});

test('SQLite begin 失败不请求 Pi，失败状态写入失败也致命并保留 running', async t => {
  const f = await fixture(t);
  const begin = await f.conversation('begin-failure');
  const db = f.database();
  db.exec("CREATE TRIGGER fail_user BEFORE INSERT ON messages WHEN NEW.role = 'user' BEGIN SELECT RAISE(ABORT, 'sqlite begin failure'); END");
  await assert.rejects(begin.prompt('never requested'), PersistenceError);
  assert.equal(f.requests.length, 0);
  await assert.rejects(begin.prompt('still forbidden'), PersistenceError);
  db.exec('DROP TRIGGER fail_user');
  const failure = await f.conversation('fail-failure');
  db.exec("CREATE TRIGGER fail_status BEFORE UPDATE OF status ON agent_runs WHEN NEW.status = 'failed' BEGIN SELECT RAISE(ABORT, 'sqlite fail failure'); END");
  await assert.rejects(failure.prompt('error'), PersistenceError);
  assert.equal(db.prepare('SELECT status FROM agent_runs').get().status, 'running');
  await assert.rejects(failure.prompt('still forbidden'), PersistenceError);
  assert.equal(f.requests.length, 1);
  db.exec('DROP TRIGGER fail_status');
  await failure.close();
  const recovered = await f.conversation('fail-failure');
  assert.equal(recovered.history()[0].runStatus, 'failed');
  assert.equal(recovered.history().length, 1);
  assert.equal(f.requests.length, 1);
});

test('close 取消活动请求，持久化期间保留锁，幂等关闭并可重新打开', async t => {
  const f = await fixture(t);
  const conversation = await f.conversation('close');
  const lock = join(conversation.info().sessionFile, '..', 'conversation.lock');
  const pending = conversation.prompt('hang');
  const rejected = assert.rejects(pending, /取消/);
  await assert.rejects(conversation.prompt('parallel'), /正在处理/);
  await waitFor(() => f.requests.length === 1);
  const originalFail = ConversationStore.prototype.failRun;
  let persistedWhileLocked = false;
  ConversationStore.prototype.failRun = function (...args) {
    assert.ok(existsSync(lock));
    originalFail.apply(this, args);
    persistedWhileLocked = true;
  };
  try { await Promise.all([conversation.close(), conversation.close()]); }
  finally { ConversationStore.prototype.failRun = originalFail; }
  await rejected;
  assert.ok(persistedWhileLocked);
  assert.equal(existsSync(lock), false);
  const reopened = await f.conversation('close');
  assert.equal(reopened.history()[0].runStatus, 'interrupted');
  assert.equal((await reopened.prompt('after')).text, 'reply:hang|after');
});

test('打开时 SQLite 初始化失败清理 Pi 锁，修复数据库后可以重开', async t => {
  const f = await fixture(t);
  await mkdir(f.config.dataDir, { recursive: true });
  const db = f.database();
  db.exec('PRAGMA user_version = 99');
  await assert.rejects(f.conversation('open-failure'), PersistenceError);
  await assert.rejects(f.conversation('open-failure'), PersistenceError);
  db.exec('PRAGMA user_version = 0');
  const conversation = await f.conversation('open-failure');
  assert.deepEqual(conversation.history(), []);
  assert.equal(f.requests.length, 0);
});

test('已关联历史的 Pi 文件丢失或被合法其他历史替换时停止，SQLite 原样保留', async t => {
  const f = await fixture(t);
  const conversation = await f.conversation('history-integrity');
  await conversation.prompt('original');
  const sessionFile = conversation.info().sessionFile;
  await conversation.close();
  const db = f.database();
  const snapshot = () => JSON.stringify({
    messages: db.prepare('SELECT * FROM messages').all(), runs: db.prepare('SELECT * FROM agent_runs').all(),
    deliveries: db.prepare('SELECT * FROM deliveries').all(),
  });
  const before = snapshot();
  await unlink(sessionFile);
  await assert.rejects(f.conversation('history-integrity'), error => {
    assert.ok(error instanceof PersistenceError); assert.match(error.message, /历史不一致/); return true;
  });
  assert.equal(snapshot(), before);
  assert.equal(f.requests.length, 1);
  const otherRuntime = await openConversation(f.config, 'replacement');
  let replacement;
  try {
    await otherRuntime.prompt('different history');
    replacement = await readFile(otherRuntime.info().sessionFile, 'utf8');
  } finally { await otherRuntime.close(); }
  await writeFile(sessionFile, replacement);
  await assert.rejects(f.conversation('history-integrity'), PersistenceError);
  assert.equal(snapshot(), before);
  assert.equal(await readFile(sessionFile, 'utf8'), replacement);
  assert.equal(f.requests.length, 2);
});
