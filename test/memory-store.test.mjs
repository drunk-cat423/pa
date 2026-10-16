import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { MemoryError } from '../dist/memory-types.js';
import { downgradeSchema10 } from './fixtures/legacy-schema.mjs';

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

// Fixtures model tombstones that were already present before deletion was retired.
function historicalDeleted(path, id) {
  inspect(path, db => {
    db.prepare("UPDATE memories SET status='deleted',content=NULL,occurred_at=NULL,expires_at=NULL WHERE id=?").run(id);
    db.prepare("UPDATE memory_revisions SET status='deleted',content=NULL,occurred_at=NULL,expires_at=NULL WHERE memory_id=?").run(id);
  });
}

function seedV1Database(databasePath) {
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
}

test('真实V1布局迁移到V6，保留消息、运行与投递并可写入记忆', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-memory-v1-'));
  const databasePath = join(directory, 'store.sqlite');
  seedV1Database(databasePath);
  const businessTables = ['actors', 'rooms', 'conversations', 'messages', 'agent_runs', 'deliveries'];
  const originalColumns = inspect(databasePath, db => businessTables.map(table => db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name)));
  const before = inspect(databasePath, db => businessTables.map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  let store;
  try {
    store = new ConversationStore(databasePath);
    assert.deepEqual(inspect(databasePath, db => businessTables.map((table, index) => db.prepare(`SELECT ${originalColumns[index].join(', ')} FROM ${table}`).all())), before);
    assert.equal(store.ensureConversation('legacy', '/legacy.jsonl').id, 'conv');
    assert.equal(store.listMessages('legacy', 10)[1].deliveryStatus, 'pending');
    const memory = store.rememberMemory('conv', { content: '显式来源', sourceMessageId: 'user' }).memory;
    assert.equal(memory.sourceMessageId, 'user');
    assert.deepEqual(store.contextState('conv'), { required: false, generation: 0 });
    store.ackDelivery('delivery', 'sent');
    inspect(databasePath, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    });
    store.close();
    store = new ConversationStore(databasePath);
    assert.deepEqual(store.queryMemories('conv'), [memory]);
    assert.equal(store.listMessages('legacy', 10)[1].deliveryStatus, 'sent');
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

function seedV2Database(databasePath) {
  seedV1Database(databasePath);
  inspect(databasePath, db => db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'episode')), content TEXT,
      revision INTEGER NOT NULL CHECK (revision >= 1), status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
      origin TEXT NOT NULL CHECK (origin = 'explicit_user'), source_event_id TEXT NOT NULL REFERENCES memory_events(id),
      source_message_id TEXT REFERENCES messages(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      CHECK ((status = 'active' AND content IS NOT NULL) OR (status = 'deleted' AND content IS NULL))
    );
    CREATE INDEX memories_by_conversation ON memories(conversation_id, status, updated_at);
    CREATE TABLE memory_events (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      memory_id TEXT NOT NULL REFERENCES memories(id) DEFERRABLE INITIALLY DEFERRED,
      action TEXT NOT NULL CHECK (action IN ('remember', 'correct', 'delete')),
      revision INTEGER NOT NULL CHECK (revision >= 1), created_at TEXT NOT NULL
    );
    CREATE TABLE memory_revisions (
      memory_id TEXT NOT NULL REFERENCES memories(id), revision INTEGER NOT NULL CHECK (revision >= 1), content TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'deleted')),
      source_event_id TEXT NOT NULL REFERENCES memory_events(id), source_message_id TEXT REFERENCES messages(id),
      created_at TEXT NOT NULL, PRIMARY KEY (memory_id, revision),
      CHECK ((status IN ('active', 'superseded') AND content IS NOT NULL) OR (status = 'deleted' AND content IS NULL))
    );
    CREATE TABLE memory_uses (
      run_id TEXT NOT NULL REFERENCES agent_runs(id), memory_id TEXT NOT NULL, revision INTEGER NOT NULL,
      PRIMARY KEY (run_id, memory_id, revision), FOREIGN KEY (memory_id, revision) REFERENCES memory_revisions(memory_id, revision)
    );
    CREATE TABLE memory_context_state (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id), reset_required INTEGER NOT NULL CHECK (reset_required IN (0, 1)),
      generation INTEGER NOT NULL CHECK (generation >= 0)
    );
    BEGIN;
    INSERT INTO memory_events VALUES ('event-old', 'conv', 'memory', 'remember', 1, '2026-01-01');
    INSERT INTO memory_events VALUES ('event-new', 'conv', 'memory', 'correct', 2, '2026-01-02');
    INSERT INTO memories VALUES ('memory', 'conv', 'preference', '新版偏好', 2, 'active', 'explicit_user', 'event-new', 'user', '2026-01-01', '2026-01-02');
    INSERT INTO memory_revisions VALUES ('memory', 1, '旧版偏好', 'superseded', 'event-old', 'user', '2026-01-01');
    INSERT INTO memory_revisions VALUES ('memory', 2, '新版偏好', 'active', 'event-new', 'user', '2026-01-02');
    INSERT INTO memory_uses VALUES ('run', 'memory', 1);
    INSERT INTO memory_context_state VALUES ('conv', 1, 4);
    COMMIT;
    PRAGMA user_version = 2;
  `));
}

function seedV3Database(databasePath) {
  seedV2Database(databasePath);
  inspect(databasePath, db => db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE rooms_v3 (
      id TEXT PRIMARY KEY, channel TEXT NOT NULL, account TEXT NOT NULL, external_chat_id TEXT NOT NULL,
      room_type TEXT NOT NULL CHECK (room_type IN ('group', 'private')), UNIQUE (channel, account, room_type, external_chat_id)
    );
    INSERT INTO rooms_v3 SELECT id, channel, account, external_chat_id, 'private' FROM rooms;
    DROP TABLE rooms;
    ALTER TABLE rooms_v3 RENAME TO rooms;
    CREATE TABLE actors_v3 (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('local-owner', 'external-user')),
      room_id TEXT REFERENCES rooms(id), external_user_id TEXT, UNIQUE (room_id, external_user_id),
      CHECK ((kind = 'local-owner' AND room_id IS NULL AND external_user_id IS NULL)
        OR (kind = 'external-user' AND room_id IS NOT NULL AND external_user_id IS NOT NULL))
    );
    INSERT INTO actors_v3 (id, kind) SELECT id, kind FROM actors;
    DROP TABLE actors;
    ALTER TABLE actors_v3 RENAME TO actors;
    ALTER TABLE messages ADD COLUMN model_input_text TEXT;
    ALTER TABLE messages ADD COLUMN external_event_id TEXT;
    ALTER TABLE messages ADD COLUMN sender_name TEXT;
    CREATE UNIQUE INDEX external_message_per_conversation ON messages(conversation_id, external_event_id) WHERE external_event_id IS NOT NULL;
    CREATE TABLE deliveries_v3 (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      run_id TEXT NOT NULL UNIQUE REFERENCES agent_runs(id), message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
      channel TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'uncertain')),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, room_id TEXT NOT NULL REFERENCES rooms(id), external_message_id TEXT
    );
    INSERT INTO deliveries_v3 SELECT d.*, c.room_id, NULL FROM deliveries d JOIN conversations c ON c.id = d.conversation_id;
    DROP TABLE deliveries;
    ALTER TABLE deliveries_v3 RENAME TO deliveries;
    INSERT INTO rooms VALUES ('qq-room', 'qq', 'bot', 'group', 'group');
    INSERT INTO conversations VALUES ('qq-conv', 'qq-room', '/qq.jsonl');
    INSERT INTO actors VALUES ('qq-actor', 'external-user', 'qq-room', 'person');
    INSERT INTO messages (id, conversation_id, actor_id, role, text, created_at, model_input_text, external_event_id, sender_name)
      VALUES ('qq-user', 'qq-conv', 'qq-actor', 'user', '原来的个人信息', '2026-01-03', '原模型输入', 'qq-event', '名字');
    INSERT INTO memory_events VALUES ('qq-memory-event', 'qq-conv', 'qq-memory', 'remember', 1, '2026-01-03');
    INSERT INTO memories VALUES ('qq-memory', 'qq-conv', 'preference', '未确认范围的旧群记忆', 1, 'active', 'explicit_user', 'qq-memory-event', 'qq-user', '2026-01-03', '2026-01-03');
    INSERT INTO memory_revisions VALUES ('qq-memory', 1, '未确认范围的旧群记忆', 'active', 'qq-memory-event', 'qq-user', '2026-01-03');
    PRAGMA user_version = 3;
    COMMIT;
  `));
}

test('真实V3增量迁移保留所有业务列、rowid及审计，旧群记忆不自动共享，DDL失败回滚', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-memory-v3-'));
  const databasePath = join(directory, 'store.sqlite');
  seedV3Database(databasePath);
  const tables = ['actors', 'rooms', 'conversations', 'messages', 'agent_runs', 'deliveries',
    'memories', 'memory_events', 'memory_revisions', 'memory_uses', 'memory_context_state'];
  const columns = inspect(databasePath, db => tables.map(table => db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name)));
  const snapshot = () => inspect(databasePath, db => tables.map((table, index) => db.prepare(`SELECT rowid, ${columns[index].join(', ')} FROM ${table} ORDER BY rowid`).all()));
  const before = snapshot();
  let store;
  try {
    inspect(databasePath, db => db.exec('CREATE INDEX active_profile_per_writer ON memories(id);'));
    assert.throws(() => new ConversationStore(databasePath), /already exists/);
    assert.deepEqual(snapshot(), before);
    inspect(databasePath, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
      assert.deepEqual(tables.map(table => db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name)), columns);
      db.exec('DROP INDEX active_profile_per_writer;');
    });
    store = new ConversationStore(databasePath);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(store.queryMemories('qq-conv'), []);
    inspect(databasePath, db => assert.equal(db.prepare('SELECT content FROM memories WHERE id = ?').get('qq-memory').content, '未确认范围的旧群记忆'));
    assert.equal(store.queryMemories('conv')[0].revision, 2);
    assert.deepEqual(store.contextState('conv'), { required: true, generation: 4 });
    inspect(databasePath, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      assert.ok(db.prepare('SELECT message_kind FROM messages').all().every(row => row.message_kind === 'chat'));
      assert.ok(db.prepare('SELECT scope_type FROM memories').all().every(row => row.scope_type === 'legacy'));
    });
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('真实V2迁移保留记忆版本、来源、使用审计与pending重置标记，失败整笔回滚', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-memory-v2-'));
  const databasePath = join(directory, 'store.sqlite');
  seedV2Database(databasePath);
  const allTables = ['actors', 'rooms', 'conversations', 'messages', 'agent_runs', 'deliveries',
    'memories', 'memory_events', 'memory_revisions', 'memory_uses', 'memory_context_state'];
  const columns = inspect(databasePath, db => allTables.map(table => db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name)));
  const snapshot = () => inspect(databasePath, db => allTables.map((table, index) => db.prepare(`SELECT ${columns[index].join(', ')} FROM ${table} ORDER BY rowid`).all()));
  const before = snapshot();
  let store;
  try {
    // A preexisting migration-name table forces a failure after rooms have been replaced.
    inspect(databasePath, db => db.exec('CREATE TABLE actors_v3 (value TEXT);'));
    assert.throws(() => new ConversationStore(databasePath), /already exists/);
    assert.deepEqual(snapshot(), before);
    inspect(databasePath, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
      db.exec('DROP TABLE actors_v3;');
    });
    store = new ConversationStore(databasePath);
    assert.deepEqual(snapshot(), before);
    assert.equal(store.ensureConversation('legacy', '/legacy.jsonl').id, 'conv');
    assert.equal(store.queryMemories('conv')[0].content, '新版偏好');
    assert.equal(store.queryMemories('conv')[0].revision, 2);
    assert.deepEqual(store.contextState('conv'), { required: true, generation: 4 });
    const route = { channel: 'qq', accountId: 'bot', roomType: 'group', roomId: 'legacy' };
    const channel = store.ensureConversation('legacy', '/qq.jsonl', route);
    assert.deepEqual(store.queryMemories(channel.id), []);
    assert.throws(() => store.correctMemory(channel.id, 'memory', { content: '越界' }), MemoryError);
    inspect(databasePath, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      const deliveries = db.prepare('SELECT room_id FROM deliveries WHERE id = ?').get('delivery');
      assert.equal(deliveries.room_id, 'room');
    });
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('旧数据库已有断裂外键时拒绝迁移，不因复制JOIN丢弃原记录', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pa-memory-invalid-v1-'));
  const databasePath = join(directory, 'store.sqlite');
  seedV1Database(databasePath);
  try {
    inspect(databasePath, db => db.exec("PRAGMA foreign_keys = OFF; UPDATE deliveries SET conversation_id = 'missing';"));
    assert.throws(() => new ConversationStore(databasePath), /已有外键损坏/);
    inspect(databasePath, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
      assert.equal(db.prepare('SELECT conversation_id FROM deliveries WHERE id = ?').get('delivery').conversation_id, 'missing');
      assert.equal(db.prepare('PRAGMA table_info(rooms)').all().some(column => column.name === 'room_type'), false);
    });
  } finally { rmSync(directory, { recursive: true, force: true }); }
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

test('历史deleted fixture保持墓碑且不恢复；当前记忆纠正保留原文与修订', () => {
  const f = fixture();
  try {
    const sourceRun = f.store.beginRun(f.a.id, '原始聊天不能删除', 'p', 'm');
    f.store.failRun(sourceRun.id, 'failed', 'test', 'test');
    const memory = f.store.rememberMemory(f.a.id, { content: '第一份秘密正文', sourceMessageId: sourceRun.inputMessageId }).memory;
    const use = f.store.beginRun(f.a.id, 'use', 'p', 'm', [{ id: memory.id, revision: 1 }]);
    f.store.failRun(use.id, 'failed', 'test', 'test');
    const corrected = f.store.correctMemory(f.a.id, memory.id, { content: '第二份秘密正文', kind: 'episode' }, 1).memory;
    assert.deepEqual(f.store.queryMemories(f.a.id), [corrected]);
    inspect(f.databasePath, db => {
      assert.deepEqual(db.prepare('SELECT content FROM memory_revisions WHERE memory_id=? ORDER BY revision').all(memory.id).map(row=>row.content), ['第一份秘密正文','第二份秘密正文']);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_events').get().n, 2);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_uses').get().n, 1);
    });
    historicalDeleted(f.databasePath,memory.id);
    f.store.close();
    const reopened = new ConversationStore(f.databasePath);
    try {
      assert.deepEqual(reopened.queryMemories(f.a.id), []);
      assert.throws(() => reopened.correctMemory(f.a.id,memory.id,{content:'复活'}), /已删除/);
      inspect(f.databasePath,db=>assert.equal(db.prepare('SELECT content FROM memories WHERE id=?').get(memory.id).content,null));
      assert.equal(reopened.listMessages('a',10)[0].text,'原始聊天不能删除');
    } finally { reopened.close(); }
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
      assert.throws(() => f.store.correctMemory(f.b.id, id, { content: '越界' }), error => error instanceof MemoryError && /记忆不存在/.test(error.message));
      assert.throws(() => f.store.beginRun(f.b.id, '越界引用', 'p', 'm', [{ id, revision: 1 }]), error => error instanceof MemoryError && /记忆不存在/.test(error.message));
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
    historicalDeleted(f.databasePath,two.id);
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
    f.store.correctMemory(f.a.id, memory.id, {content:'fourth'});
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

function groupFixture() {
  const f = fixture();
  const route = { channel: 'qq', accountId: 'bot', roomType: 'group', roomId: 'group' };
  const group = f.store.ensureConversation('group', '/group.jsonl', route);
  const other = f.store.ensureConversation('other', '/other.jsonl', { ...route, roomId: 'other' });
  function source(conversationId, senderId, eventId = `${senderId}-${Math.random()}`) {
    f.store.recordInbound(conversationId, `${senderId}的明确自述`, { eventId, senderId, modelInputText: '原文', messageKind: 'memory' });
    return { ...f.store.externalMessage(conversationId, eventId), eventId };
  }
  return { ...f, route, group, other, source };
}

test('房间记忆来源限制，拒绝新的个人长期记忆目标', () => {
  const f = groupFixture();
  try {
    const owner = f.source(f.group.id, 'owner');
    const self = f.source(f.group.id, 'self');
    const room = f.store.rememberMemory(f.group.id, { content: '群内约定', sourceMessageId: owner.id }).memory;
    assert.equal(f.store.queryMemories(f.group.id)[0].id, room.id);
    assert.throws(() => f.store.rememberMemory(f.group.id, {
      content: '不应写入的个人长期习惯', subjectActorId: self.actorId, sourceMessageId: self.id,
    }), MemoryError);
    assert.equal(f.store.queryMemories(f.group.id).length, 1);
  } finally { f.cleanup(); }
});

test('QQ私聊拒绝房间记忆写入并隐藏历史房间记录', () => {
  const f = groupFixture();
  try {
    const privateRoute = { ...f.route, roomType: 'private', roomId: 'self' };
    const privateConversation = f.store.ensureConversation('qq-private', '/qq-private.jsonl', privateRoute);
    f.store.recordInbound(privateConversation.id, '私聊来源', {
      eventId: 'private-source', senderId: 'self', modelInputText: '显式记忆命令',
    });
    const privateSource = f.store.externalMessage(privateConversation.id, 'private-source');
    const groupOwner = f.source(f.group.id, 'owner');
    const legacyRoomMemory = f.store.rememberMemory(f.group.id, {
      content: '历史房间约定', sourceMessageId: groupOwner.id,
    }).memory;
    inspect(f.databasePath, db => {
      db.exec('BEGIN');
      db.prepare(`UPDATE memory_events SET conversation_id=?, actor_id=?, source_message_id=? WHERE memory_id=?`)
        .run(privateConversation.id, privateSource.actorId, privateSource.id, legacyRoomMemory.id);
      db.prepare(`UPDATE memories SET conversation_id=?, writer_actor_id=?, source_message_id=? WHERE id=?`)
        .run(privateConversation.id, privateSource.actorId, privateSource.id, legacyRoomMemory.id);
      db.prepare('UPDATE memory_revisions SET source_message_id=? WHERE memory_id=?')
        .run(privateSource.id, legacyRoomMemory.id);
      db.exec('COMMIT');
    });
    const snapshot = () => inspect(f.databasePath, db => ({
      memory: db.prepare(`SELECT id, conversation_id, scope_type, status, content, revision, source_message_id, writer_actor_id
        FROM memories WHERE id=?`).get(legacyRoomMemory.id),
      revisions: db.prepare('SELECT revision, content, status FROM memory_revisions WHERE memory_id=? ORDER BY revision')
        .all(legacyRoomMemory.id),
      events: db.prepare('SELECT conversation_id, actor_id, action, revision, source_message_id FROM memory_events WHERE memory_id=? ORDER BY revision')
        .all(legacyRoomMemory.id),
    }));
    const before = snapshot();
    assert.equal(before.memory.scope_type, 'room');
    assert.equal(before.memory.conversation_id, privateConversation.id);
    assert.equal(before.memory.source_message_id, privateSource.id);
    assert.equal(before.events[0].conversation_id, privateConversation.id);
    assert.equal(before.events[0].actor_id, privateSource.actorId);
    assert.equal(before.events[0].source_message_id, privateSource.id);

    assert.throws(() => f.store.rememberMemory(privateConversation.id, {
      content: '私聊不可绕过', sourceMessageId: privateSource.id,
    }), /个人长期记忆已停用/);
    assert.deepEqual(f.store.queryMemories(privateConversation.id), []);
    assert.throws(() => f.store.correctMemory(privateConversation.id, legacyRoomMemory.id, {
      content: '私聊不可纠正历史房间记录', sourceMessageId: privateSource.id,
    }, 1), /停用|不存在/);

    assert.deepEqual(f.store.queryMemories(f.group.id), []);
    assert.deepEqual(snapshot(), before);
  } finally { f.cleanup(); }
});

test('房间记忆时间元数据规范化、过期过滤与修订保留', () => {
  const f = groupFixture();
  try {
    const source = f.source(f.group.id, 'self');
    for (const value of ['tomorrow', '2026-02-30T00:00:00Z', '2026-01-01', 123, '2026-01-01T99:00:00Z']) {
      assert.throws(() => f.store.rememberMemory(f.group.id, { content: 'invalid', sourceMessageId: source.id, occurredAt: value }), MemoryError);
    }
    const memory = f.store.rememberMemory(f.group.id, {
      content: '限时房间约定', sourceMessageId: source.id,
      occurredAt: '2025-01-01T08:00:00+08:00', expiresAt: '2025-01-02T00:00:00Z',
    }).memory;
    assert.equal(memory.occurredAt, '2025-01-01T00:00:00.000Z');
    assert.deepEqual(f.store.queryMemories(f.group.id), []);
    assert.throws(() => f.store.beginRun(f.group.id, 'expired', 'p', 'm', [{ id: memory.id, revision: 1 }], {
      eventId: 'expired-ref', senderId: 'self', modelInputText: 'x',
    }), /失效/);
    const corrected = f.store.correctMemory(f.group.id, memory.id, { content: '保留时间', sourceMessageId: source.id }, 1).memory;
    assert.equal(corrected.occurredAt, memory.occurredAt);
    assert.equal(corrected.expiresAt, memory.expiresAt);
    const cleared = f.store.correctMemory(f.group.id, memory.id, { content: '永久', sourceMessageId: source.id, expiresAt: null }, 2).memory;
    assert.equal(cleared.expiresAt, null);
    f.store.correctMemory(f.group.id, memory.id, { content: '再次限时', sourceMessageId: source.id, expiresAt: '2025-01-01T00:00:00Z' }, 3);
    inspect(f.databasePath, db => {
      assert.deepEqual(db.prepare('SELECT content FROM memory_revisions WHERE memory_id=? ORDER BY revision')
        .all(memory.id).map(row => row.content), ['限时房间约定', '保留时间', '永久', '再次限时']);
    });
  } finally { f.cleanup(); }
});
test('真实V4增量迁移保留rowid/正文/修订/来源/使用与reset水位，V5 DDL冲突整笔回滚', () => {
  const f = fixture();
  let reopened;
  try {
    const memory = f.store.rememberMemory(f.a.id, { content: 'v4正文' }).memory;
    const run = f.store.beginRun(f.a.id, 'v4来源', 'p', 'm', [{ id: memory.id, revision: 1 }]);
    f.store.failRun(run.id, 'failed', 'test', 'test');
    f.store.correctMemory(f.a.id, memory.id, { content: 'v4第二版', sourceMessageId: run.inputMessageId }, 1);
    const route = { channel: 'qq', accountId: 'bot', roomType: 'group', roomId: 'v4-profiles' };
    const group = f.store.ensureConversation('v4-profiles', '/v4-profiles.jsonl', route);
    for (const senderId of ['self', 'owner']) f.store.recordInbound(group.id, senderId, { eventId: senderId, senderId, modelInputText: senderId });
    const self = f.store.externalMessage(group.id, 'self');
    const owner = f.store.externalMessage(group.id, 'owner');
    const legacyRows = {};
    for (const [profileField, writer, source] of [
      ['preferred_name', self, self], ['diet', owner, owner], ['interests', self, self], ['reply_style', owner, owner],
    ]) {
      legacyRows[profileField] = f.store.rememberMemory(group.id, {
        content: `v4历史${profileField}`, sourceMessageId: source.id,
      }).memory.id;
      inspect(f.databasePath, db => db.prepare(`UPDATE memories SET subject_actor_id=?,writer_actor_id=?,profile_field=?,scope_type='actor'
        WHERE id=?`).run(self.actorId, writer.actorId, profileField, legacyRows[profileField]));
    }
    f.store.close();
    let before;
    inspect(f.databasePath, db => {
      downgradeSchema10(db);
      db.exec(`PRAGMA foreign_keys=OFF;
        DROP TRIGGER history_message_insert; DROP TRIGGER history_message_update; DROP TRIGGER history_message_delete;
        DROP TABLE message_history_fts; DROP TABLE person_profile_pending; DROP TABLE profile_tool_receipts; DROP TABLE run_progress;
        DROP TRIGGER assign_message_sequence; DROP INDEX message_ingest_sequence; DROP TABLE message_ingest_order;
        ALTER TABLE messages DROP COLUMN ingest_seq; ALTER TABLE messages DROP COLUMN sent_at;
        DROP TABLE person_fragment_messages; DROP TABLE person_fragments; DROP TABLE topic_embeddings; DROP TABLE memory_topic_messages;
        DROP TABLE memory_topics; DROP TABLE auto_memory_job_messages; DROP TABLE auto_memory_jobs; DROP TABLE auto_memory_checkpoints;
        DROP TABLE person_profile_revisions; DROP TABLE actor_person_bindings; DROP TABLE person_bindings; DROP TABLE persons;
        DROP TABLE self_profile_pending; DROP TABLE self_profile_revisions;
        DROP TABLE delivery_parts; DROP INDEX delivery_conversation_identity;
        DROP INDEX active_person_profile; DROP INDEX memories_by_person; DROP INDEX active_profile_per_writer;
        DROP TABLE primary_person_bindings;
        ALTER TABLE memories DROP COLUMN person_id;
        ALTER TABLE memories DROP COLUMN occurred_at;
        ALTER TABLE memories DROP COLUMN expires_at;
        ALTER TABLE memories DROP COLUMN is_current;
        ALTER TABLE memories DROP COLUMN profile_source_self;
        ALTER TABLE memory_revisions DROP COLUMN occurred_at;
        ALTER TABLE memory_revisions DROP COLUMN expires_at;
        CREATE UNIQUE INDEX active_profile_per_writer ON memories(conversation_id, subject_actor_id, writer_actor_id, profile_field)
          WHERE status = 'active' AND profile_field IS NOT NULL;
        PRAGMA user_version = 4;`);
      db.prepare('UPDATE memories SET source_message_id = NULL WHERE id = ?').run(legacyRows.interests);
      before = Object.fromEntries(['memories', 'memory_revisions', 'memory_events', 'memory_uses', 'memory_context_state']
        .map(table => [table, db.prepare(`SELECT rowid, * FROM ${table}`).all().map(row => ({ ...row }))]));
      db.exec('CREATE TABLE primary_person_bindings (collision TEXT)');
    });
    assert.throws(() => new ConversationStore(f.databasePath), /already exists/);
    inspect(f.databasePath, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
      assert.ok(db.prepare('PRAGMA table_info(memories)').all().every(row => row.name !== 'person_id'));
      assert.deepEqual(db.prepare('SELECT rowid, * FROM memories').all().map(row => ({ ...row })), before.memories);
      db.exec('DROP TABLE primary_person_bindings');
    });
    reopened = new ConversationStore(f.databasePath);
    inspect(f.databasePath, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 12);
      for (const [table, rows] of Object.entries(before)) {
        const columns = Object.keys(rows[0]).join(', ');
        assert.deepEqual(db.prepare(`SELECT ${columns} FROM ${table}`).all().map(row => ({ ...row })), rows);
      }
      const migrated = db.prepare('SELECT person_id, occurred_at, expires_at, is_current FROM memories').get();
      assert.deepEqual({ ...migrated }, { person_id: null, occurred_at: null, expires_at: null, is_current: 1 });
      for (const [id, expected] of [[legacyRows.preferred_name, 1], [legacyRows.diet, 0], [legacyRows.interests, 0], [legacyRows.reply_style, 0]]) {
        assert.equal(db.prepare('SELECT profile_source_self FROM memories WHERE id = ?').get(id).profile_source_self, expected);
      }
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    });
    assert.equal(reopened.queryMemories(f.a.id)[0].content, 'v4第二版');
    assert.deepEqual(reopened.contextState(f.a.id), { required: true, generation: 1 });
    assert.deepEqual(reopened.queryMemories(group.id), []);
    assert.throws(() => reopened.correctMemory(group.id, legacyRows.diet, { content: '旧个人目标不能改为房间记忆', sourceMessageId: owner.id }), /记忆不存在/);
  } finally { reopened?.close(); f.cleanup(); }
});

test('显式房间记忆到期刷新已引用上下文，迟到回复留原文不重注入', () => {
  const f = groupFixture();
  try {
    const source = f.source(f.group.id, 'self');
    const memory = f.store.rememberMemory(f.group.id, { content: '临时房间约定',
      sourceMessageId: source.id, expiresAt: '2100-01-01T00:00:00Z' }).memory;
    f.store.ackContextReset(f.group.id, f.store.contextState(f.group.id).generation);
    const refs = [{ id: memory.id, revision: 1 }];
    const completed = f.store.beginRun(f.group.id, '已引用输入', 'p', 'm', refs, { eventId: 'used-a', senderId: 'self', modelInputText: 'x' });
    f.store.completeRun(completed.id, '临时记忆派生回复', 'pi-input', 'pi-assistant');
    const late = f.store.beginRun(f.group.id, '待恢复输入', 'p', 'm', refs, { eventId: 'used-b', senderId: 'self', modelInputText: 'x' });
    assert.deepEqual(f.store.contextMessages(f.group.id, 20, 'self').map(m => m.text), ['已引用输入', '临时记忆派生回复']);
    const before = f.store.contextState(f.group.id);
    inspect(f.databasePath, db => db.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', memory.id));
    assert.deepEqual(f.store.contextMessages(f.group.id, 20, 'self'), []);
    f.store.refreshExpiredContext(f.group.id);
    assert.deepEqual(f.store.contextState(f.group.id), { required: true, generation: before.generation + 1 });
    f.store.ackContextReset(f.group.id, before.generation + 1);
    f.store.refreshExpiredContext(f.group.id);
    assert.equal(f.store.contextState(f.group.id).generation, before.generation + 1);
    f.store.completeRun(late.id, '到期后迟到的派生回复', 'late-input', 'late-assistant', true);
    assert.deepEqual(f.store.contextMessages(f.group.id, 20, 'self'), []);
    assert.equal(f.store.listMessages(f.group.id, 20, f.route).some(m => m.text === '到期后迟到的派生回复'), true);
    f.store.recordInbound(f.group.id, '普通原文不识别时间', { eventId: 'plain-after', senderId: 'self', modelInputText: 'x' });
    assert.deepEqual(f.store.contextMessages(f.group.id, 20, 'self').map(m => m.text), ['普通原文不识别时间']);
    inspect(f.databasePath, db => {
      assert.equal(db.prepare('SELECT recovered FROM agent_runs WHERE id = ?').get(late.id).recovered, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_uses WHERE memory_id = ?').get(memory.id).n, 2);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    });
  } finally { f.cleanup(); }
});

test('到期刷新reset失败整体回滚，未引用记忆和已过水位的refs不触发新reset', () => {
  const f = fixture();
  try {
    const unused = f.store.rememberMemory(f.a.id, { content: 'unused expired', expiresAt: '2020-01-01T00:00:00Z' }).memory;
    f.store.refreshExpiredContext(f.a.id);
    assert.deepEqual(f.store.contextState(f.a.id), { required: false, generation: 0 });
    const memory = f.store.rememberMemory(f.a.id, { content: 'used', expiresAt: '2100-01-01T00:00:00Z' }).memory;
    const run = f.store.beginRun(f.a.id, 'used input', 'p', 'm', [{ id: memory.id, revision: 1 }]);
    f.store.completeRun(run.id, 'used response', undefined, undefined);
    inspect(f.databasePath, db => {
      db.prepare('UPDATE memories SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', memory.id);
      db.exec("CREATE TRIGGER fail_expiry_reset BEFORE INSERT ON memory_context_state BEGIN SELECT RAISE(ABORT, 'expiry reset failure'); END");
    });
    assert.throws(() => f.store.refreshExpiredContext(f.a.id), /expiry reset failure/);
    assert.deepEqual(f.store.contextState(f.a.id), { required: false, generation: 0 });
    inspect(f.databasePath, db => db.exec('DROP TRIGGER fail_expiry_reset'));
    f.store.refreshExpiredContext(f.a.id);
    assert.deepEqual(f.store.contextState(f.a.id), { required: true, generation: 1 });
    f.store.refreshExpiredContext(f.a.id);
    assert.equal(f.store.contextState(f.a.id).generation, 1);
  } finally { f.cleanup(); }
});
