import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeQQMessage } from '../dist/qq-channel.js';
import { ChannelHarness, channelConversationKey } from '../dist/channel-harness.js';
import { ConversationStore } from '../dist/store.js';
import { createMemoryProvider } from '../dist/memory-provider.js';
import { validateExtract } from '../dist/auto-memory.js';
import { messageText } from './fixtures/conversation-context.mjs';
import { preparationDelta } from './fixtures/turn-preparation.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const imageId=createHash('sha256').update(png).digest('hex');
const history=body=>body.messages.find(message=>messageText(message).startsWith('[最近一次会话压缩摘要]'));
const files=body=>body.messages.flatMap(message=>Array.isArray(message.content)?message.content.filter(block=>block.type==='file'):[]);

test('QQ引用原图经过持久资产、真实Pi准备/回答、稳定历史、重启与容量摘要，按房间重新读取',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pa-vision-context-')),requests=[],memoryRequests=[],sent=[];
  let uploads=0,downloads=0,sendGate,sendStarted,downloadStarted;
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    if(req.url==='/files'){uploads++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'file-api-fixture-1'}));return;}
    const body=JSON.parse(Buffer.concat(chunks).toString());
    const raw=body.messages.filter(message=>message.role==='user').map(message=>Array.isArray(message.content)?message.content[0]?.text:message.content).find(text=>text?.startsWith('{')&&text.includes('"profileProtocol"'));
    let delta,reason='stop';
    if(raw){
      memoryRequests.push(body);const input=JSON.parse(raw);
      delta={role:'assistant',content:JSON.stringify({
        ...(input.extractionProtocol === 2 ? {} : {ignoredMessageIds:input.messages.filter(message=>message.role==='user').map(message=>message.id),fragments:[]}),
        topics:[],profiles:[],continuationSummary:`图中为一张小图，原图imageId=${imageId}`,
        ...(input.selfProfile ? {selfProfile:{baseVersion:input.selfProfile.baseVersion,content:input.selfProfile.content,updates:[],pendingIds:[]}} : {})})};
    }else{
      requests.push(body);
      const current=body.messages.filter(message=>message.role==='user').map(messageText).find(text=>text.includes('[本轮明确输入]'))??'';
      if(body.tool_choice?.function?.name==='prepare_turn'){delta=preparationDelta(`prepare-${requests.length}`);reason='tool_calls';}
      else if(current.includes('取原图')&&!body.messages.some(message=>message.role==='tool'&&message.tool_call_id?.startsWith('read-'))){
        delta={role:'assistant',tool_calls:[{index:0,id:`read-${requests.length}`,type:'function',function:{name:'read_image',arguments:JSON.stringify({imageId})}},{index:1,id:`history-${requests.length}`,type:'function',function:{name:'read_history',arguments:JSON.stringify({scope:'room',limit:2})}}]};reason='tool_calls';
      }else delta={role:'assistant',content:'图片回答。'};
    }
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [d,finish_reason]of[[delta,null],[{},reason]])res.write(`data: ${JSON.stringify({id:'vision',object:'chat.completion.chunk',model:'deepseek-flash',choices:[{index:0,delta:d,finish_reason}]})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    if(new URL(url).hostname==='multimedia.nt.qq.com.cn'){downloads++;if(new URL(url).pathname==='/blocking'){downloadStarted();return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));}if(new URL(url).pathname==='/failure')return new Response('failed',{status:500});return new Response(png,{headers:{'content-type':'image/png'}});}
    return originalFetch(url,options);
  };
  const config={cwd:dir,dataDir:join(dir,'data'),provider:'deepseek',model:'deepseek-flash',apiKey:'fixture-key',baseUrl:`http://127.0.0.1:${server.address().port}`,
    contextWindow:1_000_000,maxOutputTokens:1024,timeoutMs:5000};
  const route={channel:'qq',accountId:'account',roomId:'room',roomType:'group'},other={...route,roomId:'other'};
  const harnesses=[];
  const open=()=>{const h=new ChannelHarness(config,[route,other],{send:async message=>{sent.push(message);if(sendGate){sendStarted();await sendGate;}return {status:'sent',externalMessageId:`reply-${sent.length}`};}},0);harnesses.push(h);return h;};
  t.after(async()=>{await Promise.allSettled(harnesses.map(h=>h.close()));globalThis.fetch=originalFetch;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const event={op:0,t:'GROUP_MESSAGE_CREATE',d:{id:'quote-1',group_openid:'room',author:{member_openid:'asker'},content:'<@bot> 这张图是什么？',timestamp:new Date().toISOString(),message_type:103,
    message_scene:{ext:['ref_msg_idx=original-ref','msg_idx=current-ref','auth_token=PRIVATE_AUTH']},
    msg_elements:[{message_type:103,msg_idx:'original-ref',author:{member_openid:'photographer'},attachments:[{content_type:'image/png',url:'https://multimedia.nt.qq.com.cn/download?rkey=PRIVATE_SIGNED',width:1,height:1,size:png.length}]}]}};
  const normalized=normalizeQQMessage(event,'account','bot');
  assert.equal(normalized.imageSources[0].quoted,true);assert.equal(normalized.imageSources[0].sourceSenderId,'photographer');
  assert.doesNotMatch(JSON.stringify(normalized),/PRIVATE_AUTH/);
  let h=open();assert.equal(await h.handle(normalized),'sent');
  assert.equal(await h.handle(normalized),'duplicate');assert.equal(downloads,1);
  assert.equal(requests.length,2);for(const body of requests)assert.deepEqual(files(body),[{type:'file',file_id:'file-api-fixture-1'}],JSON.stringify(body.messages));
  assert.doesNotMatch(JSON.stringify(requests),/PRIVATE_SIGNED|PRIVATE_AUTH|data:image|base64/);
  const message=(eventId,text,extra={})=>({route,eventId,text,senderId:'asker',sentAt:new Date().toISOString(),mentioned:true,...extra});
  assert.equal(await h.handle(message('followup','再解释一下',{quote:{messageId:'quote-1'}})),'sent');
  assert.equal(files(requests.at(-1)).length,1);
  const prior=history(requests.at(-1)).content;
  assert.equal(await h.handle(message('followup-2','继续解释')),'sent');
  assert.deepEqual(history(requests.at(-1)).content.slice(0,prior.length),prior);
  assert.equal(uploads,1);await h.close();
  h=open();assert.equal(await h.handle(message('restart','继续看图')),'sent');assert.equal(files(requests.at(-1)).length,1);
  assert.equal(uploads,1);assert.equal(downloads,1);
  const beforeObserved=requests.length;
  const observed=normalizeQQMessage({op:0,t:'GROUP_MESSAGE_CREATE',d:{id:'image-only',group_openid:'room',author:{member_openid:'photographer'},timestamp:new Date().toISOString(),attachments:[{content_type:'image/png',url:'https://multimedia.nt.qq.com.cn/image'}]}},'account','bot');
  assert.equal(observed.text,'');assert.equal(await h.handle(observed),'observed');assert.equal(requests.length,beforeObserved);
  const failure=message('download-failure','失败的原始问题',{imageSources:[{url:'https://multimedia.nt.qq.com.cn/failure'}]});
  assert.equal(await h.handle(failure),'failed');assert.match(sent.at(-1).text,/图片下载失败/);
  const failedDownloads=downloads;
  assert.equal(await h.handle(failure),'duplicate');assert.equal(downloads,failedDownloads);
  assert.equal(await h.handle(message('post-failure','继续回答')),'sent');assert.equal(uploads,1);await h.close();
  const store=new ConversationStore(join(config.dataDir,'pa.sqlite'));
  const db=new DatabaseSync(join(config.dataDir,'pa.sqlite'));
  const room={id:db.prepare('SELECT c.id FROM conversations c JOIN rooms r ON r.id=c.room_id WHERE r.external_chat_id=?').get(route.roomId).id};db.close();
  const rawMessages=store.listMessages(channelConversationKey(route),100,route);
  const quoteMessage=rawMessages.find(message=>message.eventId==='quote-1');
  assert.equal(quoteMessage.text,'这张图是什么？');
  assert.equal(store.messageImages(room.id,quoteMessage.id)[0].referenceHash.length,64);
  assert.doesNotMatch(JSON.stringify(store.listChannelTasks(room.id)),/PRIVATE_SIGNED|PRIVATE_AUTH|imageSources/);
  const job=store.autoMemory.reserveBatch(room.id,'capacity');assert.ok(job);
  const claimed=store.autoMemory.claimNext(room.id,{owner:'vision-fixture',leaseMs:60000});
  const frozen=store.autoMemory.taskInput(claimed);
  assert.equal(frozen.messages.find(message=>message.id===quoteMessage.id).images[0].fileId,'file-api-fixture-1');
  assert.equal(frozen.messages.find(message=>message.text==='失败的原始问题').imageFailure,'download');
  assert.equal(frozen.messages.find(message=>message.text==='').images.length,1);
  const extracted=await createMemoryProvider(config).extract(frozen,new AbortController().signal);
  assert.equal(memoryRequests.length,1);assert.equal(files(memoryRequests[0]).length,1);
  assert.match(JSON.stringify(memoryRequests[0]),new RegExp(imageId));
  store.autoMemory.commit(claimed.id,claimed.leaseToken,validateExtract(extracted,frozen));
  assert.equal(store.autoMemory.conversationContext(room.id).messages.length,0);
  assert.equal(store.listMessages(channelConversationKey(route),100,route).find(message=>message.id===quoteMessage.id).text,quoteMessage.text);
  store.close();h=open();
  assert.equal(await h.handle(message('after-summary','摘要后继续')),'sent');assert.equal(files(requests.at(-1)).length,0);
  assert.equal(await h.handle(message('read-again','取原图')),'sent');assert.equal(files(requests.at(-1)).length,1);
  assert.match(requests.at(-1).messages.at(-2).tool_call_id,/^history-/);
  assert.equal(requests.at(-1).messages.at(-1).role,'user');assert.equal(requests.at(-1).messages.at(-1).content.at(-1).type,'file');
  assert.equal(await h.handle(message('foreign-read','取原图',{route:other})),'sent');assert.equal(files(requests.at(-1)).length,0);
  assert.match(JSON.stringify(requests.at(-1)),/当前房间没有可访问/);
  assert.equal(uploads,1);
  let releaseSend;
  const sending=new Promise(resolve=>{sendStarted=resolve;});
  sendGate=new Promise(resolve=>{releaseSend=resolve;});
  const inFlight=h.handle(message('sending-at-close','等待真实投递回执'));
  await sending;
  const downloading=new Promise(resolve=>{downloadStarted=resolve;});
  const preparing=h.handle(message('preparing-at-close','等待图片',{imageSources:[{url:'https://multimedia.nt.qq.com.cn/blocking'}]}));
  await downloading;
  const queued=h.handle(message('queued-at-close','排在图片后的普通问题'));
  const closing=h.close();await new Promise(resolve=>setImmediate(resolve));releaseSend();
  assert.equal(await inFlight,'sent');assert.equal(await preparing,'ignored');assert.equal(await queued,'ignored');await closing;
  const finalDb=new DatabaseSync(join(config.dataDir,'pa.sqlite'));
  try{
    assert.equal(finalDb.prepare(`SELECT d.status FROM deliveries d JOIN agent_runs r ON r.id=d.run_id JOIN messages m ON m.id=r.input_message_id WHERE m.external_event_id='sending-at-close'`).get().status,'sent');
    assert.equal(finalDb.prepare(`SELECT count(*) n FROM messages WHERE external_event_id IN ('preparing-at-close','queued-at-close')`).get().n,0);
  }finally{finalDb.close();}
});
