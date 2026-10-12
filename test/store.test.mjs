import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '../dist/store.js';

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
        assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
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
