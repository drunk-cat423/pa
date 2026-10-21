import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { emptyExtraction } from './fixtures/memory-output.mjs';
import { downgradeSchema20, downgradeSchema21 } from './fixtures/legacy-schema.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
function fixture(t,roomType='group') {
  const directory=mkdtempSync(join(tmpdir(),'pa-backfill-')),path=join(directory,'fixture.sqlite');
  let store=new ConversationStore(path),event=0;
  const room=store.ensureConversation('backfill','/fixture/session.jsonl',{channel:'qq',accountId:'test',roomType,roomId:'backfill'});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,path,room,get store(){return store;},
    inbound(text='material',senderId='alice') {
      const external={eventId:String(++event),senderId,modelInputText:text};store.recordInbound(room.id,text,external);
      return {...external,existingMessageId:store.externalMessage(room.id,external.eventId).id};
    },
    inspect(operation){const db=new DatabaseSync(path);try{return operation(db);}finally{db.close();}},
    restart(mutate){store.close();if(mutate)this.inspect(mutate);store=new ConversationStore(path);},
    plan(limits){return store.autoMemory.planMaterialBackfill(room.id,limits);},
    reserve(options={}){return store.autoMemory.reserveMaterialBackfill(room.id,{reason:'explicit fixture backfill',...options});},
    run(id){return store.autoMemory.materialBackfillRun(id);},
    claim(jobIds){return store.autoMemory.claimNext(room.id,{owner:'fixture',leaseMs:60000,pipeline:'materials',jobIds});},
    commit(job,output){store.autoMemory.commit(job.id,job.leaseToken,output??emptyExtraction(store.autoMemory.taskInput(job)));},
    pending(source,content='喜欢茶') {
      const person=store.autoMemory.personForActor(store.findActor(room.id,'alice'));
      store.autoMemory.addProfilePending(person,source.existingMessageId,content,'self');return store.autoMemory.profile(person).pending.at(-1);
    },
  };
}
function rows(db,table){return db.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all().map(row=>({...row}));}
function legacyJob(f,id,members,{status='failed',reason='count',frozen='{"opaque":"original"}',progress='{"step":1}',retired=false,deferred=false}={}) {
  f.inspect(db=>{
    db.prepare(`INSERT INTO auto_memory_jobs(id,conversation_id,reason,status,start_seq,end_seq,attempts,lease_token,lease_owner,lease_until,error,input_json,progress_json,created_at,pipeline)
      VALUES (?,?,?,?,1,99999,2,?,?,?,'original error',?,?,'old timestamp','legacy')`)
      .run(id,f.room.id,reason,status,status==='running'?'original lease':null,status==='running'?'old owner':null,status==='running'?Date.now()+60000:null,frozen,progress);
    for(const [ordinal,message] of members.entries()) db.prepare('INSERT INTO auto_memory_job_messages VALUES (?,?,?)').run(id,message.existingMessageId,ordinal);
    if(retired) db.prepare('INSERT INTO auto_memory_job_retirements VALUES (?,?,?,?,?)').run(id,'old retirement','old timestamp',sha(frozen),sha(progress));
    if(deferred) db.prepare('INSERT INTO auto_memory_job_deferrals VALUES (?,?,?,?,?)').run(id,'old deferral','old timestamp',sha(frozen),sha(progress));
  });
}

test('planning is read-only and stable; fixed message batches respect byte/count limits and isolate giant text',t=>{
  const f=fixture(t);for(const text of ['small one','small two','巨'.repeat(7000),'small three','small four'])f.inbound(text);
  const before=f.inspect(db=>({changes:db.prepare('SELECT total_changes() AS count').get().count,state:rows(db,'auto_memory_material_state'),jobs:rows(db,'auto_memory_jobs')}));
  const plan=f.plan({maxMessages:2,maxBytes:2500,maxPending:2});
  assert.equal(plan.messageCount,5);assert.equal(plan.humanCount,5);assert.equal(plan.batchCount,3);assert.equal(plan.oversizedMessages,1);
  assert.deepEqual(plan.batches.map(batch=>batch.messageCount),[2,1,2]);assert.deepEqual(plan.batches.map(batch=>batch.oversized),[false,true,false]);
  assert.deepEqual(f.plan({maxMessages:2,maxBytes:2500,maxPending:2}),plan);
  assert.deepEqual(f.inspect(db=>({changes:db.prepare('SELECT total_changes() AS count').get().count,state:rows(db,'auto_memory_material_state'),jobs:rows(db,'auto_memory_jobs')})),before);
  assert.throws(()=>f.plan({maxMessages:0}),/正整数/);assert.throws(()=>f.reserve({reason:' '}),/原因/);
  const runId=f.reserve({maxMessages:2,maxBytes:2500,maxPending:2}),run=f.run(runId);
  assert.equal(run.planHash,plan.planHash);assert.equal(run.cutoffContextSeq,plan.cutoffContextSeq);
  assert.deepEqual(run.batches,plan.batches);assert.equal(run.remainingMessages,5);assert.equal(run.status.queued,3);
  assert.equal(f.reserve(),undefined);assert.equal(f.plan().messageCount,0);
  assert.equal(f.run('unknown'),undefined);assert.deepEqual(f.store.autoMemory.listMaterialBackfillRuns(f.room.id).map(item=>item.runId),[runId]);
  f.restart();assert.deepEqual(f.run(runId),run);
});

test('backfill excludes actual legacy done members and every existing material member while including isolated retired/deferred original text',t=>{
  const f=fixture(t),done=f.inbound('legacy done'),retired=f.inbound('retired original'),deferred=f.inbound('deferred original'),fresh=f.inbound('fresh');
  legacyJob(f,'legacy-done',[done],{status:'done'});legacyJob(f,'legacy-retired',[retired],{retired:true});legacyJob(f,'legacy-deferred',[deferred],{deferred:true});
  f.restart(db=>{downgradeSchema20(db);db.exec('PRAGMA user_version=20;');});
  const preserved=f.inspect(db=>Object.fromEntries(['auto_memory_jobs','auto_memory_legacy_isolations','auto_memory_job_retirements','auto_memory_job_deferrals','auto_memory_material_legacy_messages','messages']
    .map(table=>[table,rows(db,table)])));
  const plan=f.plan({maxMessages:1});assert.equal(plan.messageCount,3);assert.equal(plan.excluded.legacyDoneMessages,1);
  const runId=f.reserve({maxMessages:1}),run=f.run(runId);
  assert.deepEqual(run.jobs.map(job=>job.messageCount),[1,1,1]);
  assert.deepEqual(f.inspect(db=>db.prepare(`SELECT jm.message_id FROM material_backfill_jobs b JOIN auto_memory_material_job_messages jm ON jm.job_id=b.job_id WHERE b.run_id=? ORDER BY b.ordinal,jm.ordinal`).all(runId).map(row=>row.message_id)),
    [retired.existingMessageId,deferred.existingMessageId,fresh.existingMessageId]);
  f.inspect(db=>{for(const [table,expected] of Object.entries(preserved))assert.deepEqual(rows(db,table).filter(row=>table!=='auto_memory_jobs'||row.pipeline==='legacy'),expected);});
  const first=f.claim(run.jobIds);f.store.autoMemory.fail(first.id,first.leaseToken,'unknown paid result');
  assert.equal(f.claim(run.jobIds),undefined);assert.equal(f.run(runId).status.failed,1);assert.equal(f.run(runId).remainingMessages,3);
  const after=f.plan();assert.equal(after.messageCount,0);assert.equal(after.excluded.materialMessages,3);assert.equal(f.reserve(),undefined);
  f.restart();assert.equal(f.claim(run.jobIds),undefined);assert.equal(f.run(runId).jobs[0].attempts,1);
});

test('reservation freezes visible cutoff and valid pending, preserving old blocked ownership audit and excluding newly owned pending',t=>{
  const f=fixture(t),source=f.inbound('我有 old profile pending；你以后回答简洁一点'),pending=f.pending(source,'old profile pending');
  f.store.autoMemory.selfProfile.addPending(source.existingMessageId,'你以后回答简洁一点');
  legacyJob(f,'old-failed',[source]);
  f.restart(db=>{downgradeSchema20(db);db.exec('PRAGMA user_version=20;');});
  const oldObserved=f.inspect(db=>rows(db,'auto_memory_material_observed_pending'));
  assert.equal(oldObserved.length,2);assert.ok(oldObserved.every(row=>row.blocked===1));
  const runId=f.reserve({maxMessages:1,maxPending:1}),run=f.run(runId);
  assert.equal(run.messageCount,1);assert.equal(run.pendingCount,2);assert.equal(run.batchCount,3);
  const newer=f.inbound('我有 new profile pending');f.pending(newer,'new profile pending');
  const after=f.plan();assert.equal(after.messageCount,1);assert.equal(after.pendingCount,1);assert.equal(after.excluded.materialPending,2);
  assert.equal(f.run(runId).cutoffContextSeq,run.cutoffContextSeq);
  assert.equal(f.run(runId).pendingCount,2);assert.equal(f.run(runId).retainedPending,2);
  f.inspect(db=>{
    const audit=rows(db,'material_backfill_pending_audit');assert.equal(audit.length,2);
    for(const item of audit) {
      const old=oldObserved.find(row=>row.kind===item.kind&&row.pending_id===item.pending_id);
      assert.equal(item.previous_blocked,old.blocked);assert.equal(item.previous_assigned_job_id,old.assigned_job_id);
      assert.equal(item.previous_observed_at,old.observed_at);
    }
    const observed=rows(db,'auto_memory_material_observed_pending');assert.ok(observed.every(item=>item.blocked===1));
    assert.ok(observed.every(item=>run.jobIds.includes(item.assigned_job_id)));
  });
  const raw=f.claim(run.jobIds),rawInput=f.store.autoMemory.taskInput(raw);assert.deepEqual(rawInput.messages.map(message=>message.id),[source.existingMessageId]);
  assert.equal(rawInput.profiles[0].pending.length,0);f.commit(raw);
  const person=f.claim(run.jobIds),personInput=f.store.autoMemory.taskInput(person);
  assert.equal(personInput.messages.length,0);assert.deepEqual(personInput.profiles[0].pending.map(item=>item.id),[pending.id]);
  assert.equal(personInput.profiles[0].pending.some(item=>item.content==='new profile pending'),false);
});

test('active pending filters exclude archived/obsolete purpose/reclassified and pending already captured by any new material job',t=>{
  const f=fixture(t),source=f.inbound('我有 owned pending');f.pending(source,'owned pending');
  f.store.autoMemory.reserveMaterialsIfDue(f.room.id,0);f.store.autoMemory.reserveMaterialsIfDue(f.room.id,600000);
  assert.equal(f.plan().pendingCount,0);assert.equal(f.plan().excluded.materialPending,1);
  const archived=f.inbound('我有 archived pending'),legacy=f.inbound('我有 old event pending');f.pending(archived,'archived pending');f.pending(legacy,'old event pending');
  f.inspect(db=>{
    db.exec(`INSERT OR IGNORE INTO person_profile_revisions(person_id,revision,facts_json,job_id,created_at)
      SELECT DISTINCT person_id,0,'[]',NULL,'fixture initial version' FROM person_profile_pending;`);
    db.prepare(`UPDATE person_profile_pending SET archived_revision=0 WHERE source_message_id=?`).run(archived.existingMessageId);
    db.prepare(`UPDATE person_profile_pending SET purpose='memory' WHERE source_message_id=?`).run(legacy.existingMessageId);
  });
  const term=f.inbound('你以后把本群术语作为固定术语');f.store.autoMemory.selfProfile.addPending(term.existingMessageId,'你以后把本群术语作为固定术语');
  const entry=f.store.autoMemory.selfProfile.snapshot().pending.find(item=>item.sourceMessageId===term.existingMessageId);
  f.store.reclassifySelfProfileTerms([{pendingId:entry.id,expectedContent:entry.content,key:'term'}],{
    version:1,ownerBindings:[{route:{channel:'qq',accountId:'test',roomType:'group',roomId:'backfill'},senderId:'alice'}]},0);
  assert.equal(f.plan().pendingCount,0);
});

test('successful bounded backfill commits captured person/self pending only and retains a later content window',t=>{
  const f=fixture(t),source=f.inbound('我喜欢茶，也希望你以后回答简洁一点');f.pending(source,'喜欢茶');
  f.store.autoMemory.selfProfile.addPending(source.existingMessageId,'你以后回答简洁一点');
  const runId=f.reserve({maxPending:1}),run=f.run(runId),later=f.inbound('我有 later pending');f.pending(later,'later pending');
  f.store.autoMemory.reserveMaterialsIfDue(f.room.id,100);
  for(const id of run.jobIds) {
    const job=f.claim(run.jobIds);assert.equal(job.id,id);
    const input=f.store.autoMemory.taskInput(job),output=emptyExtraction(input);
    output.profiles=input.profiles.filter(profile=>profile.pending.length).map(profile=>({personId:profile.personId,baseVersion:profile.baseVersion,
      facts:[...profile.facts,...profile.pending.map(item=>({content:item.content,sourceType:item.sourceType,messageIds:[item.sourceMessageId]}))],
      updates:profile.pending.map((item,index)=>({factIndex:profile.facts.length+index,baselineFactIndexes:[],evidence:[item.subject]})),
      pendingResults:profile.pending.map((item,index)=>({pendingId:item.id,status:'merged',factIndex:profile.facts.length+index}))}));
    if(input.selfProfile.pending.length) output.selfProfile={protocol:2,baseVersion:input.selfProfile.baseVersion,content:'回答简洁',
      updates:[],pendingIds:input.selfProfile.pending.map(item=>item.id)};
    f.commit(job,output);
  }
  const finished=f.run(runId);assert.equal(finished.status.completed,3);assert.equal(finished.remainingMessages,0);
  assert.equal(finished.remainingPending,0);assert.equal(finished.retainedPending,0);
  assert.equal(f.store.autoMemory.materialSchedule(f.room.id).firstContentAt,100);
  assert.equal(f.plan().messageCount,1);assert.equal(f.plan().pendingCount,1);
  assert.deepEqual(f.store.autoMemory.selfProfile.snapshot().pending,[]);
  assert.equal(f.store.autoMemory.conversationContext(f.room.id).summary,undefined);
});

test('scoped claims never skip the lane predecessor, scoped status isolates runs, failure never auto retries and success leaves compression unchanged',t=>{
  const f=fixture(t,'private');f.inbound('automatic predecessor');
  f.store.autoMemory.reserveMaterialsIfDue(f.room.id,0);const predecessor=f.store.autoMemory.reserveMaterialsIfDue(f.room.id,600000);
  f.inbound('manual one');f.inbound('manual two');const runId=f.reserve({maxMessages:1}),run=f.run(runId);
  f.store.autoMemory.reserveCompressionBatch(f.room.id);
  const contextBefore=f.inspect(db=>rows(db,'conversation_context_state'));
  assert.equal(f.claim(run.jobIds),undefined);assert.equal(f.store.autoMemory.status(f.room.id,'materials',run.jobIds).queued,2);
  assert.equal(f.store.autoMemory.status(f.room.id,'materials',[]).queued,0);
  const earlier=f.claim([predecessor.id]);f.commit(earlier);
  const first=f.claim(run.jobIds);assert.equal(first.id,run.jobIds[0]);f.commit(first);
  const second=f.claim([run.jobIds[1]]);f.store.autoMemory.fail(second.id,second.leaseToken,'unknown result');
  assert.equal(f.claim(run.jobIds),undefined);assert.equal(f.run(runId).status.failed,1);assert.equal(f.run(runId).remainingMessages,1);
  assert.equal(f.store.autoMemory.status(f.room.id,'materials',run.jobIds).completed,1);
  f.store.autoMemory.retry(second.id);const retried=f.claim(run.jobIds);assert.equal(retried.attempts,2);f.commit(retried);
  const finished=f.run(runId);assert.equal(finished.remainingMessages,0);assert.equal(finished.status.completed,2);
  assert.deepEqual(f.inspect(db=>rows(db,'conversation_context_state')),contextBefore);
  assert.equal(f.store.autoMemory.status(f.room.id,'compression').queued,1);
  assert.equal(f.store.autoMemory.conversationContext(f.room.id).summary,undefined);
});

for(const version of [18,21])test(`schema ${version}->23 preserves old rowids/JSON/leases/profiles and backup bytes while adding manual backfill`,t=>{
  const f=fixture(t),source=f.inbound('我喜欢茶，保留 original migration material');f.pending(source,'喜欢茶');
  legacyJob(f,'old-running',[source],{status:'running',frozen:'{"frozen":"不可改"}',progress:'{"progress":"原样"}'});
  const tables=['messages','auto_memory_jobs','person_profile_pending','person_profile_revisions','self_profile_revisions'];
  let before;
  f.restart(db=>{
    downgradeSchema21(db);
    if(version===18) {
      downgradeSchema20(db);db.exec(`DROP TABLE memory_topic_scopes; DROP TABLE memory_fact_attributions;
        DROP INDEX auto_memory_jobs_order; ALTER TABLE auto_memory_jobs DROP COLUMN pipeline;
        CREATE INDEX auto_memory_jobs_order ON auto_memory_jobs(conversation_id,start_seq);`);
    }
    db.exec(`PRAGMA user_version=${version};`);before=Object.fromEntries(tables.map(table=>[table,rows(db,table)]));
  });
  f.inspect(db=>{
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,23);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    for(const table of tables) {
      const expected=version===18&&table==='auto_memory_jobs'?before[table].map(row=>({...row,pipeline:'legacy'})):before[table];
      assert.deepEqual(rows(db,table),table==='person_profile_pending'?expected.map(row=>({...row,subject_json:null})):expected);
    }
    if(version===18) {
      const isolated=db.prepare('SELECT * FROM auto_memory_legacy_isolations WHERE job_id=?').get('old-running');
      assert.equal(isolated.input_hash,sha(before.auto_memory_jobs[0].input_json));assert.equal(isolated.progress_hash,sha(before.auto_memory_jobs[0].progress_json));
    }
  });
  const backups=readdirSync(f.directory).filter(file=>file.includes(`.v${version}.`)&&file.endsWith('.bak'));assert.equal(backups.length,1);
  const backup=new DatabaseSync(join(f.directory,backups[0]));try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version,version);
    for(const table of tables)assert.deepEqual(rows(backup,table),before[table]);
  }finally{backup.close();}
  const runId=f.reserve();assert.ok(runId);assert.equal(f.run(runId).messageCount,1);
  f.inspect(db=>assert.deepEqual(rows(db,'auto_memory_jobs').filter(row=>row.pipeline==='legacy'),version===18?before.auto_memory_jobs.map(row=>({...row,pipeline:'legacy'})):before.auto_memory_jobs));
});
