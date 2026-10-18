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

test('canonical full answer enters rolling and frozen compression exactly once; controls/views never enter',t=>{
  const f=fixture(t),id=f.result.deliveryId;
  f.store.prepareAnswerDocument(f.a.id,id,'显示摘要',['第一页','第二页']);
  assert.equal(f.store.answerPage(f.a.id,id,1),undefined);
  assert.equal(f.store.autoMemory.conversationContext(f.a.id).messages.filter(m=>m.role==='assistant').length,0);
  f.store.beginDeliveryPart(f.a.id,id,0);
  f.store.ackDeliveryPart(f.a.id,id,0,'sent','summary-id','summary-ref');
  f.store.recordInbound(f.a.id,`/page ${id} 1`,{eventId:'click',senderId:'bob',modelInputText:`/page ${id} 1`,messageKind:'memory'});
  const view=f.store.beginAnswerPageView(f.a.id,id,1,'passive',1);
  f.store.ackAnswerPageView(f.a.id,view.id,'sent','page-id','page-ref');
  f.store.autoMemory.reserveBatch(f.a.id,'capacity');
  const job=f.store.autoMemory.claimNext(f.a.id,{owner:'test',leaseMs:60000});
  const input=f.store.autoMemory.taskInput(job);
  assert.deepEqual(input.messages.map(m=>m.text),['问题',f.canonical]);
  const another=f.store.beginAnswerPageView(f.a.id,id,0,'active');
  f.store.ackAnswerPageView(f.a.id,another.id,'sent','summary-repeat','summary-repeat-ref');
  assert.deepEqual(f.store.autoMemory.taskInput(job),input);
  assert.deepEqual(f.store.quotedMessage(f.a.id,'summary-id'),{role:'assistant',text:'显示摘要'});
  assert.deepEqual(f.store.quotedMessage(f.a.id,'summary-ref',true),{role:'assistant',text:'显示摘要'});
  for(const [external,index] of [['page-id',false],['page-ref',true]]) {
    assert.deepEqual(f.store.quotedMessage(f.a.id,external,index),{role:'assistant',text:view.text});
    assert.equal(f.store.quotedMessage(f.b.id,external,index),undefined);
  }
  assert.equal(f.store.answerPage(f.b.id,id,1),undefined);
  assert.equal(f.store.answerPage(f.a.id,id,3),undefined);
  f.restart();
  assert.deepEqual(f.store.quotedMessage(f.a.id,'page-ref',true),{role:'assistant',text:view.text});
  assert.deepEqual(f.store.autoMemory.conversationContext(f.a.id).messages.map(m=>m.text),['问题',f.canonical]);
});

test('unknown page send survives restart without exposing a quote or retrying the attempt',t=>{
  const f=fixture(t),id=f.result.deliveryId;
  f.store.prepareAnswerDocument(f.a.id,id,'摘要',['正文']);
  f.store.beginDeliveryPart(f.a.id,id,0);
  f.store.ackDeliveryPart(f.a.id,id,0,'sent','summary');
  const view=f.store.beginAnswerPageView(f.a.id,id,1,'active');
  f.restart();
  assert.equal(f.inspect(db=>db.prepare('SELECT status FROM answer_page_views WHERE id=?').get(view.id).status),'uncertain');
  assert.throws(()=>f.store.ackAnswerPageView(f.a.id,view.id,'sent','unknown'),/已经结束/);
  assert.equal(f.store.quotedMessage(f.a.id,'unknown'),undefined);
});

test('schema16 migration keeps canonical history and creates an intact backup',t=>{
  const f=fixture(t);
  f.store.ackDelivery(f.result.deliveryId,'sent','legacy');
  f.inspect(db=>{downgradeSchema16(db);db.exec('PRAGMA user_version=16');});
  f.restart();
  assert.ok(readdirSync(f.dir).some(name=>name.includes('.v16.')&&name.endsWith('.bak')));
  assert.equal(f.inspect(db=>db.prepare('PRAGMA user_version').get().user_version),17);
  assert.deepEqual(f.store.quotedMessage(f.a.id,'legacy'),{role:'assistant',text:f.canonical});
  assert.deepEqual(f.inspect(db=>db.prepare('PRAGMA foreign_key_check').all()),[]);
});
