import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {ConversationStore} from '../dist/store.js';
import {downgradeSchema16} from './fixtures/legacy-schema.mjs';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'pa-answer-pages-')),path=join(dir,'pa.sqlite');
  let store=new ConversationStore(path);
  const route={channel:'qq',accountId:'account',roomType:'group',roomId:'one'};
  const a=store.ensureConversation('a','/pi/a',route),b=store.ensureConversation('b','/pi/b',{...route,roomId:'two'});
  const canonical='结论。\n\n'+'完整正文😀'.repeat(1000);
  const run=store.beginRun(a.id,'问题','p','m',[],{eventId:'question',senderId:'alice',modelInputText:'问题'});
  const result=store.completeRun(run.id,canonical);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,path,a,b,canonical,result,get store(){return store;},
    restart(){store.close();store=new ConversationStore(path);store.markPendingUncertain(a.id);},
    inspect(fn){const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}}};
}

test('schema17只读保留旧页面正文与引用索引，不混入规范回答历史',t=>{
  const f=fixture(t),id=f.result.deliveryId,createdAt=new Date().toISOString();
  f.store.ackDelivery(id,'sent','summary-id');
  f.inspect(db=>{
    db.prepare('INSERT INTO answer_documents(id,conversation_id,summary,pages_json,rendered_body,created_at) VALUES (?,?,?,?,?,?)')
      .run(id,f.a.id,'显示摘要',JSON.stringify(['第一页','第二页']),f.canonical,createdAt);
    db.prepare(`INSERT INTO answer_page_views(id,conversation_id,answer_id,page_number,text,status,external_message_id,reference_index,delivery_mode,reply_slot,created_at,updated_at)
      VALUES ('legacy-view',?,?,1,'旧页面正文','sent','page-id','page-ref','active',NULL,?,?)`).run(f.a.id,id,createdAt,createdAt);
  });
  assert.deepEqual(f.store.quotedMessage(f.a.id,'page-id'),{role:'assistant',text:'旧页面正文',sourceMessageId:f.result.messageId});
  assert.deepEqual(f.store.quotedMessage(f.a.id,'page-ref',true),{role:'assistant',text:'旧页面正文',sourceMessageId:f.result.messageId});
  assert.equal(f.store.quotedMessage(f.b.id,'page-ref',true),undefined);
  assert.deepEqual(f.store.autoMemory.conversationContext(f.a.id).messages.map(m=>m.text),['问题',f.canonical]);
  f.restart();
  assert.deepEqual(f.store.quotedMessage(f.a.id,'page-ref',true),{role:'assistant',text:'旧页面正文',sourceMessageId:f.result.messageId});
  assert.equal(f.inspect(db=>db.prepare('PRAGMA user_version').get().user_version),28);
});

test('schema16 migration keeps canonical history and creates an intact backup',t=>{
  const f=fixture(t);
  f.store.ackDelivery(f.result.deliveryId,'sent','legacy');
  f.inspect(db=>{downgradeSchema16(db);db.exec('PRAGMA user_version=16');});
  f.restart();
  assert.ok(readdirSync(f.dir).some(name=>name.includes('.v16.')&&name.endsWith('.bak')));
  assert.equal(f.inspect(db=>db.prepare('PRAGMA user_version').get().user_version),28);
  assert.deepEqual(f.store.quotedMessage(f.a.id,'legacy'),{role:'assistant',text:f.canonical,sourceMessageId:f.result.messageId});
  assert.deepEqual(f.inspect(db=>db.prepare('PRAGMA foreign_key_check').all()),[]);
});
