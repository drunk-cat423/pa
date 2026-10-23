import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { BackgroundMemory } from '../dist/auto-memory.js';
import { prepareMemoryWireExtraction } from '../dist/memory-wire.js';
import { emptyExtraction } from './fixtures/memory-output.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'pa-memory-robust-')),path=join(dir,'pa.sqlite');
  const store=new ConversationStore(path),workers=[];
  let event=0;
  const route=id=>({channel:'qq',accountId:'bot',roomType:'group',roomId:id});
  const a=store.ensureConversation('a',join(dir,'a.jsonl'),route('a'));
  const b=store.ensureConversation('b',join(dir,'b.jsonl'),route('b'));
  const config={dataDir:dir,contextWindow:1000000,memory:{enabled:true,maxCalls:30,timeoutMs:5000,maxOutputTokens:8192}};
  const inbound=(room,text)=>{
    const id=String(++event);store.recordInbound(room.id,text,{eventId:id,senderId:'alice',senderName:'Alice',modelInputText:text});
    return store.externalMessage(room.id,id).id;
  };
  t.after(async()=>{await Promise.all(workers.map(worker=>worker.close()));store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,path,store,a,b,route,config,inbound,
    worker(room,provider,override={}) { const worker=new BackgroundMemory({...config,...override},store.autoMemory,room.id,provider);workers.push(worker);return worker; },
    inspect(callback){const db=new DatabaseSync(path);try{return callback(db);}finally{db.close();}},
  };
}

test('two rooms sharing one person serialize material snapshots, preserve compression and cancel queued workers', {timeout:15000},async t=>{
  const f=fixture(t);
  f.store.autoMemory.configurePersons([{id:'alice',bindings:[f.a,f.b].map(room=>({route:f.route(room===f.a?'a':'b'),senderId:'alice'}))}]);
  f.inbound(f.a,'今天讨论学习计划');f.inbound(f.b,'明天讨论研究计划');
  for(const room of [f.a,f.b]) {
    f.store.autoMemory.reserveMaterialsIfDue(room.id,1000);
    assert.ok(f.store.autoMemory.reserveMaterialsIfDue(room.id,601001));
  }
  let unblock,started;
  const gate=new Promise(resolve=>{unblock=resolve;}),begun=new Promise(resolve=>{started=resolve;});
  const versions=[],pipelines=[];
  const provider={extract:async input=>{
    pipelines.push(input.pipeline);
    if(input.pipeline==='compression') return emptyExtraction(input,'压缩独立完成');
    versions.push(input.profiles[0].baseVersion);
    if(versions.length===1){started();await gate;}
    return {...emptyExtraction(input),profiles:input.profiles.map(profile=>({personId:profile.personId,
      baseVersion:profile.baseVersion,facts:profile.facts,pendingResults:[],updates:[]}))};
  }};
  t.after(()=>unblock());
  const first=f.worker(f.a,provider),second=f.worker(f.b,provider),cancelled=f.worker(f.b,provider);
  first.start();await begun;second.start();cancelled.start();
  await cancelled.close();
  // Direct claims from another store/process cannot capture a conflicting baseline either.
  const other=new ConversationStore(f.path);
  try {assert.equal(other.autoMemory.claimNext(f.b.id,{owner:'another-process',leaseMs:10000,pipeline:'materials'}),undefined);}
  finally{other.close();}
  first.start('capacity');await first.wait(undefined,3000,'compression');
  assert.ok(pipelines.includes('compression'));assert.deepEqual(versions,[0]);
  unblock();await Promise.all([first.wait(undefined,5000,'materials'),second.wait(undefined,5000,'materials')]);
  assert.deepEqual(versions,[0,1]);
  assert.equal(f.store.autoMemory.profile('alice').baseVersion,2);
  assert.equal(f.store.autoMemory.status(f.b.id,'materials').failed,0);
  await first.close();await second.close();
  f.inbound(f.b,'新增资料由外部工作器领取');
  const now=Date.now();
  f.store.autoMemory.reserveMaterialsIfDue(f.b.id,now);
  assert.ok(f.store.autoMemory.reserveMaterialsIfDue(f.b.id,now+600001));
  const external=f.store.autoMemory.claimNext(f.b.id,{owner:'external-process',leaseMs:1000,pipeline:'materials'});
  assert.ok(external);
  const blocked=f.worker(f.a,provider);
  f.inbound(f.a,'另一个房间也有待整理内容');
  f.store.autoMemory.reserveMaterialsIfDue(f.a.id,now);
  f.store.autoMemory.reserveMaterialsIfDue(f.a.id,now+600001);
  const tick=Date.now();blocked.start();
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.ok(Date.now()-tick<800,'a foreign lease must not trigger a microtask spin that starves heartbeat timers');
  await blocked.close();assert.deepEqual(versions,[0,1]);
});

test('compression incorporates correction lineage and only unmasks the exact captured version, retaining originals',async t=>{
  const f=fixture(t),original=f.inbound(f.a,'Alice 喜欢喝咖啡');
  const compress=async summary=>{
    assert.ok(f.store.autoMemory.reserveCompressionBatch(f.a.id));
    const worker=f.worker(f.a,{extract:async input=>{
      const wire=prepareMemoryWireExtraction(input,1000000);
      if(summary==='纠正后的摘要') {
        const payload=JSON.parse(wire.userContent);
        assert.equal(payload.summaryCorrections[0].correctedMessages[0].text,'Alice 喜欢喝咖啡');
        assert.equal(payload.summaryCorrections[0].source.senderId,'alice');
        assert.ok(wire.systemPrompt.includes('summaryCorrections'));
      }
      return emptyExtraction(input,summary);
    }});
    worker.start();await worker.wait(undefined,3000,'compression');await worker.close();
  };
  await compress('Alice 喜欢咖啡');
  const policy={version:1,ownerBindings:[{route:f.route('a'),senderId:'alice'}]};
  const correct=(text,target)=>{
    const source=f.inbound(f.a,text);
    f.store.prepareTurn(f.a.id,source,{intent:'question',mode:'standard',updates:[{target:'room_memory',content:text,
      attribution:{kind:'correction',subjectSenderIds:['alice'],excludedSenderIds:[],correctsMessageIds:[target]}}]},policy);
    return source;
  };
  const correction=correct('Alice 不喜欢咖啡，之前说错了',original);
  assert.equal(f.store.roomFactContext(f.a.id).summaryInvalidated,true);
  await compress('纠正后的摘要');
  assert.equal(f.store.roomFactContext(f.a.id).summaryInvalidated,false);
  f.inbound(f.a,'无关的新聊天');
  assert.equal(f.store.roomFactContext(f.a.id).summaryInvalidated,false);
  assert.ok(f.store.autoMemory.reserveCompressionBatch(f.a.id));
  const job=f.store.autoMemory.claimNext(f.a.id,{owner:'held',leaseMs:10000,pipeline:'compression'});
  const frozen=f.store.autoMemory.taskInput(job);
  correct('Alice 现在又开始喜欢咖啡了',correction);
  f.store.autoMemory.commit(job.id,job.leaseToken,emptyExtraction(frozen,'旧快照整理'));
  assert.equal(f.store.roomFactContext(f.a.id).summaryInvalidated,true,'late correction must not be acknowledged by an older snapshot');
  await compress('最新纠正摘要');
  assert.equal(f.store.roomFactContext(f.a.id).summaryInvalidated,false);
  // Older frozen jobs have no proof that corrections were supplied to the model.
  f.inbound(f.a,'再聊一句');f.store.autoMemory.reserveCompressionBatch(f.a.id);
  const old=f.store.autoMemory.claimNext(f.a.id,{owner:'old',leaseMs:10000,pipeline:'compression'}),oldInput=f.store.autoMemory.taskInput(old);
  delete oldInput.summaryCorrections;
  f.inspect(db=>db.prepare('UPDATE auto_memory_jobs SET input_json=? WHERE id=?').run(JSON.stringify(oldInput),old.id));
  f.store.autoMemory.commit(old.id,old.leaseToken,emptyExtraction(oldInput,'旧协议摘要'));
  assert.equal(f.store.roomFactContext(f.a.id).summaryInvalidated,true);
  assert.equal(f.inspect(db=>db.prepare('SELECT text FROM messages WHERE id=?').get(original).text),'Alice 喜欢喝咖啡');
});
