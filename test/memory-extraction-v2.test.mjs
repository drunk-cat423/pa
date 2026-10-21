import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { BackgroundMemory, validateExtract } from '../dist/auto-memory.js';
import { prepareMemoryExtraction, MemoryInputTooLargeError } from '../dist/memory-provider.js';
import { assertMemoryOutputFits, MemoryOutputBudgetError } from '../dist/memory-work.js';
import { emptyExtraction, legacyFrozenInput } from './fixtures/memory-output.mjs';
import { downgradeSchema20 } from './fixtures/legacy-schema.mjs';

const config = { contextWindow: 1_000_000, memory: { enabled: true, maxCalls: 0, maxOutputTokens: 8192, timeoutMs: 3000 } };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pa-memory-v2-')), path = join(directory, 'store.sqlite');
  let store = new ConversationStore(path), event = 0;
  const workers = [], route = {channel:'qq',accountId:'test',roomType:'group',roomId:'one'};
  const room = store.ensureConversation('one','/one.jsonl',route);
  t.after(async () => { for (const worker of workers) await worker.close(); store.close(); rmSync(directory,{recursive:true,force:true}); });
  return { directory, path, room, route, get store() { return store; },
    inbound(text, senderId = 'alice', conversation = room) {
      const input = {eventId:String(++event),senderId,senderName:senderId,modelInputText:text};
      store.recordInbound(conversation.id,text,input); return store.externalMessage(conversation.id,input.eventId).id;
    },
    freeze() { store.autoMemory.reserveBatch(room.id,'capacity'); const job = store.autoMemory.claimNext(room.id,{owner:'test',leaseMs:60000}); return {job,input:store.autoMemory.taskInput(job)}; },
    reserveMaterials(now = 1000) {
      store.autoMemory.reserveMaterialsIfDue(room.id,now);
      return store.autoMemory.reserveMaterialsIfDue(room.id,now + 600_000);
    },
    worker(provider, overrides = config) { const worker = new BackgroundMemory(overrides,store.autoMemory,room.id,provider); workers.push(worker); return worker; },
    restart() { store.close(); store = new ConversationStore(path); },
    inspect(action) { const db = new DatabaseSync(path); try { return action(db); } finally { db.close(); } },
  };
}

function proposal(input, summary = '继续讨论已确认的决定') {
  if (input.mode === 'profiles') return {profiles:input.profiles.map(profile => ({...profile,pendingResults:(profile.pending??[]).map(item => ({pendingId:item.id,status:'deferred'}))}))};
  if (input.mode === 'self') return {...emptyExtraction(input),selfProfile:{baseVersion:input.selfProfile.baseVersion,content:input.selfProfile.content,
    protocol:2,updates:[],pendingIds:[]}};
  return emptyExtraction(input,summary);
}

test('two thousand messages compress to a bounded summary while every original stays retained',async t=>{
  const f=fixture(t); for(let i=0;i<2000;i++) f.inbound(`普通消息${i}`);
  let calls=0, captured, result;
  const worker=f.worker({extract:async input=>{calls++;captured=input;result=proposal(input,'本批讨论的有效决定');return result;}});
  worker.start('capacity');await worker.wait(undefined,15000);
  assert.equal(calls,1);assert.equal(captured.messages.length,2000);assert.equal(captured.extractionProtocol,2);
  assert.ok(JSON.stringify(result).length<400);
  assert.equal(result.continuationSummary,'本批讨论的有效决定');
  const wire=JSON.parse(prepareMemoryExtraction(captured,1_000_000).userContent);
  assert.equal(wire.messages[0].id,'m0');assert.equal(wire.messages.at(-1).id,'m1999');
  assert.ok(!JSON.stringify(wire).includes(captured.messages[0].id));
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM messages').get().n),2000);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM memory_topic_messages').get().n),0);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM memory_topic_scopes').get().n),0);
  assert.equal(f.store.autoMemory.conversationContext(f.room.id).summary,'本批讨论的有效决定');
  assert.equal(f.store.autoMemory.conversationContext(f.room.id).messages.length,0);
});

test('range Topics track their actual step membership, skip unrelated rooms and do not borrow legacy facts',async t=>{
  const f=fixture(t), ids=['早期甲','早期乙','后期甲','后期乙'].map(text=>f.inbound(text));
  const other=f.store.ensureConversation('other','/other.jsonl',{...f.route,roomId:'other'});
  const foreign=f.inbound('其他房间','alice',other);
  const worker=f.worker({extract:async input=>{
    if(input.mode!=='profiles'&&input.messages.length>2)throw new MemoryInputTooLargeError('offline split');
    if(input.mode==='profiles')return proposal(input);
    return {...proposal(input),topics:[{summary:input.messages[0].text+'话题',messageIds:[]}]};
  }});
  assert.ok(f.reserveMaterials());worker.start();await worker.wait(undefined,10000,'materials');
  const topics=f.store.autoMemory.searchTopics(f.room.id,{text:'话题'}).topics;
  assert.equal(topics.length,2);
  const early=topics.find(topic=>topic.summary.startsWith('早期')), late=topics.find(topic=>topic.summary.startsWith('后期'));
  assert.deepEqual(early.sourceRange,{startOrdinal:0,endOrdinal:1});assert.deepEqual(late.sourceRange,{startOrdinal:2,endOrdinal:3});
  assert.equal(f.store.autoMemory.topicTouchesSources(early,[ids[0]]),true);
  assert.equal(f.store.autoMemory.topicTouchesSources(late,[ids[0]]),false);
  assert.equal(f.store.autoMemory.topicTouchesSources(early,[foreign]),false);
  assert.deepEqual(early.facts,[]);assert.deepEqual(late.messageIds,[]);
  assert.deepEqual(f.store.autoMemory.searchTopics(other.id,{text:'话题'}).topics,[]);
});

test('missing, overlapping, out of bounds and mismatched completion ranges never advance the summary',t=>{
  const f=fixture(t);f.inbound('one');f.inbound('two');const {job,input}=f.freeze();
  const base=emptyExtraction(input);
  for(const ranges of [undefined,[],[{startOrdinal:0,endOrdinal:0}], [{startOrdinal:0,endOrdinal:1},{startOrdinal:1,endOrdinal:1}], [{startOrdinal:0,endOrdinal:2}]]){
    assert.throws(()=>f.store.autoMemory.commit(job.id,job.leaseToken,{...base,processedRanges:ranges}),/回执|范围|快照/);
  }
  assert.throws(()=>f.store.autoMemory.commit(job.id,job.leaseToken,{...base,topics:[{summary:'topic',messageIds:[],sourceRange:{startOrdinal:0,endOrdinal:0}}]}),/回执/);
  assert.equal(f.store.autoMemory.conversationContext(f.room.id).summaryVersion,0);
  assert.equal(f.store.autoMemory.conversationContext(f.room.id).messages.length,2);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM memory_topics').get().n),0);
});

test('new model results cannot return UUID coverage lists or event fragments',t=>{
  const f=fixture(t),id=f.inbound('one');const {input}=f.freeze();const base=emptyExtraction(input);
  assert.throws(()=>validateExtract({...base,ignoredMessageIds:[id]},input),/不接受逐条覆盖/);
  assert.throws(()=>validateExtract({...base,fragments:[{}]},input),/人物事件片段/);
  assert.throws(()=>validateExtract({...base,topics:[{summary:'topic',messageIds:[id]}]},input),/来源范围/);
});

test('profile cleanup, range Topic and summary stay in one transaction when a late write fails',t=>{
  const f=fixture(t),source=f.inbound('我喜欢绘画'),person=f.store.autoMemory.personForActor(f.store.findActor(f.room.id,'alice'));
  f.store.autoMemory.addProfilePending(person,source,'喜欢绘画','self');const {job,input}=f.freeze();
  const pending=input.profiles[0].pending[0];
  const result=validateExtract({...emptyExtraction(input),topics:[{summary:'绘画话题',messageIds:[]}],profiles:[{personId:person,baseVersion:0,
    facts:[{content:'喜欢绘画',sourceType:'self',messageIds:[source]}],pendingResults:[{pendingId:pending.id,status:'merged',factIndex:0}]}]},input);
  f.inspect(db=>db.exec("CREATE TRIGGER fail_summary BEFORE UPDATE ON conversation_context_state BEGIN SELECT RAISE(ABORT,'forced commit failure'); END;"));
  assert.throws(()=>f.store.autoMemory.commit(job.id,job.leaseToken,result),/forced commit failure/);
  assert.equal(f.store.autoMemory.profile(person).baseVersion,0);assert.equal(f.store.autoMemory.profile(person).pending.length,1);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM memory_topic_scopes').get().n),0);
  assert.equal(f.store.autoMemory.conversationContext(f.room.id).summaryVersion,0);
  f.inspect(db=>db.exec('DROP TRIGGER fail_summary'));
  f.store.autoMemory.commit(job.id,job.leaseToken,result);
  assert.equal(f.store.autoMemory.profile(person).pending.length,0);assert.equal(f.store.autoMemory.profile(person).facts[0].content,'喜欢绘画');
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM person_profile_pending_results').get().n),1);
  assert.equal(f.inspect(db=>db.prepare('SELECT text FROM messages WHERE id=?').get(source).text),'我喜欢绘画');
});

test('output-budget splitting retains third-party statements for a single-person profile step',async t=>{
  const f=fixture(t);f.inbound('我是小乙','bob');const source=f.inbound('bob一直喜欢绘画','alice');
  const bob=f.store.autoMemory.personForActor(f.store.findActor(f.room.id,'bob'));let checked=false;
  f.store.autoMemory.addProfilePending(bob,source,'bob一直喜欢绘画','third_party',{allowThirdParty:true});
  const worker=f.worker({extract:async input=>{
    if(input.mode===undefined)throw new MemoryInputTooLargeError('offline split');
    if(input.mode==='profiles')return {profiles:input.profiles.map(profile=>{
      if(profile.personId!==bob)return {...profile,pendingResults:[]};
      assert.ok(input.messages.some(message=>message.id===source));checked=true;
      return {...profile,facts:[{content:'喜欢绘画',sourceType:'third_party',messageIds:[source]}],
        updates:[{factIndex:0,baselineFactIndexes:[],evidence:[profile.pending[0].subject]}],
        pendingResults:[{pendingId:profile.pending[0].id,status:'merged',factIndex:0}]};
    })};
    return proposal(input);
  }});
  assert.ok(f.reserveMaterials());worker.start();await worker.wait(undefined,10000,'materials');
  assert.equal(checked,true);assert.equal(f.store.autoMemory.profile(bob).facts[0].sourceType,'third_party');
});

test('self pending splits before requests and a restart resumes only unfinished steps before atomic archival',async t=>{
  const f=fixture(t);for(let i=0;i<12;i++){const source=f.inbound(`以后你的表达采用建议${i}`);f.store.autoMemory.selfProfile.addPending(source,`以后你的表达采用建议${i}`);}
  const settings={...config,memory:{...config.memory,maxOutputTokens:512}};
  const successes=[],attempts=[];let fail=true;
  const provider={extract:async input=>{
    if(input.mode!=='self'){assert.equal(input.selfProfile,undefined);return proposal(input,'简短续聊摘要');}
    const pending=input.selfProfile.pending;attempts.push(pending.map(item=>item.id));
    if(successes.length&&fail){fail=false;throw new Error('unknown provider result');}
    const result={...proposal(input),selfProfile:{baseVersion:input.selfProfile.baseVersion,content:'简洁的对话伙伴',
      protocol:2,updates:[],pendingIds:pending.map(item=>item.id)}};
    successes.push(pending.map(item=>item.id));return result;
  }};
  assert.ok(f.reserveMaterials());const first=f.worker(provider,settings);first.start();await assert.rejects(first.wait(undefined,10000,'materials'),/失败/);
  const job=f.store.autoMemory.listJobs()[0],before=f.inspect(db=>db.prepare('SELECT input_json,progress_json FROM auto_memory_jobs WHERE id=?').get(job.id));
  assert.equal(JSON.parse(before.progress_json).version,3);assert.equal(successes.length,1);
  assert.equal(f.store.autoMemory.selfProfile.snapshot().pending.length,12);assert.equal(f.store.autoMemory.conversationContext(f.room.id).summaryVersion,0);
  await first.close();f.restart();const second=f.worker(provider,settings);second.retry(job.id);await second.wait(undefined,10000,'materials');
  assert.equal(successes.length,2);assert.equal(attempts.filter(ids=>ids.join()===successes[0].join()).length,1);
  assert.equal(f.store.autoMemory.selfProfile.snapshot().pending.length,0);assert.equal(f.store.autoMemory.selfProfile.snapshot().sourceMessageIds,undefined);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM self_profile_update_sources WHERE pending_id IS NOT NULL').get().n),12);
  assert.equal(f.inspect(db=>db.prepare('SELECT input_json FROM auto_memory_jobs WHERE id=?').get(job.id)).input_json,before.input_json);
  assert.equal(f.store.autoMemory.conversationContext(f.room.id).summaryVersion,0);
  assert.equal(second.info('materials').hasSummary,false);
});

test('an indivisible full profile can fail output preflight without submitting any request',()=>{
  const input={extractionProtocol:2,mode:'profiles',profiles:[{personId:'p',baseVersion:1,facts:[{content:'稳定信息'.repeat(45),sourceType:'self',messageIds:['one']}]}]};
  assert.throws(()=>assertMemoryOutputFits(input,{...config,memory:{...config.memory,maxOutputTokens:128}}),MemoryOutputBudgetError);
});

test('a long existing AI profile can still be consolidated without cropping its input or evidence',()=>{
  const input={extractionProtocol:2,mode:'self',profiles:[],selfProfile:{baseVersion:2,content:'风格'.repeat(2000),
    sourceMessageIds:Array.from({length:100},(_,i)=>`source-${i}`),pending:[{id:'pending',content:'表达自然',sourceMessageId:'new-source'}]}};
  assert.doesNotThrow(()=>assertMemoryOutputFits(input,config));
  assert.equal(input.selfProfile.content.length,4000);assert.equal(input.selfProfile.sourceMessageIds.length,100);
});

test('v19 upgrade adds range metadata and backup without altering old exact Topic links or messages',t=>{
  const f=fixture(t),id=f.inbound('旧话题');const {job}=f.freeze();const input=legacyFrozenInput(f.store,f.path,job);
  f.store.autoMemory.commit(job.id,job.leaseToken,{...emptyExtraction(input),ignoredMessageIds:[],topics:[{summary:'旧话题',messageIds:[id]}]});
  const before=f.inspect(db=>({messages:db.prepare('SELECT * FROM messages').all(),links:db.prepare('SELECT * FROM memory_topic_messages').all()}));
  f.store.close();f.inspect(db=>{downgradeSchema20(db);db.exec('DROP TABLE memory_topic_scopes; PRAGMA user_version=19;');});f.restart();
  assert.equal(f.inspect(db=>db.prepare('PRAGMA user_version').get().user_version),23);
  assert.ok(readdirSync(f.directory).some(name=>name.includes('.v19.')&&name.endsWith('.bak')));
  assert.deepEqual(f.inspect(db=>({messages:db.prepare('SELECT * FROM messages').all(),links:db.prepare('SELECT * FROM memory_topic_messages').all()})),before);
  const topic=f.store.autoMemory.searchTopics(f.room.id,{text:'旧话题'}).topics[0];assert.equal(topic.sourceRange,undefined);assert.deepEqual(topic.messageIds,[id]);
});
