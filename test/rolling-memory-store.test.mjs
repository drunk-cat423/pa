import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { BackgroundMemory } from '../dist/auto-memory.js';
import { MemoryInputTooLargeError, prepareMemoryExtraction } from '../dist/memory-provider.js';
import { downgradeSchema14 } from './fixtures/legacy-schema.mjs';
import { emptyExtraction } from './fixtures/memory-output.mjs';

function fixture(t, roomType='group') {
  const dir=mkdtempSync(join(tmpdir(),'pa-rolling-')),path=join(dir,'store.sqlite');
  let store=new ConversationStore(path),event=0;
  const room=store.ensureConversation('room','/room.jsonl',{channel:'qq',accountId:'test',roomType,roomId:'room'});
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,path,room,get store(){return store;},
    inbound(text,senderId='alice') {
      const input={eventId:String(++event),senderId,senderName:senderId.toUpperCase(),modelInputText:text};
      store.recordInbound(room.id,text,input);
      return {...input,existingMessageId:store.externalMessage(room.id,input.eventId).id};
    },
    reserve(before){return store.autoMemory.reserveBatch(room.id,'capacity',50,before);},
    claim(){return store.autoMemory.claimNext(room.id,{owner:'worker',leaseMs:60000});},
    context(before){return store.autoMemory.conversationContext(room.id,before);},
    restart(){store.close();store=new ConversationStore(path);},
    inspect(fn){const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}},
  };
}
function output(input,summary='rolling summary') {
  return emptyExtraction(input, summary);
}
function commit(f,summary) {const job=f.claim(),input=f.store.autoMemory.taskInput(job);f.store.autoMemory.commit(job.id,job.leaseToken,output(input,summary));return input;}

for(const roomType of ['group','private']) test(`${roomType} snapshots include the full human suffix beyond fifty and carry the previous summary`,t=>{
  const f=fixture(t,roomType);
  for(let i=0;i<123;i++)f.inbound(`message ${i}`);
  const current=f.inbound('current question');
  const job=f.reserve(current.existingMessageId);assert.equal(job.messageIds.length,123);
  assert.equal(f.reserve(current.existingMessageId),undefined);
  const original=f.context(current.existingMessageId);assert.equal(original.messages.length,123);assert.equal(original.summary,undefined);
  commit(f,'all earlier decisions');
  const snapshot=f.context();assert.equal(snapshot.summary,'all earlier decisions');assert.equal(snapshot.messages.length,1);
  assert.equal(snapshot.messages[0].id,current.existingMessageId);assert.equal(snapshot.summaryVersion,1);
  f.inbound('next');f.reserve();const input=commit(f,'earlier decisions plus current and next');
  assert.equal(input.previousSummary,'all earlier decisions');assert.deepEqual(input.messages.map(m=>m.text),['current question','next']);
  assert.equal(f.context().messages.length,0);f.restart();assert.equal(f.context().summaryVersion,2);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM messages').get().n),125);
});

test('late delivery appends after a committed prefix and retains original sender and reply identity',t=>{
  const f=fixture(t,'private'),source=f.inbound('question');
  const run=f.store.beginRun(f.room.id,'question','p','m',[],source);
  const delivery=f.store.completeRun(run.id,'late answer');
  const later=f.inbound('later human','bob');
  const prefix=f.context();assert.deepEqual(prefix.messages.map(m=>m.text),['question','later human']);
  f.reserve();const job=f.claim(),input=f.store.autoMemory.taskInput(job);
  f.store.ackDelivery(delivery.deliveryId,'sent');
  assert.deepEqual(f.store.autoMemory.taskInput(job),input);
  f.store.autoMemory.commit(job.id,job.leaseToken,output(input));
  const tail=f.context().messages;assert.deepEqual(tail.map(m=>m.text),['late answer']);
  assert.equal(tail[0].replyToSenderId,'alice');assert.equal(tail[0].replyToMessageId,source.existingMessageId);
  assert.ok(tail[0].contextSeq>prefix.messages.at(-1).contextSeq);
  f.store.ackDelivery(delivery.deliveryId,'sent');assert.equal(f.context().messages.length,1);
  assert.deepEqual(f.context(later.existingMessageId).messages.map(m=>m.text),['question']);
  assert.equal(prefix.messages[0].senderId,'alice');assert.equal(prefix.messages[0].senderName,'ALICE');
  f.restart();assert.deepEqual(f.context().messages,tail);
});

test('failed snapshots retain all raw text; explicit deferral keeps the gap while later summaries advance',t=>{
  const f=fixture(t);f.inbound('deferred original');f.reserve();const first=f.claim();
  const input=f.store.autoMemory.taskInput(first);f.store.autoMemory.saveProgress(first.id,first.leaseToken,{saved:'unchanged'});
  f.store.autoMemory.fail(first.id,first.leaseToken,'unknown call');f.inbound('later statement');
  assert.equal(f.reserve(),undefined);assert.equal(f.context().messages.length,2);
  f.store.autoMemory.defer(first.id,'operator chose to preserve original');
  const frozen=f.inspect(db=>db.prepare('SELECT input_json,progress_json,error FROM auto_memory_jobs WHERE id=?').get(first.id));
  f.reserve();const second=commit(f,'later statement; earlier range remains deferred');
  assert.deepEqual(second.messages.map(m=>m.text),['later statement']);assert.equal(second.deferredRanges.length,1);
  assert.equal(f.context().checkpoint,0);assert.ok(f.context().summaryCursor>0);
  assert.deepEqual(f.context().messages.map(m=>m.text),['deferred original']);
  f.restart();assert.deepEqual(f.context().messages.map(m=>m.text),['deferred original']);
  assert.throws(()=>f.store.autoMemory.retry(first.id),/搁置/);
  assert.deepEqual(f.inspect(db=>db.prepare('SELECT input_json,progress_json,error FROM auto_memory_jobs WHERE id=?').get(first.id)),frozen);
  assert.equal(input.messages.length,1);
});

test('v14 migration backs up original jobs and preserves old done group Topic history without a summary',t=>{
  const f=fixture(t);const source=f.inbound('old Topic evidence');
  f.store.autoMemory.reserveBatch(f.room.id,'count',1);const job=f.claim(),input=f.store.autoMemory.taskInput(job);
  f.store.autoMemory.commit(job.id,job.leaseToken,{topics:[{summary:'old Topic',messageIds:[source.existingMessageId]}],fragments:[],profiles:[],ignoredMessageIds:[]});
  const before=f.inspect(db=>({jobs:db.prepare('SELECT * FROM auto_memory_jobs').all(),messages:db.prepare('SELECT * FROM messages').all()}));
  f.store.close();f.inspect(db=>{downgradeSchema14(db);db.exec('PRAGMA user_version=14;');});f.restart();
  assert.ok(readdirSync(f.dir).some(name=>name.includes('.v14.')&&name.endsWith('.bak')));
  assert.deepEqual(f.inspect(db=>({jobs:db.prepare('SELECT * FROM auto_memory_jobs').all(),messages:db.prepare('SELECT * FROM messages').all()})),before);
  assert.equal(f.context().summary,undefined);assert.deepEqual(f.context().messages.map(m=>m.id),[source.existingMessageId]);
  assert.deepEqual(f.reserve().messageIds,[source.existingMessageId]);commit(f,'whole room history');
  assert.equal(f.context().messages.length,0);assert.equal(f.store.autoMemory.searchTopics(f.room.id,{text:'Topic'}).topics.length,1);
  assert.equal(input.contextProtocol,undefined);
});

test('independent SQLite connections cannot reserve overlapping snapshots or steal a live lease',t=>{
  const f=fixture(t);f.inbound('one');const first=f.reserve();
  const other=new ConversationStore(f.path);
  try {
    assert.equal(other.autoMemory.reserveBatch(f.room.id,'capacity'),undefined);
    const job=f.claim();
    assert.equal(other.autoMemory.claimNext(f.room.id,{owner:'other',leaseMs:60000}),undefined);
    f.inbound('two');assert.equal(other.autoMemory.reserveBatch(f.room.id,'capacity'),undefined);
    f.store.autoMemory.commit(job.id,job.leaseToken,output(f.store.autoMemory.taskInput(job)));
    const second=other.autoMemory.reserveBatch(f.room.id,'capacity');
    assert.equal(first.messageIds.some(id=>second.messageIds.includes(id)),false);
    assert.equal(second.messageIds.length,1);
  } finally {other.close();}
});

test('v14 frozen failed jobs are isolated and keep their input and progress unchanged',async t=>{
  const f=fixture(t);f.inbound('legacy input');
  f.store.autoMemory.reserveBatch(f.room.id,'count',1);const job=f.claim();
  const input=f.store.autoMemory.taskInput(job);
  f.store.autoMemory.saveProgress(job.id,job.leaseToken,{version:2,
    remaining:[{messageIds:input.messages.map(m=>m.id),personIds:input.profiles.map(p=>p.personId)}],
    profiles:input.profiles,extract:{topics:[],fragments:[],profiles:[],ignoredMessageIds:[]}});
  f.store.autoMemory.fail(job.id,job.leaseToken,'unknown result');
  const frozen=f.inspect(db=>db.prepare('SELECT input_json,progress_json,error FROM auto_memory_jobs WHERE id=?').get(job.id));
  f.store.close();f.inspect(db=>{downgradeSchema14(db);db.exec('PRAGMA user_version=14;');});f.restart();
  let calls=0;
  const worker=new BackgroundMemory({contextWindow:8192,memory:{enabled:true,maxCalls:2,timeoutMs:1000}},
    f.store.autoMemory,f.room.id,{extract:async captured=>{
      calls++;assert.equal(captured.contextProtocol,undefined);
      const result=output(captured);delete result.continuationSummary;return result;
    }});
  t.after(()=>worker.close());
  worker.start();await worker.wait();assert.equal(calls,0);
  assert.deepEqual(f.inspect(db=>db.prepare('SELECT input_json,progress_json,error FROM auto_memory_jobs WHERE id=?').get(job.id)),frozen);
  assert.equal(f.store.autoMemory.status(f.room.id).isolated,1);
  assert.throws(()=>worker.retry(job.id),/隔离/);
  assert.equal(f.inspect(db=>db.prepare('SELECT input_json FROM auto_memory_jobs WHERE id=?').get(job.id)).input_json,frozen.input_json);
  assert.deepEqual(f.context().messages.map(m=>m.text),['legacy input']);
});

test('new background chunks roll summaries forward and persist completed work before explicit retry',async t=>{
  const f=fixture(t);for(let i=0;i<5;i++)f.inbound(`m${i}`);
  const seen=[];let fail=true;
  const provider={extract:async input=>{
    if(input.mode!=='profiles'&&input.messages.length>1)throw new MemoryInputTooLargeError('preflight');
    seen.push(input);
    if(input.messages[0]?.text==='m2'&&fail){fail=false;throw new Error('unknown call');}
    return input.mode==='profiles'?{profiles:input.profiles.map(p=>({...p,pendingResults:[]}))}:
      output(input,`${input.previousSummary??''}|${input.messages.map(m=>m.text).join()}`);
  }};
  const config={contextWindow:4096,memory:{enabled:true,maxCalls:30,timeoutMs:1000}};
  const worker=new BackgroundMemory(config,f.store.autoMemory,f.room.id,provider);t.after(()=>worker.close());
  worker.start();await worker.wait();assert.equal(seen.length,0);
  worker.start('capacity');await assert.rejects(worker.wait(),/失败/);
  assert.deepEqual(f.context().messages.map(m=>m.text),['m0','m1','m2','m3','m4']);
  const id=f.store.autoMemory.listJobs()[0].id;worker.retry(id);await worker.wait();
  assert.equal(f.context().summary,'|m0|m1|m2|m3|m4');assert.equal(f.context().messages.length,0);
  assert.equal(seen.filter(input=>input.mode!=='profiles'&&input.messages[0]?.text==='m0').length,1);
  assert.equal(seen.find(input=>input.messages[0]?.text==='m3').previousSummary,'|m0|m1|m2');
});

test('group rolling extraction prompt requires a full continuation summary and actual identity fields',t=>{
  const f=fixture(t);f.inbound('hello');f.reserve();const job=f.claim(),input=f.store.autoMemory.taskInput(job);
  const prepared=prepareMemoryExtraction(input,8192),message=JSON.parse(prepared.userContent).messages[0];
  assert.match(prepared.systemPrompt,/group\s*和\s*private\s*都必须给\s*continuationSummary/);
  assert.doesNotMatch(prepared.systemPrompt,/group 禁止 continuationSummary/);
  assert.equal(message.senderId,'alice');assert.equal(message.senderName,'ALICE');assert.ok(message.contextSeq>0);
});

test('a materials snapshot commits range Topics from bounded chunks without changing the conversation summary',async t=>{
  const f=fixture(t);for(let i=0;i<101;i++)f.inbound(`topic ${i}`);
  const counts=[];
  const worker=new BackgroundMemory({contextWindow:65536,memory:{enabled:true,maxCalls:100,timeoutMs:3000}},
    f.store.autoMemory,f.room.id,{extract:async input=>{
      if(input.mode==='profiles')return {profiles:input.profiles.map(profile=>({...profile,pendingResults:[]}))};
      if(input.messages.length>4)throw new MemoryInputTooLargeError('split before calling provider');
      counts.push(input.messages.length);
      return {...output(input,`${input.previousSummary??''}|${input.messages.length}`),ignoredMessageIds:[],
        topics:input.messages.map(message=>({summary:message.text,messageIds:[]}))};
    }});
  t.after(()=>worker.close());
  assert.equal(f.store.autoMemory.reserveMaterialsIfDue(f.room.id,1000),undefined);
  assert.ok(f.store.autoMemory.reserveMaterialsIfDue(f.room.id,601000));
  worker.start();await worker.wait(undefined,10000);
  assert.equal(counts.reduce((sum,count)=>sum+count,0),101);
  assert.ok(counts.every(count=>count<=4));
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM memory_topics').get().n),101);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM memory_topic_messages').get().n),0);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM memory_topic_scopes').get().n),101);
  assert.equal(f.context().messages.length,101);
  assert.equal(f.context().summaryVersion,0);
});
