import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {ConversationStore,StoreInitializationScope} from '../dist/store.js';
import {BackgroundMemory} from '../dist/auto-memory.js';
import {TrendingStore} from '../dist/trending-store.js';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'pa-storage-efficiency-')),path=join(dir,'pa.sqlite');
  const store=new ConversationStore(path),db=store.db;
  const room=store.ensureConversation('room','/fixture/room.jsonl',{channel:'qq',accountId:'fixture',roomType:'group',roomId:'room'});
  let sequence=0;
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const add=()=>{
    const eventId=String(++sequence);
    store.recordInbound(room.id,`message ${eventId}`,{eventId,senderId:'alice',modelInputText:`message ${eventId}`});
    return store.externalMessage(room.id,eventId).id;
  };
  return {dir,path,store,db,room,add};
}

function legacyMessages(db,ids){
  const parse=value=>JSON.parse(String(value));
  return ids.map(id=>{
    const r=db.prepare(`SELECT m.*,p.person_id,coalesce(r.status,CASE WHEN cf.status='sent' THEN 'failed' WHEN rd.status='sent' THEN 'completed' END) AS run_status,coalesce(d.status,rd.status,cf.status) AS delivery_status,input.ingest_seq AS turn_input_seq,
      context.seq AS context_seq,a.external_user_id AS sender_id,inputa.external_user_id AS reply_sender_id,inputp.person_id AS reply_person_id,coalesce(r.input_message_id,rd.source_message_id,failed_task.message_id) AS input_message_id FROM messages m
      LEFT JOIN actor_person_bindings p ON p.actor_id=m.actor_id LEFT JOIN agent_runs r ON r.input_message_id=m.id OR r.response_message_id=m.id
      LEFT JOIN research_deliveries rd ON rd.message_id=m.id LEFT JOIN channel_task_failures cf ON cf.message_id=m.id LEFT JOIN channel_tasks failed_task ON failed_task.id=cf.task_id
      LEFT JOIN messages input ON input.id=coalesce(r.input_message_id,rd.source_message_id,failed_task.message_id) LEFT JOIN deliveries d ON d.message_id=m.id
      LEFT JOIN actors a ON a.id=m.actor_id LEFT JOIN actors inputa ON inputa.id=input.actor_id LEFT JOIN actor_person_bindings inputp ON inputp.actor_id=input.actor_id
      LEFT JOIN conversation_context_messages context ON context.message_id=m.id WHERE m.id=?`).get(id);
    const images=db.prepare('SELECT metadata_json FROM message_images WHERE message_id=? ORDER BY ordinal').all(id).map(row=>parse(row.metadata_json));
    const context=db.prepare('SELECT mentioned_sender_ids_json FROM message_profile_context WHERE message_id=?').get(id);
    return {id:String(r.id),conversationId:String(r.conversation_id),role:r.role,text:String(r.text),ingestSeq:Number(r.ingest_seq),createdAt:String(r.created_at),
      ...(images.length?{images}:{}),...(context?{mentionedSenderIds:parse(context.mentioned_sender_ids_json)}:{}),
      ...(r.image_failure==null?{}:{imageFailure:String(r.image_failure)}),...(r.turn_input_seq==null?{}:{turnInputSeq:Number(r.turn_input_seq)}),
      ...(r.context_seq==null?{}:{contextSeq:Number(r.context_seq)}),...(r.sender_id==null?{}:{senderId:String(r.sender_id)}),...(r.sender_name==null?{}:{senderName:String(r.sender_name)}),
      ...(r.role!=='assistant'||r.input_message_id==null?{}:{replyToMessageId:String(r.input_message_id),...(r.reply_sender_id==null?{}:{replyToSenderId:String(r.reply_sender_id)}),...(r.reply_person_id==null?{}:{replyToPersonId:String(r.reply_person_id)})}),
      ...(r.actor_id==null?{}:{actorId:String(r.actor_id)}),...(r.person_id==null?{}:{personId:String(r.person_id)}),...(r.sent_at==null?{}:{sentAt:String(r.sent_at)}),
      ...(r.run_status==null?{}:{runStatus:String(r.run_status)}),...(r.delivery_status==null?{}:{deliveryStatus:String(r.delivery_status)})};
  });
}

test('压缩后只读取增量和旧缺口，资料水位从已有位置推进且不越缺口',t=>{
  const f=fixture(t),ids=[];
  for(let i=0;i<3;i++)ids.push(f.add());
  const batch=f.store.autoMemory.reserveCompressionBatch(f.room.id);
  const job=f.store.autoMemory.claimNext(f.room.id,{owner:'fixture',leaseMs:60000,pipeline:'compression'});
  f.store.autoMemory.fail(job.id,job.leaseToken,'fixture interrupted');
  for(let i=3;i<210;i++)ids.push(f.add());
  f.store.autoMemory.conversationContext(f.room.id);
  const seq=id=>Number(f.db.prepare('SELECT seq FROM conversation_context_messages WHERE message_id=?').get(id).seq);
  f.db.prepare("UPDATE conversation_context_state SET cursor=?,summary='kept summary',revision=1 WHERE conversation_id=?").run(seq(ids[199]),f.room.id);
  const original=f.db.prepare.bind(f.db);let materialized=0,coverageRows=0;
  t.mock.method(f.db,'prepare',sql=>{
    const statement=original(sql);
    if(/SELECT message_id,seq FROM conversation_context_messages/.test(sql)){
      const all=statement.all.bind(statement);
      statement.all=(...args)=>{const rows=all(...args);materialized+=rows.length;return rows;};
    }
    if(/AS covered/.test(sql)){
      const all=statement.all.bind(statement),iterate=statement.iterate.bind(statement);
      statement.all=(...args)=>{const rows=all(...args);coverageRows+=rows.length;return rows;};
      statement.iterate=function*(...args){for(const row of iterate(...args)){coverageRows++;yield row;}};
    }
    return statement;
  });
  const snapshot=f.store.autoMemory.conversationContext(f.room.id);
  assert.deepEqual(snapshot.messages.map(m=>m.id),[...ids.slice(0,3),...ids.slice(200)]);
  assert.equal(materialized,13,'the 197 summarized IDs must not be materialized');
  assert.deepEqual(f.store.autoMemory.conversationContext(f.room.id,ids[1]).messages.map(m=>m.id),[ids[0]]);
  f.store.autoMemory.materialSchedule(f.room.id);
  const ingest=id=>Number(original('SELECT ingest_seq FROM messages WHERE id=?').get(id).ingest_seq);
  original('UPDATE auto_memory_material_state SET completed_seq=? WHERE conversation_id=?').run(ingest(ids[199]),f.room.id);
  // Reuse the retained job as a legacy coverage source; only two tail rows are covered.
  for(const id of [ids[200],ids[201]])original('INSERT INTO auto_memory_material_legacy_messages VALUES(?,?,?)').run(id,batch.id,'done');
  coverageRows=0;
  f.store.autoMemory.advanceMaterialCheckpoint(f.room.id);
  assert.equal(f.store.autoMemory.materialSchedule(f.room.id).completedSeq,ingest(ids[201]));
  assert.equal(coverageRows,3,'advance only two covered tail rows and stop at the gap');
  for(const id of ids.slice(202))original('INSERT INTO auto_memory_material_legacy_messages VALUES(?,?,?)').run(id,batch.id,'done');
  coverageRows=0;f.store.autoMemory.advanceMaterialCheckpoint(f.room.id);
  assert.equal(f.store.autoMemory.materialSchedule(f.room.id).completedSeq,ingest(ids.at(-1)));
  assert.equal(coverageRows,8);
});

test('空闲记忆轮询不汇总历史状态，pending查询不扫描done任务',async t=>{
  const f=fixture(t);f.add();
  const insert=f.db.prepare("INSERT INTO auto_memory_jobs(id,conversation_id,reason,status,start_seq,end_seq,created_at,pipeline) VALUES(?,?,'capacity','done',1,1,?,'materials')");
  f.store.memoryTransaction(()=>{for(let i=0;i<2000;i++)insert.run(`done-${i}`,f.room.id,new Date().toISOString());});
  t.mock.method(f.store.autoMemory,'status',()=>{throw new Error('idle poll must not aggregate history');});
  const worker=new BackgroundMemory({dataDir:f.dir,contextWindow:1000000,memory:{enabled:true,maxCalls:1,timeoutMs:1000,maxOutputTokens:8192}},f.store.autoMemory,f.room.id,{extract:()=>{throw new Error('no due model work');}});
  try {worker.start();await new Promise(resolve=>setImmediate(resolve));assert.equal(worker.diagnosticFailed,false);}
  finally {await worker.close();}
  const plan=f.db.prepare("EXPLAIN QUERY PLAN SELECT j.* FROM auto_memory_jobs j WHERE conversation_id=? AND pipeline=? AND status<>'done' ORDER BY rowid LIMIT 1").all(f.room.id,'materials');
  assert.match(plan.map(row=>row.detail).join('\n'),/auto_memory_pending_order/);
  const trending=new TrendingStore(join(f.dir,'trending.sqlite'));
  try {
    const insert=trending.db.prepare('INSERT INTO editions VALUES(?,?,?,?)');
    trending.db.exec('BEGIN');
    for(let i=0;i<2000;i++)insert.run(`old-${i}`,'2020-01-01',i%2,JSON.stringify({state:'delivered'}));
    trending.db.exec('COMMIT');
    const exec=trending.db.exec.bind(trending.db);let transactions=0;
    t.mock.method(trending.db,'exec',sql=>{if(sql==='BEGIN IMMEDIATE')transactions++;return exec(sql);});
    trending.expire(Date.now());assert.equal(transactions,0);
    assert.equal(trending.pendingManual(Date.now()),undefined);
    for(const [sql,index] of [
      ["SELECT body FROM editions WHERE manual=1 AND COALESCE(json_extract(body,'$.preview'),0)=0 AND json_extract(body,'$.state') IN ('pending','collect_failed','ready') AND json_extract(body,'$.nextAttemptAt')<=0 ORDER BY rowid LIMIT 1",'editions_pending_manual'],
      ["SELECT body FROM editions INDEXED BY editions_pending_expiry WHERE manual=0 AND date<='2030-01-01' AND json_extract(body,'$.state') IN ('pending','collect_failed','ready')",'editions_pending_expiry']
    ])assert.match(trending.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(r=>r.detail).join('\n'),new RegExp(index));
  }finally{trending.close();}
});

test('同一次harness初始化共用完整性核验，新scope和结构变化仍核验损坏',t=>{
  const f=fixture(t);f.add();f.store.close();
  const scope=new StoreInitializationScope(),prepare=DatabaseSync.prototype.prepare;let checks=0;
  t.mock.method(DatabaseSync.prototype,'prepare',function(sql){if(sql==='PRAGMA foreign_key_check')checks++;return prepare.call(this,sql);});
  const a=new ConversationStore(f.path,scope),b=new ConversationStore(f.path,scope);
  assert.equal(checks,1);
  b.close();a.close();
  const c=new ConversationStore(f.path,new StoreInitializationScope());assert.equal(checks,2);c.close();
  const db=new DatabaseSync(f.path);db.exec('PRAGMA foreign_keys=OFF');
  db.prepare("UPDATE messages SET actor_id='missing'").run();
  db.exec('CREATE TABLE schema_changed(value TEXT)');db.close();
  assert.throws(()=>new ConversationStore(f.path,scope),/外键损坏/);
  assert.equal(checks,3);
});

test('批量历史读取保持1000条逐条查询结果并将SQL准备次数降为常数级',t=>{
  const f=fixture(t),ids=[];
  for(let i=0;i<500;i++){
    const id=f.add();ids.push(id);
    if(i%3===0)f.db.prepare('INSERT INTO message_images(message_id,image_id,ordinal,metadata_json) VALUES(?,?,?,?)').run(id,`image-${i}`,0,JSON.stringify({id:`image-${i}`,mimeType:'image/jpeg'}));
    if(i%7===0)f.db.prepare('INSERT INTO message_profile_context VALUES(?,?)').run(id,JSON.stringify([`mentioned-${i}`]));
    const eventId=String(f.db.prepare('SELECT external_event_id FROM messages WHERE id=?').get(id).external_event_id);
    const run=f.store.beginRun(f.room.id,`message ${i+1}`,'fixture-provider','fixture-model',[],{existingMessageId:id,eventId,senderId:'alice'});
    const delivery=f.store.completeRun(run.id,`AI reply ${i}`,undefined,undefined);f.store.ackDelivery(delivery.deliveryId,'sent');
    ids.push(delivery.messageId);
  }
  const queryIds=ids.slice(0,990).concat(ids.slice(0,10));
  const original=f.db.prepare.bind(f.db);let prepares=0;
  t.mock.method(f.db,'prepare',sql=>{prepares++;return original(sql);});
  const oldTimes=[],newTimes=[];let oldCalls=0,newCalls=0;
  for(let i=0;i<3;i++){
    prepares=0;let start=performance.now();const old=legacyMessages(f.db,queryIds);oldTimes.push(performance.now()-start);oldCalls=prepares;
    prepares=0;start=performance.now();const batch=f.store.autoMemory.messages(queryIds);newTimes.push(performance.now()-start);newCalls=prepares;
    assert.deepEqual(batch,old);
  }
  assert.equal(oldCalls,queryIds.length*3);
  assert.equal(newCalls,9,'1000 IDs require three batched reads for each of three chunks');
  console.log(`history-batch benchmark (local SQLite; 1000 requested rows): old=${oldCalls} prepare calls, ${oldTimes.map(n=>n.toFixed(1)).join('/')}ms; batch=${newCalls} prepare calls, ${newTimes.map(n=>n.toFixed(1)).join('/')}ms`);
});
