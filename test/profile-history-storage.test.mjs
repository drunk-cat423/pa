import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { downgradeSchema10 } from './fixtures/legacy-schema.mjs';

function fixture(roomType = 'group') {
  const dir=mkdtempSync(join(tmpdir(),'pa-profile-history-')); const path=join(dir,'store.sqlite');
  let store=new ConversationStore(path); let event=0;
  const route={channel:'qq',accountId:'test',roomType,roomId:'one'};
  const room=store.ensureConversation('one','/one.jsonl',route);
  return {dir,path,route,room,get store(){return store;},
    inbound(text,senderId='alice',conversation=room,sentAt) {
      const external={eventId:String(++event),senderId,senderName:senderId.toUpperCase(),modelInputText:text,...(sentAt?{sentAt}:{})};
      store.recordInbound(conversation.id,text,external);
      return {...external,existingMessageId:store.externalMessage(conversation.id,external.eventId).id};
    },
    turn(text,senderId='alice') {
      const external=this.inbound(text,senderId); const run=store.beginRun(room.id,text,'p','m',[],external);
      const delivery=store.completeRun(run.id,'收到，这是原始回复。',undefined,undefined);store.ackDelivery(delivery.deliveryId,'sent');return run;
    },
    inspect(fn){const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}},
    restart(){store.close();store=new ConversationStore(path);},
    close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
function addPending(f, conversationId, sourceId, _legacyCallId, target, content, sourceType='third_party') {
  if(target==='ai_self') return f.store.autoMemory.selfProfile.addPending(sourceId,content);
  const source=f.inspect(db=>db.prepare('SELECT actor_id FROM messages WHERE id=? AND conversation_id=?').get(sourceId,conversationId));
  return f.store.autoMemory.addProfilePending(f.store.autoMemory.ensureActorPerson(source.actor_id),sourceId,content,sourceType);
}
function batch(f) { f.store.autoMemory.reserveBatch(f.room.id,'capacity');return f.store.autoMemory.claimNext(f.room.id,{owner:'test',leaseMs:60000,pipeline:'legacy'}); }

test('v8 migration backs up and preserves archived legacy field metadata, identities, queued snapshot and FTS backfill',()=>{
  const f=fixture();try {
    const old=f.inbound('迁移前喜欢火锅；你的名字叫 PA');const actor=f.store.findActor(f.room.id,'alice');const person=f.store.autoMemory.personForActor(actor);
    const job=batch(f);const input=f.store.autoMemory.taskInput(job);f.store.autoMemory.fail(job.id,job.leaseToken,'offline');
    addPending(f,f.room.id,old.existingMessageId,'legacy-ai-name','ai_self','你的名字叫 PA');
    // Seed the archived legacy state directly: this snapshot predates the current AI attribution protocol.
    f.inspect(db=>db.prepare(`UPDATE self_profile_pending SET archived_revision=(SELECT revision FROM self_profile_revisions ORDER BY revision DESC LIMIT 1),archived_at=? WHERE source_message_id=?`)
      .run('2026-10-16T00:00:00Z',old.existingMessageId));
    const style=f.inbound('回复要简洁');addPending(f,f.room.id,style.existingMessageId,'legacy-ai-style','ai_self','回复要简洁');
    const selfRows=f.inspect(db=>db.prepare('SELECT * FROM self_profile_pending ORDER BY id').all().map(row=>({...row})));
    const frozenBeforeMigration=f.inspect(db=>{
      downgradeSchema10(db);
      db.prepare('UPDATE persons SET revision=1 WHERE id=?').run(person);
      db.prepare('INSERT INTO person_profile_revisions VALUES (?,1,?,NULL,?)').run(person,JSON.stringify([{field:'diet',content:'喜欢火锅',sourceType:'self',messageIds:[old.existingMessageId]}]),new Date().toISOString());
      const legacy={...input,profiles:input.profiles.map(p=>({personId:p.personId,baseVersion:p.baseVersion,facts:p.facts}))};delete legacy.profileSources;
      db.prepare('UPDATE auto_memory_jobs SET input_json=? WHERE id=?').run(JSON.stringify(legacy),job.id);
      db.exec(`CREATE TABLE self_profile_pending_v8 (
        id TEXT PRIMARY KEY,content TEXT NOT NULL,source_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
        created_at TEXT NOT NULL,archived_revision INTEGER REFERENCES self_profile_revisions(revision),archived_at TEXT);
        INSERT INTO self_profile_pending_v8 SELECT * FROM self_profile_pending;
        DROP TABLE self_profile_pending; ALTER TABLE self_profile_pending_v8 RENAME TO self_profile_pending;
        CREATE INDEX active_self_profile_pending ON self_profile_pending(archived_revision);
        DROP TRIGGER history_message_insert; DROP TRIGGER history_message_update; DROP TRIGGER history_message_delete;
        DROP TABLE message_history_fts; DROP TABLE person_profile_pending; DROP TABLE profile_tool_receipts; DROP TABLE run_progress; PRAGMA user_version=8;`);
      return db.prepare('SELECT input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id);
    });
    f.restart();assert.ok(readdirSync(f.dir).some(name=>name.includes('.v8.')&&name.endsWith('.bak')));
    assert.deepEqual(f.inspect(db=>db.prepare('SELECT * FROM self_profile_pending ORDER BY id').all().map(row=>({...row}))),selfRows);
    assert.equal(f.store.autoMemory.selfProfile.snapshot().pending[0].sourceMessageId,style.existingMessageId);
    addPending(f,f.room.id,old.existingMessageId,'repeat-archived','ai_self','你的名字叫 PA');
    assert.equal(f.store.autoMemory.selfProfile.snapshot().pending.length,1);
    assert.equal(f.store.autoMemory.personForActor(actor),person);assert.equal(f.store.autoMemory.profile(person).facts[0].field,'diet');assert.equal(f.store.autoMemory.profile(person).pending.length,0);
    assert.throws(()=>f.store.autoMemory.retry(job.id),/隔离|退役|重试/);
    assert.equal(f.store.autoMemory.claimNext(f.room.id,{owner:'retry',leaseMs:60000,pipeline:'legacy'}),undefined);
    assert.deepEqual(f.inspect(db=>db.prepare('SELECT input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id)),frozenBeforeMigration);
    const current=f.inbound('查询历史');assert.equal(f.store.readHistory(f.room.id,current.existingMessageId,{query:'火锅'}).messages[0].id,old.existingMessageId);
    assert.equal(f.inspect(db=>db.prepare('PRAGMA user_version').get().user_version),33);assert.deepEqual(f.inspect(db=>db.prepare('PRAGMA foreign_key_check').all()),[]);
  }finally{f.close();}
});
