import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';

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
    } };
}

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
