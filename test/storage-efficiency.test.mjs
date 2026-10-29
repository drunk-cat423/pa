import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
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
