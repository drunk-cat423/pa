import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { normalizeQQMessage } from '../dist/qq-channel.js';
import { ChannelHarness, channelConversationKey } from '../dist/channel-harness.js';
import { ConversationStore } from '../dist/store.js';
import { createMemoryProvider } from '../dist/memory-provider.js';
import { preflightImageMetadata, BAILIAN_MAX_REQUEST_BYTES } from '../dist/image-context.js';
import { ImageAssets } from '../dist/image-assets.js';
import { validateExtract } from '../dist/auto-memory.js';
import { messageText } from './fixtures/conversation-context.mjs';
import { preparationDelta } from './fixtures/turn-preparation.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64');
const imageId=createHash('sha256').update(png).digest('hex');
const history=body=>body.messages.find(message=>messageText(message).startsWith('[最近一次会话压缩摘要]'));
const historyText=body=>history(body)?.content.map(block=>block.type==='text'?block.text:'').join('')??'';
const files=body=>body.messages.flatMap(message=>Array.isArray(message.content)?message.content.filter(block=>block.type==='file'):[]);

test('read_image rejects cumulative inline-image overflow before loading the next original',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'pa-image-preload-')),loaded=[],requests=[],errors=[];
  // Large trusted metadata exercises ordering without allocating large image buffers.
  const images=Array.from({length:5},(_,i)=>({imageId:String(i+1).repeat(64),fileId:`local-${String(i+1).repeat(64)}`,
    mimeType:'image/png',bytes:10*1024*1024,width:1,height:1,tokenEstimate:1024}));
  t.mock.method(ImageAssets.prototype,'prepare',async source=>images[Number(source.url.split('/').at(-1))]);
  t.mock.method(ImageAssets.prototype,'loadContent',function(id){
    loaded.push(id);const image=images.find(item=>item.imageId===id);
    return {image,content:{type:'image_url',image_url:{url:`data:image/png;base64,${png.toString('base64')}`},bytes:image.bytes}};
  });
  const server=createServer(async(req,res)=>{
    try {
      let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);requests.push(body);
      const n=requests.length;
      const delta=n===1?preparationDelta('prepare-budget'):n===2?{role:'assistant',tool_calls:[{index:0,id:'read-overflow',type:'function',
        function:{name:'read_image',arguments:JSON.stringify({imageId:images[4].imageId})}}]}:{role:'assistant',content:'本轮图片容量已满，先处理已经看到的图片。'};
      if(n===3)assert.match(JSON.stringify(body.messages),/本轮图片的单图、数量或总容量/);
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write(`data: ${JSON.stringify({id:'budget',model:body.model,choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
      res.end(`data: ${JSON.stringify({id:'budget',model:body.model,choices:[{index:0,delta:{},finish_reason:n===1||n===2?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
    }catch(error){errors.push(error);res.writeHead(500);res.end('fixture error');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={cwd:dir,dataDir:join(dir,'data'),provider:'bailian',model:'deepseek-v4.1-flash-1017',apiKey:'fixture',
    baseUrl:`http://127.0.0.1:${server.address().port}/v1`,contextWindow:1000000,maxOutputTokens:512,timeoutMs:5000};
  const route={channel:'qq',accountId:'budget',roomType:'group',roomId:'room'};
  const h=new ChannelHarness(config,[route],{send:async()=>({status:'sent',externalMessageId:'sent'})},0);
  try {
    await h.prepare();
    const store=new ConversationStore(join(config.dataDir,'pa.sqlite'));
    try {const room=store.ensureConversation(channelConversationKey(route),'',route);
      store.recordInbound(room.id,'旧图片',{eventId:'old-image',senderId:'owner',modelInputText:'旧图片',images:[images[4]]});
    }finally{store.close();}
    await h.start();
    assert.equal(await h.handle({route,eventId:'current-images',senderId:'owner',text:'看看图片',mentioned:true,sentAt:new Date().toISOString(),
      imageSources:images.slice(0,4).map((_,i)=>({url:`https://multimedia.nt.qq.com.cn/${i}`}))}),'sent');
    assert.equal(requests.length,3);assert.equal(loaded.length,4);assert.ok(!loaded.includes(images[4].imageId));assert.deepEqual(errors,[]);
  }finally{await h.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('QQ引用原图只进入当前请求，历史与容量摘要保留引用并可按房间重新读取',async t=>{
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
        topics:[],profiles:[],continuationSummary:`原图尚未重新查看，可通过imageId=${imageId}调用read_image回查。`,
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
  assert.equal(files(requests.at(-1)).length,1,'当前消息明确引用附件时发送原图');
  const prior=historyText(requests.at(-1));
  assert.equal(await h.handle(message('followup-2','继续解释')),'sent');
  assert.equal(files(requests.at(-1)).length,0,'普通问答不展开历史原图');
  assert.match(JSON.stringify(requests.at(-1)),new RegExp(imageId),'历史仍带可回查imageId');
  assert.ok(historyText(requests.at(-1)).startsWith(prior.slice(0,80)),'previous history prefix remains intact');
  assert.equal(uploads,1);await h.close();
  h=open();assert.equal(await h.handle(message('restart','继续看图')),'sent');assert.equal(files(requests.at(-1)).length,0,'重启后普通问答不展开历史原图');
  assert.match(JSON.stringify(requests.at(-1)),new RegExp(imageId));assert.match(JSON.stringify(requests.at(-1)),/图片回答/);
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
  const metadata=frozen.messages.flatMap(message=>message.images??[]);
  assert.ok(metadata.some(image=>image.imageId===imageId));
  const preflight=preflightImageMetadata(metadata,{provider:{provider:'bailian',model:'deepseek-v4.1-flash-1017'}});
  assert.equal(preflight.fits,true);assert.ok(preflight.imageCount<metadata.length,'repeated imageId is budgeted once');
  const oversized=preflightImageMetadata([{imageId,bytes:10*1024*1024+1}],{provider:{provider:'bailian',model:'deepseek-v4.1-flash-1017'}});
  assert.equal(oversized.fits,false);assert.equal(oversized.reason,'image_too_large');
  assert.equal(preflightImageMetadata([{imageId,bytes:10*1024*1024+1}],{provider:{provider:'deepseek',model:'deepseek-flash'}}).fits,true);
  assert.equal(preflightImageMetadata([{imageId,bytes:32*1024*1024+1}]).reason,'image_too_large');
  assert.equal(preflightImageMetadata([{imageId,bytes:1}],{provider:{provider:'bailian',model:'deepseek-v4.1-flash-1017'},knownRequestBytes:BAILIAN_MAX_REQUEST_BYTES}).reason,'request_bytes');
  const imagePath=join(config.dataDir,'images',`${imageId}.bin`),originalImage=await readFile(imagePath),corruptImage=Buffer.from(originalImage);corruptImage[corruptImage.length-1]^=1;
  await writeFile(imagePath,corruptImage);
  let extracted;
  try { extracted=await createMemoryProvider(config).extract(frozen,new AbortController().signal); }
  finally { await writeFile(imagePath,originalImage); }
  assert.equal(memoryRequests.length,1);assert.equal(files(memoryRequests[0]).length,0,'后台整理不读取或发送历史原图');
  assert.match(JSON.stringify(memoryRequests[0]),new RegExp(imageId));
  assert.match(JSON.stringify(memoryRequests[0]),/只使用消息文字和已经存在的识图回答/);
  store.autoMemory.commit(claimed.id,claimed.leaseToken,validateExtract(extracted,frozen));
  assert.equal(store.autoMemory.conversationContext(room.id).messages.length,0);
  assert.equal(store.listMessages(channelConversationKey(route),100,route).find(message=>message.id===quoteMessage.id).text,quoteMessage.text);
  store.close();h=open();
  assert.equal(await h.handle(message('after-summary','摘要后继续')),'sent');assert.equal(files(requests.at(-1)).length,0);
  assert.equal(await h.handle(message('read-again','取原图')),'sent');assert.equal(files(requests.at(-1)).length,1);
  const imageMessages=requests.at(-1).messages;
  assert.match(imageMessages.at(-3).tool_call_id,/^read-/);assert.match(imageMessages.at(-2).tool_call_id,/^history-/);
  assert.equal(imageMessages.at(-1).role,'user');assert.equal(imageMessages.at(-1).content.at(-1).type,'file');
  const controlIndex=imageMessages.findLastIndex(message=>messageText(message).startsWith('[PA本轮控制｜应用生成]'));
  assert.ok(controlIndex>=0&&controlIndex<imageMessages.length-4,'unchanged controls stay before the tool round; the new image follows all tool results');
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
