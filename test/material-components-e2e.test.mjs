import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { BackgroundMemory } from '../dist/auto-memory.js';
import { prepareMemoryWireExtraction } from '../dist/memory-wire.js';
import { parseMemoryResponse } from '../dist/memory-provider.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'pa-components-')),path=join(dir,'pa.sqlite');
  let store=new ConversationStore(path),sequence=0;
  const route={channel:'qq',accountId:'bot',roomType:'group',roomId:'group'};
  const room=store.ensureConversation('group',join(dir,'session.jsonl'),route),workers=[];
  store.autoMemory.configurePersons(['alice','bob'].map(id=>({id,bindings:[{route,senderId:id}]})));
  t.after(async()=>{await Promise.all(workers.map(worker=>worker.close()));store.close();rmSync(dir,{recursive:true,force:true});});
  return {room,path,get store(){return store;},
    add(senderId,text){const eventId=String(++sequence);store.recordInbound(room.id,text,{eventId,senderId,modelInputText:text});return store.externalMessage(room.id,eventId).id;},
    reserve(){const now=Date.now();store.autoMemory.reserveMaterialsIfDue(room.id,now);return store.autoMemory.reserveMaterialsIfDue(room.id,now+600001);},
    restart(){store.close();store=new ConversationStore(path);},
    inspect(fn){const db=new DatabaseSync(path,{readOnly:true});try{return fn(db);}finally{db.close();}},
    async run(provider){const worker=new BackgroundMemory({dataDir:dir,contextWindow:1000000,memory:{enabled:true,maxCalls:50,timeoutMs:2000,maxOutputTokens:8192}},store.autoMemory,room.id,{extract:async input=>{
      const wire=prepareMemoryWireExtraction(input,1000000),payload=JSON.parse(wire.userContent);
      return parseMemoryResponse({stopReason:'stop',content:[{type:'text',text:JSON.stringify(await provider(input,payload,wire))}]},input);
    }});workers.push(worker);worker.start();try{await worker.wait(undefined,5000,'materials');}finally{await worker.close();}},
  };
}

test('单人物简化提案接受自然表达，无关字段不拖垮Topic；失败画像跨重启只补自身',async t=>{
  const f=fixture(t),alice=f.add('alice','我觉得回答简短一点比较好；我也喜欢阅读'),bob=f.add('bob','我喜欢咖啡');
  f.store.autoMemory.addProfilePending('alice',alice,'我觉得回答简短一点比较好','self');
  f.store.autoMemory.addProfilePending('alice',alice,'我也喜欢阅读','self');
  const root=f.reserve(),calls=[];
  await f.run(async(input,payload,wire)=>{
    calls.push(input.mode==='profiles'?input.profiles[0].personId:input.mode);
    if(input.mode==='messages')return {topics:[{summary:'讨论偏好和交流方式',summaryExtra:'无关说明'}],profiles:[]};
    assert.equal(input.mode,'profiles');assert.equal(input.profiles.length,1);
    assert.doesNotMatch(wire.systemPrompt,/factIndex:|baselineFactIndexes:/);
    if(input.profiles[0].personId==='bob')return {facts:[{content:'喜欢咖啡',sources:['m999999']}]};
    const source=payload.pending.find(pending=>pending.content==='我觉得回答简短一点比较好');
    return {facts:[{content:'喜欢简短回答',sources:[source.id],explanation:'额外注释'}],discardPending:[],summaryExtra:'不影响保存'};
  });
  assert.ok(calls.includes('messages'));assert.ok(calls.includes('alice'));assert.ok(calls.includes('bob'));
  assert.equal(f.store.autoMemory.profile('alice').facts[0].content,'喜欢简短回答');
  assert.deepEqual(f.store.autoMemory.profile('alice').pending.map(item=>item.content),['我也喜欢阅读'],
    'handling one pending must not archive another suggestion from the same original message');
  assert.deepEqual(f.store.autoMemory.profile('bob').facts,[]);
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM memory_topics').get().n),1);
  assert.equal(f.store.autoMemory.listJobs().find(job=>job.id===root.id).status,'failed','partial results must not masquerade as a complete batch');
  const version=f.store.autoMemory.profile('alice').baseVersion,due=f.store.autoMemory.recoveryInfo(root.id).dueAt;
  f.restart();f.store.autoMemory.reserveRecoveryJobs(f.room.id,due+1);
  const repeated=[];
  await f.run(async(input,payload)=>{
    repeated.push(input.mode==='profiles'?input.profiles[0].personId:input.mode);
    assert.equal(input.mode,'profiles');assert.equal(input.profiles[0].personId,'bob');
    const source=payload.sources.find(source=>source.text==='我喜欢咖啡');
    return {facts:[{content:'喜欢咖啡',sources:[source.id]}]};
  });
  assert.deepEqual(repeated,['bob']);assert.equal(f.store.autoMemory.profile('alice').baseVersion,version);
  assert.equal(f.store.autoMemory.profile('bob').facts[0].content,'喜欢咖啡');
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM memory_topics').get().n),1);
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM messages').get().n),2);
  assert.deepEqual(f.inspect(db=>db.prepare('PRAGMA foreign_key_check').all()),[]);
});

test('画像请求未知失败保留其他组件，单目标来源和真实权限仍不能越界',async t=>{
  const f=fixture(t);f.add('alice','喜欢阅读，回答尽量简短');f.add('bob','我喜欢登山');
  const root=f.reserve();
  await f.run(async(input,payload)=>{
    if(input.mode==='messages')return {topics:[{summary:'阅读和登山'}]};
    const person=input.profiles[0].personId;
    if(person==='alice')throw new Error('fixture upstream response unknown');
    assert.ok(payload.sources.every(source=>!source.text.includes('喜欢阅读')),'other members are not writable sources for this target');
    return {personId:'alice',facts:[{content:'喜欢登山',sources:[payload.sources.find(source=>source.text==='我喜欢登山').id]}]};
  });
  assert.equal(f.store.autoMemory.profile('bob').facts[0].content,'喜欢登山');
  assert.deepEqual(f.store.autoMemory.profile('alice').facts,[]);
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM memory_topics').get().n),1);
  assert.equal(f.store.autoMemory.listJobs().find(job=>job.id===root.id).status,'failed');
  assert.ok(f.store.autoMemory.recoveryInfo(root.id));
});
