import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';

test('引用ID只匹配当前conversation入站或确认投递，重复和未确认ID不猜测', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-quote-store-'));
  const store = new ConversationStore(join(directory, 'store.sqlite'));
  try {
    const route = { channel: 'qq', accountId: 'account', roomId: 'group', roomType: 'group' };
    const a = store.ensureConversation('A', '/pi/a.jsonl', route);
    const b = store.ensureConversation('B', '/pi/b.jsonl', { ...route, roomId: 'other' });
    store.recordInbound(a.id, 'A原文', { eventId: 'shared', senderId: 'author-A', modelInputText: 'A原文' });
    store.recordInbound(b.id, 'B原文', { eventId: 'shared', senderId: 'author-B', modelInputText: 'B原文' });
    assert.deepEqual(store.quotedMessage(a.id, 'shared'), { role: 'user', senderId: 'author-A', text: 'A原文' });
    assert.deepEqual(store.quotedMessage(b.id, 'shared'), { role: 'user', senderId: 'author-B', text: 'B原文' });
    const run = store.beginRun(a.id, '问题', 'p', 'm', [], { eventId: 'question', senderId: 'asker', modelInputText: '问题' });
    const delivery = store.completeRun(run.id, '**模型原文**', undefined, undefined);
    assert.equal(store.quotedMessage(a.id, 'outgoing'), undefined);
    store.ackDelivery(delivery.deliveryId, 'uncertain', 'outgoing');
    assert.equal(store.quotedMessage(a.id, 'outgoing'), undefined);
    const confirmedRun = store.beginRun(a.id, '确认问题', 'p', 'm', [], { eventId: 'confirmed-question', senderId: 'asker', modelInputText: '确认问题' });
    const confirmed = store.completeRun(confirmedRun.id, '**模型原文**', undefined, undefined);
    store.ackDelivery(confirmed.deliveryId, 'sent', 'confirmed-outgoing');
    assert.deepEqual(store.quotedMessage(a.id, 'confirmed-outgoing'), { role: 'assistant', text: '**模型原文**' });
    assert.equal(store.quotedMessage(b.id, 'confirmed-outgoing'), undefined);
    store.recordInbound(a.id, '碰撞ID', { eventId: 'confirmed-outgoing', senderId: 'other', modelInputText: '碰撞ID' });
    assert.equal(store.quotedMessage(a.id, 'confirmed-outgoing'), undefined);
    assert.equal(store.quotedMessage(a.id, 'missing'), undefined);
    assert.equal(store.quotedMessage(a.id, "' OR 1=1 --"), undefined);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
