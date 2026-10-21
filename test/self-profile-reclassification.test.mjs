import { downgradeSchema14 } from './fixtures/legacy-schema.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { randomUUID } from 'node:crypto';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'pa-reclassification-')),path=join(dir,'pa.sqlite');
  let store=new ConversationStore(path),counter=0;
  const route={channel:'qq',accountId:'bot',roomType:'group',roomId:'one'};
  const room=store.ensureConversation('one','/one.jsonl',route);
  const other=store.ensureConversation('two','/two.jsonl',{...route,roomId:'two'});
  const policy={version:1,ownerBindings:[{route,senderId:'owner'}]};
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const inspect=fn=>{const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}};
  const note=(content='以后rsi指的是recursive self improvement',senderId='owner',inRoom=room)=>{
    const input={eventId:`source-${++counter}`,senderId,modelInputText:`/self ${content}`};
    store.recordInbound(inRoom.id,input.modelInputText,input);
    const source=store.externalMessage(inRoom.id,input.eventId);
    // Historical pending may contain terms that current attribution checks reject.
    inspect(db=>db.prepare('INSERT INTO self_profile_pending(id,content,source_message_id,created_at) VALUES (?,?,?,?)')
      .run(randomUUID(),content,source.id,new Date().toISOString()));
    const pending=store.autoMemory.selfProfile.snapshot().pending.find(p=>p.sourceMessageId===source.id);
    return {source,pending,move:{pendingId:pending.id,expectedContent:content,key:'RSI'}};
  };
  return {dir,path,route,room,other,policy,inspect,note,get store(){return store;},restart(){store.close();store=new ConversationStore(path);}};
}

test('v11升级只新增审计结构并保留历史，升级前创建一致性备份',t=>{
  const f=fixture(t),term=f.note();
  const pending=f.store.autoMemory.selfProfile.snapshot().pending;
  f.store.close();
  f.inspect(db=>{downgradeSchema14(db);db.exec('DROP TABLE person_profile_pending_results;DROP TABLE person_profile_revision_sources;DROP TABLE auto_memory_job_deferrals;DROP TABLE self_profile_reclassifications;PRAGMA user_version=11;');});
  f.restart();
  assert.equal(f.inspect(db=>db.prepare('PRAGMA user_version').get().user_version),24);
  assert.deepEqual(f.store.autoMemory.selfProfile.snapshot().pending,pending);
  assert.equal(f.store.externalMessage(f.room.id,term.source.eventId??'source-1').text,term.source.text);
  assert.ok(readdirSync(f.dir).some(name=>name.includes('.v11.')&&name.endsWith('.bak')));
});
