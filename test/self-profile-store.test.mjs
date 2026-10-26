import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { memoryWords } from '../dist/memory-text.js';
import { downgradeSchema10 } from './fixtures/legacy-schema.mjs';

const sourceTexts = new Map();

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'pa-self-profile-'));
  const path = join(directory, 'store.sqlite');
  let store = new ConversationStore(path);
  const rooms = ['one', 'two'].map(id => store.ensureConversation(id, `/${id}.jsonl`, {
    channel: 'qq', accountId: 'test', roomType: 'group', roomId: id,
  }));
  let event = 0;
  return { directory, path, rooms, get store() { return store; },
    inbound(text, room = rooms[0], senderId = 'member') {
      if (!text.startsWith('你')) text = `你以后回复时参考：${text}`;
      const external = { eventId: String(++event), senderId, modelInputText: text };
      store.recordInbound(room.id, text, external);
      const existingMessageId = store.externalMessage(room.id, external.eventId).id;
      sourceTexts.set(existingMessageId, text);
      return { ...external, existingMessageId };
    },
    claim(room = rooms[0]) {
      store.autoMemory.reserveBatch(room.id, 'capacity');
      return store.autoMemory.claimNext(room.id, { owner: 'test', leaseMs: 60000 });
    },
    restart() { store.close(); store = new ConversationStore(path); },
    close() { store.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
function inspect(f, operation) {
  const db = new DatabaseSync(f.path);
  try { return operation(db); } finally { db.close(); }
}

test('AI画像可归纳当前真人确认，归档不要求重复原话或AI关键词', () => {
  const f = fixture();
  try {
    const text = '可以，就按你说的来';
    f.store.recordInbound(f.rooms[0].id, text, { eventId: 'confirmation', senderId: 'member', modelInputText: text });
    const source = f.store.externalMessage(f.rooms[0].id, 'confirmation').id;
    const content = '长期关注何为生命第一因';
    const receipt = f.store.prepareTurn(f.rooms[0].id, source,
      { intent: 'memory_update', mode: 'casual', updates: [{ target: 'ai_self', content }] },
      { version: 1, ownerBindings: [] });
    assert.deepEqual(receipt.saved, [{ target: 'ai_self', status: 'saved_pending' }]);
    const snapshot = f.store.autoMemory.selfProfile.snapshot();
    assert.equal(snapshot.pending[0].content, content);
    assert.equal(snapshot.pending[0].sourceMessageId, source);
    f.store.autoMemory.selfProfile.commit(snapshot, { protocol: 2, baseVersion: snapshot.baseVersion,
      content, pendingIds: snapshot.pending.map(item => item.id), updates: [] }, []);
    assert.equal(f.store.autoMemory.selfProfile.snapshot().content, content);
    assert.deepEqual(f.store.autoMemory.selfProfile.snapshot().pending, []);
    assert.equal(inspect(f, db => db.prepare('SELECT text FROM messages WHERE id=?').get(source)).text, text);
    assert.equal(inspect(f, db => db.prepare('SELECT message_id,evidence_json FROM self_profile_update_sources WHERE message_id=?').get(source)).evidence_json, null);
    assert.throws(() => f.store.autoMemory.selfProfile.addPending('missing', content), /原始真人/);
    const fakeSource = 'assistant-only';
    inspect(f, db => {
      db.function('history_tokens', { deterministic: true }, value => memoryWords(String(value ?? '')).join(' '));
      db.prepare("INSERT INTO messages(id,conversation_id,role,text,created_at,message_kind) VALUES(?,?,'assistant',?,?,'chat')")
        .run(fakeSource, f.rooms[0].id, '我建议长期关注这个问题', '2026-01-01T00:00:00Z');
    });
    assert.throws(() => f.store.autoMemory.selfProfile.addPending(fakeSource, content), /原始真人/);
  } finally { f.close(); }
});

test('本地审阅AI画像执行CAS并保留历史来源与待整理建议', () => {
  const f = fixture();
  try {
    const first = f.inbound('请长期关注数理逻辑');
    f.store.autoMemory.selfProfile.addPending(first.existingMessageId, '长期关注数理逻辑');
    const pending = f.store.autoMemory.selfProfile.snapshot();
    f.store.autoMemory.selfProfile.commit(pending, { protocol: 2, baseVersion: pending.baseVersion,
      content: '旧的AI画像正文', pendingIds: pending.pending.map(item => item.id), updates: [] }, []);

    const activeSource = f.inbound('以后回答尽量简短');
    f.store.autoMemory.selfProfile.addPending(activeSource.existingMessageId, '回答详略偏好待整理');
    const before = f.store.autoMemory.selfProfile.snapshot();
    const oldRows = inspect(f, db => ({
      revision: db.prepare('SELECT * FROM self_profile_revisions WHERE revision=?').get(before.baseVersion),
      updates: db.prepare('SELECT * FROM self_profile_updates WHERE revision=?').all(before.baseVersion),
      sources: db.prepare(`SELECT s.message_id,s.pending_id,s.evidence_json FROM self_profile_update_sources s
        JOIN self_profile_updates u ON u.id=s.update_id WHERE u.revision=?`).all(before.baseVersion),
      pending: db.prepare('SELECT * FROM self_profile_pending WHERE id=?').get(before.pending[0].id),
    }));
    assert.throws(() => f.store.autoMemory.selfProfile.review(before.baseVersion, 'stale body', '整理后的AI画像'), /正文已变化/);
    assert.throws(() => f.store.autoMemory.selfProfile.review(before.baseVersion - 1, before.content, '整理后的AI画像'), /版本冲突/);
    assert.throws(() => f.store.autoMemory.selfProfile.review(before.baseVersion, before.content, '   '), /正文无效/);
    assert.throws(() => f.store.autoMemory.selfProfile.review(before.baseVersion, before.content, '界'.repeat(4001)), /正文无效/);

    // Duplicate source tuples and NULL pending IDs remain safe when copied.
    inspect(f, db => {
      const updateId = db.prepare('SELECT id FROM self_profile_updates WHERE revision=?').get(before.baseVersion).id;
      db.prepare('INSERT INTO self_profile_update_sources(update_id,message_id,pending_id) VALUES (?,?,?)')
        .run(updateId, oldRows.sources[0].message_id, oldRows.sources[0].pending_id);
      db.prepare('INSERT INTO self_profile_update_sources(update_id,message_id,pending_id) VALUES (?, ?, NULL)')
        .run(updateId, oldRows.sources[0].message_id);
    });
    const reviewed = f.store.autoMemory.selfProfile.review(before.baseVersion, before.content, '整理后的AI画像');
    assert.equal(reviewed.beforeVersion, before.baseVersion);
    assert.equal(reviewed.afterVersion, before.baseVersion + 1);
    assert.ok(reviewed.beforeBytes > 0);
    assert.ok(reviewed.afterBytes > 0);
    assert.equal(f.store.autoMemory.selfProfile.snapshot().content, '整理后的AI画像');
    assert.deepEqual(f.store.autoMemory.selfProfile.snapshot().pending, before.pending);
    assert.deepEqual(inspect(f, db => db.prepare('SELECT * FROM self_profile_revisions WHERE revision=?').get(before.baseVersion)), oldRows.revision);
    assert.deepEqual(inspect(f, db => db.prepare('SELECT * FROM self_profile_updates WHERE revision=?').all(before.baseVersion)), oldRows.updates);
    assert.deepEqual(inspect(f, db => db.prepare('SELECT * FROM self_profile_pending WHERE id=?').get(before.pending[0].id)), oldRows.pending);
    const copied = inspect(f, db => db.prepare(`SELECT s.message_id,s.pending_id,s.evidence_json FROM self_profile_update_sources s
      JOIN self_profile_updates u ON u.id=s.update_id WHERE u.revision=? ORDER BY s.message_id,s.pending_id`).all(reviewed.afterVersion));
    assert.deepEqual(copied.map(({ message_id, pending_id }) => [message_id, pending_id]),
      [[oldRows.sources[0].message_id, null], [oldRows.sources[0].message_id, oldRows.sources[0].pending_id]]);
    assert.ok(copied.every(row => row.evidence_json === null));
    assert.equal(inspect(f, db => db.prepare('SELECT kind,job_id FROM self_profile_updates WHERE revision=?').get(reviewed.afterVersion).kind), 'proposal');

    const noOp = f.store.autoMemory.selfProfile.review(reviewed.afterVersion, '整理后的AI画像', '整理后的AI画像');
    assert.equal(noOp.afterVersion, noOp.beforeVersion);
    assert.equal(noOp.afterBytes, noOp.beforeBytes);
    assert.equal(inspect(f, db => db.prepare('SELECT COUNT(*) AS n FROM self_profile_updates').get().n), 2);
    assert.equal(inspect(f, db => db.prepare('SELECT text FROM messages WHERE id=?').get(first.existingMessageId).text), first.modelInputText);
    assert.equal(inspect(f, db => db.prepare('SELECT text FROM messages WHERE id=?').get(activeSource.existingMessageId).text), activeSource.modelInputText);
    const ruleSource=f.inbound('你以后在本群默认简短回答');
    f.store.autoMemory.selfProfile.addPending(ruleSource.existingMessageId,ruleSource.modelInputText);
    const rule=f.store.autoMemory.selfProfile.snapshot().pending.find(item=>item.sourceMessageId===ruleSource.existingMessageId);
    const moved=f.store.reclassifySelfProfileTerms([{pendingId:rule.id,expectedContent:rule.content,key:'default-detail'}],
      {version:1,ownerBindings:[{route:{channel:'qq',accountId:'test',roomType:'group',roomId:'one'},senderId:'member'}]},reviewed.afterVersion);
    assert.equal(moved.revision,reviewed.afterVersion+1);
    const finalSources=inspect(f,db=>db.prepare(`SELECT s.message_id,s.pending_id,s.evidence_json FROM self_profile_update_sources s
      JOIN self_profile_updates u ON u.id=s.update_id WHERE u.revision=? ORDER BY s.message_id,s.pending_id`).all(moved.revision));
    assert.deepEqual(finalSources,copied,'moving a group rule must retain archived AI sources on the final projection revision');
    assert.deepEqual(f.store.autoMemory.selfProfile.snapshot().pending,before.pending);
  } finally { f.close(); }
});

test('本地AI画像审阅拒绝在途与等待自动恢复的资料任务及超容量正文', () => {
  const f = fixture();
  try {
    const source = f.inbound('长期关注系统设计');
    f.store.autoMemory.selfProfile.addPending(source.existingMessageId, '长期关注系统设计');
    const pending = f.store.autoMemory.selfProfile.snapshot();
    f.store.autoMemory.selfProfile.commit(pending, { protocol: 2, baseVersion: pending.baseVersion,
      content: '当前AI画像', pendingIds: pending.pending.map(item => item.id), updates: [] }, []);
    const before = f.store.autoMemory.selfProfile.snapshot();
    f.store.autoMemory.reserveMaterialsIfDue(f.rooms[0].id, 1000);
    assert.ok(f.store.autoMemory.reserveMaterialsIfDue(f.rooms[0].id, 601000));
    const running = f.store.autoMemory.claimNext(f.rooms[0].id, { owner: 'self-review-test', leaseMs: 60000, pipeline: 'materials' });
    assert.throws(() => f.store.autoMemory.selfProfile.review(before.baseVersion, before.content, '新正文'), /待处理或运行中的资料任务/);
    f.store.autoMemory.fail(running.id, running.leaseToken, 'model_request test failure');
    assert.throws(() => f.store.autoMemory.selfProfile.review(before.baseVersion, before.content, '新正文'), /等待自动恢复/);

    const clean = fixture();
    try {
      const seed = clean.inbound('请整理AI画像');
      clean.store.autoMemory.selfProfile.addPending(seed.existingMessageId, '待整理提议');
      const initial = clean.store.autoMemory.selfProfile.snapshot();
      clean.store.autoMemory.selfProfile.commit(initial, { protocol: 2, baseVersion: initial.baseVersion,
        content: '当前AI画像', pendingIds: initial.pending.map(item => item.id), updates: [] }, []);
      for (let i = 0; i < 16; i++) {
        const item = clean.inbound(`建议${i}`);
        clean.store.autoMemory.selfProfile.addPending(item.existingMessageId, '待整理'.repeat(80));
      }
      const full = clean.store.autoMemory.selfProfile.snapshot();
      assert.throws(() => clean.store.autoMemory.selfProfile.review(full.baseVersion, full.content, '😀'.repeat(3000)), /容量上限/);
    } finally { clean.close(); }
  } finally { f.close(); }
});

test('v6 migration backs up original data and preserves frozen job input while isolating its old lease', () => {
  const f = fixture();
  try {
    const source = f.inbound('original chat');
    f.store.rememberMemory(f.rooms[0].id, { content: 'retained', sourceMessageId: source.existingMessageId });
    const job = f.claim();
    const oldInput = f.store.autoMemory.taskInput(job);
    delete oldInput.selfProfile;
    f.store.close();
    const tables = ['messages', 'memories', 'memory_revisions', 'memory_events', 'persons', 'actor_person_bindings', 'auto_memory_jobs', 'auto_memory_job_messages'];
    const before = inspect(f, db => {
      downgradeSchema10(db);
      db.exec(`PRAGMA foreign_keys=OFF;
        DROP TRIGGER history_message_insert; DROP TRIGGER history_message_update; DROP TRIGGER history_message_delete;
        DROP TABLE message_history_fts; DROP TABLE person_profile_pending; DROP TABLE profile_tool_receipts; DROP TABLE run_progress;
        DROP TABLE self_profile_pending; DROP TABLE self_profile_revisions;
        DROP TABLE delivery_parts; DROP INDEX delivery_conversation_identity;
        UPDATE memories SET content=NULL,status='deleted'; UPDATE memory_revisions SET content=NULL,status='deleted'; PRAGMA user_version=6;`);
      db.prepare('UPDATE auto_memory_jobs SET input_json=? WHERE id=?').run(JSON.stringify(oldInput), job.id);
      return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT rowid,* FROM ${table}`).all().map(r => ({ ...r }))]));
    });
    f.restart();
    inspect(f, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version,33);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
      for (const table of tables) assert.deepEqual(db.prepare(`SELECT rowid,* FROM ${table}`).all().map(({image_failure: _failure,...r}) => ({ ...r })), before[table]);
    });
    const backups = readdirSync(f.directory).filter(name => name.includes('.v6.') && name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(f.directory, backups[0]));
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 6);
      assert.equal(backup.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='self_profile_revisions'").get().n, 0);
      for (const table of tables) assert.deepEqual(backup.prepare(`SELECT rowid,* FROM ${table}`).all().map(r => ({ ...r })), before[table]);
    } finally { backup.close(); }
    assert.equal(f.store.externalMessage(f.rooms[0].id, source.eventId).id, source.existingMessageId);
    const frozen = inspect(f, db => db.prepare('SELECT input_json FROM auto_memory_jobs WHERE id=?').get(job.id));
    assert.equal(frozen.input_json, JSON.stringify(oldInput));
    assert.equal(JSON.parse(frozen.input_json).selfProfile, undefined);
    assert.throws(() => f.store.autoMemory.taskInput(job), /租约已失效/);
    assert.throws(() => f.store.autoMemory.retry(job.id), /隔离/);
    assert.equal(f.store.autoMemory.status(f.rooms[0].id).isolated, 1);
    assert.equal(f.store.autoMemory.listJobs().find(item => item.id === job.id).isolated, true);
  } finally { f.close(); }
});
