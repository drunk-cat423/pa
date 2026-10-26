import assert from 'node:assert/strict';
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
  assert.equal(f.inspect(db => db.prepare('PRAGMA user_version').get().user_version),31);
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

test('崩溃恢复仅重排没有run的领取，不重排已记录模型调用的任务',t=>{
  const f=fixture(t),neverStarted=f.enqueue('claimed'),started=f.enqueue('dispatched');
  assert.equal(f.store.claimChannelTask(neverStarted.id),true);
  const run=f.run(started);
  assert.equal(f.store.listChannelTasks(f.conversation.id).find(t=>t.id===started.id).status,'running');
  f.reopen();
  f.store.failRun(run.id,'interrupted','interrupted','unknown request');
  f.store.recoverChannelTasks(f.conversation.id);
  const rows=f.store.listChannelTasks(f.conversation.id);
  assert.equal(rows.find(t=>t.id===neverStarted.id).status,'queued');
  assert.equal(rows.find(t=>t.id===started.id).status,'interrupted');
  assert.equal(f.store.releaseUnstartedChannelTask(f.conversation.id,started.id),false);
  assert.equal(f.store.claimNextChannelTask(f.conversation.id).id,neverStarted.id);
});
