import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore,  } from '../dist/store.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'pa-store-'));
  const databasePath = join(directory, 'nested', 'store.sqlite');
  const store = new ConversationStore(databasePath);
  return {
    directory, databasePath, store,
    cleanup() { try { store.close(); } finally { rmSync(directory, { recursive: true, force: true }); } },
  };
}

test('schema启用WAL与外键，会话和消息重开后持久化并隔离', () => {
  const f = fixture();
  try {
    const first = f.store.ensureConversation('alpha', '/pi/alpha.jsonl');
    const second = f.store.ensureConversation('beta', '/pi/beta.jsonl');
    const run = f.store.beginRun(first.id, '保留原始内容 🙂', 'provider', 'model');
    f.store.completeRun(run.id, '回复', 'pi-user-1', 'pi-assistant-1');
    assert.equal(f.store.ensureConversation('alpha', '/pi/alpha.jsonl').id, first.id);
    assert.throws(() => f.store.ensureConversation('alpha', '/changed.jsonl'), /不同的 Pi session/);
    assert.deepEqual(f.store.listMessages('beta', 10), []);
    f.store.close();

    const reopened = new ConversationStore(f.databasePath);
    try {
      assert.equal(reopened.listMessages('alpha', 10).map(message => message.text).join('|'), '保留原始内容 🙂|回复');
      const db = new DatabaseSync(f.databasePath);
      try {
        assert.equal(db.prepare('PRAGMA user_version').get().user_version,31);
        assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
        assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
        assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 2);
      } finally { db.close(); }
      assert.equal(reopened.ensureConversation('beta', '/pi/beta.jsonl').id, second.id);
    } finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('上下文SQL在LIMIT之前过滤管理、失败运行与其他成员AI交互，重置水位持久生效', () => {
  const f = fixture();
  const route = { channel: 'qq', accountId: 'bot', roomType: 'group', roomId: 'group' };
  const conversation = f.store.ensureConversation('group', '/group.jsonl', route);
  function run(senderId, eventId, status = 'completed') {
    const run = f.store.beginRun(conversation.id, `${eventId}输入`, 'p', 'm', [], { eventId, senderId, modelInputText: eventId });
    if (status === 'completed') f.store.completeRun(run.id, `${eventId}回复`, undefined, undefined);
    else f.store.failRun(run.id, status, 'test', 'test');
  }
  try {
    run('a', '甲');
    f.store.recordInbound(conversation.id, '公开旁听消息', { eventId: 'observe', senderId: 'b', modelInputText: '公开消息' });
    run('b', '乙');
    run('a', '失败', 'failed');
    run('a', '中断', 'interrupted');
    for (let i = 0; i < 3; i += 1) f.store.recordControlRun(conversation.id, '管理命令', {
      eventId: `control-${i}`, senderId: 'a', modelInputText: '管理命令',
    }, () => '管理回复');
    assert.deepEqual(f.store.contextMessages(conversation.id, 3, 'a').map(message => message.text), ['甲输入', '甲回复', '公开旁听消息']);
    assert.deepEqual(f.store.contextMessages(conversation.id, 3, 'b').map(message => message.text), ['公开旁听消息', '乙输入', '乙回复']);
    const pending = f.store.beginRun(conversation.id, '运行中', 'p', 'm', [], { eventId: 'pending', senderId: 'a', modelInputText: '运行中' });
    assert.deepEqual(f.store.contextMessages(conversation.id, 3, 'a').map(message => message.text), ['甲输入', '甲回复', '公开旁听消息']);
    f.store.failRun(pending.id, 'interrupted', 'test', 'test');
    let memory;
    f.store.recordControlRun(conversation.id, '纠正本群约定', { eventId: 'rule', senderId: 'a', modelInputText: '群约定' }, source => {
      memory = f.store.rememberMemory(conversation.id, { content: '旧群约定', sourceMessageId: source.id }).memory;
      memory = f.store.correctMemory(conversation.id,memory.id,{content:'新群约定',sourceMessageId:source.id},1).memory;
      return '已更新';
    });
    assert.deepEqual(f.store.contextMessages(conversation.id, 20, 'a'), []);
    assert.equal(f.store.listMessages('group', 50, route).some(message => message.text === '甲回复'), true);
    f.store.ackContextReset(conversation.id, f.store.contextState(conversation.id).generation);
    f.store.recordInbound(conversation.id, '水位后的公开消息', { eventId: 'after', senderId: 'b', modelInputText: '公开消息' });
    assert.deepEqual(f.store.contextMessages(conversation.id, 20, 'a').map(message => message.text), ['水位后的公开消息']);
    f.store.recordControlRun(conversation.id, '纠正', { eventId: 'correct', senderId: 'owner', modelInputText: '纠正' }, source => {
      f.store.correctMemory(conversation.id, memory.id, {content:'管理员纠正',sourceMessageId:source.id},2);
      return '已纠正';
    });
    assert.deepEqual(f.store.contextMessages(conversation.id, 20, 'a'), []);
    f.store.close();
    const reopened = new ConversationStore(f.databasePath);
    try { assert.deepEqual(reopened.contextMessages(conversation.id, 20, 'a'), []); }
    finally { reopened.close(); }
  } finally { f.cleanup(); }
});
