import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';

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
