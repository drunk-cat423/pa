import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { BackgroundMemory } from '../dist/auto-memory.js';
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
