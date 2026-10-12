import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { MemoryError } from '../dist/memory-types.js';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'pa-memory-'));
  const databasePath = join(directory, 'store.sqlite');
  const store = new ConversationStore(databasePath);
  const a = store.ensureConversation('a', '/a.jsonl');
  const b = store.ensureConversation('b', '/b.jsonl');
  return { store, a, b, databasePath, cleanup() { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function inspect(path, callback) {
  const db = new DatabaseSync(path);
  try { return callback(db); } finally { db.close(); }
}

test('真实V1布局迁移到V2，保留消息、运行与投递并可写入记忆', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-memory-v1-'));
  const databasePath = join(directory, 'store.sqlite');
  inspect(databasePath, db => {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE actors (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind = 'local-owner'));
      CREATE TABLE rooms (id TEXT PRIMARY KEY, channel TEXT NOT NULL CHECK (channel = 'cli'), account TEXT NOT NULL CHECK (account = 'local'), external_chat_id TEXT NOT NULL, UNIQUE (channel, account, external_chat_id));
      CREATE TABLE conversations (id TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id), pi_session_file TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), actor_id TEXT REFERENCES actors(id), role TEXT NOT NULL CHECK (role IN ('user', 'assistant')), text TEXT NOT NULL, pi_entry_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), input_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')), response_message_id TEXT UNIQUE REFERENCES messages(id),
        provider TEXT NOT NULL, model TEXT NOT NULL, error_kind TEXT, error_message TEXT, recovered INTEGER NOT NULL DEFAULT 0 CHECK (recovered IN (0, 1)),
        started_at TEXT NOT NULL, finished_at TEXT,
        CHECK ((status = 'completed' AND response_message_id IS NOT NULL AND finished_at IS NOT NULL) OR (status <> 'completed' AND response_message_id IS NULL))
      );
      CREATE UNIQUE INDEX one_running_run_per_conversation ON agent_runs(conversation_id) WHERE status = 'running';
      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id),
        message_id TEXT NOT NULL UNIQUE REFERENCES messages(id), channel TEXT NOT NULL CHECK (channel = 'cli'),
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'uncertain')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO actors VALUES ('local-owner', 'local-owner');
      INSERT INTO rooms VALUES ('room', 'cli', 'local', 'legacy');
      INSERT INTO conversations VALUES ('conv', 'room', '/legacy.jsonl');
      INSERT INTO messages VALUES ('user', 'conv', 'local-owner', 'user', '原始聊天保留 🙂', 'pi-u', '2026-01-01');
      INSERT INTO messages VALUES ('assistant', 'conv', NULL, 'assistant', '原始回复', 'pi-a', '2026-01-01');
      INSERT INTO agent_runs VALUES ('run', 'conv', 'user', 'completed', 'assistant', 'p', 'm', NULL, NULL, 1, '2026-01-01', '2026-01-01');
      INSERT INTO deliveries VALUES ('delivery', 'conv', 'run', 'assistant', 'cli', 'pending', '2026-01-01', '2026-01-01');
      PRAGMA user_version = 1;
    `);
  });
  const businessTables = ['actors', 'rooms', 'conversations', 'messages', 'agent_runs', 'deliveries'];
  const before = inspect(databasePath, db => businessTables.map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  let store;
  try {
    store = new ConversationStore(databasePath);
    assert.deepEqual(inspect(databasePath, db => businessTables.map(table => db.prepare(`SELECT * FROM ${table}`).all())), before);
    assert.equal(store.ensureConversation('legacy', '/legacy.jsonl').id, 'conv');
    assert.equal(store.listMessages('legacy', 10)[1].deliveryStatus, 'pending');
    const memory = store.rememberMemory('conv', { content: '显式来源', sourceMessageId: 'user' }).memory;
    assert.equal(memory.sourceMessageId, 'user');
    assert.deepEqual(store.contextState('conv'), { required: false, generation: 0 });
    store.ackDelivery('delivery', 'sent');
    inspect(databasePath, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    });
    store.close();
    store = new ConversationStore(databasePath);
    assert.deepEqual(store.queryMemories('conv'), [memory]);
    assert.equal(store.listMessages('legacy', 10)[1].deliveryStatus, 'sent');
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('显式CRUD持久化，纠正保留稳定ID、历史版本和无原文事件', () => {
  const f = fixture();
  try {
    const run = f.store.beginRun(f.a.id, '聊天中的来源原文', 'p', 'm');
    f.store.completeRun(run.id, '回复', 'pi-user', 'pi-assistant');
    const original = f.store.rememberMemory(f.a.id, { content: '  喜欢中文 🙂  ', kind: 'preference', sourceMessageId: run.inputMessageId });
    assert.equal(original.contextResetRequired, false);
    assert.equal(original.memory.content, '  喜欢中文 🙂  ');
    assert.equal(original.memory.origin, 'explicit_user');
    assert.equal(original.memory.revision, 1);
    const corrected = f.store.correctMemory(f.a.id, original.memory.id, { content: '喜欢英文' }, 1);
    assert.equal(corrected.memory.id, original.memory.id);
    assert.equal(corrected.memory.revision, 2);
    assert.equal(corrected.memory.kind, 'preference');
    assert.equal(corrected.memory.sourceMessageId, null);
    assert.equal(corrected.memory.createdAt, original.memory.createdAt);
    assert.notEqual(corrected.memory.sourceEventId, original.memory.sourceEventId);
    assert.equal(corrected.contextResetRequired, true);
    assert.deepEqual(f.store.queryMemories(f.a.id, '中文'), []);
    assert.deepEqual(f.store.queryMemories(f.a.id), [corrected.memory]);
    inspect(f.databasePath, db => {
      const versions = db.prepare('SELECT revision, content, status FROM memory_revisions WHERE memory_id = ? ORDER BY revision').all(original.memory.id);
      assert.deepEqual(versions.map(row => ({ ...row })), [
        { revision: 1, content: '  喜欢中文 🙂  ', status: 'superseded' }, { revision: 2, content: '喜欢英文', status: 'active' },
      ]);
      const events = db.prepare('SELECT * FROM memory_events ORDER BY rowid').all();
      assert.deepEqual(events.map(event => event.action), ['remember', 'correct']);
      assert.equal(events[0].id, original.memory.sourceEventId);
      assert.equal(events[1].id, corrected.memory.sourceEventId);
      assert.equal(JSON.stringify(events).includes('喜欢'), false);
    });
    f.store.close();
    const reopened = new ConversationStore(f.databasePath);
    try {
      assert.deepEqual(reopened.queryMemories(f.a.id), [corrected.memory]);
      assert.deepEqual(reopened.contextState(f.a.id), { required: true, generation: 1 });
      assert.deepEqual(reopened.listMessages('a', 10).map(message => message.text), ['聊天中的来源原文', '回复']);
    } finally { reopened.close(); }
  } finally { f.cleanup(); }
});

test('删除清空全部记忆版本正文，保留元数据和使用审计，重复删除幂等', () => {
  const f = fixture();
  try {
    const sourceRun = f.store.beginRun(f.a.id, '原始聊天不能删除', 'p', 'm');
    f.store.failRun(sourceRun.id, 'failed', 'test', 'test');
    const memory = f.store.rememberMemory(f.a.id, { content: '第一份秘密正文', sourceMessageId: sourceRun.inputMessageId }).memory;
    const use = f.store.beginRun(f.a.id, 'use', 'p', 'm', [{ id: memory.id, revision: 1 }]);
    f.store.failRun(use.id, 'failed', 'test', 'test');
    f.store.correctMemory(f.a.id, memory.id, { content: '第二份秘密正文', kind: 'episode' }, 1);
    const deletion = f.store.deleteMemory(f.a.id, memory.id, 2);
    assert.deepEqual(deletion, { id: memory.id, revision: 3, deleted: true, contextResetRequired: true });
    assert.deepEqual(f.store.queryMemories(f.a.id), []);
    assert.throws(() => f.store.correctMemory(f.a.id, memory.id, { content: '复活' }), /已删除/);
    assert.deepEqual(f.store.deleteMemory(f.a.id, memory.id, 1), deletion);
    assert.deepEqual(f.store.contextState(f.a.id), { required: true, generation: 2 });
    inspect(f.databasePath, db => {
      const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(memory.id);
      assert.equal(row.content, null);
      assert.equal(row.status, 'deleted');
      assert.equal(row.source_message_id, null);
      const versions = db.prepare('SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision').all(memory.id);
      assert.equal(versions.length, 3);
      assert.ok(versions.every(version => version.content === null && version.status === 'deleted'));
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_uses').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_events').get().n, 3);
      for (const table of ['memories', 'memory_revisions', 'memory_events', 'memory_uses', 'memory_context_state']) {
        assert.equal(JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes('秘密正文'), false);
      }
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    });
    assert.equal(f.store.listMessages('a', 10)[0].text, '原始聊天不能删除');
    f.store.ackContextReset(f.a.id, 2);
    assert.equal(f.store.deleteMemory(f.a.id, memory.id).contextResetRequired, false);
    assert.deepEqual(f.store.contextState(f.a.id), { required: false, generation: 2 });
  } finally { f.cleanup(); }
});

test('SQL按会话隔离读改删和引用，来源只能是本会话user消息', () => {
  const f = fixture();
  try {
    const own = f.store.beginRun(f.a.id, 'source a', 'p', 'm');
    const assistant = f.store.completeRun(own.id, 'assistant', undefined, undefined);
    const foreign = f.store.beginRun(f.b.id, 'source b', 'p', 'm');
    f.store.failRun(foreign.id, 'failed', 'test', 'test');
    const memory = f.store.rememberMemory(f.a.id, { content: '隔离', sourceMessageId: own.inputMessageId }).memory;
    for (const sourceMessageId of [assistant.messageId, foreign.inputMessageId, 'missing']) {
      assert.throws(() => f.store.rememberMemory(f.a.id, { content: '无效来源', sourceMessageId }), MemoryError);
      assert.throws(() => f.store.correctMemory(f.a.id, memory.id, { content: '无效来源', sourceMessageId }), MemoryError);
    }
    assert.deepEqual(f.store.queryMemories(f.b.id), []);
    for (const id of [memory.id, 'missing']) {
      assert.throws(() => f.store.correctMemory(f.b.id, id, { content: '越界' }), { name: 'MemoryError', message: '记忆不存在。' });
      assert.throws(() => f.store.deleteMemory(f.b.id, id), { name: 'MemoryError', message: '记忆不存在。' });
      assert.throws(() => f.store.beginRun(f.b.id, '越界引用', 'p', 'm', [{ id, revision: 1 }]), { name: 'MemoryError', message: '记忆不存在。' });
    }
    assert.deepEqual(f.store.queryMemories(f.a.id), [memory]);
    assert.equal(f.store.listMessages('b', 10).length, 1);
    inspect(f.databasePath, db => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_events').get().n, 1));
  } finally { f.cleanup(); }
});

test('字面子串查询支持百分号下划线引号中文emoji，限制与排序稳定', () => {
  const f = fixture();
  try {
    const first = f.store.rememberMemory(f.a.id, { content: "百分比% 下划线_ 引号' 中文🙂" }).memory;
    const second = f.store.rememberMemory(f.a.id, { content: '第二条' }).memory;
    const third = f.store.rememberMemory(f.a.id, { content: '第三条' }).memory;
    inspect(f.databasePath, db => db.prepare('UPDATE memories SET updated_at = ? WHERE conversation_id = ?').run('same-time', f.a.id));
    for (const query of ['%', '_', "'", '中文', '🙂']) assert.equal(f.store.queryMemories(f.a.id, query)[0].id, first.id);
    assert.deepEqual(f.store.queryMemories(f.a.id, "' OR 1=1 --"), []);
    assert.deepEqual(f.store.queryMemories(f.a.id, '', 2).map(memory => memory.id), [third.id, second.id]);
    const maxContent = '🙂'.repeat(4000);
    assert.equal(f.store.rememberMemory(f.a.id, { content: maxContent }).memory.content, maxContent);
    assert.doesNotThrow(() => f.store.queryMemories(f.a.id, '🙂'.repeat(1000), 200));
    for (const content of ['', ' \n\t ', '🙂'.repeat(4001), null, 12]) assert.throws(() => f.store.rememberMemory(f.a.id, { content }), MemoryError);
    assert.throws(() => f.store.rememberMemory(f.a.id, { content: 'x', kind: 'invented' }), MemoryError);
    assert.throws(() => f.store.rememberMemory(f.a.id, { content: 'x', sourceMessageId: '' }), MemoryError);
    for (const limit of [0, 201, 1.5, NaN, '2']) assert.throws(() => f.store.queryMemories(f.a.id, '', limit), MemoryError);
    for (const query of ['🙂'.repeat(1001), null, 12]) assert.throws(() => f.store.queryMemories(f.a.id, query), MemoryError);
  } finally { f.cleanup(); }
});

test('版本过期失败不改记忆；beginRun引用与输入运行原子提交或回滚', () => {
  const f = fixture();
  try {
    const one = f.store.rememberMemory(f.a.id, { content: 'one' }).memory;
    const two = f.store.rememberMemory(f.a.id, { content: 'two' }).memory;
    const other = f.store.rememberMemory(f.b.id, { content: 'other' }).memory;
    f.store.correctMemory(f.a.id, one.id, { content: 'new one' }, 1);
    assert.throws(() => f.store.correctMemory(f.a.id, one.id, { content: 'stale' }, 1), /版本已变化/);
    assert.throws(() => f.store.deleteMemory(f.a.id, one.id, 1), /版本已变化/);
    for (const expected of [0, -1, 1.5, NaN]) assert.throws(() => f.store.deleteMemory(f.a.id, one.id, expected), MemoryError);
    const good = { id: two.id, revision: 1 };
    for (const bad of [{ id: one.id, revision: 1 }, { id: other.id, revision: 1 }]) {
      assert.throws(() => f.store.beginRun(f.a.id, 'rollback', 'p', 'm', [good, bad]), MemoryError);
      assert.deepEqual(f.store.listMessages('a', 10), []);
      assert.deepEqual(f.store.unfinishedRuns(f.a.id), []);
      inspect(f.databasePath, db => assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_uses').get().n, 0));
    }
    const refs = [{ id: one.id, revision: 2 }, good];
    const run = f.store.beginRun(f.a.id, 'commit', 'p', 'm', refs);
    inspect(f.databasePath, db => {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_uses WHERE run_id = ?').get(run.id).n, 2);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get().n, 1);
    });
    assert.throws(() => f.store.beginRun(f.a.id, 'second running', 'p', 'm', refs), error => !(error instanceof MemoryError));
    assert.equal(f.store.listMessages('a', 10).length, 1);
    f.store.failRun(run.id, 'failed', 'test', 'test');
    f.store.deleteMemory(f.a.id, two.id);
    assert.throws(() => f.store.beginRun(f.a.id, 'deleted', 'p', 'm', [good]), /已删除/);
    assert.equal(f.store.listMessages('a', 10).length, 1);
  } finally { f.cleanup(); }
});

test('上下文重置generation递增，CAS不会清除更新期间产生的标记', () => {
  const f = fixture();
  try {
    const memory = f.store.rememberMemory(f.a.id, { content: 'initial' }).memory;
    assert.deepEqual(f.store.contextState(f.a.id), { required: false, generation: 0 });
    f.store.correctMemory(f.a.id, memory.id, { content: 'second' });
    const snapshot = f.store.contextState(f.a.id);
    f.store.correctMemory(f.a.id, memory.id, { content: 'third' });
    f.store.ackContextReset(f.a.id, snapshot.generation);
    assert.deepEqual(f.store.contextState(f.a.id), { required: true, generation: 2 });
    assert.deepEqual(f.store.contextState(f.b.id), { required: false, generation: 0 });
    f.store.ackContextReset(f.a.id, 2);
    assert.deepEqual(f.store.contextState(f.a.id), { required: false, generation: 2 });
    f.store.deleteMemory(f.a.id, memory.id);
    assert.deepEqual(f.store.contextState(f.a.id), { required: true, generation: 3 });
    assert.throws(() => f.store.ackContextReset(f.a.id, -1), MemoryError);
    assert.throws(() => f.store.contextState('missing'), MemoryError);
  } finally { f.cleanup(); }
});

test('SQLite故障保持原始错误，记忆写入事务不遗留事件', () => {
  const f = fixture();
  try {
    inspect(f.databasePath, db => db.exec("CREATE TRIGGER fail_memory BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'storage failure'); END"));
    assert.throws(() => f.store.rememberMemory(f.a.id, { content: 'never saved' }), error => !(error instanceof MemoryError) && /storage failure/.test(error.message));
    inspect(f.databasePath, db => {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_events').get().n, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 0);
    });
  } finally { f.cleanup(); }
});
