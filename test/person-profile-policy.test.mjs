import { downgradeSchema14 } from './fixtures/legacy-schema.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { emptyExtraction } from './fixtures/memory-output.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pa-person-profile-policy-'));
  const path = join(dir, 'store.sqlite');
  let store = new ConversationStore(path);
  const route = { channel: 'qq', accountId: 'test', roomType: 'group', roomId: 'policy-room' };
  const room = store.ensureConversation('policy-room', '/policy-room.jsonl', route);
  let sequence = 0;
  return {
    dir, path, route, room,
    get store() { return store; },
    inbound(text, senderId = 'alice') {
      const external = { eventId: String(++sequence), senderId, modelInputText: text, sentAt: '2026-01-01T00:00:00Z' };
      store.recordInbound(room.id, text, external);
      return { ...external, existingMessageId: store.externalMessage(room.id, external.eventId).id };
    },
    inspect(fn) { const db = new DatabaseSync(path); try { return fn(db); } finally { db.close(); } },
    restart() { store.close(); store = new ConversationStore(path); },
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function batch(f) {
  f.store.autoMemory.reserveBatch(f.room.id, 'capacity');
  const job = f.store.autoMemory.claimNext(f.room.id, { owner: 'policy-test', leaseMs: 60000 });
  assert.ok(job);
  return { job, input: f.store.autoMemory.taskInput(job) };
}
function personFor(f, senderId = 'alice') {
  return f.store.autoMemory.personForActor(f.store.findActor(f.room.id, senderId));
}
function extract(input, profiles) {
  const updated = profiles.map(profile => {
    const baseline = input.profiles.find(item => item.personId === profile.personId);
    const updates = [];
    profile.facts.forEach((fact, factIndex) => {
      const baselineFactIndexes = baseline?.facts.flatMap((previous, index) => previous.content === fact.content
        && previous.sourceType === fact.sourceType ? [index] : []) ?? [];
      const evidence = fact.messageIds.flatMap(messageId => {
        const source = [...input.messages, ...(input.profileSources ?? [])].find(message => message.id === messageId);
        if (!source || source.role !== 'user' || !/^\s*(?:我|本人)/u.test(source.text)) return [];
        return [{ messageId, factQuote: source.text, subjectKind: 'self', subjectQuote: source.text.trim().startsWith('本人') ? '本人' : '我' }];
      });
      if (baselineFactIndexes.length || evidence.length) updates.push({ factIndex, baselineFactIndexes, evidence });
    });
    return { ...profile, updates };
  });
  return { ...emptyExtraction(input), profiles: updated };
}

test('v13 migration backup preserves archived legacy pending rows and current database advances to v23', () => {
  const f = fixture();
  try {
    const source = f.inbound('我喜欢读书，也有旧版已归档提醒');
    const personId = personFor(f);
    let current = batch(f);
    f.store.autoMemory.commit(current.job.id, current.job.leaseToken, extract(current.input, [{ personId, baseVersion: 0,
      facts: [{ content: '喜欢读书', sourceType: 'self', messageIds: [source.existingMessageId] }] }]));
    f.store.autoMemory.addProfilePending(personId, source.existingMessageId, '旧版已归档提醒', 'self');
    const archived = f.store.autoMemory.profile(personId).pending[0];
    f.inspect(db => db.prepare('UPDATE person_profile_pending SET archived_revision=1,archived_at=? WHERE id=?').run('2026-10-16T00:00:00Z', archived.id));
    f.store.close();
    f.inspect(db => {
      downgradeSchema14(db);db.exec('DROP TABLE person_profile_pending_results; DROP TABLE person_profile_revision_sources; PRAGMA user_version=13;');
    });
    f.restart();
    assert.equal(f.inspect(db => db.prepare('PRAGMA user_version').get().user_version),31);
    assert.deepEqual({ ...f.inspect(db => db.prepare('SELECT id,person_id,source_message_id,archived_revision,archived_at FROM person_profile_pending WHERE id=?').get(archived.id)) }, {
      id: archived.id, person_id: personId, source_message_id: source.existingMessageId, archived_revision: 1, archived_at: '2026-10-16T00:00:00Z',
    });
    const backups = readdirSync(f.dir).filter(name => name.includes('.v13.') && name.endsWith('.bak'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(f.dir, backups[0]), { readOnly: true });
    try {
      assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 13);
      assert.deepEqual({ ...backup.prepare('SELECT id,person_id,source_message_id,archived_revision,archived_at FROM person_profile_pending WHERE id=?').get(archived.id) }, {
        id: archived.id, person_id: personId, source_message_id: source.existingMessageId, archived_revision: 1, archived_at: '2026-10-16T00:00:00Z',
      });
      assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name='person_profile_pending_results'").get(), undefined);
      assert.deepEqual(backup.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { backup.close(); }
  } finally { f.close(); }
});
