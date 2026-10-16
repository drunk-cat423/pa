import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {openConversation,RequestError} from '../dist/runtime.js';
import {MemoryError} from '../dist/memory-types.js';
import {ConversationStore} from '../dist/store.js';

async function fixture(t,respond,overrides={}) {
  const dir=await mkdtemp(join(tmpdir(),'pa-preparation-runtime-')),requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);
    const value=respond(body,requests.length);
    if(value?.error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture failure'}}));return;}
    res.writeHead(200,{'content-type':'text/event-stream'});
    const delta=typeof value==='string'?{role:'assistant',content:value}:{role:'assistant',tool_calls:value.map((tool,index)=>({
      index,id:tool.id??`call-${index}`,type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.args)}}))};
    for(const [d,reason]of[[delta,null],[{},typeof value==='string'?'stop':value.stopReason??'tool_calls']])res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:d,finish_reason:reason}]})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const runtime=await openConversation({cwd:dir,dataDir:join(dir,'data'),provider:'fixture',model:'fixture',apiKey:'fixture',
    baseUrl:`http://127.0.0.1:${server.address().port}`,contextWindow:32768,maxOutputTokens:512,timeoutMs:3000,...overrides},'test');
  t.after(async()=>{await runtime.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  return {runtime,requests,dir};
}
const plan=(updates=[],mode='casual')=>({intent:updates.length?'memory_update':'social',mode,updates});
const prepare=p=>[{name:'prepare_turn',args:p}];
const tools=overrides=>({updateProfile:()=>{throw Error('must not bypass preparation');},readHistory:()=>[],...overrides});

test('每轮强制一次结构化判断，持久化完成后才调用回答，模式只控制表达',async t=>{
  let saved=false;
  const p=plan([{target:'sender',content:'我喜欢清淡',sourceType:'self'}],'professional');
  const f=await fixture(t,(_body,n)=>{if(n===1)return prepare(p);assert.equal(saved,true);return '已记下，具体方案是……';});
  const answer=await f.runtime.prompt('记住我喜欢清淡，再详细比较方案',{runId:'run',companionTools:tools({
    prepareTurn:async got=>{assert.deepEqual(got,p);await new Promise(r=>setTimeout(r,10));saved=true;return {prepared:true,mode:got.mode,saved:[{target:'sender',status:'saved_pending'}]};},
  })});
  assert.equal(answer,'已记下，具体方案是……');assert.equal(f.requests.length,2);
  assert.deepEqual(f.requests[0].tool_choice,{type:'function',function:{name:'prepare_turn'}});
  assert.deepEqual(f.requests[0].tools.map(x=>x.function.name),['prepare_turn']);
  assert.ok(!f.requests[1].tools?.some(x=>['update_profile','answer_in_depth','prepare_turn'].includes(x.function.name)));
  assert.match(JSON.stringify(f.requests[1].messages),/本轮采用专业回答/);
});

test('准备阶段与answer_in_depth共享单轮进度额度且先等待保存回执',async t=>{
  const p={...plan([], 'casual'),progressText:'我先理清问题。'},order=[];
  const f=await fixture(t,(_body,n)=>n===1?prepare(p):n===2?[
    {name:'answer_in_depth',args:{reason:'需要仔细推导'}},
  ]:'深入回答正文。');
  const answer=await f.runtime.prompt('深入分析这个问题',{runId:'progress-once',companionTools:tools({
    prepareTurn:got=>{assert.deepEqual(got,p);order.push('saved');return {prepared:true,mode:got.mode,saved:[]};},
    onProgress:async text=>{order.push(`progress:${text}`);return {status:'sent'};},
  })});

  assert.equal(answer,'深入回答正文。');
  assert.deepEqual(order,['saved','progress:我先理清问题。']);
  assert.equal(f.requests.length,3);
});

test('提供商忽略强制调用或并列其他工具时不放行回答、写入或第二次模型请求',async t=>{
  for(const value of ['我记住了',[...prepare(plan()),{name:'update_profile',args:{target:'ai_self',content:'你叫初号机'}}]]){
    let writes=0;const f=await fixture(t,()=>value);
    await assert.rejects(f.runtime.prompt('你叫初号机',{runId:'run',companionTools:tools({prepareTurn:()=>{writes++;return {prepared:true,mode:'casual',saved:[]};}})}),RequestError);
    assert.equal(writes,0,JSON.stringify(value));assert.equal(f.requests.length,1);
  }
});

test('落库后回答失败不回滚已经保存的资料；无回执的保存宣称被阻止',async t=>{
  const f=await fixture(t,(_b,n)=>n===1?prepare(plan()):'我记住了');
  await assert.rejects(f.runtime.prompt('你好',{runId:'one',companionTools:tools({prepareTurn:()=>({prepared:true,mode:'casual',saved:[]})})}),/没有对应落库回执/);
  const g=await fixture(t,(_b,n)=>n===1?prepare(plan([{target:'ai_self',content:'你叫初号机'}])):{error:true});
  const store=new ConversationStore(join(g.dir,'data','pa.sqlite'));
  try {
    const c=store.ensureConversation('g','/g.jsonl',{channel:'qq',accountId:'bot',roomId:'group',roomType:'group'});
    store.recordInbound(c.id,'你叫初号机',{eventId:'source',senderId:'alice',modelInputText:'你叫初号机'});
    const source=store.externalMessage(c.id,'source').id;
    await assert.rejects(g.runtime.prompt('你叫初号机',{runId:'two',companionTools:tools({
      prepareTurn:p=>store.prepareTurn(c.id,source,p,{version:1,ownerBindings:[]}),
    })}),RequestError);
    assert.equal(store.autoMemory.selfProfile.snapshot().pending[0].content,'你叫初号机');
    assert.equal(g.requests.length,2);
  } finally {store.close();}
});

test('原子保存被拒绝时回执明确为空，不靠专业模式放宽权限',async t=>{
  const f=await fixture(t,(_b,n)=>n===1?prepare(plan([{target:'room_rule',key:'pa',content:'pa代表personal agent'}],'professional')):'没有管理权限，这次没有保存。');
  let progressCalls=0;
  await f.runtime.prompt('pa代表personal agent',{runId:'run',companionTools:tools({prepareTurn:()=>{throw new MemoryError('你没有管理权限，本批内容均未保存。');},
    onProgress:async()=>{progressCalls++;return {status:'sent'};}})});
  const tool=f.requests[1].messages.findLast(x=>x.role==='tool');assert.match(JSON.stringify(tool),/saved.*\[\]/);
  assert.match(JSON.stringify(tool),/均未保存/);
  assert.equal(progressCalls,0);
});

test('预算不足在首个请求前拒绝，不隐藏准备阶段调用成本',async t=>{
  const f=await fixture(t,()=>'',{loop:{maxModelCalls:1,maxToolCalls:8}});
  await assert.rejects(f.runtime.prompt('你好',{runId:'run',companionTools:tools({prepareTurn:()=>({prepared:true,mode:'casual',saved:[]})})}),/至少需要2次/);
  assert.equal(f.requests.length,0);
});

test('准备参数不合法或被输出上限截断时不保存、不自动再次请求',async t=>{
  const truncated=prepare(plan());truncated.stopReason='length';
  for(const value of [prepare({...plan(),owner:true}),truncated]) {
    let writes=0;const f=await fixture(t,()=>value);
    await assert.rejects(f.runtime.prompt('你好',{runId:'run',companionTools:tools({prepareTurn:()=>{writes++;return {prepared:true,mode:'casual',saved:[]};}})}),RequestError);
    assert.equal(writes,0);assert.equal(f.requests.length,1);
  }
});
