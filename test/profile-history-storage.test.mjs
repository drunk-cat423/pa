import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { BackgroundMemory, validateExtract } from '../dist/auto-memory.js';
import { MemoryInputTooLargeError } from '../dist/memory-provider.js';
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
function batch(f) { f.store.autoMemory.reserveBatch(f.room.id,'capacity');return f.store.autoMemory.claimNext(f.room.id,{owner:'test',leaseMs:60000}); }
function ignored(input,profiles=[]) {return {ignoredMessageIds:input.messages.filter(m=>m.role==='user').map(m=>m.id),topics:[],fragments:[],profiles,
  ...(input.roomType==='private'?{continuationSummary:'继续对话'}:{})};}

test('FTS Chinese words, source identities, before current boundary, actor and room isolation',()=>{
  const f=fixture();try {
    const first=f.turn('我喜欢北京的咖啡馆'); f.turn('北京咖啡馆是朋友的爱好','bob');
    const other=f.store.ensureConversation('two','/two.jsonl',{...f.route,roomId:'two'});
    f.inbound('北京咖啡馆其他房间秘密','alice',other);
    const current=f.inbound('查以前的咖啡馆'); f.turn('咖啡馆稍后才进入数据库');
    let result=f.store.readHistory(f.room.id,current.existingMessageId,{query:'咖啡馆'});
    assert.deepEqual(result.messages.map(m=>m.id),[first.inputMessageId,f.inspect(db=>db.prepare('SELECT response_message_id FROM agent_runs WHERE id=?').get(first.id).response_message_id)]);
    assert.equal(result.messages[0].senderId,'alice');assert.equal(result.messages[0].senderName,'ALICE');assert.equal(result.messages[1].replyToSenderId,'alice');
    result=f.store.readHistory(f.room.id,current.existingMessageId,{query:'咖啡馆',scope:'room'});
    assert.equal(result.messages.length,4);assert.ok(result.messages.some(m=>m.senderId==='bob'));
    assert.equal(f.store.readHistory(f.room.id,current.existingMessageId,{query:'咖啡馆',senderId:'bob'}).messages.length,2);
    assert.throws(()=>f.store.readHistory(f.room.id,current.existingMessageId,{senderId:'foreign'}),/当前房间/);
    assert.throws(()=>f.store.readHistory(other.id,current.existingMessageId,{}),/当前会话/);
    assert.throws(()=>f.store.readHistory(f.room.id,current.existingMessageId,{limit:11}),/参数/);
  }finally{f.close();}
});

test('time and sender filters run before latest LIMIT; private room scope is rejected',()=>{
  const f=fixture();try {
    f.inbound('旧消息','alice',f.room,'2026-01-01T00:00:00Z');
    const wanted=f.inbound('需要的消息','alice',f.room,'2026-02-01T00:00:00Z');
    for(let i=0;i<12;i++) f.inbound('无关成员的新消息','bob',f.room,'2026-03-01T00:00:00Z');
    const current=f.inbound('当前');
    assert.deepEqual(f.store.readHistory(f.room.id,current.existingMessageId,{limit:1,after:'2026-01-15T00:00:00Z',before:'2026-02-15T00:00:00Z'}).messages.map(m=>m.id),[wanted.existingMessageId]);
    assert.equal(f.store.readHistory(f.room.id,current.existingMessageId,{limit:1}).messages[0].id,wanted.existingMessageId);
  }finally{f.close();}
  const privateFixture=fixture('private');try {
    const current=privateFixture.inbound('当前');assert.throws(()=>privateFixture.store.readHistory(privateFixture.room.id,current.existingMessageId,{scope:'room'}),/仅群聊/);
  }finally{privateFixture.close();}
});

test('archived original messages stay searchable independently of context checkpoint',()=>{
  const f=fixture();try {
    const original=f.inbound('那天在上海参加马拉松');const job=batch(f);const input=f.store.autoMemory.taskInput(job);
    f.store.autoMemory.commit(job.id,job.leaseToken,ignored(input));
    assert.equal(f.store.autoMemory.contextAfterCheckpoint(f.room.id).length,0);
    const current=f.inbound('过去参加过什么');
    assert.equal(f.store.readHistory(f.room.id,current.existingMessageId,{query:'马拉松'}).messages[0].id,original.existingMessageId);
    f.restart();assert.equal(f.store.readHistory(f.room.id,current.existingMessageId,{query:'马拉松'}).messages[0].text,'那天在上海参加马拉松');
  }finally{f.close();}
});

test('profile tool uses current actor, NFKC excerpt validation, bound idempotent receipts and no second run',()=>{
  const f=fixture();try {
    const source=f.inbound('请记住：我喜欢ＡＢＣ茶；你的名字叫 PA');
    const run=f.store.beginRun(f.room.id,source.modelInputText,'p','m',[],source);
    const save=()=>f.store.updateProfileFromTool(f.room.id,source.existingMessageId,'call','sender','我喜欢ABC茶','self');
    assert.deepEqual(save(),{saved:true,target:'sender'});save();
    const actor=f.store.findActor(f.room.id,'alice');const profile=f.store.autoMemory.profileForActors(actor)[0];
    assert.equal(profile.facts.length,0);assert.equal(profile.baseVersion,0);assert.equal(profile.pending.length,1);assert.equal(profile.pending[0].sourceType,'self');
    assert.equal(f.store.unfinishedRuns(f.room.id).length,1);assert.equal(f.store.unfinishedRuns(f.room.id)[0].id,run.id);
    assert.throws(()=>f.store.updateProfileFromTool(f.room.id,source.existingMessageId,'call','sender','你的名字叫 PA'),/已绑定/);
    const second=f.inbound(source.modelInputText,'bob');
    assert.deepEqual(f.store.updateProfileFromTool(f.room.id,second.existingMessageId,'call','sender','我喜欢ABC茶','self'),{saved:true,target:'sender'});
    const bobProfile=f.store.autoMemory.profileForActors(f.store.findActor(f.room.id,'bob'))[0];
    assert.notEqual(bobProfile.personId,profile.personId);assert.equal(bobProfile.pending.length,1);assert.equal(bobProfile.pending[0].sourceMessageId,second.existingMessageId);
    assert.throws(()=>f.store.updateProfileFromTool(f.room.id,source.existingMessageId,'invented','sender','我喜欢咖啡'),/连续摘录/);
    assert.throws(()=>f.store.updateProfileFromTool(f.room.id,source.existingMessageId,'empty','sender',''),/参数/);
    f.store.updateProfileFromTool(f.room.id,source.existingMessageId,'ai','ai_self','你的名字叫 PA');assert.equal(f.store.autoMemory.selfProfile.snapshot().pending.length,1);
    assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM profile_tool_receipts').get().n),3);
    const foreign=f.store.ensureConversation('foreign','/foreign.jsonl',{...f.route,roomId:'foreign'});
    assert.throws(()=>f.store.updateProfileFromTool(foreign.id,source.existingMessageId,'foreign','sender','我喜欢ABC茶'),/真人原文/);
    const delivery=f.store.completeRun(run.id,'assistant-only',undefined,undefined);
    assert.throws(()=>f.store.updateProfileFromTool(f.room.id,delivery.messageId,'assistant','sender','assistant-only'),/真人原文/);
  }finally{f.close();}
});

test('captured pending sources outside chat batch archive atomically and concurrent cross-room pending survive',()=>{
  const f=fixture();try {
    const other=f.store.ensureConversation('two','/two.jsonl',{...f.route,roomType:'private',roomId:'two'});
    f.store.configurePersons([{id:'person',bindings:[{route:f.route,senderId:'alice'},{route:{...f.route,roomType:'private',roomId:'two'},senderId:'alias'}]}]);
    const old=f.inbound('我喜欢乌龙茶');f.store.updateProfileFromTool(f.room.id,old.existingMessageId,'old','sender','我喜欢乌龙茶','self');
    // First chat batch leaves the explicit note pending.
    let job=batch(f);f.store.autoMemory.commit(job.id,job.leaseToken,ignored(f.store.autoMemory.taskInput(job)));
    f.inbound('稍后的一批聊天');job=batch(f);const input=f.store.autoMemory.taskInput(job);const p=input.profiles[0];
    assert.ok(!input.messages.some(m=>m.id===old.existingMessageId));assert.equal(input.profileSources[0].text,'我喜欢乌龙茶');
    const fresh=f.inbound('我还喜欢旅行','alias',other);f.store.updateProfileFromTool(other.id,fresh.existingMessageId,'fresh','sender','我还喜欢旅行','self');
    const profile={personId:p.personId,baseVersion:p.baseVersion,facts:[{content:'喜欢乌龙茶',sourceType:'self',messageIds:[old.existingMessageId]}],pendingIds:[p.pending[0].id]};
    const extract=validateExtract(ignored(input,[profile]),input);f.store.autoMemory.commit(job.id,job.leaseToken,extract);
    const current=f.store.autoMemory.profile('person');assert.equal(current.facts[0].content,'喜欢乌龙茶');assert.equal(current.pending.length,1);assert.equal(current.pending[0].sourceMessageId,fresh.existingMessageId);
    assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM person_profile_pending WHERE archived_revision IS NOT NULL').get().n),1);
  }finally{f.close();}
});

test('pending IDs, person self evidence, other-person pending, assistant and field validation fail atomically',()=>{
  const f=fixture();try {
    const alice=f.inbound('我喜欢茶');const bob=f.inbound('我喜欢咖啡','bob');
    f.store.updateProfileFromTool(f.room.id,alice.existingMessageId,'a','sender','我喜欢茶','self');f.store.updateProfileFromTool(f.room.id,bob.existingMessageId,'b','sender','我喜欢咖啡','self');
    let job=batch(f);f.store.autoMemory.commit(job.id,job.leaseToken,ignored(f.store.autoMemory.taskInput(job)));
    const assistant=f.turn('新的对话');job=batch(f);const input=f.store.autoMemory.taskInput(job);const p=input.profiles[0];
    const attempt=(facts,pendingIds)=>ignored(input,[{personId:p.personId,baseVersion:p.baseVersion,facts,pendingIds}]);
    const fact={content:'喜欢茶',sourceType:'self',messageIds:[alice.existingMessageId]};
    for(const proposal of [attempt([fact],['not-captured']),attempt([{...fact,messageIds:[bob.existingMessageId]}],[]),attempt([{...fact,field:'diet'}],[]),attempt([{...fact,messageIds:[f.inspect(db=>db.prepare('SELECT response_message_id FROM agent_runs WHERE id=?').get(assistant.id).response_message_id)]}],[])]) {
      assert.throws(()=>validateExtract(proposal,input));assert.throws(()=>f.store.autoMemory.commit(job.id,job.leaseToken,proposal));
      assert.equal(f.store.autoMemory.profile(p.personId).baseVersion,0);assert.equal(f.store.autoMemory.status(f.room.id).completed,1);
    }
  }finally{f.close();}
});

test('v8 migration backs up and preserves archived legacy field metadata, identities, queued snapshot and FTS backfill',()=>{
  const f=fixture();try {
    const old=f.inbound('迁移前喜欢火锅；你的名字叫 PA');const actor=f.store.findActor(f.room.id,'alice');const person=f.store.autoMemory.personForActor(actor);
    const job=batch(f);const input=f.store.autoMemory.taskInput(job);f.store.autoMemory.fail(job.id,job.leaseToken,'offline');
    f.store.updateProfileFromTool(f.room.id,old.existingMessageId,'legacy-ai-name','ai_self','你的名字叫 PA');
    const self=f.store.autoMemory.selfProfile.snapshot();
    f.store.autoMemory.selfProfile.commit(self,{baseVersion:self.baseVersion,content:'名字叫 PA',sourceMessageIds:[old.existingMessageId],pendingIds:[self.pending[0].id]},[]);
    const style=f.inbound('回复要简洁');f.store.updateProfileFromTool(f.room.id,style.existingMessageId,'legacy-ai-style','ai_self','回复要简洁');
    const selfRows=f.inspect(db=>db.prepare('SELECT * FROM self_profile_pending ORDER BY id').all().map(row=>({...row})));
    f.inspect(db=>{
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
    });
    f.restart();assert.ok(readdirSync(f.dir).some(name=>name.includes('.v8.')&&name.endsWith('.bak')));
    assert.deepEqual(f.inspect(db=>db.prepare('SELECT * FROM self_profile_pending ORDER BY id').all().map(row=>({...row}))),selfRows);
    assert.equal(f.store.autoMemory.selfProfile.snapshot().pending[0].sourceMessageId,style.existingMessageId);
    f.store.updateProfileFromTool(f.room.id,old.existingMessageId,'repeat-archived','ai_self','你的名字叫 PA');
    assert.equal(f.store.autoMemory.selfProfile.snapshot().pending.length,1);
    assert.equal(f.store.autoMemory.personForActor(actor),person);assert.equal(f.store.autoMemory.profile(person).facts[0].field,'diet');assert.equal(f.store.autoMemory.profile(person).pending.length,0);
    f.store.autoMemory.retry(job.id);const retried=f.store.autoMemory.claimNext(f.room.id,{owner:'retry',leaseMs:60000});assert.equal(f.store.autoMemory.taskInput(retried).profiles[0].pending,undefined);
    const current=f.inbound('查询历史');assert.equal(f.store.readHistory(f.room.id,current.existingMessageId,{query:'火锅'}).messages[0].id,old.existingMessageId);
    assert.equal(f.inspect(db=>db.prepare('PRAGMA user_version').get().user_version), 12);assert.deepEqual(f.inspect(db=>db.prepare('PRAGMA foreign_key_check').all()),[]);
  }finally{f.close();}
});

test('progress lifecycle is persistent and separate from message evidence; restart fences uncertain sends',()=>{
  const f=fixture();try {
    const source=f.inbound('开始');const run=f.store.beginRun(f.room.id,source.modelInputText,'p','m',[],source);
    const sent=f.store.createProgress(run.id,'准备查询').id;f.store.startProgress(sent);f.store.ackProgress(sent,'sent','progress-id');f.store.ackProgress(sent,'sent','progress-id');
    assert.throws(()=>f.store.startProgress(sent),/已经尝试/);
    const uncertain=f.store.createProgress(run.id,'执行中').id;f.store.startProgress(uncertain);const pending=f.store.createProgress(run.id,'待发送').id;
    f.restart();f.store.markPendingUncertain(f.room.id);
    assert.equal(f.inspect(db=>db.prepare('SELECT status FROM run_progress WHERE id=?').get(uncertain).status),'uncertain');assert.equal(f.inspect(db=>db.prepare('SELECT status FROM run_progress WHERE id=?').get(pending).status),'uncertain');
    assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM messages').get().n),1);assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM deliveries').get().n),0);
    assert.throws(()=>f.store.startProgress(uncertain),/已经尝试/);
  }finally{f.close();}
});


test('cross-room archived-profile CAS rolls back topics and pending archival for a stale snapshot',()=>{
  const f=fixture();try {
    const route={...f.route,roomId:'second'};const other=f.store.ensureConversation('second','/second.jsonl',route);
    f.store.configurePersons([{id:'shared',bindings:[{route:f.route,senderId:'alice'},{route,senderId:'alias'}]}]);
    const first=f.inbound('我喜欢绿茶');f.store.updateProfileFromTool(f.room.id,first.existingMessageId,'first','sender','我喜欢绿茶','self');
    f.inbound('在另一个群聊天','alias',other);
    const one=batch(f);const firstInput=f.store.autoMemory.taskInput(one);
    f.store.autoMemory.reserveBatch(other.id,'capacity');const two=f.store.autoMemory.claimNext(other.id,{owner:'other',leaseMs:60000});const secondInput=f.store.autoMemory.taskInput(two);
    const profile=input=>({personId:'shared',baseVersion:input.profiles[0].baseVersion,facts:[{content:'喜欢绿茶',sourceType:'self',messageIds:[first.existingMessageId]}],pendingIds:[input.profiles[0].pending[0].id]});
    f.store.autoMemory.commit(one.id,one.leaseToken,ignored(firstInput,[profile(firstInput)]));
    const stale={...ignored(secondInput,[profile(secondInput)]),topics:[{summary:'另一个房间的话题',messageIds:secondInput.messages.map(m=>m.id)}]};
    assert.throws(()=>f.store.autoMemory.commit(two.id,two.leaseToken,stale),/版本冲突/);
    assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM memory_topics WHERE job_id=?').get(two.id).n),0);
    assert.equal(f.store.autoMemory.profile('shared').baseVersion,1);assert.equal(f.store.autoMemory.status(other.id).completed,0);
  }finally{f.close();}
});

test('background chunk splitting keeps captured pending evidence and archives once across chunks',async()=>{
  const f=fixture();let background;try {
    const original=f.inbound('我喜欢阅读');f.store.updateProfileFromTool(f.room.id,original.existingMessageId,'note','sender','我喜欢阅读','self');
    const old=batch(f);f.store.autoMemory.commit(old.id,old.leaseToken,ignored(f.store.autoMemory.taskInput(old)));
    for(let i=0;i<4;i++) f.inbound('下一批'+i);
    let calls=0;const config={contextWindow:100000,memory:{enabled:true,maxCalls:10,maxRetries:1,timeoutMs:5000}};
    background=new BackgroundMemory(config,f.store.autoMemory,f.room.id,{extract:async input=>{
      if(input.messages.length>2) throw new MemoryInputTooLargeError('split');
      calls++;const p=input.profiles[0];const note=p.pending?.[0];
      if(note) assert.equal(input.profileSources[0].text,'我喜欢阅读');
      return ignored(input,[{personId:p.personId,baseVersion:p.baseVersion,
        facts:note?[{content:'喜欢阅读',sourceType:'self',messageIds:[note.sourceMessageId]}]:p.facts,
        pendingIds:note?[note.id]:[]}]);
    }});
    background.start('capacity');await background.wait(undefined,3000);
    assert.equal(calls,2);const p=f.store.autoMemory.profileForActors(f.store.findActor(f.room.id,'alice'))[0];
    assert.equal(p.facts[0].content,'喜欢阅读');assert.equal(p.pending.length,0);assert.equal(p.baseVersion,1);
  }finally{await background?.close();f.close();}
});


test('foreground history-topic retrieval respects caller cancellation without starting aborted requests',async()=>{
  const f=fixture();let background;let release;try {
    let calls=0;let capturedSignal;
    background=new BackgroundMemory({contextWindow:100000,memory:{enabled:true,maxCalls:10,maxRetries:1,timeoutMs:5000}},f.store.autoMemory,f.room.id,
      {extract:async input=>ignored(input),embedding:{model:'test',dimensions:2,inputVersion:1,embed:async(_query,signal)=>{
        calls++;capturedSignal=signal;return new Promise(resolve=>{release=()=>resolve([1,0]);});
      }}});
    const already=new AbortController();already.abort();assert.equal((await background.retrieve('tea',already.signal)).status,'unavailable');assert.equal(calls,0);
    const controller=new AbortController();const pending=background.retrieve('tea',controller.signal);controller.abort();
    assert.equal((await pending).status,'unavailable');assert.equal(calls,1);assert.equal(capturedSignal.aborted,true);
  }finally{release?.();await background?.close();f.close();}
});


test('two distinct AI suggestions from one source persist independently with receipts and exact-content archival idempotency',()=>{
  const f=fixture();try {
    const source=f.inbound('你的名字叫 PA，回复要简洁。');
    assert.deepEqual(f.store.updateProfileFromTool(f.room.id,source.existingMessageId,'name','ai_self','你的名字叫 PA'),{saved:true,target:'ai_self'});
    assert.deepEqual(f.store.updateProfileFromTool(f.room.id,source.existingMessageId,'style','ai_self','回复要简洁'),{saved:true,target:'ai_self'});
    f.store.updateProfileFromTool(f.room.id,source.existingMessageId,'name','ai_self','你的名字叫 PA');
    const snapshot=f.store.autoMemory.selfProfile.snapshot();assert.deepEqual(snapshot.pending.map(note=>note.content),['你的名字叫 PA','回复要简洁']);
    assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM profile_tool_receipts').get().n),2);
    f.store.autoMemory.selfProfile.commit(snapshot,{baseVersion:0,content:'名字叫 PA',sourceMessageIds:[source.existingMessageId],pendingIds:[snapshot.pending[0].id]},[]);
    f.store.updateProfileFromTool(f.room.id,source.existingMessageId,'repeat-archived','ai_self','你的名字叫 PA');
    assert.deepEqual(f.store.autoMemory.selfProfile.snapshot().pending.map(note=>note.content),['回复要简洁']);
    assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM self_profile_pending').get().n),2);
    assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM profile_tool_receipts').get().n),3);
    f.restart();assert.equal(f.store.autoMemory.selfProfile.snapshot().pending[0].id,snapshot.pending[1].id);
  }finally{f.close();}
});
