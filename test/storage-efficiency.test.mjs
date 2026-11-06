import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {ConversationStore } from '../dist/store.js';

function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'pa-storage-efficiency-')),path=join(dir,'pa.sqlite');
  const store=new ConversationStore(path),db=store.db;
  const room=store.ensureConversation('room','/fixture/room.jsonl',{channel:'qq',accountId:'fixture',roomType:'group',roomId:'room'});
  let sequence=0;
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const add=()=>{
    const eventId=String(++sequence);
    store.recordInbound(room.id,`message ${eventId}`,{eventId,senderId:'alice',modelInputText:`message ${eventId}`});
    return store.externalMessage(room.id,eventId).id;
  };
  return {dir,path,store,db,room,add};
}

function legacyMessages(db,ids){
  const parse=value=>JSON.parse(String(value));
  return ids.map(id=>{
    const r=db.prepare(`SELECT m.*,p.person_id,coalesce(r.status,CASE WHEN cf.status='sent' THEN 'failed' WHEN rd.status='sent' THEN 'completed' END) AS run_status,coalesce(d.status,rd.status,cf.status) AS delivery_status,input.ingest_seq AS turn_input_seq,
      context.seq AS context_seq,a.external_user_id AS sender_id,inputa.external_user_id AS reply_sender_id,inputp.person_id AS reply_person_id,coalesce(r.input_message_id,rd.source_message_id,failed_task.message_id) AS input_message_id FROM messages m
      LEFT JOIN actor_person_bindings p ON p.actor_id=m.actor_id LEFT JOIN agent_runs r ON r.input_message_id=m.id OR r.response_message_id=m.id
      LEFT JOIN research_deliveries rd ON rd.message_id=m.id LEFT JOIN channel_task_failures cf ON cf.message_id=m.id LEFT JOIN channel_tasks failed_task ON failed_task.id=cf.task_id
      LEFT JOIN messages input ON input.id=coalesce(r.input_message_id,rd.source_message_id,failed_task.message_id) LEFT JOIN deliveries d ON d.message_id=m.id
      LEFT JOIN actors a ON a.id=m.actor_id LEFT JOIN actors inputa ON inputa.id=input.actor_id LEFT JOIN actor_person_bindings inputp ON inputp.actor_id=input.actor_id
      LEFT JOIN conversation_context_messages context ON context.message_id=m.id WHERE m.id=?`).get(id);
    const images=db.prepare('SELECT metadata_json FROM message_images WHERE message_id=? ORDER BY ordinal').all(id).map(row=>parse(row.metadata_json));
    const context=db.prepare('SELECT mentioned_sender_ids_json FROM message_profile_context WHERE message_id=?').get(id);
    return {id:String(r.id),conversationId:String(r.conversation_id),role:r.role,text:String(r.text),ingestSeq:Number(r.ingest_seq),createdAt:String(r.created_at),
      ...(images.length?{images}:{}),...(context?{mentionedSenderIds:parse(context.mentioned_sender_ids_json)}:{}),
      ...(r.image_failure==null?{}:{imageFailure:String(r.image_failure)}),...(r.turn_input_seq==null?{}:{turnInputSeq:Number(r.turn_input_seq)}),
      ...(r.context_seq==null?{}:{contextSeq:Number(r.context_seq)}),...(r.sender_id==null?{}:{senderId:String(r.sender_id)}),...(r.sender_name==null?{}:{senderName:String(r.sender_name)}),
      ...(r.role!=='assistant'||r.input_message_id==null?{}:{replyToMessageId:String(r.input_message_id),...(r.reply_sender_id==null?{}:{replyToSenderId:String(r.reply_sender_id)}),...(r.reply_person_id==null?{}:{replyToPersonId:String(r.reply_person_id)})}),
      ...(r.actor_id==null?{}:{actorId:String(r.actor_id)}),...(r.person_id==null?{}:{personId:String(r.person_id)}),...(r.sent_at==null?{}:{sentAt:String(r.sent_at)}),
      ...(r.run_status==null?{}:{runStatus:String(r.run_status)}),...(r.delivery_status==null?{}:{deliveryStatus:String(r.delivery_status)})};
  });
}

test('批量历史读取保持1000条逐条查询结果并将SQL准备次数降为常数级',t=>{
  const f=fixture(t),ids=[];
  for(let i=0;i<500;i++){
    const id=f.add();ids.push(id);
    if(i%3===0)f.db.prepare('INSERT INTO message_images(message_id,image_id,ordinal,metadata_json) VALUES(?,?,?,?)').run(id,`image-${i}`,0,JSON.stringify({id:`image-${i}`,mimeType:'image/jpeg'}));
    if(i%7===0)f.db.prepare('INSERT INTO message_profile_context VALUES(?,?)').run(id,JSON.stringify([`mentioned-${i}`]));
    const eventId=String(f.db.prepare('SELECT external_event_id FROM messages WHERE id=?').get(id).external_event_id);
    const run=f.store.beginRun(f.room.id,`message ${i+1}`,'fixture-provider','fixture-model',[],{existingMessageId:id,eventId,senderId:'alice'});
    const delivery=f.store.completeRun(run.id,`AI reply ${i}`,undefined,undefined);f.store.ackDelivery(delivery.deliveryId,'sent');
    ids.push(delivery.messageId);
  }
  const queryIds=ids.slice(0,990).concat(ids.slice(0,10));
  const original=f.db.prepare.bind(f.db);let prepares=0;
  t.mock.method(f.db,'prepare',sql=>{prepares++;return original(sql);});
  const oldTimes=[],newTimes=[];let oldCalls=0,newCalls=0;
  for(let i=0;i<3;i++){
    prepares=0;let start=performance.now();const old=legacyMessages(f.db,queryIds);oldTimes.push(performance.now()-start);oldCalls=prepares;
    prepares=0;start=performance.now();const batch=f.store.autoMemory.messages(queryIds);newTimes.push(performance.now()-start);newCalls=prepares;
    assert.deepEqual(batch,old);
  }
  assert.equal(oldCalls,queryIds.length*3);
  assert.equal(newCalls,9,'1000 IDs require three batched reads for each of three chunks');
  console.log(`history-batch benchmark (local SQLite; 1000 requested rows): old=${oldCalls} prepare calls, ${oldTimes.map(n=>n.toFixed(1)).join('/')}ms; batch=${newCalls} prepare calls, ${newTimes.map(n=>n.toFixed(1)).join('/')}ms`);
});
