import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { downgradeSchema11 } from './fixtures/legacy-schema.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pa-delivery-parts-'));
  const path = join(directory, 'pa.sqlite');
  let store = new ConversationStore(path);
  const route = { channel: 'qq', accountId: 'account', roomType: 'group', roomId: 'group' };
  const a = store.ensureConversation('A', '/pi/a.jsonl', route);
  const b = store.ensureConversation('B', '/pi/b.jsonl', { ...route, roomId: 'other' });
  const run = store.beginRun(a.id, '问题', 'p', 'm', [], { eventId: 'input', senderId: 'member', modelInputText: '问题' });
  const delivery = store.completeRun(run.id, '**完整原文**', undefined, undefined);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, path, get store() { return store; }, a, b, deliveryId: delivery.deliveryId,
    reopen() { store.close(); store = new ConversationStore(path); return store; },
    inspect(operation) { const db = new DatabaseSync(path); try { return operation(db); } finally { db.close(); } } };
}

test('last receipt and parent completion are atomic; cross-conversation child references fail', t => {
  const f = fixture(t);
  f.store.prepareDeliveryParts(f.a.id, f.deliveryId, ['实际文本']);
  f.store.beginDeliveryPart(f.a.id, f.deliveryId, 0);
  f.inspect(db => db.exec(`CREATE TRIGGER prevent_completion BEFORE UPDATE OF status ON deliveries
    WHEN NEW.status='sent' BEGIN SELECT RAISE(ABORT, 'fixture parent failure'); END;`));
  assert.throws(() => f.store.ackDeliveryPart(f.a.id, f.deliveryId, 0, 'sent', 'real-id'), /fixture parent failure/);
  assert.equal(f.inspect(db => db.prepare('SELECT status FROM delivery_parts').get().status), 'sending');
  assert.equal(f.inspect(db => db.prepare('SELECT status FROM deliveries').get().status), 'pending');
  f.inspect(db => db.exec('DROP TRIGGER prevent_completion'));
  f.store.ackDeliveryPart(f.a.id, f.deliveryId, 0, 'sent', 'real-id');
  // Parent and child have the same ID, but quote resolution returns the actual transmitted part once.
  assert.deepEqual(f.store.quotedMessage(f.a.id, 'real-id'), { role: 'assistant', text: '实际文本', sourceMessageId:f.inspect(db=>db.prepare('SELECT message_id FROM deliveries WHERE id=?').get(f.deliveryId).message_id) });
  f.inspect(db => {
    db.exec('PRAGMA foreign_keys=ON');
    assert.throws(() => db.prepare(`INSERT INTO delivery_parts
      (delivery_id,conversation_id,part_index,text,status,external_message_id,created_at,updated_at)
      VALUES (?, ?, 1, 'foreign', 'pending', NULL, 'now', 'now')`)
      .run(f.deliveryId, f.b.id), /FOREIGN KEY/);
  });
});

test('v7 migration creates a consistent backup and preserves legacy replies and unrelated records', t => {
  const f = fixture(t);
  f.store.ackDelivery(f.deliveryId, 'sent', 'legacy-id');
  f.store.close();
  f.inspect(db => {
    downgradeSchema11(db);
    db.exec(`DROP TRIGGER history_message_insert; DROP TRIGGER history_message_update; DROP TRIGGER history_message_delete;
      DROP TABLE message_history_fts; DROP TABLE run_progress; DROP TABLE profile_tool_receipts; DROP TABLE person_profile_pending;
      DROP TABLE channel_tasks; DROP INDEX message_conversation_identity;
      DROP INDEX one_running_run_per_session; DROP INDEX one_running_run_per_conversation;
      ALTER TABLE agent_runs DROP COLUMN pi_session_file;
      CREATE UNIQUE INDEX one_running_run_per_conversation ON agent_runs(conversation_id) WHERE status='running';
      DROP TABLE delivery_parts; DROP INDEX delivery_conversation_identity; PRAGMA user_version=7;`);
  });
  f.reopen();
  assert.equal(f.inspect(db => db.prepare('PRAGMA user_version').get().user_version),23);
  assert.deepEqual(f.store.quotedMessage(f.a.id, 'legacy-id'), { role: 'assistant', text: '**完整原文**', sourceMessageId:f.inspect(db=>db.prepare('SELECT message_id FROM deliveries WHERE id=?').get(f.deliveryId).message_id) });
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM messages').get().n), 2);
  const backups = readdirSync(f.directory).filter(name => name.includes('.v7.') && name.endsWith('.bak'));
  assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(f.directory, backups[0]));
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 7);
    assert.equal(backup.prepare('SELECT count(*) n FROM messages').get().n, 2);
    assert.deepEqual(backup.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { backup.close(); }
});
