import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import test from 'node:test';
import {ConversationStore} from '../dist/store.js';
import {ChannelHarness} from '../dist/channel-harness.js';
import {companionReply} from './fixtures/companion-tools.mjs';

test('admission rolls back raw event with failed task insert, then restart preserves one queued intent and observation boundaries',t=>{
  const dir=mkdtempSync(join(tmpdir(),'pa-admission-')),path=join(dir,'pa.sqlite');
  let store=new ConversationStore(path);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const route={channel:'qq',accountId:'fixture',roomType:'group',roomId:'one'};
  const room=store.ensureConversation('room',join(dir,'room.jsonl'),route);
  const privateRoute={...route,roomType:'private',roomId:'private'};
  const privateRoom=store.ensureConversation('private',join(dir,'private.jsonl'),privateRoute);
  const input={route,eventId:'incoming',senderId:'alice',senderName:'Alice',text:'请处理这条消息',mentioned:true,
    mentionedSenderIds:['bob'],quote:{inlineMessages:[{senderId:'bob',text:'引用原话'}]},sentAt:'2026-10-26T00:00:00.000Z'};
  store.recordInbound(room.id,'历史原文',{eventId:'old-observation',senderId:'bob',modelInputText:'历史原文'});
  const old=store.db.prepare('SELECT * FROM messages').all();
  store.db.exec("CREATE TRIGGER reject_admission BEFORE INSERT ON channel_tasks BEGIN SELECT RAISE(ABORT,'injected task persistence failure'); END;");
  assert.throws(()=>store.admitChannelMessage(room.id,input),/injected task persistence failure/);
  assert.deepEqual(store.db.prepare('SELECT * FROM messages').all(),old);
  assert.equal(store.hasExternalMessage(room.id,input.eventId),false);
  assert.equal(store.db.prepare('SELECT count(*) n FROM channel_tasks').get().n,0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM message_profile_context').get().n,0);
  store.db.exec('DROP TRIGGER reject_admission');
  store.close();store=new ConversationStore(path);
  const accepted=store.admitChannelMessage(room.id,input);
  assert.ok(accepted.task);assert.equal(accepted.source.text,input.text);
  assert.equal(store.admitChannelMessage(room.id,input),undefined);
  store.close();store=new ConversationStore(path);
  assert.equal(store.listChannelTasks(room.id,'queued').length,1);
  assert.deepEqual(store.listChannelTasks(room.id,'queued')[0].input,input);
  assert.equal(store.hasExternalMessage(room.id,'old-observation'),true);
  assert.deepEqual(store.db.prepare("SELECT * FROM messages WHERE external_event_id='old-observation'").all(),old);
  assert.deepEqual(JSON.parse(store.db.prepare('SELECT mentioned_sender_ids_json FROM message_profile_context WHERE message_id=?').get(accepted.source.id).mentioned_sender_ids_json),['bob']);
  const observed=store.admitChannelMessage(room.id,{...input,eventId:'non-mention',mentioned:false});
  assert.ok(observed.source);assert.equal(observed.task,undefined);
  assert.equal(store.listChannelTasks(room.id,'queued').length,1);
  assert.throws(()=>store.admitChannelMessage(privateRoom.id,{...input,eventId:'wrong-route',mentioned:false}),/路由/);
  assert.equal(store.hasExternalMessage(privateRoom.id,'wrong-route'),false);
  const direct=store.admitChannelMessage(privateRoom.id,{...input,route:privateRoute,eventId:'direct',mentioned:false});
  assert.ok(direct.task,'private messages still respond without an @');
  assert.equal(store.claimChannelTask(accepted.task.id),true);
  assert.equal(store.claimChannelTask(accepted.task.id),false);
  assert.equal(store.db.prepare('SELECT count(*) n FROM agent_runs').get().n,0);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('channel ingress uses the atomic transaction and a replay after rollback executes only once',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'pa-admission-harness-')),requests=[],sent=[],harnesses=[],errors=[];
  const server=createServer(async(req,res)=>{
    try{
      let raw='';for await(const part of req)raw+=part;
      const body=JSON.parse(raw);requests.push(body);const reply=companionReply(body,'已收到');
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const [delta,reason]of[[reply.delta,null],[{},reply.finishReason]])res.write('data: '+JSON.stringify({id:'fixture',choices:[{index:0,delta,finish_reason:reason}]})+'\n\n');
      res.end('data: [DONE]\n\n');
    }catch(error){errors.push(error);res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={cwd:dir,dataDir:join(dir,'data'),provider:'fixture',model:'fixture',apiKey:'offline',
    baseUrl:`http://127.0.0.1:${server.address().port}/v1`,contextWindow:131072,maxOutputTokens:512,
    timeoutMs:10000,memory:{enabled:false}};
  const route={channel:'qq',accountId:'fixture',roomType:'group',roomId:'one'};
  const create=()=>{const h=new ChannelHarness(config,[route],{send:async message=>{sent.push(message);return {status:'sent',externalMessageId:'out-'+sent.length};}},0);harnesses.push(h);return h;};
  t.after(async()=>{await Promise.allSettled(harnesses.map(h=>h.close()));server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  const input={route,eventId:'atomic-gap',senderId:'alice',text:'请回答',mentioned:true,sentAt:new Date().toISOString()};
  const first=create();await first.start();
  let inspect=new ConversationStore(join(config.dataDir,'pa.sqlite'));
  inspect.db.exec("CREATE TRIGGER reject_admission BEFORE INSERT ON channel_tasks BEGIN SELECT RAISE(ABORT,'injected task persistence failure'); END;");inspect.close();
  await assert.rejects(first.handle(input));await first.close();
  inspect=new ConversationStore(join(config.dataDir,'pa.sqlite'));
  assert.equal(inspect.db.prepare('SELECT count(*) n FROM messages').get().n,0);
  assert.equal(inspect.db.prepare('SELECT count(*) n FROM channel_tasks').get().n,0);
  inspect.db.exec('DROP TRIGGER reject_admission');inspect.close();
  const resumed=create();assert.equal(await resumed.handle(input),'sent');
  assert.equal(await resumed.handle(input),'duplicate');
  assert.equal(sent.length,1);assert.equal(requests.length,2);
  inspect=new ConversationStore(join(config.dataDir,'pa.sqlite'));
  try{
    assert.equal(inspect.db.prepare("SELECT count(*) n FROM channel_tasks WHERE status='completed'").get().n,1);
    assert.equal(inspect.db.prepare('SELECT count(*) n FROM agent_runs').get().n,1);
    assert.equal(inspect.db.prepare("SELECT count(*) n FROM messages WHERE role='user'").get().n,1);
  }finally{inspect.close();}
});
