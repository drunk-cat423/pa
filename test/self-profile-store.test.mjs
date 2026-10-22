import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
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
      assert.equal(db.prepare('PRAGMA user_version').get().user_version,27);
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
