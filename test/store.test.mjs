import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore, DuplicateMessageError } from '../dist/store.js';

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
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 7);
        assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
        assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
        assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 2);
      } finally { db.close(); }
      assert.equal(reopened.ensureConversation('beta', '/pi/beta.jsonl').id, second.id);
    } finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('beginRun原子写入用户消息，完成原子写入回复和pending投递，失败不伪造回复', () => {
  const f = fixture();
  try {
    const conversation = f.store.ensureConversation('one', '/one.jsonl');
    const run = f.store.beginRun(conversation.id, 'question', 'p', 'm');
    assert.deepEqual(f.store.unfinishedRuns(conversation.id), [run]);
    const { messageId, deliveryId } = f.store.completeRun(run.id, 'answer', undefined, undefined);
    assert.equal(f.store.unfinishedRuns(conversation.id).length, 0);
    const messages = f.store.listMessages('one', 10);
    assert.deepEqual(messages.map(({ role, text }) => ({ role, text })), [
      { role: 'user', text: 'question' }, { role: 'assistant', text: 'answer' },
    ]);
    assert.equal(messages[1].id, messageId);
    assert.equal(messages[1].runStatus, 'completed');
    assert.equal(messages[1].deliveryStatus, 'pending');
    assert.throws(() => f.store.completeRun(run.id, 'duplicate', undefined, undefined), /已结束/);
    assert.equal(f.store.listMessages('one', 10).length, 2);
    assert.throws(() => f.store.ackDelivery('missing', 'sent'), /不存在/);
    f.store.ackDelivery(deliveryId, 'sent');
    f.store.ackDelivery(deliveryId, 'sent');
    assert.throws(() => f.store.ackDelivery(deliveryId, 'uncertain'), /不能/);
    assert.equal(f.store.listMessages('one', 10)[1].deliveryStatus, 'sent');

    const failed = f.store.beginRun(conversation.id, 'second question', 'p', 'm');
    f.store.failRun(failed.id, 'failed', 'test', 'sanitized failure');
    assert.equal(f.store.listMessages('one', 10).length, 3);
    assert.equal(f.store.listMessages('one', 10)[2].runStatus, 'failed');
    assert.throws(() => f.store.failRun(failed.id, 'interrupted', 'again', 'no'), /已结束/);
  } finally { f.cleanup(); }
});

test('同一会话拒绝并发running，失败事务不会残留输入消息', () => {
  const f = fixture();
  try {
    const conversation = f.store.ensureConversation('one', '/one.jsonl');
    f.store.beginRun(conversation.id, 'first', 'p', 'm');
    assert.throws(() => f.store.beginRun(conversation.id, 'second', 'p', 'm'));
    assert.deepEqual(f.store.listMessages('one', 10).map(message => message.text), ['first']);
  } finally { f.cleanup(); }
});

test('渠道路由四维隔离，发送者按房间作用域记录，恢复保留模型输入和投递回执', () => {
  const f = fixture();
  const route = { channel: 'qq', accountId: 'bot-1', roomType: 'group', roomId: 'shared-id' };
  const variants = [route, { ...route, channel: 'telegram' }, { ...route, accountId: 'bot-2' },
    { ...route, roomType: 'private' }, { ...route, roomId: 'other-group' }];
  try {
    const conversations = variants.map((selected, index) => f.store.ensureConversation('same-key', `/pi/${index}.jsonl`, selected));
    assert.equal(new Set(conversations.map(conversation => conversation.id)).size, variants.length);
    const external = { eventId: 'event-1', senderId: 'person-1', senderName: '甲', modelInputText: '{"sender":"甲","text":"原文"}' };
    const run = f.store.beginRun(conversations[0].id, '原文', 'p', 'm', [], external);
    assert.equal(run.modelInputText, external.modelInputText);
    assert.deepEqual(f.store.unfinishedRuns(conversations[0].id), [run]);
    assert.equal(f.store.hasExternalMessage(conversations[0].id, 'event-1'), true);
    assert.equal(f.store.hasExternalMessage(conversations[1].id, 'event-1'), false);
    assert.throws(() => f.store.beginRun(conversations[0].id, '重复', 'p', 'm', [], external), DuplicateMessageError);
    const delivery = f.store.completeRun(run.id, '回应', 'pi-user', 'pi-assistant');
    f.store.ackDelivery(delivery.deliveryId, 'sent', 'qq-response-1');
    f.store.ackDelivery(delivery.deliveryId, 'sent', 'qq-response-1');
    assert.throws(() => f.store.ackDelivery(delivery.deliveryId, 'sent', 'different-response'), /不同的渠道消息 ID/);
    assert.throws(() => f.store.beginRun(conversations[0].id, '重复', 'p', 'm', [], external), DuplicateMessageError);
    const second = f.store.beginRun(conversations[0].id, '乙的原文', 'p', 'm', [], { ...external, eventId: 'event-2', senderId: 'person-2', senderName: '乙' });
    f.store.failRun(second.id, 'interrupted', 'test', 'test');
    for (let index = 1; index < variants.length; index += 1) {
      const other = f.store.beginRun(conversations[index].id, '独立原文', 'p', 'm', [], external);
      f.store.failRun(other.id, 'failed', 'test', 'test');
      assert.equal(f.store.listMessages('same-key', 10, variants[index]).length, 1);
    }
    assert.deepEqual(f.store.listMessages('same-key', 10), []);
    const history = f.store.listMessages('same-key', 10, route);
    assert.deepEqual(history.map(message => message.text), ['原文', '回应', '乙的原文']);
    assert.equal(history[0].senderId, 'person-1');
    assert.equal(history[0].senderName, '甲');
    assert.equal(history[0].eventId, 'event-1');
    assert.equal(history[1].externalMessageId, 'qq-response-1');
    const db = new DatabaseSync(f.databasePath);
    try {
      const stored = db.prepare('SELECT d.channel, d.external_message_id, r.channel AS room_channel, r.account, r.external_chat_id, r.room_type FROM deliveries d JOIN rooms r ON r.id = d.room_id').get();
      assert.deepEqual({ ...stored }, { channel: 'qq', external_message_id: 'qq-response-1', room_channel: 'qq', account: 'bot-1', external_chat_id: 'shared-id', room_type: 'group' });
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM actors WHERE kind = 'external-user'").get().n, 6);
      assert.equal(db.prepare("SELECT COUNT(DISTINCT actor_id) AS n FROM messages WHERE role = 'user'").get().n, 6);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
    f.store.close();
    const reopened = new ConversationStore(f.databasePath);
    try { assert.deepEqual(reopened.listMessages('same-key', 10, route), history); }
    finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('纯观察输入记录实际身份且无运行，重复观察和运行均去重，失败回滚不占用事件', () => {
  const f = fixture();
  const route = { channel: 'qq', accountId: 'bot', roomType: 'group', roomId: 'group' };
  try {
    const conversation = f.store.ensureConversation('group-key', '/group.jsonl', route);
    const observation = { eventId: 'observe-1', senderId: 'person', modelInputText: '旁观原文' };
    assert.equal(f.store.recordInbound(conversation.id, '旁观原文', observation), true);
    assert.equal(f.store.recordInbound(conversation.id, '重复原文', observation), false);
    assert.throws(() => f.store.beginRun(conversation.id, '重复@', 'p', 'm', [], observation), DuplicateMessageError);
    const message = f.store.listMessages('group-key', 10, route)[0];
    assert.equal(message.runStatus, null);
    assert.equal(message.piEntryId, null);
    assert.equal(message.deliveryStatus, null);
    assert.equal(message.senderId, 'person');
    assert.equal(message.eventId, 'observe-1');
    assert.equal(Object.hasOwn(message, 'senderName'), false);
    assert.deepEqual(f.store.unfinishedRuns(conversation.id), []);
    const run = f.store.beginRun(conversation.id, '被@输入', 'p', 'm', [], { ...observation, eventId: 'run-1' });
    assert.equal(f.store.recordInbound(conversation.id, '运行期间观察', { ...observation, eventId: 'observe-2' }), true);
    assert.throws(() => f.store.beginRun(conversation.id, '并发', 'p', 'm', [], { ...observation, eventId: 'rollback', senderId: 'new-person' }));
    assert.equal(f.store.hasExternalMessage(conversation.id, 'rollback'), false);
    f.store.failRun(run.id, 'failed', 'test', 'test');
    assert.equal(f.store.recordInbound(conversation.id, '重投', { ...observation, eventId: 'rollback', senderId: 'new-person' }), true);
    const db = new DatabaseSync(f.databasePath);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 4);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM actors WHERE kind = 'external-user'").get().n, 2);
    } finally { db.close(); }
  } finally { f.cleanup(); }
});

test('pending转uncertain仅影响指定会话，已有sent保持不变', () => {
  const f = fixture();
  try {
    const a = f.store.ensureConversation('a', '/a.jsonl');
    const b = f.store.ensureConversation('b', '/b.jsonl');
    const runA = f.store.beginRun(a.id, 'a', 'p', 'm');
    const outA = f.store.completeRun(runA.id, 'A', undefined, undefined);
    f.store.ackDelivery(outA.deliveryId, 'sent');
    const runB = f.store.beginRun(b.id, 'b', 'p', 'm');
    f.store.completeRun(runB.id, 'B', undefined, undefined);
    const runA2 = f.store.beginRun(a.id, 'a2', 'p', 'm');
    f.store.completeRun(runA2.id, 'A2', undefined, undefined);
    f.store.markPendingUncertain(a.id);
    assert.deepEqual(f.store.listMessages('a', 10).map(message => message.deliveryStatus), [null, 'sent', null, 'uncertain']);
    assert.deepEqual(f.store.listMessages('b', 10).map(message => message.deliveryStatus), [null, 'pending']);
  } finally { f.cleanup(); }
});

test('拒绝并保留非空未知数据库', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-store-unknown-'));
  const databasePath = join(directory, 'unknown.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec('CREATE TABLE user_data (value TEXT); INSERT INTO user_data VALUES (\'keep\');');
  db.close();
  try {
    assert.throws(() => new ConversationStore(databasePath), /未知数据库/);
    const check = new DatabaseSync(databasePath);
    try {
      assert.equal(check.prepare('SELECT value FROM user_data').get().value, 'keep');
      assert.equal(check.prepare('PRAGMA user_version').get().user_version, 0);
    } finally { check.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('拒绝高版本数据库并保留版本号', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-store-version-'));
  const databasePath = join(directory, 'future.sqlite');
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA user_version = 99');
  db.close();
  try {
    assert.throws(() => new ConversationStore(databasePath), /高于当前支持版本/);
    const check = new DatabaseSync(databasePath);
    try { assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99); }
    finally { check.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('并发首次初始化在写锁内重读版本，不重复建表或覆盖会话', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-store-race-'));
  const databasePath = join(directory, 'store.sqlite');
  const readyPath = join(directory, 'child-ready');
  const releasePath = join(directory, 'release-child');
  const storeModule = new URL('../dist/store.js', import.meta.url).href;
  const childSource = `
    import { DatabaseSync } from 'node:sqlite';
    import { existsSync, writeFileSync } from 'node:fs';
    const originalExec = DatabaseSync.prototype.exec;
    let paused = false;
    DatabaseSync.prototype.exec = function (...args) {
      if (!paused && args[0] === 'BEGIN IMMEDIATE') {
        paused = true;
        writeFileSync(process.env.PA_TEST_READY, 'ready');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(process.env.PA_TEST_RELEASE)) Atomics.wait(wait, 0, 0, 10);
      }
      return originalExec.apply(this, args);
    };
    const { ConversationStore } = await import(${JSON.stringify(storeModule)});
    const store = new ConversationStore(process.env.PA_TEST_DATABASE);
    store.ensureConversation('child', '/pi/child.jsonl');
    store.close();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
    cwd: process.cwd(),
    env: { ...process.env, PA_TEST_DATABASE: databasePath, PA_TEST_READY: readyPath, PA_TEST_RELEASE: releasePath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const childExit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(readyPath)) {
      if (child.exitCode !== null) throw new Error(`子进程提前退出 (${child.exitCode}): ${stderr}`);
      if (Date.now() >= deadline) throw new Error(`等待子进程到达初始化锁前超时: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const parent = new ConversationStore(databasePath);
    try { parent.ensureConversation('parent', '/pi/parent.jsonl'); }
    finally { parent.close(); }
    writeFileSync(releasePath, 'continue');
    let timeout;
    const result = await Promise.race([
      childExit,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          child.kill();
          reject(new Error(`并发初始化子进程超时: ${stderr}`));
        }, 10000);
      }),
    ]).finally(() => clearTimeout(timeout));
    assert.deepEqual(result, { code: 0, signal: null }, `${stdout}\n${stderr}`);
    const finalStore = new ConversationStore(databasePath);
    try {
      assert.equal(finalStore.ensureConversation('parent', '/pi/parent.jsonl').key, 'parent');
      assert.equal(finalStore.ensureConversation('child', '/pi/child.jsonl').key, 'child');
      assert.equal(finalStore.listMessages('parent', 10).length, 0);
      assert.equal(finalStore.listMessages('child', 10).length, 0);
    } finally { finalStore.close(); }
  } finally {
    writeFileSync(releasePath, 'continue');
    if (child.exitCode === null) child.kill();
    await childExit;
    rmSync(directory, { recursive: true, force: true });
  }
});

function inspect(databasePath, operation) {
  const db = new DatabaseSync(databasePath);
  try { return operation(db); } finally { db.close(); }
}

test('管理运行原子提交来源、记忆、回复和投递；异常与投递失败全部回滚并可重投', () => {
  const f = fixture();
  const route = { channel: 'qq', accountId: 'bot', roomType: 'group', roomId: 'group' };
  const conversation = f.store.ensureConversation('group', '/group.jsonl', route);
  const external = { eventId: 'memory-1', senderId: 'self', modelInputText: '明确自述' };
  const tables = ['actors', 'messages', 'agent_runs', 'deliveries', 'memories', 'memory_events', 'memory_revisions', 'memory_context_state'];
  const snapshot = () => inspect(f.databasePath, db => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
  try {
    let source;
    const result = f.store.recordControlRun(conversation.id, '更新我的饮食', external, actual => {
      source = actual;
      const change = f.store.rememberMemory(conversation.id, {
        content: '吃素', subjectActorId: actual.actorId, profileField: 'diet', sourceMessageId: actual.id,
      });
      assert.equal(change.contextResetRequired, true);
      return '已更新';
    });
    assert.equal(result.text, '已更新');
    assert.deepEqual(source, f.store.externalMessage(conversation.id, external.eventId));
    assert.equal(source.senderId, 'self');
    const history = f.store.listMessages('group', 10, route);
    assert.deepEqual(history.map(message => message.messageKind), ['memory', 'memory']);
    assert.equal(history[0].actorId, source.actorId);
    assert.equal(history[0].piEntryId, null);
    assert.equal(history[1].piEntryId, null);
    assert.equal(history[1].deliveryStatus, 'pending');
    assert.deepEqual(f.store.contextMessages(conversation.id, 10, 'self'), []);
    assert.deepEqual(f.store.unfinishedRuns(conversation.id), []);
    assert.throws(() => f.store.recordControlRun(conversation.id, '重投', external, () => '重复'), DuplicateMessageError);
    const before = snapshot();
    const crash = { ...external, eventId: 'crash', senderId: 'new-actor' };
    assert.throws(() => f.store.recordControlRun(conversation.id, '崩溃命令', crash, actual => {
      f.store.rememberMemory(conversation.id, { content: '尚未提交', sourceMessageId: actual.id });
      throw new Error('operation crash');
    }), /operation crash/);
    assert.deepEqual(snapshot(), before);
    assert.equal(f.store.findActor(conversation.id, 'new-actor'), undefined);
    inspect(f.databasePath, db => db.exec("CREATE TRIGGER fail_control_delivery BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'delivery failure'); END"));
    assert.throws(() => f.store.recordControlRun(conversation.id, '投递失败命令', crash, actual => {
      f.store.rememberMemory(conversation.id, { content: '尚未提交', sourceMessageId: actual.id });
      return '完成';
    }), /delivery failure/);
    assert.deepEqual(snapshot(), before);
    inspect(f.databasePath, db => db.exec('DROP TRIGGER fail_control_delivery;'));
    assert.equal(f.store.recordControlRun(conversation.id, '重投命令', crash, () => '完成').text, '完成');
  } finally { f.cleanup(); }
});

test('管理回调捕获子CRUD错误时SAVEPOINT清除半成品，外层可提交正常拒绝回复', () => {
  const f = fixture();
  const route = { channel: 'qq', accountId: 'bot', roomType: 'group', roomId: 'group' };
  const conversation = f.store.ensureConversation('group', '/group.jsonl', route);
  try {
    inspect(f.databasePath, db => db.exec("CREATE TRIGGER fail_revision BEFORE INSERT ON memory_revisions BEGIN SELECT RAISE(ABORT, 'revision failure'); END"));
    const result = f.store.recordControlRun(conversation.id, '更新', { eventId: 'e', senderId: 'self', modelInputText: '更新' }, source => {
      try {
        f.store.rememberMemory(conversation.id, { content: '不能保存', sourceMessageId: source.id });
        assert.fail('must reject');
      } catch (error) { assert.match(error.message, /revision failure/); }
      return '更新失败';
    });
    assert.equal(result.text, '更新失败');
    inspect(f.databasePath, db => {
      for (const table of ['memories', 'memory_events', 'memory_revisions']) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
      }
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status = 'completed'").get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deliveries').get().n, 1);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    });
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
    f.store.recordControlRun(conversation.id, '更新自己的饮食', { eventId: 'diet', senderId: 'a', modelInputText: '自述' }, source => {
      memory = f.store.rememberMemory(conversation.id, { content: '新口味', subjectActorId: source.actorId, profileField: 'diet', sourceMessageId: source.id }).memory;
      return '已更新';
    });
    assert.deepEqual(f.store.contextMessages(conversation.id, 20, 'a'), []);
    assert.equal(f.store.listMessages('group', 50, route).some(message => message.text === '甲回复'), true);
    f.store.ackContextReset(conversation.id, f.store.contextState(conversation.id).generation);
    f.store.recordInbound(conversation.id, '水位后的公开消息', { eventId: 'after', senderId: 'b', modelInputText: '公开消息' });
    assert.deepEqual(f.store.contextMessages(conversation.id, 20, 'a').map(message => message.text), ['水位后的公开消息']);
    f.store.recordControlRun(conversation.id, '纠正', { eventId: 'correct', senderId: 'owner', modelInputText: '纠正' }, source => {
      f.store.correctMemory(conversation.id, memory.id, {content:'管理员纠正',sourceMessageId:source.id},1);
      return '已纠正';
    });
    assert.deepEqual(f.store.contextMessages(conversation.id, 20, 'a'), []);
    f.store.close();
    const reopened = new ConversationStore(f.databasePath);
    try { assert.deepEqual(reopened.contextMessages(conversation.id, 20, 'a'), []); }
    finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('reset前running恢复完成后仅保留原始审计，新assistant rowid不能使旧输入/回复越过水位', () => {
  const f = fixture();
  try {
    const conversation = f.store.ensureConversation('late', '/late.jsonl');
    const memory = f.store.rememberMemory(conversation.id, { content: '旧背景' }).memory;
    const run = f.store.beginRun(conversation.id, '重置前输入', 'p', 'm', [{ id: memory.id, revision: 1 }]);
    f.store.correctMemory(conversation.id, memory.id, { content: '新背景' }, 1);
    f.store.ackContextReset(conversation.id, f.store.contextState(conversation.id).generation);
    f.store.completeRun(run.id, '重置后迟到旧背景回复', 'pi-old-u', 'pi-old-a', true);
    assert.deepEqual(f.store.contextMessages(conversation.id, 20), []);
    assert.deepEqual(f.store.listMessages('late', 20).map(m => m.text), ['重置前输入', '重置后迟到旧背景回复']);
    const next = f.store.beginRun(conversation.id, '新输入', 'p', 'm');
    f.store.completeRun(next.id, '新回复', undefined, undefined);
    assert.deepEqual(f.store.contextMessages(conversation.id, 20).map(m => m.text), ['新输入', '新回复']);
    inspect(f.databasePath, db => assert.equal(db.prepare('SELECT recovered FROM agent_runs WHERE id = ?').get(run.id).recovered, 1));
  } finally { f.cleanup(); }
});

test('上下文SQL排除已删除/被替代/版本变更memory refs的completed整对，保持raw消息', () => {
  const f = fixture();
  try {
    const conversation = f.store.ensureConversation('refs', '/refs.jsonl');
    const memory = f.store.rememberMemory(conversation.id, { content: '引用背景' }).memory;
    const run = f.store.beginRun(conversation.id, '引用输入', 'p', 'm', [{ id: memory.id, revision: 1 }]);
    f.store.completeRun(run.id, '引用回复', undefined, undefined);
    assert.equal(f.store.contextMessages(conversation.id, 20).length, 2);
    for (const sql of [
      'UPDATE memories SET revision = 2 WHERE id = ?',
      'UPDATE memories SET revision = 1, is_current = 0 WHERE id = ?',
      "UPDATE memories SET is_current = 1, status = 'deleted', content = NULL WHERE id = ?",
    ]) {
      inspect(f.databasePath, db => db.prepare(sql).run(memory.id));
      assert.deepEqual(f.store.contextMessages(conversation.id, 20), []);
      assert.equal(f.store.listMessages('refs', 20).length, 2);
    }
  } finally { f.cleanup(); }
});
