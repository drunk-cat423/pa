import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';

function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'pa-human-background-'));
  const store=new ConversationStore(join(dir,'pa.sqlite'));
  const route={channel:'qq',accountId:'bot',roomType:'group',roomId:'one'};
  const room=store.ensureConversation('one','/one.jsonl',route);
  const other=store.ensureConversation('two','/two.jsonl',{...route,roomId:'two'});
  let n=0;
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const input=(text,extra={})=>({eventId:`event-${++n}`,senderId:n%2?'alice':'bob',senderName:`member-${n%2}`,
    sentAt:'2020-01-01T00:00:00.000Z',modelInputText:text,...extra});
  const inbound=(text,extra={},inRoom=room)=>{
    const external=input(text,extra);
    store.recordInbound(inRoom.id,text,external);
    return store.externalMessage(inRoom.id,external.eventId);
  };
  return {store,room,other,input,inbound};
}

test('最近10条先排除Bot回复和控制消息，再按本群入库顺序截取；不依赖问答状态或时间',t=>{
  const f=fixture(t);
  for(let i=0;i<12;i++) {
    const external=f.input(`真人-${i}`);
    const run=f.store.beginRun(f.room.id,`真人-${i}`,'fixture','fixture',[],external);
    if(i===2) f.store.failRun(run.id,'failed','fixture','fixture');
    else f.store.completeRun(run.id,`Bot回复-${i}`,undefined,undefined);
    f.inbound(`控制命令-${i}`,{messageKind:'memory'});
  }
  f.inbound('另一个群的记录',{},f.other);
  const current=f.inbound('当前问题');
  f.inbound('当前问题之后的消息',{sentAt:'2010-01-01T00:00:00.000Z'});
  const recent=f.store.recentHumanMessages(f.room.id,10,current.id);
  assert.deepEqual(recent.map(m=>m.text),Array.from({length:10},(_,i)=>`真人-${i+2}`));
  assert.ok(recent.every(m=>m.role==='user'&&m.senderId&&m.senderName));
  assert.ok(recent.every(m=>m.sentAt==='2020-01-01T00:00:00.000Z'));
  assert.throws(()=>f.store.recentHumanMessages(f.room.id,11,current.id),/1到10/);
  const foreign=f.inbound('外群边界',{},f.other);
  assert.throws(()=>f.store.recentHumanMessages(f.room.id,10,foreign.id),/当前会话/);
});

test('完成后台归档不会清掉群聊最近十条背景原文',t=>{
  const f=fixture(t);
  for(let i=0;i<50;i++) f.inbound(`已整理-${i}`);
  f.store.autoMemory.reserveBatch(f.room.id,'count');
  const job=f.store.autoMemory.claimNext(f.room.id,{owner:'fixture',leaseMs:60000});
  const input=f.store.autoMemory.taskInput(job);
  f.store.autoMemory.commit(job.id,job.leaseToken,{topics:[],fragments:[],profiles:[],
    ignoredMessageIds:input.messages.filter(m=>m.role==='user').map(m=>m.id)});
  const current=f.inbound('整理完成后的新问题');
  assert.equal(f.store.autoMemory.status(f.room.id).completed,1);
  assert.deepEqual(f.store.recentHumanMessages(f.room.id,10,current.id).map(m=>m.text),
    Array.from({length:10},(_,i)=>`已整理-${i+40}`));
});
