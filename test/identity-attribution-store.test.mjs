import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { downgradeSchema20 } from './fixtures/legacy-schema.mjs';
import { ConversationStore } from '../dist/store.js';

function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'pa-attribution-')),path=join(directory,'pa.sqlite');
  let store=new ConversationStore(path);
  const route={channel:'qq',accountId:'bot',roomId:'group',roomType:'group'};
  const room=store.ensureConversation('room','/room.jsonl',route);
  const other=store.ensureConversation('other','/other.jsonl',{...route,roomId:'other'});
  const policy={version:1,ownerBindings:[{route,senderId:'owner'}],primaryPerson:{id:'primary',bindings:[{route,senderId:'owner'}]}};
  store.configurePersons([policy.primaryPerson]);
  const input=(text,senderId='owner',conversation=room)=>{
    const external={eventId:crypto.randomUUID(),senderId,senderName:'同名',modelInputText:text};
    store.recordInbound(conversation.id,text,external);
    return {...external,existingMessageId:store.externalMessage(conversation.id,external.eventId).id};
  };
  const inspect=fn=>{const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}};
  const save=(source,attribution,authority=policy)=>store.prepareTurn(room.id,source.existingMessageId,
    {intent:'memory_update',mode:'standard',updates:[{target:'room_memory',content:source.modelInputText,...(attribution?{attribution}:{})}]},authority);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,path,route,room,other,policy,input,save,inspect,get store(){return store;},restart(){store.close();store=new ConversationStore(path);}};
}
const correction=(subjectSenderIds,excludedSenderIds=[],correctsMessageIds=[])=>({kind:'correction',subjectSenderIds,excludedSenderIds,correctsMessageIds});

test('群共享事实的我固定指来源发言者，同昵称不合人，不同来源同句话不合并',t=>{
  const f=fixture(t);
  const owner=f.input('本群我的项目叫 PA'),member=f.input('本群我的项目叫 PA','member');
  f.save(owner);f.save(member,undefined,{...f.policy,ownerBindings:[{route:f.route,senderId:'member'}]});
  const facts=f.store.roomFactContext(f.room.id).facts;
  assert.equal(facts.length,2);
  assert.equal(facts[0].sourceSpeaker.senderId,'member');
  assert.equal(facts[1].sourceSpeaker.senderId,'owner');
  assert.notEqual(facts[0].sourceSpeaker.personId,facts[1].sourceSpeaker.personId);
  assert.deepEqual(facts.map(f=>f.subjects),[[],[]]);
  assert.deepEqual(f.store.roomFactContext(f.other.id),{facts:[],corrections:[],correctedMessages:{},summaryInvalidated:false});
});

test('明确归属纠正持久化、幂等、重启保留；原消息和版本不改，历史保留纠正指针',t=>{
  const f=fixture(t);f.input('我的 bot 唤醒失败','member');
  const question=f.input('谈谈开发流程');
  const run=f.store.beginRun(f.room.id,question.modelInputText,'fixture','test',[],question);
  const wrong='你一直在修唤醒失败、卡会话这些问题';
  const answer=f.store.completeRun(run.id,wrong,undefined,undefined);f.store.ackDelivery(answer.deliveryId,'sent');
  const source=f.input('请记住：唤醒失败是<@member>那边的，不是我的');
  const attribution=correction(['member'],['owner'],[answer.messageId]);
  const receipt=f.save(source,attribution);
  assert.equal(receipt.saved[0].status,'saved');
  assert.deepEqual(receipt.attributionCorrections[0].subjectSenderIds,['member']);
  assert.equal(receipt.attributionCorrections[0].speakerSenderId,'owner');
  assert.deepEqual(f.save(source,attribution),receipt);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM memory_fact_attributions').get().n),1);
  const context=f.store.roomFactContext(f.room.id);
  assert.equal(context.corrections[0].subjects[0].senderId,'member');
  assert.equal(context.corrections[0].excludedSubjects[0].personId,'primary');
  assert.equal(context.corrections[0].sourceSpeaker.senderId,'owner');
  assert.deepEqual(context.correctedMessages[answer.messageId],[source.existingMessageId]);
  assert.equal(f.inspect(db=>db.prepare('SELECT text FROM messages WHERE id=?').get(answer.messageId).text),wrong);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM memory_revisions').get().n),1);
  const later=f.input('回看唤醒失败');
  const history=f.store.readHistory(f.room.id,later.existingMessageId,{scope:'room',query:'唤醒失败',limit:10});
  assert.deepEqual(history.messages.find(m=>m.id===answer.messageId).correctedBy,[source.existingMessageId]);
  f.restart();assert.deepEqual(f.store.roomFactContext(f.room.id),context);
});

test('拒绝昵称猜测、未知或他群人物、跨群/当前/未来消息，整批回滚且不给普通成员授权',t=>{
  const f=fixture(t);f.input('member ready','member');
  const foreign=f.input('其他房间的内容','foreign',f.other);
  const source=f.input('请记住：这个问题不是我的，是同名群友的');
  const future=f.input('稍后才到的内容');
  for (const attribution of [correction(['member'],['owner']),correction(['foreign'],['owner']),
    correction([],['owner'],[foreign.existingMessageId]),correction([],['owner'],[source.existingMessageId]),
    correction([],['owner'],[future.existingMessageId])]) assert.throws(()=>f.save(source,attribution));
  const ordinary=f.input('请记住：问题是<@owner>的，不是我的','member');
  assert.throws(()=>f.save(ordinary,correction(['owner'],['member'])),/没有管理/);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM memories').get().n),0);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM memory_fact_attributions').get().n),0);
});

test('上下文边界挡住迟到纠正，新纠正覆盖旧来源但不改旧记录',t=>{
  const f=fixture(t);f.input('member ready','member');
  const original=f.input('请记住：问题属于<@member>，不属于我');f.save(original,correction(['member'],['owner']));
  const boundary=f.input('当时的问题');
  const revised=f.input('请纠正：问题属于我，不属于<@member>');
  f.save(revised,correction(['owner'],['member'],[original.existingMessageId]));
  const before=f.store.roomFactContext(f.room.id,boundary.existingMessageId);
  assert.equal(before.corrections.length,1);assert.equal(before.corrections[0].subjects[0].senderId,'member');
  const after=f.store.roomFactContext(f.room.id);
  assert.equal(after.corrections.length,1);assert.equal(after.corrections[0].subjects[0].senderId,'owner');
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM memories').get().n),2);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM memory_revisions').get().n),2);
  assert.throws(()=>f.store.roomFactContext(f.room.id,f.input('foreign','foreign',f.other).existingMessageId),/不属于当前房间/);
});

test('二次纠正保留完整失效链，旧错误不因改口或纠正有效期结束而复活',t=>{
  const f=fixture(t);f.input('member ready','member');
  const wrong=f.input('问题属于我');f.save(wrong);
  const first=f.input('纠正：问题属于<@member>，不是我的');
  f.save(first,correction(['member'],['owner'],[wrong.existingMessageId]));
  const second=f.input('再次纠正：问题属于我，不是<@member>');
  const receipt=f.save(second,correction(['owner'],['member'],[first.existingMessageId]));
  const context=f.store.roomFactContext(f.room.id);
  assert.equal(context.facts.length,0);assert.equal(context.corrections.length,1);
  assert.deepEqual(context.correctedMessages[wrong.existingMessageId],[second.existingMessageId]);
  const same=f.input(second.modelInputText);
  f.store.correctMemory(f.room.id,receipt.attributionCorrections[0].memoryId,
    {content:second.modelInputText,sourceMessageId:same.existingMessageId,expiresAt:'2000-01-01T00:00:00Z'},1);
  const expired=f.store.roomFactContext(f.room.id);
  assert.ok(expired.correctedMessages[wrong.existingMessageId]?.length);
  assert.equal(expired.facts.length,0);
});

test('现有修订入口改有效期保留归属，改变归属正文须明确重提，不能静默退回普通事实',t=>{
  const f=fixture(t);f.input('member ready','member');
  const old=f.input('旧错误');
  const source=f.input('纠正：这是<@member>的，不是我的');
  const receipt=f.save(source,correction(['member'],['owner'],[old.existingMessageId]));
  const memoryId=receipt.attributionCorrections[0].memoryId;
  const same=f.input(source.modelInputText);
  f.store.correctMemory(f.room.id,memoryId,{content:source.modelInputText,sourceMessageId:same.existingMessageId,expiresAt:'2099-01-01T00:00:00Z'},1);
  const current=f.store.roomFactContext(f.room.id);
  assert.equal(current.corrections[0].revision,2);
  assert.equal(current.corrections[0].subjects[0].senderId,'member');
  assert.ok(current.correctedMessages[old.existingMessageId]?.length);
  const changed=f.input('其实是我自己的问题');
  assert.throws(()=>f.store.correctMemory(f.room.id,memoryId,{content:changed.modelInputText,sourceMessageId:changed.existingMessageId},2),/归属/);
  assert.equal(f.store.queryMemories(f.room.id)[0].revision,2);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM memory_revisions WHERE memory_id=?').get(memoryId).n),2);
});

test('旧schema18升级只增加旁表，完整备份原文和旧版本；旧共享事实按真实来源补发言者',t=>{
  const f=fixture(t),source=f.input('历史共享事实中的我是谁');f.save(source);
  const before=f.inspect(db=>({messages:db.prepare('SELECT * FROM messages ORDER BY id').all(),versions:db.prepare('SELECT * FROM memory_revisions').all()}));
  f.store.close();f.inspect(db=>{downgradeSchema20(db);db.exec('DROP TABLE memory_topic_scopes; DROP TABLE memory_fact_attributions; PRAGMA user_version=18;');});
  f.restart();
  assert.equal(f.inspect(db=>db.prepare('PRAGMA user_version').get().user_version),23);
  const backups=readdirSync(f.directory).filter(name=>name.includes('.v18.')&&name.endsWith('.bak'));
  assert.equal(backups.length,1);
  const backup=new DatabaseSync(join(f.directory,backups[0]),{readOnly:true});
  try{assert.equal(backup.prepare('PRAGMA user_version').get().user_version,18);assert.deepEqual(backup.prepare('SELECT * FROM memory_revisions').all(),before.versions);}finally{backup.close();}
  assert.deepEqual(f.inspect(db=>db.prepare('SELECT * FROM messages ORDER BY id').all()),before.messages);
  const fact=f.store.roomFactContext(f.room.id).facts[0];
  assert.equal(fact.sourceSpeaker.senderId,'owner');assert.deepEqual(fact.subjects,[]);
});
