import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {ChannelHarness} from '../dist/channel-harness.js';
import {ConversationStore} from '../dist/store.js';
import {ReminderService} from '../dist/reminder-service.js';
import {QQChannel} from '../dist/qq-channel.js';
import {preparationDelta} from './fixtures/turn-preparation.mjs';

const route={channel:'qq',accountId:'fixture',roomType:'group',roomId:'group-one'};
async function until(predicate){const deadline=Date.now()+4000;while(!predicate()){if(Date.now()>deadline)throw new Error('等待提醒超时');await new Promise(r=>setTimeout(r,10));}}
function storageFixture(t){
  const dir=mkdtempSync(join(tmpdir(),'pa-reminder-service-')),config={dataDir:dir};
  const store=new ConversationStore(join(dir,'pa.sqlite')),room=store.ensureConversation('fixture',join(dir,'session.jsonl'),route);
  store.recordInbound(room.id,'请提醒我提交报销',{eventId:'source',senderId:'member_A',modelInputText:'请提醒我提交报销'});
  const source=store.externalMessage(room.id,'source').id;
  const due=Date.now()+60_000,services=[];
  const create=(key)=>store.workLedger.createReminder(room.id,source,{key,goal:'提交报销',remindAt:new Date(due).toISOString(),timezone:'Asia/Shanghai'});
  t.after(async()=>{await Promise.all(services.map(s=>s.close()));store.close();rmSync(dir,{recursive:true,force:true});});
  return {store,room,source,due,create,service(send,clock=()=>due,output=(_route,operation)=>operation(),allowed=()=>[route],onError=error=>{throw error;}){
    const s=new ReminderService(config,allowed,output,send,onError,clock);services.push(s);return s;
  }};
}

test('真实harness落库后确认，重开服务由1秒循环补提醒，群目标正确且不再请求模型',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'pa-reminder-flow-')),requests=[],sent=[],errors=[],services=[];
  const due=Date.now()+60_000,text='明天下午三点提醒我提交报销';
  const server=createServer(async(req,res)=>{
    try{
      let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push(body);
      const delta=body.tool_choice?.function?.name==='prepare_turn'?preparationDelta('prepare'):
        {role:'assistant',tool_calls:[{index:0,id:'reminder-create',type:'function',function:{name:'create_reminder',arguments:JSON.stringify({
          key:'expense',goal:'提交报销',remindAt:new Date(due).toISOString(),timezone:'Asia/Shanghai',requestQuote:text})}}]};
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const [value,finish]of[[delta,null],[{},'tool_calls']])res.write('data: '+JSON.stringify({id:'fixture',choices:[{index:0,delta:value,finish_reason:finish}]})+'\n\n');
      res.end('data: [DONE]\n\n');
    }catch(e){errors.push(e);res.writeHead(500);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={cwd:dir,dataDir:join(dir,'data'),provider:'fixture',model:'fixture',apiKey:'offline',baseUrl:`http://127.0.0.1:${server.address().port}`,
    contextWindow:131072,maxOutputTokens:1024,timeoutMs:5000,memory:{enabled:false}};
  const h=new ChannelHarness(config,[route],{send:async message=>{
    const inspect=new ConversationStore(join(config.dataDir,'pa.sqlite'));
    try{assert.equal(inspect.db.prepare('SELECT count(*) n FROM work_items').get().n,1,'确认发送前任务必须已提交');}finally{inspect.close();}
    sent.push(message);return {status:'sent',externalMessageId:'confirmation'};
  }},0);
  t.after(async()=>{await h.close();await Promise.all(services.map(s=>s.close()));server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(dir,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  await h.start();assert.equal(await h.handle({route,eventId:'create',senderId:'member_A',text,mentioned:true,sentAt:new Date().toISOString()}),'sent');
  assert.match(sent[0].text,/已安排.*北京时间/);assert.equal(requests.length,2);await h.close();
  let clock=due-1000;
  const resumed=new ReminderService(config,()=>[route],(_route,op)=>op(),async m=>{sent.push(m);return {status:'sent',externalMessageId:'reminder-sent'};},e=>errors.push(e),()=>clock);
  services.push(resumed);resumed.start();await resumed.wait();assert.equal(sent.length,1);
  clock=due+10*60_000;await until(()=>sent.length===2);await resumed.wait();
  assert.equal(sent[1].mentionSenderId,'member_A');assert.equal(sent[1].route.roomId,route.roomId);assert.equal(sent[1].deliveryMode,'active');
  assert.match(sent[1].text,/原定北京时间.*现补提醒一次/);assert.equal(requests.length,2);
  resumed.poll();await resumed.wait();assert.equal(sent.length,2);
  const inspect=new ConversationStore(join(config.dataDir,'pa.sqlite'));
  try{assert.equal(inspect.db.prepare('SELECT count(*) n FROM work_items').get().n,0);assert.equal(inspect.db.prepare('SELECT count(*) n FROM work_notifications').get().n,0);
    assert.equal(inspect.db.prepare('SELECT count(*) n FROM work_delivery_receipts').get().n,1);
    assert.equal(inspect.db.prepare("SELECT text FROM messages WHERE external_event_id='create'").get().text,text);
  }finally{inspect.close();}
});

test('等待房间输出期间取消或撤销权限不发送；未知投递重开后不重发',async t=>{
  const f=storageFixture(t),sent=[];let release;const gate=new Promise(r=>release=r);
  const item=f.create('cancel'),waiting=f.service(async m=>{sent.push(m);return {status:'sent',externalMessageId:'no'};},()=>f.due,async(_r,op)=>{await gate;await op();});
  waiting.poll();f.store.workLedger.cancelReminder(f.room.id,f.source,item.id,item.version);release();await waiting.wait();assert.equal(sent.length,0);await waiting.close();
  f.create('permission');let routes=[route],unlock;const hold=new Promise(r=>unlock=r);
  const revoked=f.service(async m=>{sent.push(m);return {status:'sent',externalMessageId:'no'};},()=>f.due,async(_r,op)=>{await hold;await op();},()=>routes);
  revoked.poll();routes=[];unlock();await revoked.wait();assert.equal(sent.length,0);await revoked.close();
  const unknown=f.create('unknown');const uncertain=f.service(async m=>{sent.push(m);return {status:'uncertain'};});
  uncertain.poll();await uncertain.wait();assert.equal(sent.length,1);await uncertain.close();
  const restarted=f.service(async m=>{sent.push(m);return {status:'sent',externalMessageId:'duplicate'};},()=>f.due+120_000);
  restarted.start();await restarted.wait();assert.equal(sent.length,1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM work_notifications WHERE status='uncertain'").get().n,1);
  const result=restarted.context(f.room.id,f.source,'请查询提醒').execute('get_reminder',{id:unknown.id});
  assert.equal(result.status,'delivery_uncertain');assert.equal(result.notificationStatus,'uncertain');
});

test('实际工具列表在鉴权范围内分页，第100项后仍可查询取消，不把其他人任务混入',async t=>{
  const f=storageFixture(t);for(let i=0;i<105;i++)f.create('page-'+i);
  const service=f.service(async()=>({status:'rejected'}));
  const context=service.context(f.room.id,f.source,'查询我的提醒');
  const first=context.execute('list_reminders',{offset:0,limit:20});assert.equal(first.items.length,20);assert.equal(first.nextOffset,20);
  const last=context.execute('list_reminders',{offset:100,limit:20});assert.equal(last.items.length,5);assert.equal(last.more,false);
  assert.ok(!first.items.some(item=>item.id===last.items[0].id));
  const cancelled=context.execute('cancel_reminder',{id:last.items[0].id});assert.equal(cancelled.cancelled,true);
  assert.equal(context.execute('get_reminder',{id:last.items[0].id}).status,'cancelled');
});

test('QQ主动群提醒仅序列化受控发起人@，正文标签不能扩大收件人，私聊不携带@',async()=>{
  const payloads=[];
  const channel=new QQChannel({appId:'fixture',clientSecret:'offline'},{onMessage:()=>{},onStatus:()=>{}},{fetch:async(url,options)=>{
    payloads.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({id:'platform-id'}),{status:200});
  }});
  // Isolate message serialization from gateway/network authentication.
  channel.started=true;channel.token='fixture-token';channel.tokenExpiresAt=Date.now()+3600_000;
  const base={route,text:'提交报销 <qqbot-at-everyone />',plainText:true,deliveryMode:'active'};
  assert.equal((await channel.send({...base,mentionSenderId:'member_A'})).status,'sent');
  assert.equal(payloads[0].body.msg_type,0);assert.equal(payloads[0].body.msg_id,undefined);
  assert.match(payloads[0].body.content,/^<qqbot-at-user id="member_A" \/>/);
  assert.doesNotMatch(payloads[0].body.content,/<qqbot-at-everyone/);
  assert.equal((await channel.send({...base,mentionSenderId:'bad" />'})).status,'rejected');assert.equal(payloads.length,1);
  assert.equal((await channel.send({...base,route:{...route,roomType:'private'},text:'提醒：报销'})).status,'sent');
  assert.doesNotMatch(payloads[1].body.content,/qqbot-at/);channel.close();
});
