import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { MEMORY_IDLE_MS, MEMORY_MAX_WAIT_MS } from '../dist/memory-schedule.js';
import { emptyExtraction } from './fixtures/memory-output.mjs';
import { downgradeSchema20 } from './fixtures/legacy-schema.mjs';

function fixture(t,roomType='group') {
  const directory=mkdtempSync(join(tmpdir(),'pa-material-store-')),path=join(directory,'fixture.sqlite');
  let store=new ConversationStore(path),event=0;
  const room=store.ensureConversation('materials','/fixture/session.jsonl',{channel:'qq',accountId:'test',roomType,roomId:'materials'});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {path,room,get store(){return store;},
    inbound(text='new material') {
      const external={eventId:String(++event),senderId:'alice',modelInputText:text};
      store.recordInbound(room.id,text,external);
      return {...external,existingMessageId:store.externalMessage(room.id,external.eventId).id};
    },
    observe(now){return store.autoMemory.reserveMaterialsIfDue(room.id,now);},
    schedule(){return store.autoMemory.materialSchedule(room.id);},
    claim(pipeline='materials'){return store.autoMemory.claimNext(room.id,{owner:'fixture',leaseMs:60000,pipeline});},
    input(job){return store.autoMemory.taskInput(job);},
    commit(job,output){store.autoMemory.commit(job.id,job.leaseToken,output??emptyExtraction(store.autoMemory.taskInput(job)));},
    inspect(fn){const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}},
    restart(mutate){store.close();if(mutate)this.inspect(mutate);store=new ConversationStore(path);},
    pending(source,content='喜欢茶') {
      const person=store.autoMemory.personForActor(store.findActor(room.id,'alice'));
      store.autoMemory.addProfilePending(person,source.existingMessageId,content,'self');
      return store.autoMemory.profile(person).pending.at(-1);
    },
  };
}

test('idle timer is durable, unchanged by polling or duplicate events, and does not repeat without new material',t=>{
  const f=fixture(t),source=f.inbound();
  assert.ok(f.store.autoMemory.pendingConversations().includes(f.room.id));
  assert.equal(f.observe(1000),undefined);
  assert.equal(f.observe(200000),undefined);
  assert.equal(f.store.recordInbound(f.room.id,'new material',source),false);
  assert.equal(f.schedule().lastContentAt,1000);
  f.restart();
  assert.equal(f.schedule().firstContentAt,1000);
  assert.equal(f.observe(1000+MEMORY_IDLE_MS-1),undefined);
  const reserved=f.observe(1000+MEMORY_IDLE_MS);
  assert.equal(reserved.reason,'idle');assert.equal(reserved.pipeline,'materials');
  assert.equal(f.schedule().firstContentAt,undefined);assert.equal(f.schedule().lastContentAt,undefined);
  const job=f.claim();f.commit(job);
  assert.equal(f.observe(1000+MEMORY_MAX_WAIT_MS*2),undefined);
  assert.equal(f.store.autoMemory.pendingConversations().includes(f.room.id),false);
  assert.equal(f.store.autoMemory.status(f.room.id,'materials').completed,1);
  assert.equal(f.store.autoMemory.conversationContext(f.room.id).messages.length,1);
});

test('continuous content triggers the independent thirty minute deadline and resets both clocks',t=>{
  const f=fixture(t);f.inbound();f.observe(0);
  for(let now=300000;now<MEMORY_MAX_WAIT_MS;now+=300000) {f.inbound(String(now));assert.equal(f.observe(now),undefined);}
  assert.equal(f.observe(MEMORY_MAX_WAIT_MS).reason,'interval');
  assert.equal(f.schedule().firstContentAt,undefined);assert.equal(f.schedule().lastContentAt,undefined);
});

test('content during execution owns the next durable window and only materials order blocks its claim',t=>{
  const f=fixture(t);f.inbound('first');f.observe(0);const firstReserved=f.observe(MEMORY_IDLE_MS),first=f.claim();
  f.inbound('second');f.observe(MEMORY_IDLE_MS+1);
  f.restart();
  assert.equal(f.schedule().firstContentAt,MEMORY_IDLE_MS+1);
  const secondReserved=f.observe(MEMORY_IDLE_MS*2+1);
  assert.notEqual(secondReserved.id,firstReserved.id);
  assert.equal(f.claim(),undefined);
  f.commit(first);
  const second=f.claim();assert.equal(second.id,secondReserved.id);
  assert.deepEqual(f.input(second).messages.map(message=>message.text),['second']);f.commit(second);
  assert.equal(f.store.autoMemory.status(f.room.id,'materials').completed,2);
});

test('successful callback cannot clear a newer in-flight schedule',t=>{
  const f=fixture(t);f.inbound();f.observe(0);f.observe(MEMORY_IDLE_MS);const first=f.claim();
  f.inbound('new during call');f.observe(MEMORY_IDLE_MS+20);
  f.commit(first);
  assert.equal(f.schedule().firstContentAt,MEMORY_IDLE_MS+20);
  assert.equal(f.observe(MEMORY_IDLE_MS*2+20).reason,'idle');
});

test('pending is observed separately from its old source and reservation cannot consume later pending',t=>{
  const f=fixture(t),source=f.inbound('我喜欢茶，也希望你以后回答简洁一点');f.observe(0);f.observe(MEMORY_IDLE_MS);
  const later=f.pending(source);f.store.autoMemory.selfProfile.addPending(source.existingMessageId,'你以后回答简洁一点');
  const first=f.claim(),input=f.input(first);
  assert.equal(input.profiles[0].pending.length,0);assert.equal(input.selfProfile.pending.length,0);
  f.observe(MEMORY_IDLE_MS+5);f.commit(first);f.restart();
  const secondReserved=f.observe(MEMORY_IDLE_MS*2+5),second=f.claim(),next=f.input(second);
  assert.equal(second.id,secondReserved.id);assert.equal(next.messages.length,0);
  assert.deepEqual(next.profiles[0].pending.map(item=>item.id),[later.id]);assert.equal(next.selfProfile.pending.length,1);
  assert.equal(next.previousSummary,undefined);assert.equal(next.contextProtocol,undefined);
  const output=emptyExtraction(next);output.profiles=next.profiles.map(profile=>({...profile,pendingResults:profile.pending.map(item=>({pendingId:item.id,status:'deferred'}))}));
  f.commit(second,output);
  assert.equal(f.observe(MEMORY_MAX_WAIT_MS*3),undefined);
  assert.equal(f.store.autoMemory.profile(next.profiles[0].personId).pending.length,1);
});

test('failed materials do not block compression and failed compression does not block materials',t=>{
  const f=fixture(t,'private');f.inbound('one');f.observe(0);f.observe(MEMORY_IDLE_MS);const material=f.claim();
  f.store.autoMemory.fail(material.id,material.leaseToken,'material failed');
  const compressed=f.store.autoMemory.reserveCompressionBatch(f.room.id),compression=f.claim('compression'),input=f.input(compression);
  assert.equal(compressed.id,compression.id);assert.deepEqual(input.profiles,[]);
  assert.equal(input.selfProfile,undefined);assert.equal(input.profileFragments,undefined);
  f.commit(compression);assert.equal(f.store.autoMemory.conversationContext(f.room.id).summary,'继续对话');
  f.store.autoMemory.retry(material.id);const retried=f.claim();f.commit(retried);
  f.inbound('two');f.store.autoMemory.reserveCompressionBatch(f.room.id);const failed=f.claim('compression');
  f.store.autoMemory.fail(failed.id,failed.leaseToken,'compression failed');
  f.observe(MEMORY_IDLE_MS+1);f.observe(MEMORY_IDLE_MS*2+1);f.commit(f.claim());
  assert.equal(f.store.autoMemory.status(f.room.id,'materials').completed,2);
  assert.equal(f.store.autoMemory.status(f.room.id,'compression').failed,1);
  assert.equal(f.store.autoMemory.conversationContext(f.room.id).summary,'继续对话');
});

test('late AI delivery retains visibility order without starting the materials timer',t=>{
  const f=fixture(t,'private'),source=f.inbound('question'),run=f.store.beginRun(f.room.id,'question','provider','fixture',[],source);
  const delivery=f.store.completeRun(run.id,'late AI');
  f.observe(0);f.observe(MEMORY_IDLE_MS);f.commit(f.claim());
  f.store.ackDelivery(delivery.deliveryId,'sent');
  assert.equal(f.observe(MEMORY_IDLE_MS+10),undefined);assert.equal(f.schedule().firstContentAt,undefined);
  f.inbound('next human');f.observe(MEMORY_IDLE_MS+20);f.observe(MEMORY_IDLE_MS*2+20);
  const next=f.claim(),input=f.input(next);
  assert.deepEqual(input.messages.map(message=>message.text),['late AI','next human']);
  assert.ok(input.messages[0].contextSeq<input.messages[1].contextSeq);f.commit(next);
});

test('control messages and AI-only contexts do not start timers',t=>{
  const f=fixture(t),message=f.inbound('/status');
  f.inspect(db=>db.prepare("UPDATE messages SET message_kind='memory' WHERE id=?").run(message.existingMessageId));
  assert.equal(f.observe(0),undefined);assert.equal(f.schedule().firstContentAt,undefined);
  assert.equal(f.observe(MEMORY_MAX_WAIT_MS),undefined);
});

test('store rejects cross-purpose results atomically and material topic ranges use material fixed members',t=>{
  const f=fixture(t),source=f.inbound('topic source');f.observe(0);f.observe(MEMORY_IDLE_MS);const material=f.claim(),input=f.input(material);
  const output=emptyExtraction(input);output.topics=[{summary:'材料主题',messageIds:[],sourceRange:{startOrdinal:0,endOrdinal:0}}];
  assert.throws(()=>f.commit(material,{...output,continuationSummary:'wrong purpose'}),/资料整理/);
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) AS n FROM memory_topics').get().n),0);
  f.commit(material,output);
  const topic=f.store.autoMemory.searchTopics(f.room.id,{text:'材料'}).topics[0];
  assert.equal(f.store.autoMemory.topicTouchesSources(topic,[source.existingMessageId]),true);
  f.store.autoMemory.reserveCompressionBatch(f.room.id);const compression=f.claim('compression'),compressed=emptyExtraction(f.input(compression));
  assert.throws(()=>f.commit(compression,{...compressed,topics:output.topics}),/上下文压缩/);
  assert.equal(f.store.autoMemory.conversationContext(f.room.id).summary,undefined);
  f.commit(compression,compressed);
});

test('v20 migration preserves every old job byte and lease, isolates unfinished work and uses exact done members',t=>{
  const f=fixture(t),done=f.inbound('old done'),isolated=f.inbound('old unfinished'),fresh=f.inbound('new uncovered');
  const frozen='{"extractionProtocol":2,"opaque":"original"}',progress='{"step":3}',token='old-lease';
  f.inspect(db=>{
    for(const [id,status,message] of [['done','done',done],['old','running',isolated]]) {
      db.prepare(`INSERT INTO auto_memory_jobs(id,conversation_id,reason,status,start_seq,end_seq,lease_token,lease_owner,lease_until,input_json,progress_json,error,created_at)
        VALUES (?,?, 'capacity',?,1,99999,?,?,?,?,?,'original error','old time')`).run(id,f.room.id,status,status==='done'?null:token,status==='done'?null:'old worker',status==='done'?null:Date.now()+60000,frozen,progress);
      db.prepare('INSERT INTO auto_memory_context_job_messages VALUES (?,?,0)').run(id,message.existingMessageId);
      db.prepare('INSERT INTO auto_memory_context_jobs VALUES (?,0,0,1,NULL)').run(id);
    }
  });
  const before=f.inspect(db=>db.prepare('SELECT rowid,* FROM auto_memory_jobs ORDER BY rowid').all());
  f.restart(db=>{downgradeSchema20(db);db.exec(`DROP INDEX auto_memory_jobs_order;
    ALTER TABLE auto_memory_jobs DROP COLUMN pipeline;
    CREATE INDEX auto_memory_jobs_order ON auto_memory_jobs(conversation_id,start_seq);
    PRAGMA user_version=20;`);});
  const after=f.inspect(db=>db.prepare('SELECT rowid,* FROM auto_memory_jobs ORDER BY rowid').all());
  assert.deepEqual(after,before);
  const isolation=f.inspect(db=>db.prepare('SELECT * FROM auto_memory_legacy_isolations WHERE job_id=?').get('old'));
  assert.equal(isolation.input_hash,createHash('sha256').update(frozen).digest('hex'));
  assert.equal(isolation.progress_hash,createHash('sha256').update(progress).digest('hex'));
  assert.equal(f.claim('legacy'),undefined);assert.throws(()=>f.store.autoMemory.retry('old'),/隔离/);
  assert.throws(()=>f.store.autoMemory.commit('old',token,{}),/租约已失效/);
  assert.equal(f.store.autoMemory.status(f.room.id).isolated,1);
  assert.ok(f.store.autoMemory.listJobs().find(job=>job.id==='old').isolatedReason);
  f.observe(0);f.observe(MEMORY_IDLE_MS);const job=f.claim();assert.deepEqual(job.messageIds,[fresh.existingMessageId]);f.commit(job);
  assert.equal(f.schedule().completedSeq,f.inspect(db=>db.prepare('SELECT ingest_seq FROM messages WHERE id=?').get(done.existingMessageId).ingest_seq));
  assert.deepEqual(f.inspect(db=>db.prepare('PRAGMA foreign_key_check').all()),[]);
});

test('migration distinguishes old deferred pending from pending added after its successful source batch',t=>{
  const f=fixture(t),source=f.inbound('我喜欢茶，也包含 old deferred 和 late pending'),old=f.pending(source,'old deferred');
  f.store.autoMemory.reserveBatch(f.room.id,'capacity');const legacy=f.claim('legacy'),input=f.input(legacy),output=emptyExtraction(input);
  output.profiles=input.profiles.map(profile=>({...profile,pendingResults:profile.pending.map(item=>({pendingId:item.id,status:'deferred'}))}));
  f.commit(legacy,output);const late=f.pending(source,'late pending');
  f.restart(db=>{downgradeSchema20(db);db.exec('PRAGMA user_version=20;');});
  assert.equal(f.observe(0),undefined);assert.equal(f.schedule().firstContentAt,0);
  f.observe(MEMORY_IDLE_MS);const job=f.claim(),materials=f.input(job);
  assert.equal(materials.messages.length,0);
  assert.deepEqual(materials.profiles[0].pending.map(item=>item.id),[old.id,late.id]);
});

test('deferred pending joins a later genuinely new batch but never overlaps running fixed pending',t=>{
  const f=fixture(t),source=f.inbound('我喜欢茶；你以后回答简洁一点'),pending=f.pending(source);f.store.autoMemory.selfProfile.addPending(source.existingMessageId,'你以后回答简洁一点');
  f.observe(0);f.observe(MEMORY_IDLE_MS);const first=f.claim(),firstInput=f.input(first);
  f.inbound('arrived during call');f.observe(MEMORY_IDLE_MS+1);f.observe(MEMORY_IDLE_MS*2+1);
  const result=emptyExtraction(firstInput);result.profiles=firstInput.profiles.map(profile=>({...profile,
    pendingResults:profile.pending.map(item=>({pendingId:item.id,status:'deferred'}))}));
  f.commit(first,result);
  const second=f.claim(),secondInput=f.input(second);
  assert.equal(secondInput.profiles[0].pending.length,0);assert.equal(secondInput.selfProfile.pending.length,0);f.commit(second);
  assert.equal(f.observe(MEMORY_MAX_WAIT_MS*2),undefined);assert.equal(f.schedule().firstContentAt,undefined);
  f.inbound('new evidence');f.observe(MEMORY_MAX_WAIT_MS*2+1);f.observe(MEMORY_MAX_WAIT_MS*2+MEMORY_IDLE_MS+1);
  const third=f.claim(),thirdInput=f.input(third);
  assert.deepEqual(thirdInput.profiles[0].pending.map(item=>item.id),[pending.id]);assert.equal(thirdInput.selfProfile.pending.length,1);
});
