import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore,  } from '../dist/store.js';
import { downgradeSchema10, downgradeSchema14 } from './fixtures/legacy-schema.mjs';
import { emptyExtraction, legacyFrozenInput } from './fixtures/memory-output.mjs';

function fixture(roomType='group') {
  const directory=mkdtempSync(join(tmpdir(),'pa-auto-memory-'));const path=join(directory,'store.sqlite');
  let store=new ConversationStore(path);
  const route={channel:'qq',accountId:'test',roomType,roomId:'room'};
  const conversation=store.ensureConversation('room','/room.jsonl',route);
  let event=0;
  return {get store(){return store;},path,directory,route,conversation,
    inbound(text='hello',senderId='alice') {
      const external={eventId:String(++event),senderId,modelInputText:text,sentAt:'2026-01-01T00:00:00Z'};
      store.recordInbound(conversation.id,text,external);return {...external,existingMessageId:store.externalMessage(conversation.id,external.eventId).id};
    },
    turn(text='hello') {
      const external=this.inbound(text);const run=store.beginRun(conversation.id,text,'p','m',[],external);
      const delivery=store.completeRun(run.id,'reply',undefined,undefined);store.ackDelivery(delivery.deliveryId,'sent');return run;
    },
    restart(){store.close();store=new ConversationStore(path);},
    close(){store.close();rmSync(directory,{recursive:true,force:true});}};
}
function claim(f){return f.store.autoMemory.claimNext(f.conversation.id,{owner:'worker',leaseMs:60000});}
function ignored(f,job,extra={}) {
  const input=f.store.autoMemory.taskInput(job);
  const profiles=input.profileProtocol===2?input.profiles.filter(profile=>profile.pending?.length).map(profile=>({...profile,
    pendingResults:profile.pending.map(item=>({pendingId:item.id,status:'deferred'}))})):[];
  return {...emptyExtraction(input),profiles,
    ...((input.roomType==='private'||input.contextProtocol===1)?{continuationSummary:'conversation decisions'}:{}),...extra};
}
function inspect(f,operation){const db=new DatabaseSync(f.path);try{return operation(db);}finally{db.close();}}

test('capacity short batch and queued snapshot survive failures and process restart',()=>{
  const f=fixture();try {
    f.inbound('one');f.inbound('two');const batch=f.store.autoMemory.reserveBatch(f.conversation.id,'capacity');
    assert.equal(batch.messageIds.length,2);f.inbound('three');
    const worker=claim(f);f.store.autoMemory.fail(worker.id,worker.leaseToken,'offline');
    assert.equal(f.store.autoMemory.status(f.conversation.id).failed,1);assert.equal(claim(f),undefined);
    f.restart();f.store.autoMemory.retry(batch.id);
    assert.deepEqual(f.store.autoMemory.pendingConversations(),[f.conversation.id]);
    const retry=claim(f);assert.equal(retry.attempts,2);assert.deepEqual(retry.messageIds,batch.messageIds);
    f.store.autoMemory.commit(retry.id,retry.leaseToken,ignored(f,retry));
    assert.deepEqual(f.store.autoMemory.contextAfterCheckpoint(f.conversation.id).map(m=>m.text),['three']);
  }finally{f.close();}
});

test('deferral preserves failed evidence and frozen input, releases later batches in order and retains the raw gap',()=>{
  const f=fixture('private');try {
    const jobs=[];
    for(let i=0;i<3;i++) {
      f.turn(`turn ${i}`);jobs.push(f.store.autoMemory.reserveBatch(f.conversation.id,'count',1));
    }
    const first=claim(f),oldResult=ignored(f,first);
    f.store.autoMemory.saveProgress(first.id,first.leaseToken,{chunk:1,topics:[],phase:'preserved'});
    f.store.autoMemory.fail(first.id,first.leaseToken,'legacy failure');
    assert.equal(claim(f),undefined);assert.equal(f.store.autoMemory.status(f.conversation.id).failed,1);
    const snapshot=()=>inspect(f,db=>({
      job:db.prepare('SELECT * FROM auto_memory_jobs WHERE id=?').get(first.id),
      members:db.prepare('SELECT * FROM auto_memory_job_messages WHERE job_id=? ORDER BY ordinal').all(first.id),
      messages:db.prepare('SELECT * FROM messages ORDER BY ingest_seq').all(),
    }));
    const before=snapshot();f.store.autoMemory.defer(first.id,'显式保留旧协议批次');
    const deferral=inspect(f,db=>db.prepare('SELECT * FROM auto_memory_job_deferrals WHERE job_id=?').get(first.id));
    const digest=value=>createHash('sha256').update(value).digest('hex');
    assert.equal(deferral.input_hash,digest(before.job.input_json));assert.equal(deferral.progress_hash,digest(before.job.progress_json));
    f.store.autoMemory.defer(first.id,'显式保留旧协议批次');
    assert.deepEqual(inspect(f,db=>db.prepare('SELECT * FROM auto_memory_job_deferrals WHERE job_id=?').get(first.id)),deferral);
    assert.deepEqual(snapshot(),before);
    assert.throws(()=>f.store.autoMemory.defer(first.id,'rewrite reason'),/不能改写/);
    assert.throws(()=>f.store.autoMemory.retry(first.id),/搁置/);
    assert.throws(()=>f.store.autoMemory.commit(first.id,first.leaseToken,oldResult),/租约已失效/);
    const ranges=[{startSeq:first.startSeq,endSeq:first.endSeq}];
    assert.deepEqual(f.store.autoMemory.deferredRanges(f.conversation.id),ranges);
    const listed=f.store.autoMemory.listJobs().find(job=>job.id===first.id);
    assert.equal(listed.status,'failed');assert.equal(listed.deferred,true);assert.equal(listed.deferredReason,'显式保留旧协议批次');
    assert.equal(listed.error,'legacy failure');assert.equal('input_json' in listed,false);
    f.restart();
    assert.deepEqual(f.store.autoMemory.deferredRanges(f.conversation.id),ranges);
    assert.equal(f.store.autoMemory.status(f.conversation.id).deferred,1);assert.equal(f.store.autoMemory.status(f.conversation.id).failed,0);
    const second=claim(f);assert.equal(second.id,jobs[1].id);assert.equal(claim(f),undefined);
    assert.deepEqual(f.store.autoMemory.taskInput(second).deferredRanges,ranges);
    // A newly reserved job during the second batch must stay behind the already frozen third batch.
    f.turn('turn 3');const fourth=f.store.autoMemory.reserveBatch(f.conversation.id,'count',1);
    f.store.autoMemory.commit(second.id,second.leaseToken,ignored(f,second,{continuationSummary:'after second'}));
    assert.equal(f.store.autoMemory.status(f.conversation.id).checkpoint,0);
    const third=claim(f);assert.equal(third.id,jobs[2].id);
    assert.equal(f.store.autoMemory.taskInput(third).previousSummary,'after second');
    f.store.autoMemory.commit(third.id,third.leaseToken,ignored(f,third,{continuationSummary:'after third'}));
    assert.equal(f.store.autoMemory.status(f.conversation.id).checkpoint,0);
    assert.equal(claim(f).id,fourth.id);
    assert.deepEqual(f.store.autoMemory.contextAfterCheckpoint(f.conversation.id).map(m=>m.text),['turn 0','reply','turn 1','reply','turn 2','reply','turn 3','reply']);
    assert.deepEqual(snapshot().job,before.job);assert.deepEqual(snapshot().members,before.members);
    assert.deepEqual(snapshot().messages.slice(0,before.messages.length),before.messages);
  }finally{f.close();}
});

test('v12 migration backs up the consistent original database before adding deferrals',()=>{
  const f=fixture();try {
    f.inbound('original before migration');f.store.autoMemory.reserveBatch(f.conversation.id,'count',1);const worker=claim(f);
    f.store.autoMemory.saveProgress(worker.id,worker.leaseToken,{chunk:1});f.store.autoMemory.fail(worker.id,worker.leaseToken,'preserve');
    const snapshot=db=>({
      jobs:db.prepare('SELECT * FROM auto_memory_jobs ORDER BY rowid').all(),
      members:db.prepare('SELECT * FROM auto_memory_job_messages ORDER BY ordinal').all(),
      messages:db.prepare('SELECT * FROM messages ORDER BY ingest_seq').all().map(({image_failure: _failure,...message})=>message),
    });
    const original=inspect(f,snapshot);
    f.store.close();inspect(f,db=>{downgradeSchema14(db);db.exec('DROP TABLE person_profile_pending_results; DROP TABLE person_profile_revision_sources; DROP TABLE auto_memory_job_deferrals; PRAGMA user_version=12;');});f.restart();
    assert.equal(inspect(f,db=>db.prepare('PRAGMA user_version').get().user_version),31);
    assert.deepEqual(inspect(f,snapshot),original);
    const backups=readdirSync(f.directory).filter(name=>name.includes('.v12.')&&name.endsWith('.bak'));
    assert.equal(backups.length,1);
    const backup=new DatabaseSync(join(f.directory,backups[0]),{readOnly:true});try {
      assert.equal(backup.prepare('PRAGMA user_version').get().user_version,12);
      assert.deepEqual(snapshot(backup),original);
      assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name='auto_memory_job_deferrals'").get(),undefined);
      assert.deepEqual(backup.prepare('PRAGMA foreign_key_check').all(),[]);
    }finally{backup.close();}
    f.store.autoMemory.defer(worker.id,'defer after migration');
    assert.equal(f.store.autoMemory.status(f.conversation.id).isolated,1);
    assert.equal(inspect(f,db=>db.prepare('SELECT reason FROM auto_memory_job_deferrals WHERE job_id=?').get(worker.id)).reason,'defer after migration');
  }finally{f.close();}
});

test('expired worker is failed without automatic recall; explicit retry fences the old lease',()=>{
  const f=fixture();try {
    f.inbound();f.store.autoMemory.reserveBatch(f.conversation.id,'capacity');const old=claim(f);const result=ignored(f,old);
    inspect(f,db=>db.prepare('UPDATE auto_memory_jobs SET lease_until=0 WHERE id=?').run(old.id));
    assert.equal(claim(f),undefined);
    assert.match(f.store.autoMemory.listJobs()[0].error,/interrupted/);
    f.store.autoMemory.retry(old.id);
    const replacement=claim(f);assert.notEqual(replacement.leaseToken,old.leaseToken);
    assert.throws(()=>f.store.autoMemory.commit(old.id,old.leaseToken,result),/租约已失效/);
    f.store.autoMemory.commit(replacement.id,replacement.leaseToken,ignored(f,replacement));
  }finally{f.close();}
});

test('chunk progress and input snapshot survive retry and reclaim; clearing rereads facts',()=>{
  const f=fixture();try {
    const source=f.inbound('我有new self fact');const actor=f.store.findActor(f.conversation.id,'alice');
    f.store.autoMemory.reserveBatch(f.conversation.id,'capacity');const original=claim(f);
    const before=f.store.autoMemory.taskInput(original);f.store.autoMemory.saveProgress(original.id,original.leaseToken,{chunk:1,topics:[]});
    f.store.autoMemory.renewLease(original.id,original.leaseToken,120000);
    f.store.autoMemory.fail(original.id,original.leaseToken,'offline');f.restart();f.store.autoMemory.retry(original.id);
    const retried=claim(f);assert.deepEqual(f.store.autoMemory.loadProgress(retried.id,retried.leaseToken),{chunk:1,topics:[]});
    assert.equal(f.store.autoMemory.taskInput(retried).job.leaseToken,retried.leaseToken);
    f.store.autoMemory.addProfilePending(f.store.autoMemory.personForActor(actor),source.existingMessageId,'new self fact','self');
    assert.deepEqual(f.store.autoMemory.taskInput(retried).profiles,before.profiles);
    f.store.autoMemory.clearProgress(retried.id,retried.leaseToken);
    assert.equal(f.store.autoMemory.loadProgress(retried.id,retried.leaseToken),undefined);
    assert.equal(f.store.autoMemory.taskInput(retried).profiles[0].baseVersion,0);
    assert.equal(f.store.autoMemory.taskInput(retried).profiles[0].pending.length,1);
    assert.throws(()=>f.store.autoMemory.saveProgress(original.id,original.leaseToken,{chunk:2}),/租约已失效/);
  }finally{f.close();}
});

test('unbound actors are isolated and configured multiple people share only explicit bindings',()=>{
  const f=fixture();try {
    const alice=f.inbound('我喜欢tea','alice');const bob=f.inbound('我喜欢sports','bob');const a=f.store.findActor(f.conversation.id,'alice');const b=f.store.findActor(f.conversation.id,'bob');
    assert.notEqual(f.store.autoMemory.personForActor(a),f.store.autoMemory.personForActor(b));
    const route={...f.route,roomType:'private',roomId:'private'};const other=f.store.ensureConversation('private','/private.jsonl',route);
    const alias=f.store.ensureActor(other.id,'alias');
    f.store.configurePersons([{id:'alice-person',bindings:[{route:f.route,senderId:'alice'},{route,senderId:'alias'}]},
      {id:'bob-person',bindings:[{route:f.route,senderId:'bob'}]}]);
    assert.equal(f.store.autoMemory.personForActor(a),f.store.autoMemory.personForActor(alias));
    assert.notEqual(f.store.autoMemory.personForActor(a),f.store.autoMemory.personForActor(b));
    f.store.autoMemory.addProfilePending('alice-person',alice.existingMessageId,'tea','self');
    f.store.autoMemory.addProfilePending('bob-person',bob.existingMessageId,'sports','self');
    assert.equal(f.store.autoMemory.profileForActors(alias).length,1);
    assert.equal(f.store.autoMemory.profileForActors(alias)[0].pending[0].content,'tea');
    assert.deepEqual(f.store.autoMemory.profileForActors(a,[b,b]).map(p=>p.personId),['alice-person','bob-person']);
    assert.equal(f.store.deleteMemory,undefined);
  }finally{f.close();}
});

test('profile pending corrections captured after a batch stay pending for the next batch',()=>{
  const f=fixture();try {
    const source=f.inbound('我平时喝茶'),actor=f.store.findActor(f.conversation.id,'alice'),person=f.store.autoMemory.personForActor(actor);
    f.store.autoMemory.addProfilePending(person,source.existingMessageId,'喝茶','self');
    const bob=f.inbound('Alice likes coffee','bob');
    assert.throws(()=>f.store.autoMemory.addProfilePending(person,bob.existingMessageId,'coffee','self'),/实际发送者/);
    f.store.autoMemory.reserveBatch(f.conversation.id,'capacity');const worker=claim(f),baseline=f.store.autoMemory.taskInput(worker).profiles.find(p=>p.personId===person);
    const correction=f.inbound('我现在改喝水');f.store.autoMemory.addProfilePending(person,correction.existingMessageId,'喝水','self');
    f.store.autoMemory.commit(worker.id,worker.leaseToken,ignored(f,worker,{profiles:[{...baseline,
      pendingResults:baseline.pending.map(item=>({pendingId:item.id,status:'deferred'}))}]}));
    assert.deepEqual(f.store.autoMemory.profile(person).facts,[]);
    assert.deepEqual(f.store.autoMemory.profile(person).pending.map(p=>p.content),['喝茶','喝水']);
  }finally{f.close();}
});

test('confirmed binding carries independent automatic profile and fences in-flight old identity results',()=>{
  const f=fixture();try {
    const source=f.inbound('I like tea');const actor=f.store.findActor(f.conversation.id,'alice');const oldPerson=f.store.autoMemory.personForActor(actor);
    f.store.autoMemory.reserveBatch(f.conversation.id,'capacity');const first=claim(f);
    f.store.autoMemory.commit(first.id,first.leaseToken,ignored(f,first,{profiles:[{personId:oldPerson,baseVersion:0,
      facts:[{content:'tea',sourceType:'self',messageIds:[source.existingMessageId]}]}]}));
    f.inbound('I also like travel');f.store.autoMemory.reserveBatch(f.conversation.id,'capacity');const inFlight=claim(f);const result=ignored(f,inFlight);
    f.store.configurePersons([{id:'confirmed-person',bindings:[{route:f.route,senderId:'alice'}]}]);
    assert.equal(f.store.autoMemory.profileForActors(actor)[0].facts[0].content,'tea');
    assert.throws(()=>f.store.autoMemory.commit(inFlight.id,inFlight.leaseToken,result),/绑定版本冲突/);
    f.store.autoMemory.clearProgress(inFlight.id,inFlight.leaseToken);
    assert.equal(f.store.autoMemory.taskInput(inFlight).profiles[0].personId,'confirmed-person');
    f.store.autoMemory.commit(inFlight.id,inFlight.leaseToken,ignored(f,inFlight));
  }finally{f.close();}
});

test('atomic Topic, person evidence, profile and room-scoped keyword search',()=>{
  const f=fixture();try {
    const source=f.inbound('I enjoy tea');const actor=f.store.findActor(f.conversation.id,'alice');const person=f.store.autoMemory.personForActor(actor);
    f.store.autoMemory.reserveBatch(f.conversation.id,'capacity');const worker=claim(f);
    legacyFrozenInput(f.store,f.path,worker);
    const extract=ignored(f,worker,{ignoredMessageIds:[],topics:[{summary:'Tea discussion',messageIds:[source.existingMessageId]}],
      fragments:[{personId:person,content:'tea',sourceType:'self',messageIds:[source.existingMessageId],topicIndex:0}],
      profiles:[{personId:person,baseVersion:0,facts:[{content:'tea',sourceType:'self',messageIds:[source.existingMessageId]}]}]});
    f.store.autoMemory.commit(worker.id,worker.leaseToken,extract);
    const result=f.store.autoMemory.searchTopics(f.conversation.id,{text:'Tea'});
    assert.equal(result.status,'ready');assert.equal(result.topics[0].summary,'Tea discussion');
    assert.equal(result.topics[0].facts[0].personId,person);assert.ok(result.topics[0].score>0);
    assert.deepEqual(f.store.autoMemory.searchTopics('another-room',{text:'Tea'}).topics,[]);
    assert.equal(inspect(f,db=>db.prepare('SELECT COUNT(*) AS n FROM topic_embeddings').get().n),0);
    assert.equal(inspect(f,db=>db.prepare('SELECT COUNT(*) AS n FROM person_profile_revisions').get().n),1);
  }finally{f.close();}
});

test('v5 incremental migration preserves original IDs, tombstones, primary identity and snapshots legacy watermark',()=>{
  const f=fixture();try {
    const old=f.inbound('legacy');const actor=f.store.findActor(f.conversation.id,'alice');
    inspect(f,db=>db.prepare('INSERT INTO primary_person_bindings VALUES (?,?,?,?,?,?)').run(f.route.channel,f.route.accountId,f.route.roomType,f.route.roomId,'alice','original-person'));
    f.store.configurePersons([{id:'original-person',bindings:[{route:f.route,senderId:'alice'}]}]);
    const memory=f.store.rememberMemory(f.conversation.id,{content:'old',sourceMessageId:old.existingMessageId}).memory;
    const profileSource=f.inbound('legacy profile evidence');
    const legacyProfile=f.store.rememberMemory(f.conversation.id,{content:'legacy profile placeholder',sourceMessageId:profileSource.existingMessageId}).memory;
    const longLegacyFact='迁移前保留的旧画像事实'.repeat(24);
    inspect(f,db=>{
      db.prepare("UPDATE memories SET subject_actor_id=?,person_id='original-person',scope_type='actor' WHERE id=?").run(actor,memory.id);
      db.prepare("UPDATE memories SET content=?,subject_actor_id=?,writer_actor_id=?,person_id='original-person',scope_type='actor',profile_field='interests',profile_source_self=1 WHERE id=?")
        .run(longLegacyFact,actor,actor,legacyProfile.id);
    });
    f.store.close();
    inspect(f,db=>{
      downgradeSchema10(db);
      db.exec(`PRAGMA foreign_keys=OFF;
        DROP TRIGGER history_message_insert; DROP TRIGGER history_message_update; DROP TRIGGER history_message_delete;
        DROP TABLE message_history_fts; DROP TABLE person_profile_pending; DROP TABLE profile_tool_receipts; DROP TABLE run_progress;
        DROP TRIGGER assign_message_sequence; DROP INDEX message_ingest_sequence;
        DROP TABLE message_ingest_order; ALTER TABLE messages DROP COLUMN ingest_seq; ALTER TABLE messages DROP COLUMN sent_at;
        DROP TABLE person_fragment_messages; DROP TABLE person_fragments; DROP TABLE topic_embeddings; DROP TABLE memory_topic_messages;
        DROP TABLE memory_topics; DROP TABLE auto_memory_job_messages; DROP TABLE auto_memory_jobs; DROP TABLE auto_memory_checkpoints;
        DROP TABLE person_profile_revisions; DROP TABLE actor_person_bindings; DROP TABLE person_bindings; DROP TABLE persons;
        DROP TABLE self_profile_pending; DROP TABLE self_profile_revisions;
        DROP TABLE delivery_parts; DROP INDEX delivery_conversation_identity;
        PRAGMA user_version=5;`);
      db.prepare("UPDATE memories SET content=NULL,status='deleted' WHERE id=?").run(memory.id);
      db.prepare("UPDATE memory_revisions SET content=NULL,status='deleted' WHERE memory_id=?").run(memory.id);
    });
    f.restart();
    assert.equal(f.store.autoMemory.personForActor(actor),'original-person');
    assert.equal(f.store.autoMemory.reserveBatch(f.conversation.id,'count'),undefined);
    assert.ok(f.store.autoMemory.reserveBatch(f.conversation.id,'capacity'));
    assert.equal(f.store.externalMessage(f.conversation.id,old.eventId).id,old.existingMessageId);
    assert.equal(inspect(f,db=>db.prepare('SELECT status,content FROM memories WHERE id=?').get(memory.id)).content,null);
    assert.equal(f.store.autoMemory.profile('original-person').facts[0].content,longLegacyFact);
    assert.equal([...longLegacyFact].length,24*'迁移前保留的旧画像事实'.length);
    assert.equal(inspect(f,db=>db.prepare('PRAGMA user_version').get().user_version),31);
    assert.deepEqual(inspect(f,db=>db.prepare('PRAGMA foreign_key_check').all()),[]);
    assert.equal(readdirSync(f.directory).some(name=>name.includes('.v5.')&&name.endsWith('.bak')),true);
    f.inbound('new');assert.equal(f.store.autoMemory.reserveBatch(f.conversation.id,'capacity'),undefined);assert.equal(f.store.autoMemory.conversationContext(f.conversation.id).messages.at(-1).text,'new');
  }finally{f.close();}
});
