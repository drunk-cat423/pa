import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { BackgroundMemory, validateExtract } from '../dist/auto-memory.js';
import { migrateMemoryRetrieval } from '../dist/auto-memory-store.js';
import { memoryWords } from '../dist/memory-text.js';
import { ConversationStore } from '../dist/store.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(),'pa-retrieval-'));
  const path = join(directory,'pa.sqlite');
  let store = new ConversationStore(path), sequence = 0;
  const route = {channel:'qq',accountId:'test',roomType:'group',roomId:'one'};
  const conversation = store.ensureConversation('room','/room.jsonl',route);
  t.after(() => { store.close(); rmSync(directory,{recursive:true,force:true}); });
  return { get store() { return store; }, conversation, path,
    restart() { store.close(); store = new ConversationStore(path); },
    inbound(text, senderId='alice') {
      const eventId=String(++sequence);
      store.recordInbound(conversation.id,text,{eventId,senderId,modelInputText:text});
      return store.externalMessage(conversation.id,eventId).id;
    },
    batch() {
      store.autoMemory.reserveBatch(conversation.id,'capacity');
      const job=store.autoMemory.claimNext(conversation.id,{owner:'test',leaseMs:60000});
      const input=store.autoMemory.taskInput(job);
      return {job,input, output:{topics:[],fragments:[],profiles:[],ignoredMessageIds:input.messages.filter(m=>m.role==='user').map(m=>m.id)}};
    },
    inspect(action) { const db=new DatabaseSync(path); db.function('history_tokens',{deterministic:true},value=>memoryWords(String(value??'')).join(' '));
      try { return action(db); } finally { db.close(); } },
  };
}

test('Topic FTS migration backfills existing summaries, stays idempotent, and synchronizes updates', t => {
  const f=fixture(t); const id=f.inbound('讨论递归改进的方案');
  const {job,output}=f.batch(); output.topics=[{summary:'递归改进与智能体方案',messageIds:[id]}];
  f.store.autoMemory.commit(job.id,job.leaseToken,output);
  const topic=f.store.autoMemory.pendingTopics()[0];
  f.inspect(db=>{
    db.exec('DROP TRIGGER index_topic_insert; DROP TRIGGER index_topic_update; DROP TRIGGER index_topic_delete; DROP TABLE memory_topic_fts');
    migrateMemoryRetrieval(db); migrateMemoryRetrieval(db);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_topic_fts').get().n,1);
  });
  assert.equal(f.store.autoMemory.searchTopicsHybrid(f.conversation.id,{text:'递归改进'}).topics[0].id,topic.id);
  f.inspect(db=>db.prepare('UPDATE memory_topics SET summary=? WHERE id=?').run('深圳旅行计划',topic.id));
  assert.equal(f.store.autoMemory.searchTopicsHybrid(f.conversation.id,{text:'递归改进'}).topics.length,0);
  assert.equal(f.store.autoMemory.searchTopicsHybrid(f.conversation.id,{text:'深圳旅行'}).topics[0].id,topic.id);
});

test('Topic fusion filters conversation candidates first and lexical recall survives missing or failed embeddings', async t => {
  const f=fixture(t); const id=f.inbound('测试计划'); const {job,output}=f.batch();
  output.topics=[{summary:'杭州茶叶旅行',messageIds:[id]},{summary:'北京编程聚会',messageIds:[id]}];
  f.store.autoMemory.commit(job.id,job.leaseToken,output);
  const topics=f.store.autoMemory.pendingTopics();
  const meta={model:'e',dimensions:2,inputVersion:1};
  for(const topic of topics) f.store.autoMemory.saveEmbedding(topic.id,{...meta,topicVersion:topic.version,contentHash:topic.contentHash,
    vector:topic.summary.includes('杭州')?[0,1]:[1,0]});
  const lexical=f.store.autoMemory.searchTopicsHybrid(f.conversation.id,{text:'杭州茶叶'});
  assert.equal(lexical.topics[0].summary,'杭州茶叶旅行');
  const hybrid=f.store.autoMemory.searchTopicsHybrid(f.conversation.id,{text:'杭州茶叶',embedding:{...meta,vector:[1,0]}});
  assert.equal(hybrid.topics[0].summary,'杭州茶叶旅行');
  assert.equal(f.store.autoMemory.searchTopicsHybrid('foreign-room',{text:'杭州',embedding:{...meta,vector:[1,0]}}).topics.length,0);
  const config={contextWindow:100000,memory:{enabled:true,maxCalls:10,timeoutMs:100,maxRetries:3}};
  const noEmbedding=new BackgroundMemory(config,f.store.autoMemory,f.conversation.id,{extract:async()=>{throw new Error('unused');}});
  t.after(()=>noEmbedding.close());
  assert.equal((await noEmbedding.retrieve('杭州茶叶')).topics[0].summary,'杭州茶叶旅行');
  const failing=new BackgroundMemory({...config,memory:{...config.memory}},f.store.autoMemory,f.conversation.id,
    {extract:async()=>{},embedding:{...meta,embed:async()=>{throw new Error('provider failure');}}});
  t.after(()=>failing.close());
  assert.equal((await failing.retrieve('杭州茶叶')).status,'ready');
  assert.equal((await failing.retrieve('杭州茶叶')).topics[0].summary,'杭州茶叶旅行');
  const controller=new AbortController();controller.abort();
  assert.equal((await failing.retrieve('杭州茶叶',controller.signal)).status,'unavailable');
});

test('same-person atomic facts merge evidence, keep other people isolated, and corrections retain history', t => {
  const f=fixture(t);
  const first=f.inbound('我喜欢茶'); let batch=f.batch(); const alice=batch.input.profiles[0].personId;
  const fact={content:'喜欢茶',sourceType:'self',messageIds:[first]};
  batch.output.fragments=[{personId:alice,...fact}];
  batch.output.profiles=[{personId:alice,baseVersion:0,facts:[fact]}];
  f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,validateExtract(batch.output,batch.input));
  const second=f.inbound('我还是喜欢茶'); const third=f.inbound('我喜欢茶','bob'); batch=f.batch();
  const bob=batch.input.messages.find(m=>m.id===third).personId;
  batch.output.fragments=[{personId:alice,...fact,messageIds:[second]},{personId:bob,...fact,messageIds:[third]}];
  batch.output.profiles=[{personId:alice,baseVersion:1,facts:[fact,{...fact,messageIds:[second]}]}];
  f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,validateExtract(batch.output,batch.input));
  const merged=f.store.autoMemory.profile(alice).facts;
  assert.equal(merged.length,1);assert.deepEqual(new Set(merged[0].messageIds),new Set([first,second]));
  assert.deepEqual(f.store.autoMemory.profile(bob).facts,[]); // Fragments never automatically populate profiles.
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM person_fragments').get().n),2);
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM person_fragment_messages').get().n),3);
  const corrected=f.inbound('更正，现在喜欢咖啡'); batch=f.batch();
  assert.ok(batch.input.profileFragments.some(fragment=>fragment.personId===alice&&fragment.messageIds.includes(first)));
  batch.output.profiles=[{personId:alice,baseVersion:2,facts:[{content:'现在喜欢咖啡',sourceType:'self',messageIds:[corrected]}]}];
  f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,validateExtract(batch.output,batch.input));
  assert.equal(f.store.autoMemory.profile(alice).facts[0].content,'现在喜欢咖啡');
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM person_profile_revisions WHERE person_id=?').get(alice).n),3);
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM person_fragment_messages').get().n),3);
});

test('memory-purpose pending is archived with atomic evidence without becoming a resident profile', t => {
  const f=fixture(t); const source=f.inbound('我今年去过杭州'); const actor=f.store.findActor(f.conversation.id,'alice');
  const person=f.store.autoMemory.personForActor(actor);
  f.store.autoMemory.addProfilePending(person,source,'今年去过杭州','self',{purpose:'memory'});
  let batch=f.batch(); f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,batch.output); // pending predates next batch
  const next=f.inbound('接着讨论'); batch=f.batch(); const pending=batch.input.profiles.find(p=>p.personId===person).pending[0];
  assert.ok(batch.input.profileSources.some(message=>message.id===source));
  batch.output.topics=[{summary:'今年去杭州的经历',messageIds:[source]}];
  batch.output.fragments=[{personId:person,content:'今年去过杭州',sourceType:'self',messageIds:[source],topicIndex:0}];
  batch.output.memoryPending=[{personId:person,pendingIds:[pending.id]}];
  const wrong={...batch.output,memoryPending:undefined,profiles:[{personId:person,baseVersion:0,facts:[],pendingIds:[pending.id]}]};
  assert.throws(()=>validateExtract(wrong,batch.input),/归档/);
  const eventAsProfile={...batch.output,profiles:[{personId:person,baseVersion:0,facts:[{content:'今年去过杭州',sourceType:'self',messageIds:[source]}]}]};
  assert.throws(()=>validateExtract(eventAsProfile,batch.input),/不能写入人物画像/);
  assert.throws(()=>f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,eventAsProfile),/不能写入人物画像/);
  f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,validateExtract(batch.output,batch.input));
  assert.deepEqual(f.store.autoMemory.profile(person).facts,[]);assert.deepEqual(f.store.autoMemory.profile(person).pending,[]);
  assert.equal(f.store.autoMemory.searchTopicsHybrid(f.conversation.id,{text:'杭州经历'}).topics.length,1);
  const recalled=f.store.autoMemory.searchTopicsHybrid(f.conversation.id,{text:'杭州经历'}).topics[0];
  assert.equal(recalled.facts[0].content,'今年去过杭州');assert.deepEqual(recalled.facts[0].messageIds,[source]);
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM messages WHERE id IN (?,?)').get(source,next).n),2);
});

test('a captured third-party target is organized even when only its recorder spoke in this batch', async t => {
  const f=fixture(t); f.inbound('我是小乙','bob');
  let batch=f.batch();f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,batch.output);
  const bob=f.store.autoMemory.personForActor(f.store.findActor(f.conversation.id,'bob'));
  const source=f.inbound('小乙喜欢绘画','owner');
  f.store.autoMemory.addProfilePending(bob,source,'喜欢绘画','third_party',{allowThirdParty:true});
  let captured;
  const worker=new BackgroundMemory({contextWindow:100000,memory:{enabled:true,maxCalls:2,maxRetries:3,timeoutMs:1000}},
    f.store.autoMemory,f.conversation.id,{extract:async input=>{
      captured=input;
      const person=input.profiles.find(profile=>profile.personId===bob),pending=person.pending[0];
      return {topics:[],fragments:[],ignoredMessageIds:input.messages.filter(m=>m.role==='user').map(m=>m.id),
        profiles:[{personId:bob,baseVersion:person.baseVersion,facts:[{content:'喜欢绘画',sourceType:'third_party',messageIds:[source]}],pendingIds:[pending.id]}]};
    }});
  t.after(()=>worker.close());worker.start('capacity');await worker.wait(undefined,2000);
  assert.ok(captured.profiles.some(profile=>profile.personId===bob));
  assert.ok(!captured.messages.some(message=>message.personId===bob));
  assert.equal(f.store.autoMemory.profile(bob).facts[0].sourceType,'third_party');assert.equal(f.store.autoMemory.profile(bob).pending.length,0);
});

test('room-scoped pending captured after an earlier batch is picked up without the target speaking again', t => {
  const f=fixture(t);f.inbound('我是小乙','bob');
  const bob=f.store.autoMemory.personForActor(f.store.findActor(f.conversation.id,'bob'));
  const source=f.inbound('小乙喜欢绘画','owner');
  const old=f.batch();f.store.autoMemory.commit(old.job.id,old.job.leaseToken,old.output);
  // Simulate prepare_turn landing after the old batch's immutable input was already captured.
  f.store.autoMemory.addProfilePending(bob,source,'喜欢绘画','third_party',{allowThirdParty:true});
  const next=f.inbound('继续聊','owner');const batch=f.batch();
  assert.deepEqual(batch.input.messages.map(message=>message.id),[next]);
  const target=batch.input.profiles.find(profile=>profile.personId===bob);
  assert.equal(target.pending.length,1);assert.ok(batch.input.profileSources.some(message=>message.id===source));
  batch.output.profiles=[{personId:bob,baseVersion:target.baseVersion,
    facts:[{content:'喜欢绘画',sourceType:'third_party',messageIds:[source]}],pendingIds:[target.pending[0].id]}];
  f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,validateExtract(batch.output,batch.input));
  assert.equal(f.store.autoMemory.profile(bob).pending.length,0);
});

test('explicit retry can archive legacy input and progress pending without a purpose property', async t => {
  const f=fixture(t);const source=f.inbound('我喜欢茶');
  const person=f.store.autoMemory.personForActor(f.store.findActor(f.conversation.id,'alice'));
  f.store.autoMemory.addProfilePending(person,source,'喜欢茶','self');
  const {job,input}=f.batch();
  for(const profile of input.profiles) for(const pending of profile.pending??[]) delete pending.purpose;
  f.inspect(db=>db.prepare('UPDATE auto_memory_jobs SET input_json=?,progress_json=? WHERE id=?').run(JSON.stringify(input),JSON.stringify({
    remaining:[input.messages.map(message=>message.id)],profiles:input.profiles,
    extract:{topics:[],fragments:[],profiles:[],ignoredMessageIds:[]},
  }),job.id));
  f.store.autoMemory.fail(job.id,job.leaseToken,'legacy failed job');f.restart();f.store.autoMemory.retry(job.id);
  const worker=new BackgroundMemory({contextWindow:100000,memory:{enabled:true,maxCalls:2,maxRetries:3,timeoutMs:1000}},
    f.store.autoMemory,f.conversation.id,{extract:async captured=>{
      const profile=captured.profiles.find(item=>item.personId===person);
      assert.equal(profile.pending[0].purpose,undefined);
      return {topics:[],fragments:[],ignoredMessageIds:[source],profiles:[{personId:person,baseVersion:profile.baseVersion,
        facts:[{content:'喜欢茶',sourceType:'self',messageIds:[source]}],pendingIds:[profile.pending[0].id]}]};
    }});
  t.after(()=>worker.close());worker.start();await worker.wait(undefined,2000);
  assert.equal(f.store.autoMemory.profile(person).pending.length,0);assert.equal(f.store.autoMemory.profile(person).facts[0].content,'喜欢茶');
  assert.equal(f.store.autoMemory.listJobs()[0].attempts,2);
});

test('embedding dispatch markers survive restart and prevent automatic repeats of unknown results', t => {
  const f=fixture(t); const id=f.inbound('杭州茶叶'); const {job,output}=f.batch();
  output.topics=[{summary:'杭州茶叶',messageIds:[id]}];f.store.autoMemory.commit(job.id,job.leaseToken,output);
  const topic=f.store.autoMemory.pendingTopics()[0], meta={model:'e',dimensions:2,inputVersion:1};
  assert.equal(f.store.autoMemory.beginTopicEmbedding(topic,meta),true);
  assert.equal(f.store.autoMemory.beginTopicEmbedding(topic,meta),false);
  f.restart(); assert.equal(f.store.autoMemory.pendingTopicsForConversation(f.conversation.id,meta).length,0);
  assert.equal(f.store.autoMemory.searchTopicsHybrid(f.conversation.id,{text:'杭州'}).topics.length,1);
  f.store.autoMemory.retryTopicEmbedding(topic.id);
  assert.equal(f.store.autoMemory.pendingTopicsForConversation(f.conversation.id,meta).length,1);
});

test('deduplicated facts recalled through a Topic reveal only evidence from that Topic room', t => {
  const f=fixture(t);
  const one={channel:'qq',accountId:'test',roomType:'group',roomId:'one'},two={...one,roomId:'two'};
  f.store.configurePersons([{id:'same-person',bindings:[{route:one,senderId:'alice'},{route:two,senderId:'alice'}]}]);
  const sourceOne=f.inbound('我喜欢茶');const first=f.batch();
  first.output.topics=[{summary:'喝茶偏好',messageIds:[sourceOne]}];
  first.output.fragments=[{personId:'same-person',content:'喜欢茶',sourceType:'self',messageIds:[sourceOne],topicIndex:0}];
  f.store.autoMemory.commit(first.job.id,first.job.leaseToken,first.output);
  const foreign=f.store.ensureConversation('other','/other.jsonl',two);
  f.store.recordInbound(foreign.id,'我喜欢茶',{eventId:'foreign',senderId:'alice',modelInputText:'我喜欢茶'});
  const sourceTwo=f.store.externalMessage(foreign.id,'foreign').id;
  f.store.autoMemory.reserveBatch(foreign.id,'capacity');
  const job=f.store.autoMemory.claimNext(foreign.id,{owner:'test',leaseMs:60000});
  f.store.autoMemory.commit(job.id,job.leaseToken,{topics:[{summary:'喝茶偏好',messageIds:[sourceTwo]}],
    fragments:[{personId:'same-person',content:'喜欢茶',sourceType:'self',messageIds:[sourceTwo],topicIndex:0}],profiles:[],ignoredMessageIds:[]});
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM person_fragments').get().n),1);
  const here=f.store.autoMemory.searchTopicsHybrid(f.conversation.id,{text:'喝茶偏好'}).topics;
  const there=f.store.autoMemory.searchTopicsHybrid(foreign.id,{text:'喝茶偏好'}).topics;
  assert.equal(here.length,1);assert.equal(there.length,1);
  assert.deepEqual(here[0].facts[0].messageIds,[sourceOne]);assert.deepEqual(there[0].facts[0].messageIds,[sourceTwo]);
});

test('foreign memory pending cannot become a local Topic even when shared profile sources contain its original text', t => {
  const f=fixture(t),one={channel:'qq',accountId:'test',roomType:'group',roomId:'one'},two={...one,roomId:'two'};
  f.store.configurePersons([{id:'same-person',bindings:[{route:one,senderId:'alice'},{route:two,senderId:'alice'}]}]);
  const foreign=f.store.ensureConversation('foreign','/foreign.jsonl',two);
  f.store.recordInbound(foreign.id,'我喜欢茶，也去过杭州',{eventId:'foreign',senderId:'alice',modelInputText:'原始内容'});
  const source=f.store.externalMessage(foreign.id,'foreign').id;
  f.store.autoMemory.addProfilePending('same-person',source,'去过杭州','self',{purpose:'memory'});
  f.store.autoMemory.addProfilePending('same-person',source,'喜欢茶','self',{purpose:'profile'});
  f.inbound('本房间新消息');const batch=f.batch();
  assert.equal(batch.input.profiles[0].pending.length,1);assert.equal(batch.input.profiles[0].pending[0].purpose,'profile');
  assert.ok(batch.input.profileSources.some(message=>message.id===source));
  const allPending=f.store.autoMemory.profile('same-person').pending;
  // Also fence a previously frozen or forged snapshot that still captured the foreign memory entry.
  batch.input.profiles[0].pending=allPending;
  f.inspect(db=>db.prepare('UPDATE auto_memory_jobs SET input_json=? WHERE id=?').run(JSON.stringify(batch.input),batch.job.id));
  const invalid={...batch.output,topics:[{summary:'外房间杭州事件',messageIds:[source]}]};
  assert.throws(()=>validateExtract(invalid,batch.input),/输入以外|当前会话/);
  assert.throws(()=>f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,invalid),/固定批次|当前会话/);
  assert.equal(f.store.autoMemory.profile('same-person').pending.length,2);
  f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,batch.output);
  assert.equal(f.store.autoMemory.profile('same-person').pending.length,2);
});

test('failed extraction records safe phase diagnostics, preserves its batch, and never retries implicitly', async t => {
  const f=fixture(t); for(let i=0;i<100;i++)f.inbound(`真人消息${i}`);
  let calls=0;
  const worker=new BackgroundMemory({contextWindow:100000,memory:{enabled:true,maxCalls:20,maxRetries:3,timeoutMs:200}},
    f.store.autoMemory,f.conversation.id,{extract:async()=>{calls++;throw new Error('Bearer sk-secret 原始用户机密内容');}});
  t.after(()=>worker.close()); worker.start(); await assert.rejects(worker.wait(undefined,2000),/失败/);
  assert.equal(calls,1);assert.equal(f.store.autoMemory.status(f.conversation.id).failed,1);assert.equal(f.store.autoMemory.status(f.conversation.id).queued,1);
  worker.start(); await assert.rejects(worker.wait(undefined,2000),/失败/);assert.equal(calls,1);
  const error=f.store.autoMemory.listJobs().find(job=>job.status==='failed').error;
  assert.match(error,/\[unexpected\].*phase=extract/);assert.doesNotMatch(error,/sk-secret|机密/);
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM auto_memory_job_messages').get().n),100);
});

test('assistant ignored IDs fail during validation before commit instead of becoming misleading coverage', () => {
  const input={roomType:'group',messages:[{id:'u',role:'user',personId:'alice'},{id:'a',role:'assistant'}],profiles:[]};
  assert.throws(()=>validateExtract({topics:[],fragments:[],profiles:[],ignoredMessageIds:['u','a']},input),/只能引用真人/);
  assert.doesNotThrow(()=>validateExtract({topics:[],fragments:[],profiles:[],ignoredMessageIds:['u']},input));
});
