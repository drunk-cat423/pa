import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,  } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { downgradeSchema15 } from './fixtures/legacy-schema.mjs';
import { emptyExtraction, legacyFrozenInput } from './fixtures/memory-output.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'pa-retire-count-')),path=join(directory,'pa.sqlite');
  let store=new ConversationStore(path),event=0;
  const room=store.ensureConversation('room','/room.jsonl',{channel:'qq',accountId:'test',roomType:'group',roomId:'room'});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,path,room,get store(){return store;},
    inbound(text) {
      const source={eventId:String(++event),senderId:'alice',modelInputText:text};
      store.recordInbound(room.id,text,source);
      return store.externalMessage(room.id,source.eventId).id;
    },
    count(text='legacy text') {this.inbound(text);return store.autoMemory.reserveBatch(room.id,'count',1);},
    claim(){return store.autoMemory.claimNext(room.id,{owner:'offline-test',leaseMs:60000});},
    fail() {
      const job=this.claim();store.autoMemory.saveProgress(job.id,job.leaseToken,{phase:'captured',private:'PRIVATE_PROGRESS'});
      store.autoMemory.fail(job.id,job.leaseToken,'retained failure');return job;
    },
    inspect(fn){const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}},
    restart(){store.close();store=new ConversationStore(path);},
    retire(reason='交由首次完整 rolling 接管'){return store.autoMemory.retireLegacyCountJobs(room.id,reason);},
    context(){return store.autoMemory.conversationContext(room.id);},
  };
}
function output(input,summary='完整历史摘要') {
  if(input.extractionProtocol===2) return emptyExtraction(input,summary);
  return {topics:[],fragments:[],profiles:[],ignoredMessageIds:input.messages.filter(m=>m.role==='user').map(m=>m.id),
    ...(input.contextProtocol===1?{continuationSummary:summary}:{})};
}
function evidence(f) {
  return f.inspect(db=>Object.fromEntries(['auto_memory_jobs','auto_memory_job_messages','auto_memory_job_deferrals',
    'messages','memory_topics','memory_topic_messages','auto_memory_checkpoints','conversation_context_state']
    .map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}

test('retiring the failed + queued + deferred count backlog preserves evidence and hands every original to rolling',t=>{
  const f=fixture(t);
  f.count('旧 Topic 来源');const done=f.claim(),doneInput=legacyFrozenInput(f.store,f.path,done);
  f.store.autoMemory.commit(done.id,done.leaseToken,{...output(doneInput),ignoredMessageIds:[],
    topics:[{summary:'保留旧 Topic 证据',messageIds:done.messageIds}]});
  f.count('曾搁置的 PRIVATE_RAW_TEXT');const deferred=f.fail();
  f.store.autoMemory.defer(deferred.id,'旧人工搁置原因');
  f.count('失败批次 PRIVATE_RAW_TEXT');const failed=f.fail();
  const queued=Array.from({length:15},(_,index)=>f.count(`排队旧原文 ${index}`));
  const before=evidence(f),beforeHash=digest(JSON.stringify(before));
  const retired=f.retire();assert.deepEqual(retired,[deferred.id,failed.id,...queued.map(job=>job.id)]);
  assert.equal(digest(JSON.stringify(evidence(f))),beforeHash);
  const audit=f.inspect(db=>db.prepare('SELECT * FROM auto_memory_job_retirements ORDER BY rowid').all());
  for(const record of audit) {
    const original=before.auto_memory_jobs.find(job=>job.id===record.job_id);
    assert.equal(record.input_hash,original.input_json===null?null:digest(original.input_json));
    assert.equal(record.progress_hash,original.progress_json===null?null:digest(original.progress_json));
    assert.ok(record.created_at);assert.equal(record.reason,'交由首次完整 rolling 接管');
  }
  assert.deepEqual(f.store.autoMemory.status(f.room.id),{queued:0,running:0,failed:0,deferred:0,completed:1,retired:17,
    checkpoint:done.endSeq});
  assert.equal(f.claim(),undefined);
  // Raw material may still start the separate timer; retirement never pretends it was organized.
  assert.deepEqual(f.store.autoMemory.pendingConversations(),[f.room.id]);
  assert.deepEqual(f.store.autoMemory.deferredRanges(f.room.id),[]);
  const listed=f.store.autoMemory.listJobs().find(job=>job.id===deferred.id);
  assert.equal(listed.status,'failed');assert.equal(listed.deferred,true);assert.equal(listed.retired,true);
  assert.equal(listed.deferredReason,'旧人工搁置原因');assert.equal(listed.retiredReason,audit[0].reason);
  for(const job of [deferred,failed]) {
    assert.throws(()=>f.store.autoMemory.retry(job.id),/退役/);
    assert.throws(()=>f.store.autoMemory.defer(job.id,'新原因'),/退役/);
    assert.throws(()=>f.store.autoMemory.commit(job.id,job.leaseToken,{}),/租约已失效/);
    assert.throws(()=>f.store.autoMemory.saveProgress(job.id,job.leaseToken,{}),/租约已失效/);
  }
  f.restart();assert.deepEqual(f.retire('幂等调用不改审计'),[]);
  assert.deepEqual(f.inspect(db=>db.prepare('SELECT * FROM auto_memory_job_retirements ORDER BY rowid').all()),audit);
  assert.equal(digest(JSON.stringify(evidence(f))),beforeHash);
  const batch=f.store.autoMemory.reserveBatch(f.room.id,'capacity');
  assert.deepEqual(batch.messageIds,before.messages.map(message=>message.id));
  let worker=f.claim(),input=f.store.autoMemory.taskInput(worker);
  const frozenInput=f.inspect(db=>db.prepare('SELECT input_json FROM auto_memory_jobs WHERE id=?').get(worker.id).input_json);
  assert.equal(input.contextProtocol,1);assert.equal(input.deferredRanges,undefined);
  assert.ok(input.messages.some(message=>message.id===deferred.messageIds[0]));
  f.store.autoMemory.fail(worker.id,worker.leaseToken,'离线模拟失败');
  assert.deepEqual(f.context().messages.map(message=>message.id),batch.messageIds);
  const tail=f.inbound('快照之后的新消息');
  f.store.autoMemory.retry(batch.id);worker=f.claim();
  assert.deepEqual(f.store.autoMemory.taskInput(worker),{...input,job:worker});
  assert.equal(f.inspect(db=>db.prepare('SELECT input_json FROM auto_memory_jobs WHERE id=?').get(worker.id).input_json),frozenInput);
  f.store.autoMemory.commit(worker.id,worker.leaseToken,output(input));
  const context=f.context();assert.equal(context.summary,'完整历史摘要');
  assert.equal(context.summaryVersion,1);assert.ok(context.checkpoint>done.endSeq);
  assert.equal(context.checkpoint,context.summaryCursor);assert.deepEqual(context.messages.map(message=>message.id),[tail]);
  const after=evidence(f);
  assert.deepEqual(after.auto_memory_jobs.filter(job=>job.id!==batch.id),before.auto_memory_jobs);
  assert.deepEqual(after.auto_memory_job_messages,before.auto_memory_job_messages);
  assert.deepEqual(after.auto_memory_job_deferrals,before.auto_memory_job_deferrals);
  assert.deepEqual(after.messages.slice(0,-1),before.messages);
  assert.deepEqual(after.memory_topics,before.memory_topics);assert.deepEqual(after.memory_topic_messages,before.memory_topic_messages);
  assert.equal(f.store.autoMemory.searchTopics(f.room.id,{text:'旧 Topic'}).topics[0].summary,'保留旧 Topic 证据');
  f.restart();assert.deepEqual(f.retire(),[]);assert.deepEqual(f.context(),context);
});

test('schema15 upgrade backs up original evidence and never retires or reserves work automatically',t=>{
  const f=fixture(t);f.count('PRIVATE_RAW_TEXT');f.fail();const original=evidence(f);
  f.inspect(db=>{downgradeSchema15(db);db.exec('PRAGMA user_version=15');});f.restart();
  assert.equal(f.inspect(db=>db.prepare('PRAGMA user_version').get().user_version),33);
  assert.deepEqual(evidence(f),original);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM auto_memory_job_retirements').get().n),0);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM auto_memory_context_jobs').get().n),0);
  const backups=readdirSync(f.directory).filter(name=>name.startsWith('pa.sqlite.v15.')&&name.endsWith('.bak'));
  assert.equal(backups.length,1);
  const backup=new DatabaseSync(join(f.directory,backups[0]));
  try {
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version,15);
    assert.equal(backup.prepare("SELECT name FROM sqlite_master WHERE name='auto_memory_job_retirements'").get(),undefined);
    assert.deepEqual(backup.prepare('SELECT * FROM auto_memory_jobs ORDER BY rowid').all(),original.auto_memory_jobs);
    const legacyMessages=rows=>rows.map(({image_failure: _failure,...message})=>message);
    assert.deepEqual(legacyMessages(backup.prepare('SELECT * FROM messages ORDER BY rowid').all()),legacyMessages(original.messages));
  } finally {backup.close();}
  f.restart();assert.equal(readdirSync(f.directory).filter(name=>name.endsWith('.bak')).length,1);
});
