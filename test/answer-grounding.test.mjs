import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openConversation} from '../dist/runtime.js';
import {bindAnswerGrounding,UNVERIFIED_CURRENT_NOTICE,UNCERTAIN_ATTRIBUTION_NOTICE} from '../dist/answer-grounding.js';
import {preparationDelta} from './fixtures/turn-preparation.mjs';
import {DiagnosticLog,DiagnosticPersistenceError} from '../dist/diagnostics.js';
import {speakerSwapIncident} from './fixtures/production-incidents.mjs';

const context={roomType:'group',currentSender:{senderId:'owner',personId:'primary-owner',senderName:'佑'},
  currentQuestion:'真的假的 opencode里的claude是啥型号',sources:[
    {id:'source',role:'user',text:'我之前用的免费插件8个小时才写了几行代码',senderId:'chocolate',personId:'person-chocolate',senderName:'巧克力'},
  ]};
const references=[{messageId:'source',quote:context.sources[0].text,subjectSenderId:'chocolate'}];
const plan=(experienceRefs=references,freshness='stable')=>({intent:'question',mode:'standard',updates:[],
  grounding:{freshness,experienceRefs,...(freshness==='current_external'?{searchQuery:'opencode Go 当前口碑 官方型号'}:{})}});
const tool=(name,args,id='tool')=>({role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
const nativeFetch=globalThis.fetch;

async function fixture(t,respond,overrides={},native) {
  const directory=await mkdtemp(join(tmpdir(),'pa-grounding-')),requests=[],errors=[],runtimes=[],nativeRequests=[];
  const server=createServer(async(req,res)=>{
    try {
      let raw='';for await(const part of req)raw+=part;
      const body=JSON.parse(raw);requests.push(body);
      const delta=await respond(body,requests.length);
      if(delta.httpStatus){res.writeHead(delta.httpStatus,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture unavailable'}}));return;}
      res.writeHead(200,{'content-type':'text/event-stream'});
      for(const [value,finish] of [[delta,null],[{},delta.tool_calls?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:'fixture',choices:[{index:0,delta:value,finish_reason:finish}]})}\n\n`);
      res.end('data: [DONE]\n\n');
    } catch(error) {errors.push(error);res.writeHead(500);res.end('fixture failure');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const originalFetch=nativeFetch,baseUrl=`http://127.0.0.1:${server.address().port}/v1`;
  globalThis.fetch=async(url,options)=>{
    if(String(url).startsWith(baseUrl))return originalFetch(url,options);
    assert.equal(String(url),'https://api.deepseek.com/anthropic/v1/messages');
    assert.ok(native,'Unexpected external request');nativeRequests.push(JSON.parse(options.body));
    return native(nativeRequests.at(-1));
  };
  t.after(async()=>{await Promise.allSettled(runtimes.map(r=>r.close()));globalThis.fetch=originalFetch;
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  const config={cwd:directory,dataDir:join(directory,'data'),provider:'fixture',model:'fixture',apiKey:'fixture-key',
    baseUrl,contextWindow:131072,maxOutputTokens:1024,timeoutMs:5000,loop:{maxModelCalls:6,maxToolCalls:8},...overrides};
  return {requests,nativeRequests,directory,async open(name){const r=await openConversation(config,name,{enableSearch:true});runtimes.push(r);return r;}};
}
const metadata=(ctx=context)=>({runId:'grounded',conversationContext:'稳定会话前缀\n'+ctx.sources.map(source=>JSON.stringify(source)).join('\n'),
  companionTools:{answerGrounding:ctx,prepareTurn:p=>({prepared:true,mode:p.mode,saved:[]}),readHistory:()=>[]}});

test('真实串人材料的归属绑定区分发言者与对象，拒绝伪造原文、其他房间及已纠正来源',()=>{
  const receipt=bindAnswerGrounding(plan().grounding,context);
  assert.equal(receipt.crossPersonExperience,true);assert.equal(receipt.currentSender.senderId,'owner');
  assert.equal(receipt.references[0].speaker.senderId,'chocolate');assert.equal(receipt.references[0].proposedSubject.senderId,'chocolate');
  const reported=bindAnswerGrounding({...plan().grounding,experienceRefs:[{...references[0],subjectSenderId:'owner'}]},context);
  assert.equal(reported.references[0].speaker.senderId,'chocolate');assert.equal(reported.references[0].proposedSubject.senderId,'owner');
  assert.equal(reported.references[0].subjectVerified,false);
  for(const ref of [{...references[0],quote:'伪造经历'},{...references[0],messageId:'other-room'},{...references[0],subjectSenderId:'unknown'}]) {
    assert.throws(()=>bindAnswerGrounding({...plan().grounding,experienceRefs:[ref]},context));
  }
  for(const change of [{corrected:true},{role:'assistant'}])assert.throws(()=>bindAnswerGrounding(plan().grounding,
    {...context,sources:[{...context.sources[0],...change}]}));
  const shared=bindAnswerGrounding(plan().grounding,{...context,currentSender:{senderId:'other-account',personId:'person-chocolate'}});
  assert.equal(shared.crossPersonExperience,false);
});

test('同轮纠正不再引用已否定旧说法，拒绝发生在保存之前且核验保留已保存纠正',async t=>{
  let saves=0;
  const correction={memoryId:'correction',sourceMessageId:'now',speakerSenderId:'owner',subjectSenderIds:['owner'],excludedSenderIds:['chocolate'],correctsMessageIds:['other-old']};
  const f=await fixture(t,(body,n)=>{
    if(n===1)return preparationDelta('invalid',{...plan(),updates:[{target:'room_memory',content:'纠正归属',attribution:{kind:'correction',
      subjectSenderIds:['owner'],excludedSenderIds:['chocolate'],correctsMessageIds:['source']}}]});
    if(n===2){assert.equal(saves,0);assert.match(JSON.stringify(body.messages),/正在纠正的旧说法/);return preparationDelta('valid',plan());}
    if(n===3)return {role:'assistant',content:'巧克力那款插件。'};
    assert.equal(n,4);const content=body.messages.at(-1).content;
    const packet=JSON.parse(typeof content==='string'?content:content.map(p=>p.text??'').join(''));
    assert.deepEqual(packet.corrections,[correction]);return {role:'assistant',content:'{"status":"ok"}'};
  });
  const runtime=await f.open('same-turn-correction'),meta=metadata();
  meta.companionTools.prepareTurn=p=>{saves++;return {prepared:true,mode:p.mode,saved:[],attributionCorrections:[correction]};};
  assert.equal(await runtime.prompt('纠正归属',meta),'巧克力那款插件。');assert.equal(saves,1);assert.equal(f.requests.length,4);
});

test('跨人物经历才进入有界无工具核验，修正回复和原始草稿均保留且前缀不重排',async t=>{
  const f=await fixture(t,(body,n)=>{
    if(n===1)return preparationDelta('prepare',plan());
    if(n===2){const receipt=JSON.parse(body.messages.findLast(m=>m.role==='tool').content.split('\n').at(-1));
      assert.equal(receipt.answerGrounding.references[0].speaker.senderId,'chocolate');
      return {role:'assistant',content:'你之前那个8小时写几行的插件，可能存在排队。'};}
    assert.equal(n,3);assert.equal(body.tool_choice,'none');assert.deepEqual(body.tools,[]);
    assert.equal(body.messages.length,2);assert.match(JSON.stringify(body.messages),/只核验候选回复的人物经历归属/);
    assert.ok(JSON.stringify(body).length<10000);
    return {role:'assistant',content:JSON.stringify({status:'corrected',answer:'巧克力刚才提到的插件，可能存在排队。具体型号尚不能确认。'})};
  });
  const runtime=await f.open('cross-person'),input=metadata();
  const answer=await runtime.prompt(context.currentQuestion,input);
  assert.match(answer,/巧克力刚才/);assert.equal(f.requests.length,3);
  const histories=f.requests.slice(0,2).map(r=>r.messages.find(m=>m.role==='user').content);
  assert.deepEqual(histories[0],histories[1]);
  const systems=f.requests.slice(0,2).map(r=>r.messages.find(m=>m.role==='system').content);
  assert.ok(systems[0].startsWith('你是用户的个人对话伙伴。'));assert.ok(systems[1].startsWith('你是用户的个人对话伙伴。'));
  assert.equal(runtime.recordedTurns().at(-1).assistant.text,answer);
  const session=await readFile(runtime.info().sessionFile,'utf8');assert.match(session,/你之前那个8小时/);assert.match(session,/巧克力刚才/);
  const plain=runtime.estimate('下一轮',undefined,{channel:true});
  const larger=runtime.estimate('下一轮',undefined,{channel:true,conversationContext:'新增背景'.repeat(2000)});
  assert.ok(larger.inputTokens>plain.inputTokens+5000);
});

test('普通群聊和私聊不增加核验调用，跨人物核验无余预算或协议无效时不发送未核验草稿',async t=>{
  for(const variant of ['ordinary','private','budget','invalid']) {
    const f=await fixture(t,(_body,n)=>n===1?preparationDelta('prepare',plan(variant==='ordinary'?[]:references))
      :{role:'assistant',content:n===2?'候选答复':'not valid JSON'},variant==='budget'?{loop:{maxModelCalls:2,maxToolCalls:8}}:{});
    const runtime=await f.open('mode-'+variant),meta=metadata(variant==='private'?{...context,roomType:'private'}:context);
    const answer=await runtime.prompt('问题',meta);
    if(variant==='ordinary'||variant==='private'){assert.equal(answer,'候选答复');assert.equal(f.requests.length,2);}
    else {assert.equal(answer,UNCERTAIN_ATTRIBUTION_NOTICE);assert.equal(f.requests.length,variant==='budget'?2:3);}
    assert.equal(runtime.recordedTurns().at(-1).assistant.text,answer);
  }
});

test('现况回答强制先搜索绑定的当前问题，日期未核验的结果必须明示且不自动追加搜索',async t=>{
  const search={enabled:true,budgetId:'current',model:'deepseek-flash',maxRequests:1,maxUses:1,maxTokens:1024,timeoutMs:1000,maxResults:5};
  const f=await fixture(t,(body,n)=>{
    if(n===1)return preparationDelta('prepare',plan([],'current_external'));
    if(n===2){assert.equal(body.tool_choice.function.name,'web_search');return tool('web_search',{query:'无关查询'});}
    assert.equal(n,3);return {role:'assistant',content:'检索结果显示有相关讨论，不能确认当前完整口碑。'};
  },{search},()=>new Response(JSON.stringify({content:[{type:'web_search_tool_result',content:[
    {type:'web_search_result',url:'https://example.org/old',title:'旧讨论',page_age:'2020-01-01'},
  ]},{type:'text',text:'有相关讨论，但发布时间较旧。'}],usage:{input_tokens:10,output_tokens:10}})));
  const runtime=await f.open('current-search'),answer=await runtime.prompt('现在口碑如何？',metadata());
  assert.equal(f.requests.length,3);assert.equal(f.nativeRequests.length,1);
  assert.match(f.nativeRequests[0].messages[0].content[0].text,/opencode Go 当前口碑 官方型号/);
  assert.match(answer,/来源日期与现况尚未独立核验/);assert.equal(runtime.recordedTurns().at(-1).assistant.text,answer);
});

test('现况搜索失败、未启用或预算不足时明确未核验，不重试收费请求也不放行猜测结论',async t=>{
  for(const variant of ['failed','disabled','budget','same-batch']) {
    const enabled=variant!=='disabled';
    const f=await fixture(t,(body,n)=>n===1?preparationDelta('prepare',plan([],'current_external'))
      :variant==='same-batch'?{role:'assistant',tool_calls:[...tool('web_search',{query:'现在口碑'},'first').tool_calls,
        {...tool('web_search',{query:'再试一次'},'second').tool_calls[0],index:1}]}:tool('web_search',{query:'现在口碑'}),{
      ...(enabled?{search:{enabled:true,budgetId:'current',model:'deepseek-flash',maxRequests:0,maxUses:0,maxTokens:1024,timeoutMs:1000,maxResults:5}}:{}),
      ...(variant==='budget'?{loop:{maxModelCalls:2,maxToolCalls:8}}:{}),
    },()=>new Response(JSON.stringify({error:'fixture unavailable'}),{status:503}));
    const runtime=await f.open('current-'+variant);
    const answer=await runtime.prompt('现在口碑如何？',metadata());
    assert.equal(answer,UNVERIFIED_CURRENT_NOTICE);assert.equal(f.nativeRequests.length,['failed','same-batch'].includes(variant)?1:0);
    assert.equal(f.requests.length,['failed','same-batch'].includes(variant)?2:1);assert.equal(runtime.recordedTurns().at(-1).assistant.text,answer);
  }
});

test('归属核验的未知响应、取消和诊断持久化失败均停止，不放行草稿或追加请求',async t=>{
  for(const variant of ['unknown','cancel','persistence']) {
    let reviewStarted,release;
    const started=new Promise(resolve=>{reviewStarted=resolve;}),gate=new Promise(resolve=>{release=resolve;});
    const f=await fixture(t,async(_body,n)=>{
      if(n===1)return preparationDelta('prepare',plan());
      if(n===2)return {role:'assistant',content:'你之前那个插件有问题。'};
      assert.equal(n,3);
      if(variant==='cancel'){reviewStarted();await gate;return {role:'assistant',content:'{"status":"ok"}'};}
      return {httpStatus:503};
    });
    const runtime=await f.open('review-'+variant);
    const original=DiagnosticLog.prototype.startCall;
    if(variant==='persistence') {
      let calls=0;
      DiagnosticLog.prototype.startCall=function(...args){if(++calls===3)throw new DiagnosticPersistenceError();return original.apply(this,args);};
    }
    try {
      const running=runtime.prompt('问题',metadata());
      const failure=assert.rejects(running,error=>variant==='persistence'?error instanceof DiagnosticPersistenceError:/cancelled|取消|模型请求失败/.test(error.message+' '+error.kind));
      if(variant==='cancel'){await started;await runtime.abort();release();}
      await failure;
      assert.equal(f.requests.length,variant==='persistence'?2:3);
      if(variant==='persistence') {
        await assert.rejects(runtime.prompt('不能再次请求',metadata()),DiagnosticPersistenceError);
        assert.equal(f.requests.length,2);
      }
    } finally {DiagnosticLog.prototype.startCall=original;release();}
  }
});

test('历史事故对照：旧准备响应缺grounding时拒绝放行，明确跨人引用后可阻止旧错答',async t=>{
  const incident=speakerSwapIncident,source=incident.context.sources[0],refs=[{messageId:source.id,quote:incident.source,subjectSenderId:source.senderId}];
  let saves=0;
  const f=await fixture(t,(body,n)=>{
    if(n===1)return tool('prepare_turn',{intent:'question',mode:'standard',updates:[]},'old-schema');
    if(n===2){assert.equal(saves,0);assert.match(JSON.stringify(body.messages),/缺少grounding/);return preparationDelta('fixed-schema',plan(refs));}
    if(n===3)return {role:'assistant',content:incident.wrongAnswer};
    assert.equal(n,4);return {role:'assistant',content:'{"status":"uncertain"}'};
  });
  const runtime=await f.open('old-incident-schema'),meta=metadata(incident.context);
  meta.companionTools.prepareTurn=p=>{saves++;return {prepared:true,mode:p.mode,saved:[]};};
  const answer=await runtime.prompt(incident.question,meta);
  assert.equal(answer,UNCERTAIN_ATTRIBUTION_NOTICE);assert.equal(saves,1);assert.equal(f.requests.length,4);
});
