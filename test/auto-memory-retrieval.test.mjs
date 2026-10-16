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
      assert.equal(input.profileProtocol,2);
      return {job,input, output:{topics:[],fragments:[],profiles:[],ignoredMessageIds:input.messages.filter(m=>m.role==='user').map(m=>m.id)}};
    },
    inspect(action) { const db=new DatabaseSync(path); db.function('history_tokens',{deterministic:true},value=>memoryWords(String(value??'')).join(' '));
      try { return action(db); } finally { db.close(); } }};
}

function currentProgress(input) {
  return {version:2,remaining:[{messageIds:input.messages.map(message=>message.id),personIds:input.profiles.map(profile=>profile.personId)}],
    profiles:input.profiles,extract:{topics:[],fragments:[],profiles:[],ignoredMessageIds:[]}};
}

test('Topic FTS migration backfills existing summaries, stays idempotent, and synchronizes updates', t => {
  const f=fixture(t); const id=f.inbound('讨论递归改进的方案');
  const {job,output}=f.batch(); output.topics=[{summary:'递归改进与智能体方案',messageIds:[id]}];
  f.store.autoMemory.commit(job.id,job.leaseToken,output);
  const topic=f.store.autoMemory.searchTopics(f.conversation.id,{text:'递归改进'}).topics[0];
  f.inspect(db=>{
    db.exec('DROP TRIGGER index_topic_insert; DROP TRIGGER index_topic_update; DROP TRIGGER index_topic_delete; DROP TABLE memory_topic_fts');
    migrateMemoryRetrieval(db); migrateMemoryRetrieval(db);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_topic_fts').get().n,1);
  });
  assert.equal(f.store.autoMemory.searchTopics(f.conversation.id,{text:'递归改进'}).topics[0].id,topic.id);
  f.inspect(db=>db.prepare('UPDATE memory_topics SET summary=? WHERE id=?').run('深圳旅行计划',topic.id));
  assert.equal(f.store.autoMemory.searchTopics(f.conversation.id,{text:'递归改进'}).topics.length,0);
  assert.equal(f.store.autoMemory.searchTopics(f.conversation.id,{text:'深圳旅行'}).topics[0].id,topic.id);
});

test('Topic BM25 search is room scoped and retrieval performs no model request', async t => {
  const f=fixture(t),id=f.inbound('测试计划'),{job,output}=f.batch();
  output.topics=[{summary:'杭州茶叶旅行',messageIds:[id]},{summary:'北京编程聚会',messageIds:[id]}];
  f.store.autoMemory.commit(job.id,job.leaseToken,output);
  const result=f.store.autoMemory.searchTopics(f.conversation.id,{text:'杭州茶叶'});
  assert.equal(result.status,'ready');assert.equal(result.topics[0].summary,'杭州茶叶旅行');
  assert.ok(result.topics[0].score>0);
  assert.deepEqual(f.store.autoMemory.searchTopics('foreign-room',{text:'杭州'}).topics,[]);
  assert.deepEqual(f.store.autoMemory.searchTopics(f.conversation.id,{text:'不存在'}).topics,[]);
  assert.deepEqual(f.store.autoMemory.searchTopics(f.conversation.id,{text:''}).topics,[]);
  assert.throws(()=>f.store.autoMemory.searchTopics(f.conversation.id,{text:'杭州',limit:0}),/参数/);
  let calls=0;
  const worker=new BackgroundMemory({contextWindow:100000,memory:{enabled:true,maxCalls:10,timeoutMs:100}},
    f.store.autoMemory,f.conversation.id,{extract:async()=>{calls++;throw new Error('unused');}});
  t.after(()=>worker.close());
  assert.equal((await worker.retrieve('杭州茶叶')).topics[0].summary,'杭州茶叶旅行');
  assert.equal(calls,0);assert.equal(worker.info().calls,0);
  const controller=new AbortController();controller.abort();
  assert.equal((await worker.retrieve('杭州茶叶',controller.signal)).status,'unavailable');
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

test('legacy personal-event pending stays stored but never enters profiles or new batches', t => {
  const f=fixture(t),source=f.inbound('我今年去过杭州'),stableSource=f.inbound('我喜欢茶');
  const person=f.store.autoMemory.personForActor(f.store.findActor(f.conversation.id,'alice'));
  assert.throws(()=>f.store.autoMemory.addProfilePending(person,source,'今年去过杭州','self',{purpose:'memory'}),/仅支持画像/);
  f.store.autoMemory.addProfilePending(person,stableSource,'喜欢茶','self');
  f.inspect(db=>db.prepare("INSERT INTO person_profile_pending(id,person_id,content,source_message_id,source_type,created_at,purpose) VALUES ('legacy-event',?,?,?,'self',?,'memory')")
    .run(person,'今年去过杭州',source,new Date().toISOString()));
  const before=f.inspect(db=>db.prepare("SELECT * FROM person_profile_pending WHERE id='legacy-event'").get());
  const batch=f.batch(),profile=batch.input.profiles.find(item=>item.personId===person);
  assert.deepEqual(profile.pending.map(item=>item.content),['喜欢茶']);
  const pendingId=profile.pending[0].id;
  batch.output.profiles=[{personId:person,baseVersion:0,facts:[{content:'喜欢茶',sourceType:'self',messageIds:[stableSource]}],
    pendingResults:[{pendingId,status:'merged',factIndex:0}]}];
  f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,validateExtract(batch.output,batch.input));f.restart();
  assert.deepEqual(f.store.autoMemory.profile(person).pending,[]);
  assert.equal(f.inspect(db=>db.prepare('SELECT * FROM person_profile_pending WHERE id=?').get(pendingId)),undefined);
  assert.deepEqual({...f.inspect(db=>db.prepare('SELECT pending_id,person_id,source_message_id,outcome,profile_revision,fact_index FROM person_profile_pending_results WHERE job_id=? AND pending_id=?').get(batch.job.id,pendingId))},
    {pending_id:pendingId,person_id:person,source_message_id:stableSource,outcome:'merged',profile_revision:1,fact_index:0});
  assert.deepEqual(f.inspect(db=>db.prepare("SELECT * FROM person_profile_pending WHERE id='legacy-event'").get()),before);
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM person_fragments').get().n),0);
});

test('a captured third-party target is organized even when only its recorder spoke in this batch', async t => {
  const f=fixture(t); f.inbound('我是小乙','bob');
  let batch=f.batch();f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,batch.output);
  const bob=f.store.autoMemory.personForActor(f.store.findActor(f.conversation.id,'bob'));
  const source=f.inbound('小乙喜欢绘画','owner');
  f.store.autoMemory.addProfilePending(bob,source,'喜欢绘画','third_party',{allowThirdParty:true});
  let captured;
  const worker=new BackgroundMemory({contextWindow:100000,memory:{enabled:true,maxCalls:2,timeoutMs:1000}},
    f.store.autoMemory,f.conversation.id,{extract:async input=>{
      captured=input;
      const person=input.profiles.find(profile=>profile.personId===bob),pending=person.pending[0];
      return {topics:[],fragments:[],ignoredMessageIds:input.messages.filter(m=>m.role==='user').map(m=>m.id),
        profiles:[{personId:bob,baseVersion:person.baseVersion,facts:[{content:'喜欢绘画',sourceType:'third_party',messageIds:[source]}],
          pendingResults:[{pendingId:pending.id,status:'merged',factIndex:0}]}]};
    }});
  t.after(()=>worker.close());worker.start('capacity');await worker.wait(undefined,2000);
  assert.ok(captured.profiles.some(profile=>profile.personId===bob));
  assert.ok(!captured.messages.some(message=>message.personId===bob));
  assert.equal(f.store.autoMemory.profile(bob).facts[0].sourceType,'third_party');assert.equal(f.store.autoMemory.profile(bob).pending.length,0);
  const pendingId=captured.profiles.find(profile=>profile.personId===bob).pending[0].id;
  assert.equal(f.inspect(db=>db.prepare('SELECT * FROM person_profile_pending WHERE id=?').get(pendingId)),undefined);
  assert.deepEqual({...f.inspect(db=>db.prepare('SELECT source_message_id,outcome,fact_index FROM person_profile_pending_results WHERE pending_id=?').get(pendingId))},
    {source_message_id:source,outcome:'merged',fact_index:0});
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
    facts:[{content:'喜欢绘画',sourceType:'third_party',messageIds:[source]}],pendingResults:[{pendingId:target.pending[0].id,status:'merged',factIndex:0}]}];
  f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,validateExtract(batch.output,batch.input));
  assert.equal(f.store.autoMemory.profile(bob).pending.length,0);
  assert.equal(f.inspect(db=>db.prepare('SELECT * FROM person_profile_pending WHERE id=?').get(target.pending[0].id)),undefined);
  assert.deepEqual({...f.inspect(db=>db.prepare('SELECT source_message_id,outcome,fact_index FROM person_profile_pending_results WHERE pending_id=?').get(target.pending[0].id))},
    {source_message_id:source,outcome:'merged',fact_index:0});
});

test('explicit retry rejects legacy progress without a model call and preserves frozen input, progress and pending', async t => {
  const f=fixture(t);const source=f.inbound('我喜欢茶');
  const person=f.store.autoMemory.personForActor(f.store.findActor(f.conversation.id,'alice'));
  f.store.autoMemory.addProfilePending(person,source,'喜欢茶','self');
  const {job,input}=f.batch();
  for(const profile of input.profiles) for(const pending of profile.pending??[]) delete pending.purpose;
  const pendingBefore=f.inspect(db=>db.prepare('SELECT * FROM person_profile_pending WHERE person_id=?').all(person));
  f.inspect(db=>db.prepare('UPDATE auto_memory_jobs SET input_json=?,progress_json=? WHERE id=?').run(JSON.stringify(input),JSON.stringify({
    remaining:[input.messages.map(message=>message.id)],profiles:input.profiles,
    extract:{topics:[],fragments:[],profiles:[],ignoredMessageIds:[]}}),job.id));
  const frozen=f.inspect(db=>db.prepare('SELECT input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id));
  f.store.autoMemory.fail(job.id,job.leaseToken,'legacy failed job');f.restart();f.store.autoMemory.retry(job.id);
  let calls=0;
  const worker=new BackgroundMemory({contextWindow:100000,memory:{enabled:true,maxCalls:2,timeoutMs:1000}},
    f.store.autoMemory,f.conversation.id,{extract:async()=>{calls++;throw new Error('legacy progress must fail before extraction');}});
  t.after(()=>worker.close());worker.start();await assert.rejects(worker.wait(undefined,2000),/失败/);
  assert.equal(calls,0);assert.equal(worker.info().calls,0);
  assert.match(f.store.autoMemory.listJobs()[0].error,/profile_protocol/);
  assert.deepEqual(f.inspect(db=>db.prepare('SELECT input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id)),frozen);
  assert.deepEqual(f.inspect(db=>db.prepare('SELECT * FROM person_profile_pending WHERE person_id=?').all(person)),pendingBefore);
  assert.deepEqual(f.store.autoMemory.profile(person).facts,[]);
  assert.equal(f.inspect(db=>db.prepare('SELECT text FROM messages WHERE id=?').get(source).text),'我喜欢茶');
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM person_profile_pending_results WHERE job_id=?').get(job.id).n),0);
  assert.equal(f.store.autoMemory.listJobs()[0].attempts,2);
});

test('removed embedding APIs leave historical vectors and attempts unchanged on reopen', t => {
  const f=fixture(t),id=f.inbound('杭州茶叶'),{job,output}=f.batch();
  output.topics=[{summary:'杭州茶叶',messageIds:[id]}];f.store.autoMemory.commit(job.id,job.leaseToken,output);
  const topic=f.store.autoMemory.searchTopics(f.conversation.id,{text:'杭州'}).topics[0];
  f.inspect(db=>{
    db.prepare('INSERT INTO topic_embeddings VALUES (?,?,?,?,?,?,?,?)').run(topic.id,'old-model',2,1,topic.version,topic.contentHash,'[1,0]','old-time');
    db.prepare('INSERT INTO topic_embedding_attempts VALUES (?,?,?,?,?,?,?,?)').run(topic.id,'old-model',2,1,topic.version,topic.contentHash,'unknown-result','old-time');
  });
  const before=f.inspect(db=>({vectors:db.prepare('SELECT * FROM topic_embeddings').all(),attempts:db.prepare('SELECT * FROM topic_embedding_attempts').all()}));
  f.restart();
  for(const method of ['pendingTopics','pendingTopicsForConversation','beginTopicEmbedding','saveEmbedding','retryTopicEmbedding','searchTopicsHybrid']) assert.equal(f.store.autoMemory[method],undefined);
  assert.equal(f.store.autoMemory.searchTopics(f.conversation.id,{text:'杭州'}).topics.length,1);
  assert.deepEqual(f.inspect(db=>({vectors:db.prepare('SELECT * FROM topic_embeddings').all(),attempts:db.prepare('SELECT * FROM topic_embedding_attempts').all()})),before);
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
  const here=f.store.autoMemory.searchTopics(f.conversation.id,{text:'喝茶偏好'}).topics;
  const there=f.store.autoMemory.searchTopics(foreign.id,{text:'喝茶偏好'}).topics;
  assert.equal(here.length,1);assert.equal(there.length,1);
  assert.deepEqual(here[0].facts[0].messageIds,[sourceOne]);assert.deepEqual(there[0].facts[0].messageIds,[sourceTwo]);
});

for(const legacy of ['input','progress','proposal']) test('obsolete personal-event '+legacy+' fails explicitly and preserves frozen work', async t => {
  const f=fixture(t),source=f.inbound('旧事件'),{job,input}=f.batch();
  const progress=currentProgress(input);
  if(legacy==='input') input.profiles[0].pending=[{id:'old',content:'旧事件',sourceMessageId:source,sourceType:'self',purpose:'memory'}];
  if(legacy==='progress') progress.extract.memoryPending=[];
  f.inspect(db=>db.prepare('UPDATE auto_memory_jobs SET input_json=?,progress_json=? WHERE id=?').run(JSON.stringify(input),JSON.stringify(progress),job.id));
  const frozen=f.inspect(db=>db.prepare('SELECT input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id));
  f.store.autoMemory.fail(job.id,job.leaseToken,'prior failure');f.store.autoMemory.retry(job.id);
  let calls=0;
  const worker=new BackgroundMemory({contextWindow:100000,memory:{enabled:true,maxCalls:2,timeoutMs:500}},
    f.store.autoMemory,f.conversation.id,{extract:async()=>{calls++;return {topics:[],fragments:[],profiles:[],ignoredMessageIds:[source],memoryArchives:[]};}});
  t.after(()=>worker.close());worker.start();await assert.rejects(worker.wait(undefined,1000),/失败/);
  assert.equal(calls,legacy==='proposal'?1:0);
  assert.match(f.store.autoMemory.listJobs()[0].error,/obsolete_personal_memory/);
  assert.deepEqual(f.inspect(db=>db.prepare('SELECT input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id)),frozen);
  assert.deepEqual(f.store.autoMemory.profile(input.profiles[0].personId).facts,[]);
});

test('failed extraction records safe phase diagnostics, preserves its batch, and never retries implicitly', async t => {
  const f=fixture(t); for(let i=0;i<100;i++)f.inbound(`真人消息${i}`);
  let calls=0;
  const worker=new BackgroundMemory({contextWindow:100000,memory:{enabled:true,maxCalls:20,timeoutMs:200}},
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

test('private fragments require stable profile evidence while room Topics may retain continuation context', t => {
  const f=fixture(t),room=f.store.ensureConversation('private','/private.jsonl',{channel:'qq',accountId:'test',roomType:'private',roomId:'private'});
  f.store.recordInbound(room.id,'我今天去了杭州',{eventId:'private-source',senderId:'alice',modelInputText:'今天去了杭州'});
  const source=f.store.externalMessage(room.id,'private-source').id;
  f.store.autoMemory.reserveBatch(room.id,'capacity');const job=f.store.autoMemory.claimNext(room.id,{owner:'test',leaseMs:60000}),input=f.store.autoMemory.taskInput(job);
  const person=input.profiles[0].personId,fragment={personId:person,content:'今天去了杭州',sourceType:'self',messageIds:[source]};
  const output={topics:[{summary:'杭州行程',messageIds:[source]}],fragments:[fragment],profiles:[],ignoredMessageIds:[],continuationSummary:'接着讨论杭州行程'};
  assert.throws(()=>validateExtract(output,input),/只能保存稳定画像证据/);
  assert.throws(()=>f.store.autoMemory.commit(job.id,job.leaseToken,output),/只能保存稳定画像证据/);
  output.fragments=[];f.store.autoMemory.commit(job.id,job.leaseToken,validateExtract(output,input));
  assert.equal(f.store.autoMemory.searchTopics(room.id,{text:'杭州'}).topics.length,1);
  assert.equal(f.inspect(db=>db.prepare('SELECT COUNT(*) n FROM person_fragments').get().n),0);
});

function archivedPersonalEvent(f, withStableProfile=false) {
  const source=f.inbound('我喜欢茶，去年去了杭州'),first=f.batch(),person=first.input.profiles[0].personId;
  const stable={content:'喜欢茶',sourceType:'self',messageIds:[source]};
  const event={personId:person,content:'去年去了杭州',sourceType:'self',messageIds:[source],topicIndex:0};
  first.output.topics=[{summary:'杭州旅行讨论',messageIds:[source]}];first.output.fragments=[event];
  first.output.profiles=[{personId:person,baseVersion:0,facts:withStableProfile?[stable]:[]}];
  f.store.autoMemory.commit(first.job.id,first.job.leaseToken,first.output);
  // Model a completed pre-removal archive with its original purpose and FK to the retained revision.
  f.inspect(db=>db.prepare("INSERT INTO person_profile_pending(id,person_id,content,source_message_id,source_type,created_at,archived_revision,archived_at,purpose) VALUES ('archived-event',?,?,?,'self',?,1,?,'memory')")
    .run(person,event.content,source,'legacy-created','legacy-archived'));
  if(withStableProfile) f.store.autoMemory.addProfilePending(person,source,'喜欢茶','self');
  return {source,person,stable,event};
}

for(const sharedSource of [false,true]) test('archived event fragments cannot become new profiles'+(sharedSource?' even with a same-source profile':''), t=>{
  const f=fixture(t),legacy=archivedPersonalEvent(f,sharedSource);
  const before=f.inspect(db=>({pending:db.prepare('SELECT * FROM person_profile_pending').all(),fragments:db.prepare('SELECT * FROM person_fragments').all(),
    sources:db.prepare('SELECT * FROM person_fragment_messages').all(),revisions:db.prepare('SELECT * FROM person_profile_revisions').all()}));
  f.restart();f.inbound('继续聊');const batch=f.batch(),profile=batch.input.profiles.find(item=>item.personId===legacy.person);
  assert.deepEqual(batch.input.profileFragments,[]);assert.deepEqual(profile.pending,[]);
  assert.deepEqual(batch.input.excludedProfileSourceIds,[legacy.source]);
  assert.deepEqual(profile.facts,sharedSource?[legacy.stable]:[]);
  const malicious={...batch.output,profiles:[{personId:legacy.person,baseVersion:profile.baseVersion,
    facts:[...profile.facts,{content:legacy.event.content,sourceType:'self',messageIds:[legacy.source]}]}]};
  assert.throws(()=>validateExtract(malicious,batch.input),/协议已过期/);
  assert.throws(()=>f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,malicious),/协议已过期/);
  // Commit independently resolves original purpose rows even when frozen metadata is absent.
  const tampered={...batch.input};delete tampered.excludedProfileSourceIds;
  f.inspect(db=>db.prepare('UPDATE auto_memory_jobs SET input_json=? WHERE id=?').run(JSON.stringify(tampered),batch.job.id));
  assert.throws(()=>f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,malicious),/协议已过期/);
  const recalled=f.store.autoMemory.searchTopics(f.conversation.id,{text:'杭州'}).topics[0];
  assert.equal(recalled.facts[0].content,legacy.event.content);assert.deepEqual(recalled.facts[0].messageIds,[legacy.source]);
  batch.output.profiles=[{personId:legacy.person,baseVersion:profile.baseVersion,facts:profile.facts}];
  f.store.autoMemory.commit(batch.job.id,batch.job.leaseToken,validateExtract(batch.output,batch.input));
  const after=f.inspect(db=>({pending:db.prepare('SELECT * FROM person_profile_pending').all(),fragments:db.prepare('SELECT * FROM person_fragments').all(),
    sources:db.prepare('SELECT * FROM person_fragment_messages').all(),revisions:db.prepare('SELECT * FROM person_profile_revisions WHERE revision=1').all()}));
  assert.deepEqual(after,before);assert.deepEqual(f.store.autoMemory.profile(legacy.person).facts,sharedSource?[legacy.stable]:[]);
});

for(const frozenPart of ['input-fragment','progress-profile','progress-fragment']) test('frozen '+frozenPart+' resolving to archived events fails without rewriting JSON',async t=>{
  const f=fixture(t),legacy=archivedPersonalEvent(f);f.inbound('新批次');const batch=f.batch();
  const input=structuredClone(batch.input);delete input.excludedProfileSourceIds;
  const progress=currentProgress(input);
  if(frozenPart==='input-fragment') {
    input.profileFragments=[legacy.event];
    input.profileSources=[f.inspect(db=>({...db.prepare('SELECT id,text FROM messages WHERE id=?').get(legacy.source),
      role:'user',personId:legacy.person,conversationId:f.conversation.id}))];
  }
  if(frozenPart==='progress-profile') progress.profiles=[{...input.profiles[0],facts:[{content:legacy.event.content,sourceType:'self',messageIds:[legacy.source]}]}];
  if(frozenPart==='progress-fragment') progress.extract.fragments=[legacy.event];
  f.inspect(db=>db.prepare('UPDATE auto_memory_jobs SET input_json=?,progress_json=? WHERE id=?').run(JSON.stringify(input),JSON.stringify(progress),batch.job.id));
  const before=f.inspect(db=>db.prepare('SELECT input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(batch.job.id));
  f.store.autoMemory.fail(batch.job.id,batch.job.leaseToken,'previous failure');f.store.autoMemory.retry(batch.job.id);
  let calls=0;const worker=new BackgroundMemory({contextWindow:100000,memory:{enabled:true,maxCalls:2,timeoutMs:500}},
    f.store.autoMemory,f.conversation.id,{extract:async()=>{calls++;return batch.output;}});
  t.after(()=>worker.close());worker.start();await assert.rejects(worker.wait(undefined,1000),/失败/);
  assert.equal(calls,0);assert.match(f.store.autoMemory.listJobs()[0].error,/obsolete_personal_memory/);
  assert.deepEqual(f.inspect(db=>db.prepare('SELECT input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(batch.job.id)),before);
  assert.deepEqual(f.store.autoMemory.profile(legacy.person).facts,[]);
});
