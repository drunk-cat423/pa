import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { BackgroundMemory } from '../dist/auto-memory.js';
import { emptyExtraction } from './fixtures/memory-output.mjs';
import { parseMemoryResponse } from '../dist/memory-provider.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'pa-memory-recovery-')),path=join(dir,'pa.sqlite');
  let store=new ConversationStore(path),sequence=0;
  const workers=[],route=id=>({channel:'qq',accountId:'bot',roomType:'group',roomId:id});
  const a=store.ensureConversation('a',join(dir,'a.jsonl'),route('a'));
  const b=store.ensureConversation('b',join(dir,'b.jsonl'),route('b'));
  store.autoMemory.configurePersons([{id:'alice',bindings:[{route:route('a'),senderId:'alice'},{route:route('b'),senderId:'alice'}]}]);
  t.after(async()=>{await Promise.all(workers.map(worker=>worker.close()));store.close();rmSync(dir,{recursive:true,force:true});});
  return {a,b,path,get store(){return store;},
    inbound(room,text){const eventId=String(++sequence);store.recordInbound(room.id,text,{eventId,senderId:'alice',modelInputText:text});return store.externalMessage(room.id,eventId).id;},
    reserve(room){const now=Date.now();store.autoMemory.reserveMaterialsIfDue(room.id,now);return store.autoMemory.reserveMaterialsIfDue(room.id,now+600001);},
    claim(room,pipeline){return store.autoMemory.claimNext(room.id,{owner:'fixture',leaseMs:60000,pipeline});},
    restart(){store.close();store=new ConversationStore(path);},
    inspect(fn){const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}},
    async run(room,pipeline,extract){const worker=new BackgroundMemory({dataDir:dir,contextWindow:1000000,
      memory:{enabled:true,maxCalls:30,timeoutMs:3000,maxOutputTokens:8192}},store.autoMemory,room.id,{extract});
      workers.push(worker);worker.start();try{await worker.wait(undefined,5000,pipeline);}finally{await worker.close();}},
  };
}
const evidence=(messageId,factQuote)=>({messageId,factQuote,subjectKind:'self',subjectQuote:'我'});
const fact=(content,messageId)=>({content,sourceType:'self',messageIds:[messageId]});

test('资料失败退出队列，重启后按原时间补旧事实且不能覆盖跨房间新画像',async t=>{
  const f=fixture(t),prior=f.inbound(f.b,'我现在不喝咖啡');f.reserve(f.b);
  await f.run(f.b,'materials',async input=>({...emptyExtraction(input),profiles:input.profiles.map(profile=>({...profile,
    facts:[fact('现在不喝咖啡',prior)],pendingResults:[],updates:[{factIndex:0,evidence:[evidence(prior,'我现在不喝咖啡')]}]}))}));
  const old=f.inbound(f.a,'我喜欢猫，也喜欢咖啡');
  f.store.autoMemory.addProfilePending('alice',old,'我喜欢猫，也喜欢咖啡','self');
  f.reserve(f.a);const failed=f.claim(f.a,'materials');
  const frozen=f.store.autoMemory.taskInput(failed),originalTime=frozen.messages[0].createdAt;
  f.store.autoMemory.fail(failed.id,failed.leaseToken,'fixture: model request failed');
  const due=f.store.autoMemory.recoveryInfo(failed.id).dueAt;
  f.inbound(f.a,'之后讨论了其他话题');f.reserve(f.a);
  await f.run(f.a,'materials',async input=>emptyExtraction(input));
  assert.equal(f.store.autoMemory.status(f.a.id,'materials').completed,1);
  assert.equal(f.store.autoMemory.materialSchedule(f.a.id).completedSeq,0,'coverage cannot cross the old gap');
  const newer=f.inbound(f.b,'我现在不喝咖啡');
  // Two messages can share a timestamp; the original sequence must break ties.
  f.inspect(db=>db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(originalTime,newer));
  f.store.autoMemory.addProfilePending('alice',newer,'我现在不喝咖啡','self');f.reserve(f.b);
  await f.run(f.b,'materials',async input=>({...emptyExtraction(input),profiles:input.profiles.map(profile=>({...profile,
    facts:profile.facts,pendingResults:profile.pending.map(item=>({pendingId:item.id,status:'merged',factIndex:0})),updates:[]}))}));
  assert.deepEqual(f.store.autoMemory.profile('alice').facts[0].messageIds,[prior],'later confirmation lives in supplementary revision sources');
  f.restart();
  assert.deepEqual(f.store.autoMemory.reserveRecoveryJobs(f.a.id,due-1),[]);
  assert.equal(f.store.autoMemory.reserveRecoveryJobs(f.a.id,due+1).length,1);
  let checked=false;
  await f.run(f.a,'materials',async input=>{
    if(input.mode!=='profiles') return emptyExtraction(input);
    const profile=input.profiles.find(item=>item.personId==='alice');
    assert.equal(input.messages.find(message=>message.id===old).createdAt,originalTime);
    assert.deepEqual(input.messages.map(message=>message.contextSeq),input.messages.map(message=>message.contextSeq).sort((a,b)=>a-b));
    assert.ok(input.recoveryReviewMessages.some(message=>message.id===newer),'later cross-room source must be visible for chronology review');
    const pendingResults=profile.pending.map(item=>({pendingId:item.id,status:'deferred'}));
    const stale={...emptyExtraction(input),profiles:[{...profile,facts:[fact('喜欢咖啡',old)],pendingResults,
      updates:[{factIndex:0,baselineFactIndexes:[0],evidence:[evidence(old,'我喜欢猫，也喜欢咖啡')]}]}]};
    assert.throws(()=>f.store.autoMemory.commit(input.job.id,input.job.leaseToken,stale,undefined,{key:'profile:alice',messageIds:[]}),/较早来源|较新的/);
    assert.equal(f.store.autoMemory.profile('alice').facts[0].content,'现在不喝咖啡');
    checked=true;
    return {...emptyExtraction(input),profiles:[{...profile,facts:[...profile.facts,fact('喜欢猫',old)],pendingResults,
      updates:[{factIndex:profile.facts.length,evidence:[evidence(old,'我喜欢猫，也喜欢咖啡')]}]}]};
  });
  assert.ok(checked);
  assert.deepEqual(f.store.autoMemory.profile('alice').facts.map(item=>item.content),['现在不喝咖啡','喜欢猫']);
  assert.ok(f.store.autoMemory.materialSchedule(f.a.id).completedSeq>0);
  assert.throws(()=>f.store.autoMemory.commit(failed.id,failed.leaseToken,emptyExtraction(frozen)));
  assert.equal(f.inspect(db=>db.prepare('SELECT text FROM messages WHERE id=?').get(old).text),'我喜欢猫，也喜欢咖啡');
  f.inbound(f.a,'接下来继续聊');assert.ok(f.reserve(f.a));
  const following=f.claim(f.a,'materials');
  const followingInput=f.store.autoMemory.taskInput(following),person=followingInput.profiles.find(item=>item.personId==='alice');
  assert.ok(person.pending.some(item=>item.sourceMessageId===old),
    'a deferred pending from a successful recovery must remain schedulable');
  const mergeInput={...followingInput,mode:'profiles',profiles:[person]};
  const merged=parseMemoryResponse({stopReason:'stop',content:[{type:'text',text:JSON.stringify({changes:[
    {content:'不再喝咖啡',replaces:['f0']},
  ]})}]},mergeInput);
  f.store.autoMemory.commit(following.id,following.leaseToken,{...emptyExtraction(mergeInput),...merged},undefined,{key:'profile:alice',messageIds:[]});
  const revision=f.store.autoMemory.profile('alice').baseVersion;
  const compactedIndex=f.store.autoMemory.profile('alice').facts.findIndex(fact=>fact.content==='不再喝咖啡');
  assert.ok(f.inspect(db=>db.prepare('SELECT 1 FROM person_profile_revision_sources WHERE person_id=? AND revision=? AND fact_index=? AND message_id=?').get('alice',revision,compactedIndex,newer)),
    'compacting baseline facts must preserve their newer supplementary confirmation');
  assert.deepEqual(f.inspect(db=>db.prepare('PRAGMA foreign_key_check').all()),[]);
});

test('压缩失败保留旧摘要和水位，新快照按可见顺序覆盖失败原文及后续消息',async t=>{
  const f=fixture(t);f.inbound(f.a,'最初的话题');f.store.autoMemory.reserveCompressionBatch(f.a.id);
  await f.run(f.a,'compression',async input=>emptyExtraction(input,'第一次成功摘要'));
  const state=()=>f.inspect(db=>({...db.prepare('SELECT * FROM conversation_context_state WHERE conversation_id=?').get(f.a.id)}));
  const before=state(),old=f.inbound(f.a,'不能漏掉的旧消息');f.store.autoMemory.reserveCompressionBatch(f.a.id);
  const failed=f.claim(f.a,'compression'),frozen=f.store.autoMemory.taskInput(failed);
  f.store.autoMemory.fail(failed.id,failed.leaseToken,'fixture: response unknown');
  assert.deepEqual(state(),before);
  const newer=f.inbound(f.a,'此后又发生了一件事'),due=f.store.autoMemory.recoveryInfo(failed.id).dueAt;
  f.restart();assert.equal(f.store.autoMemory.reserveRecoveryJobs(f.a.id,due+1).length,1);
  await f.run(f.a,'compression',async input=>{
    assert.equal(input.previousSummary,'第一次成功摘要');
    assert.deepEqual(input.messages.map(message=>message.id),[old,newer]);
    return emptyExtraction(input,'旧消息和新消息均已按顺序整理');
  });
  assert.ok(state().cursor>before.cursor);assert.equal(state().completed_seq,state().cursor);
  assert.equal(state().summary,'旧消息和新消息均已按顺序整理');
  assert.throws(()=>f.store.autoMemory.commit(failed.id,failed.leaseToken,emptyExtraction(frozen,'迟到结果')));
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM messages').get().n),3);
  // Reproduce the historical projection bug: the cursor advanced past a deferred gap.
  const historical=f.inbound(f.a,'旧版本跳过的原文');f.store.autoMemory.reserveCompressionBatch(f.a.id);
  const broken=f.claim(f.a,'compression');f.store.autoMemory.fail(broken.id,broken.leaseToken,'fixture old skipped range');
  const tail=f.inbound(f.a,'旧版本已放到摘要里的后续消息');
  f.inspect(db=>db.prepare(`UPDATE conversation_context_state SET cursor=(SELECT MAX(seq) FROM conversation_context_messages WHERE conversation_id=?),
    revision=revision+1,summary='旧版本有缺口的摘要' WHERE conversation_id=?`).run(f.a.id,f.a.id));
  const legacyState=state();
  assert.ok(legacyState.cursor>legacyState.completed_seq);
  f.store.autoMemory.reserveRecoveryJobs(f.a.id,f.store.autoMemory.recoveryInfo(broken.id).dueAt+1);
  await f.run(f.a,'compression',async input=>{
    assert.equal(input.previousSummary,undefined,'a summary that already omitted a gap cannot be the trusted rebuild base');
    assert.ok(input.messages.some(message=>message.id===historical));
    assert.ok(input.messages.some(message=>message.id===tail));
    assert.equal(input.messages.length,5);
    return emptyExtraction(input,'完整重建后的摘要');
  });
  assert.equal(state().completed_seq,state().cursor);
  assert.deepEqual(f.store.autoMemory.deferredRanges(f.a.id),[]);
});

test('重复失败的恢复次数与退避跨重启保留，耗尽不堵新资料且不伪造覆盖',async t=>{
  const f=fixture(t);f.inbound(f.a,'反复失败的那段原文');f.reserve(f.a);
  // Exercise the actual worker failure path, not just a direct database state edit.
  let calls=0;
  await f.run(f.a,'materials',async()=>{calls++;throw new Error('fixture upstream unavailable');}).catch(()=>{});
  let latest=f.store.autoMemory.listJobs().find(job=>job.pipeline==='materials');
  assert.equal(latest.status,'failed');
  for(let i=0;i<3;i++) {
    const recovery=f.store.autoMemory.recoveryInfo(latest.id);assert.ok(recovery);
    f.restart();assert.deepEqual(f.store.autoMemory.reserveRecoveryJobs(f.a.id,recovery.dueAt-1),[]);
    const jobs=f.store.autoMemory.reserveRecoveryJobs(f.a.id,recovery.dueAt+1);assert.equal(jobs.length,1);
    const next=f.claim(f.a,'materials');assert.equal(next.id,jobs[0]);
    f.store.autoMemory.fail(next.id,next.leaseToken,'fixture repeated failure');latest=next;
  }
  f.restart();assert.equal(f.store.autoMemory.recoveryInfo(latest.id).exhausted,true);
  assert.deepEqual(f.store.autoMemory.reserveRecoveryJobs(f.a.id,Date.now()+86400000),[]);
  f.inbound(f.a,'新任务仍然可以处理');f.reserve(f.a);
  await f.run(f.a,'materials',async input=>emptyExtraction(input));
  assert.equal(f.store.autoMemory.status(f.a.id,'materials').completed,1);
  assert.equal(f.store.autoMemory.materialSchedule(f.a.id).completedSeq,0);
  assert.equal(calls,2);assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM messages').get().n),2);
  const authorized=f.store.autoMemory.recover(latest.id,'explicit offline recovery');
  const manual=f.claim(f.a,'materials');assert.equal(manual.id,authorized);
  f.store.autoMemory.fail(manual.id,manual.leaseToken,'fixture manual attempt also failed');
  f.restart();
  assert.equal(f.store.autoMemory.recoveryInfo(manual.id).exhausted,true);
  assert.deepEqual(f.store.autoMemory.reserveRecoveryJobs(f.a.id,Date.now()+86400000),[],'manual authorization must not reset automatic retry limits');
  assert.equal(f.inspect(db=>db.prepare('SELECT manual_reason FROM auto_memory_recoveries WHERE failed_job_id=?').get(latest.id).manual_reason),'explicit offline recovery');
  f.inbound(f.b,'压缩反复失败的原文');f.store.autoMemory.reserveCompressionBatch(f.b.id);
  let compressed=f.claim(f.b,'compression');f.store.autoMemory.fail(compressed.id,compressed.leaseToken,'fixture compression failure');
  for(let i=0;i<3;i++) {
    f.store.autoMemory.reserveRecoveryJobs(f.b.id,f.store.autoMemory.recoveryInfo(compressed.id).dueAt+1);
    compressed=f.claim(f.b,'compression');f.store.autoMemory.fail(compressed.id,compressed.leaseToken,'fixture compression repeated');
  }
  assert.equal(f.store.autoMemory.reserveCompressionBatch(f.b.id),undefined,'same input cannot silently reset the retry budget');
  f.inbound(f.b,'后来确实新增的原文');
  assert.ok(f.store.autoMemory.reserveCompressionBatch(f.b.id),'new capacity work must not be permanently blocked by an exhausted old snapshot');
  await f.run(f.b,'compression',async input=>{
    assert.deepEqual(input.messages.map(message=>message.text),['压缩反复失败的原文','后来确实新增的原文']);
    return emptyExtraction(input,'补齐失败原文和新增内容');
  });
  assert.deepEqual(f.store.autoMemory.deferredRanges(f.b.id),[]);
  // Corrupt persisted input is not an upstream error and must not be hidden by a fresh attempt.
  f.inbound(f.b,'损坏的冻结输入');f.store.autoMemory.reserveCompressionBatch(f.b.id);
  const corrupt=f.claim(f.b,'compression');f.store.autoMemory.taskInput(corrupt);
  f.inspect(db=>db.prepare("UPDATE auto_memory_jobs SET input_json='{invalid',status='queued',lease_token=NULL,lease_owner=NULL,lease_until=NULL WHERE id=?").run(corrupt.id));
  await assert.rejects(f.run(f.b,'compression',async()=>{throw new Error('provider must not be called for corrupt input');}));
  f.restart();f.store.autoMemory.reserveRecoveryJobs(f.b.id,Date.now()+86400000);
  assert.equal(f.store.autoMemory.recoveryInfo(corrupt.id),undefined);
  assert.throws(()=>f.store.autoMemory.recover(corrupt.id,'must repair storage before recovery'));
});
