import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { downgradeSchema11 } from './fixtures/legacy-schema.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pa-channel-task-'));
  const path = join(directory, 'pa.sqlite');
  let store = new ConversationStore(path);
  const route = { channel: 'qq', accountId: 'bot', roomType: 'group', roomId: 'room' };
  const conversation = store.ensureConversation('room', '/pi/canonical.jsonl', route);
  const other = store.ensureConversation('other', '/pi/other.jsonl', { ...route, roomId: 'other' });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path, route, conversation, other, get store() { return store; },
    reopen() { store.close(); store = new ConversationStore(path); return store; },
    inspect(operation) { const db = new DatabaseSync(path); try { return operation(db); } finally { db.close(); } },
    enqueue(eventId, senderId = 'alice', selected = conversation, extras = {}) {
      const input = { route: selected.id === conversation.id ? route : { ...route, roomId: 'other' },
        eventId, senderId, text: `原始问题 ${eventId}`, sentAt: '2026-10-14T01:02:03.000Z', mentioned: true, ...extras };
      const external = { eventId, senderId, modelInputText: input.text, sentAt: input.sentAt,
        ...(input.senderName === undefined ? {} : { senderName: input.senderName }) };
      assert.equal(store.recordInbound(selected.id, input.text, external), true);
      const source = store.externalMessage(selected.id, eventId);
      const task = store.enqueueChannelTask(selected.id, source.id, input);
      return { ...task, input, messageId: source.id, external: { ...external, existingMessageId: source.id }, conversationId: selected.id };
    },
    run(task, session = `/pi/task-${task.messageId}.jsonl`) {
      return store.beginRun(task.conversationId, task.input.text, 'provider', 'model', [], task.external, undefined, session);
    },
  };
}

test('任务去重并保留原始事件，拒绝房间、身份、内容和原始输入漂移', t => {
  const f = fixture(t);
  const task = f.enqueue('question', 'alice', f.conversation, { senderName: '甲', quote: { messageId: 'ref' } });
  assert.deepEqual(f.store.enqueueChannelTask(f.conversation.id, task.messageId, task.input), { id: task.id, status: 'queued' });
  assert.deepEqual(f.store.enqueueChannelTask(f.conversation.id, task.messageId, { ...task.input, mentionedSenderIds: undefined }), { id: task.id, status: 'queued' });
  for (const changed of [{ text: '篡改' }, { senderId: 'bob' }, { eventId: 'other' },
    { route: { ...f.route, roomId: 'other' } }, { senderName: '乙' }, { sentAt: '2026-10-15T01:02:03.000Z' },
    { quote: { messageId: 'different-ref' } }]) {
    assert.throws(() => f.store.enqueueChannelTask(f.conversation.id, task.messageId, { ...task.input, ...changed }), /来源|不能修改/);
  }
  assert.throws(() => f.store.enqueueChannelTask(f.other.id, task.messageId, task.input), /来源/);
  assert.deepEqual(f.reopen().listChannelTasks(f.conversation.id), [{ id: task.id, messageId: task.messageId, input: task.input, status: 'queued' }]);
  assert.equal(f.store.claimChannelTask(task.id), true);
  assert.equal(f.store.claimChannelTask(task.id), false);
  assert.equal(f.store.claimChannelTask('missing'), false);
  assert.equal(f.store.listChannelTasks(f.other.id).length, 0);
});

test('独立Pi会话允许同房间多运行，canonical仍独占，同一Pi文件不能并发', t => {
  const f = fixture(t);
  const first = f.enqueue('first');
  const second = f.enqueue('second');
  const run1 = f.run(first, '/pi/task-first.jsonl');
  const run2 = f.run(second, '/pi/task-second.jsonl');
  const canonical = f.store.beginRun(f.conversation.id, 'canonical', 'p', 'm', [], { eventId: 'canonical', senderId: 'alice', modelInputText: 'canonical' });
  assert.deepEqual(f.store.unfinishedRuns(f.conversation.id), [run1, run2, canonical]);
  assert.throws(() => f.store.beginRun(f.conversation.id, 'blocked canonical', 'p', 'm', [], { eventId: 'blocked', senderId: 'alice', modelInputText: 'blocked' }), /UNIQUE/);
  assert.equal(f.store.hasExternalMessage(f.conversation.id, 'blocked'), false);
  const third = f.enqueue('third');
  assert.throws(() => f.run(third, '/pi/task-first.jsonl'), /绑定/);
  assert.throws(() => f.run(third, '/pi/canonical.jsonl'), /canonical/);
  assert.throws(() => f.run(third, '   '), /不能为空/);
  const delivery = f.store.completeRun(run1.id, 'answer-one', 'entry-user', 'entry-assistant');
  assert.throws(() => f.run(third, '/pi/task-first.jsonl'), /绑定/);
  const messages = f.store.listMessages('room', 20, f.route);
  assert.equal(messages.find(message => message.id === first.messageId).piSessionFile, '/pi/task-first.jsonl');
  assert.equal(messages.find(message => message.id === delivery.messageId).piSessionFile, '/pi/task-first.jsonl');
  assert.equal(messages.find(message => message.id === canonical.inputMessageId).piSessionFile, undefined);
  assert.deepEqual(f.store.recordedTaskSessions(f.conversation.id), [
    { piSessionFile: '/pi/task-first.jsonl', inputMessageId: first.messageId },
    { piSessionFile: '/pi/task-second.jsonl', inputMessageId: second.messageId },
  ]);
  assert.deepEqual(f.reopen().unfinishedRuns(f.conversation.id), [run2, canonical]);
});

test('两个真实SQLite连接并发写入同房间不同session，重复默认CLI只有一个成功', async t => {
  const f = fixture(t);
  const cli = f.store.ensureConversation('cli', '/pi/cli.jsonl');
  const moduleUrl = new URL('../dist/store.js', import.meta.url).href;
  const script = `import { ConversationStore } from ${JSON.stringify(moduleUrl)};
    const [path,conversationId,text,session] = process.argv.slice(1);
    const store = new ConversationStore(path);
    try {
      const run = store.beginRun(conversationId,text,'p','m',[],session ? {eventId:text,senderId:'alice',modelInputText:text} : undefined,undefined,session || undefined);
      process.stdout.write(JSON.stringify({ok:true,id:run.id}));
    } catch (error) { process.stdout.write(JSON.stringify({ok:false,error:error.message})); }
    finally { store.close(); }`;
  function child(conversationId, text, session = '') {
    return new Promise((resolve, reject) => {
      const processChild = spawn(process.execPath, ['--input-type=module', '-e', script, f.path, conversationId, text, session], { windowsHide: true });
      let stdout = ''; let stderr = '';
      processChild.stdout.on('data', chunk => { stdout += chunk; });
      processChild.stderr.on('data', chunk => { stderr += chunk; });
      processChild.on('error', reject);
      processChild.on('close', code => { if (code !== 0) reject(new Error(stderr)); else resolve(JSON.parse(stdout)); });
    });
  }
  const isolated = await Promise.all([child(f.conversation.id, 'a', '/pi/a-task.jsonl'), child(f.conversation.id, 'b', '/pi/b-task.jsonl')]);
  assert.equal(isolated.filter(result => result.ok).length, 2);
  assert.equal(f.store.unfinishedRuns(f.conversation.id).length, 2);
  const defaults = await Promise.all([child(cli.id, 'a'), child(cli.id, 'b')]);
  assert.equal(defaults.filter(result => result.ok).length, 1);
  assert.equal(f.store.listMessages('cli', 10).length, 1);
  assert.deepEqual(f.inspect(db => db.prepare('PRAGMA foreign_key_check').all()), []);
});

test('恢复只保留没有运行的queued，有运行的任务不重新调用模型，完成结果修复绑定', t => {
  const f = fixture(t);
  const queued = f.enqueue('never-started');
  const claimed = f.enqueue('claimed-no-run'); f.store.claimChannelTask(claimed.id);
  const running = f.enqueue('unknown-running'); f.run(running);
  const completed = f.enqueue('saved-answer');
  const completeRun = f.run(completed);
  const result = f.store.completeRun(completeRun.id, '完整答案', undefined, undefined);
  const failed = f.enqueue('failed'); f.store.claimChannelTask(failed.id);
  const failedRun = f.run(failed); f.store.failRun(failedRun.id, 'failed', 'fixture', 'fixture');
  const interrupted = f.enqueue('interrupted');
  const interruptedRun = f.run(interrupted); f.store.failRun(interruptedRun.id, 'interrupted', 'fixture', 'fixture');
  const count = f.inspect(db => db.prepare('SELECT count(*) n FROM agent_runs').get().n);
  f.reopen().recoverChannelTasks(f.conversation.id);
  const statuses = new Map(f.store.listChannelTasks(f.conversation.id).map(task => [task.id, task.status]));
  assert.deepEqual([...statuses.values()], ['queued', 'interrupted', 'interrupted', 'completed', 'failed', 'interrupted']);
  assert.equal(f.store.listChannelTasks(f.conversation.id, 'completed')[0].deliveryId, result.deliveryId);
  f.store.recoverChannelTasks(f.conversation.id);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM agent_runs').get().n), count);
  for (const task of [claimed, running, completed, failed, interrupted]) assert.equal(f.store.claimChannelTask(task.id), false);
  assert.equal(f.store.claimChannelTask(queued.id), true);
  assert.equal(f.store.latestTaskResult(f.conversation.id, 'alice', completed.id).text, '完整答案');
  assert.equal(f.inspect(db => db.prepare('SELECT status FROM deliveries WHERE id=?').get(result.deliveryId).status), 'pending');
});

test('任务完成只能绑定自己的已完成run，已结束状态不能覆盖', t => {
  const f = fixture(t);
  const first = f.enqueue('first'); const second = f.enqueue('second');
  assert.throws(() => f.store.finishChannelTask(first.id, 'completed'), /已完成/);
  const run1 = f.run(first); const run2 = f.run(second);
  const delivery1 = f.store.completeRun(run1.id, 'first-answer', undefined, undefined);
  const delivery2 = f.store.completeRun(run2.id, 'second-answer', undefined, undefined);
  assert.throws(() => f.store.finishChannelTask(first.id, 'completed', delivery2.deliveryId), /已完成/);
  f.store.finishChannelTask(first.id, 'completed', delivery1.deliveryId);
  f.store.finishChannelTask(first.id, 'completed', delivery1.deliveryId);
  assert.throws(() => f.store.finishChannelTask(first.id, 'failed'), /已结束/);
  f.store.finishChannelTask(second.id, 'completed');
  assert.equal(f.store.listChannelTasks(f.conversation.id, 'completed').length, 2);
});

test('/result仅同房间原发送者读取完成答案，使用持久化分段且不改变未知回执', t => {
  const f = fixture(t);
  const alice = f.enqueue('alice'); const bob = f.enqueue('bob', 'bob');
  for (const task of [alice, bob]) {
    const run = f.run(task);
    const result = f.store.completeRun(run.id, `**原始答案${task.input.senderId}**`, undefined, undefined);
    f.store.prepareDeliveryParts(f.conversation.id, result.deliveryId, [`实际${task.input.senderId}`, '\n引用 https://example.test/ref']);
    f.store.beginDeliveryPart(f.conversation.id, result.deliveryId, 0);
    f.store.ackDeliveryPart(f.conversation.id, result.deliveryId, 0, 'uncertain');
    f.store.finishChannelTask(task.id, 'completed', result.deliveryId);
  }
  const before = f.inspect(db => db.prepare('SELECT * FROM deliveries ORDER BY rowid').all());
  const result = f.store.latestTaskResult(f.conversation.id, 'alice');
  assert.deepEqual(result, { taskId: alice.id, text: '实际alice\n引用 https://example.test/ref', deliveryId: before[0].id,
    sourceEventId: 'alice', sourceText: alice.input.text });
  for (const alias of [alice.id, alice.id.slice(0, 8), alice.id.slice(0, 12)]) assert.deepEqual(f.store.latestTaskResult(f.conversation.id, 'alice', alias), result);
  assert.equal(f.store.latestTaskResult(f.conversation.id, 'bob', alice.id), undefined);
  assert.equal(f.store.latestTaskResult(f.other.id, 'alice', alice.id), undefined);
  assert.equal(f.store.latestTaskResult(f.conversation.id, 'alice', alice.id.slice(0, 5)), undefined);
  assert.equal(f.store.latestTaskResult(f.conversation.id, 'alice', '%'), undefined);
  const pending = f.enqueue('pending');
  assert.equal(f.store.latestTaskResult(f.conversation.id, 'alice', pending.id), undefined);
  assert.deepEqual(f.inspect(db => db.prepare('SELECT * FROM deliveries ORDER BY rowid').all()), before);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM agent_runs').get().n), 2);
  assert.deepEqual(f.reopen().latestTaskResult(f.conversation.id, 'alice', alice.id), result);
});

test('任务短编号有歧义时拒绝领取，未创建分段使用原始完整回复', t => {
  const f = fixture(t);
  const ids = ['deadbeef-abc1-4000-8000-000000000001', 'deadbeef-abc2-4000-8000-000000000002'];
  for (let index = 0; index < 2; index += 1) {
    const task = f.enqueue(`question-${index}`);
    const run = f.run(task);
    f.store.completeRun(run.id, `raw-answer-${index}`, undefined, undefined);
    f.store.finishChannelTask(task.id, 'completed');
    f.inspect(db => db.prepare('UPDATE channel_tasks SET id=? WHERE id=?').run(ids[index], task.id));
  }
  assert.equal(f.store.latestTaskResult(f.conversation.id, 'alice', 'deadbeef'), undefined);
  assert.equal(f.store.latestTaskResult(f.conversation.id, 'alice', 'deadbeef-abc'), undefined);
  assert.equal(f.store.latestTaskResult(f.conversation.id, 'alice', ids[0]).text, 'raw-answer-0');
  assert.equal(f.store.latestTaskResult(f.conversation.id, 'alice').text, 'raw-answer-1');
});

test('网络发送前持久化mode与被动slot，文本分段序号独立且未知投递停止后续', t => {
  const f = fixture(t);
  const task = f.enqueue('question'); const run = f.run(task);
  const progress = f.store.createProgress(run.id, '正在查询');
  assert.throws(() => f.store.startProgress(progress.id, 'active', 1), /无效/);
  f.store.startProgress(progress.id, 'active');
  f.store.ackProgress(progress.id, 'sent', 'progress-id');
  const result = f.store.completeRun(run.id, 'answer', undefined, undefined);
  f.store.prepareDeliveryParts(f.conversation.id, result.deliveryId, ['A', 'B', 'C']);
  f.store.beginDeliveryPart(f.conversation.id, result.deliveryId, 0, 'passive', 2);
  f.store.ackDeliveryPart(f.conversation.id, result.deliveryId, 0, 'sent', 'A-id');
  f.store.beginDeliveryPart(f.conversation.id, result.deliveryId, 1, 'active');
  f.reopen().markPendingUncertain(f.conversation.id);
  assert.deepEqual(f.inspect(db => db.prepare('SELECT part_index,delivery_mode,reply_slot,status FROM delivery_parts ORDER BY part_index').all().map(row => ({ ...row }))), [
    { part_index: 0, delivery_mode: 'passive', reply_slot: 2, status: 'sent' },
    { part_index: 1, delivery_mode: 'active', reply_slot: null, status: 'uncertain' },
    { part_index: 2, delivery_mode: 'passive', reply_slot: null, status: 'uncertain' },
  ]);
  assert.deepEqual({ ...f.inspect(db => db.prepare('SELECT delivery_mode,reply_slot,status FROM run_progress').get()) },
    { delivery_mode: 'active', reply_slot: null, status: 'sent' });
  assert.throws(() => f.store.beginDeliveryPart(f.conversation.id, result.deliveryId, 2, 'active'), /不能继续|不存在/);
});

test('真实v9迁移先备份，保留原文、已确认分段和旧canonical运行', t => {
  const f = fixture(t);
  const run = f.store.beginRun(f.conversation.id, '原始问题', 'p', 'm', [], { eventId: 'legacy', senderId: 'alice', modelInputText: '模型输入' });
  const result = f.store.completeRun(run.id, '**原始答案**', 'old-user', 'old-assistant');
  f.store.prepareDeliveryParts(f.conversation.id, result.deliveryId, ['原有已发送文本', '未发送文本']);
  f.store.beginDeliveryPart(f.conversation.id, result.deliveryId, 0);
  f.store.ackDeliveryPart(f.conversation.id, result.deliveryId, 0, 'sent', 'old-external');
  const pendingRun = f.store.beginRun(f.other.id, 'canonical进行中', 'p', 'm', [], { eventId: 'unfinished', senderId: 'alice', modelInputText: 'canonical进行中' });
  f.store.close();
  f.inspect(db => { downgradeSchema11(db); db.exec(`
    DROP TABLE channel_tasks; DROP INDEX message_conversation_identity;
    DROP INDEX one_running_run_per_session; DROP INDEX one_running_run_per_conversation;
    ALTER TABLE agent_runs DROP COLUMN pi_session_file;
    CREATE UNIQUE INDEX one_running_run_per_conversation ON agent_runs(conversation_id) WHERE status='running';
    ALTER TABLE delivery_parts DROP COLUMN delivery_mode; ALTER TABLE delivery_parts DROP COLUMN reply_slot;
    ALTER TABLE run_progress DROP COLUMN delivery_mode; ALTER TABLE run_progress DROP COLUMN reply_slot;
    PRAGMA user_version=9;
  `); });
  f.reopen();
  const backups = readdirSync(f.directory).filter(name => name.includes('.v9.') && name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(f.directory, backups[0]));
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 9);
    assert.equal(backup.prepare('SELECT text FROM messages WHERE id=?').get(result.messageId).text, '**原始答案**');
    assert.deepEqual(backup.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(backup.prepare("SELECT name FROM pragma_table_info('agent_runs') WHERE name='pi_session_file'").get(), undefined);
  } finally { backup.close(); }
  assert.equal(f.inspect(db => db.prepare('PRAGMA user_version').get().user_version), 18);
  assert.deepEqual(f.store.unfinishedRuns(f.other.id), [pendingRun]);
  assert.equal(f.store.quotedMessage(f.conversation.id, 'old-external').text, '原有已发送文本');
  assert.equal(f.inspect(db => db.prepare('SELECT text FROM messages WHERE id=?').get(result.messageId).text), '**原始答案**');
  assert.equal(f.inspect(db => db.prepare('SELECT model_input_text FROM messages WHERE id=?').get(run.inputMessageId).model_input_text), '模型输入');
  assert.deepEqual(f.inspect(db => db.prepare('SELECT status,delivery_mode,reply_slot FROM delivery_parts ORDER BY part_index').all().map(row => ({ ...row }))), [
    { status: 'sent', delivery_mode: 'passive', reply_slot: null }, { status: 'pending', delivery_mode: 'passive', reply_slot: null },
  ]);
  assert.deepEqual(f.inspect(db => db.prepare('PRAGMA foreign_key_check').all()), []);
  f.reopen();
  assert.equal(readdirSync(f.directory).filter(name => name.includes('.v9.') && name.endsWith('.bak')).length, 1);
});
