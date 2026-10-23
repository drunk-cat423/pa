import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MemoryError } from '../dist/memory-types.js';
import { openConversation } from '../dist/runtime.js';
import { ResearchMaterialReader } from '../dist/research-material-reader.js';
import { preparationDelta } from './fixtures/turn-preparation.mjs';

const call = (name, args, id='call') => ({ role:'assistant',tool_calls:[{index:0,id,type:'function',function:{name,arguments:JSON.stringify(args)}}] });
async function fixture(t, respond, overrides={}) {
  const directory=await mkdtemp(join(tmpdir(),'pa-tool-recovery-')), requests=[], errors=[], runtimes=[];
  const server=createServer(async(req,res)=>{
    try {
      let raw='';for await(const part of req) raw+=part;
      const body=JSON.parse(raw);requests.push(body);
      const delta=await respond(body,requests.length);
      if (delta.httpStatus) { res.writeHead(delta.httpStatus,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture provider unavailable'}}));return; }
      res.writeHead(200,{'content-type':'text/event-stream'});
      const emit=(delta,finish_reason=null)=>res.write(`data: ${JSON.stringify({id:'fixture',model:body.model,choices:[{index:0,delta,finish_reason}]})}\n\n`);
      emit(delta);emit({},delta.tool_calls?'tool_calls':'stop');
      res.end('data: [DONE]\n\n');
    } catch(error){errors.push(error);res.writeHead(500);res.end('fixture failure');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={cwd:directory,dataDir:join(directory,'data'),provider:'fixture',model:'fixture',apiKey:'fixture',
    baseUrl:`http://127.0.0.1:${server.address().port}/v1`,contextWindow:131072,maxOutputTokens:1024,timeoutMs:5000,
    loop:{maxModelCalls:6,maxToolCalls:8},...overrides};
  t.after(async()=>{
    await Promise.allSettled(runtimes.map(runtime=>runtime.close()));server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});assert.deepEqual(errors,[]);
  });
  return {requests, async open(id,options){const runtime=await openConversation(config,id,options);runtimes.push(runtime);return runtime;}};
}

test('真实Pi循环：准备schema和跨目标字段被拒后可修正，未保存承诺仅重写一次且不扩大预算',async t=>{
  let preparations=0;
  const f=await fixture(t,(body,n)=>{
    if(n===1)return call('prepare_turn',{intent:'question',mode:'invalid',updates:[]},'schema');
    if(n===2){assert.equal(body.messages.at(-1).role,'tool');return preparationDelta('business',{
      intent:'question',mode:'standard',updates:[{target:'ai_self',content:'轻松一点',attribution:{kind:'statement',subjectSenderIds:[],excludedSenderIds:[],correctsMessageIds:[]}}]});}
    if(n===3){assert.match(JSON.stringify(body.messages),/群事实归属信息无效/);return preparationDelta('valid');}
    if(n===4)return {role:'assistant',content:'你可以在设置中修改。记下了。'};
    assert.equal(n,5);assert.equal(body.tool_choice,'none');assert.match(JSON.stringify(body.messages),/刚才草稿含无持久化回执/);
    return {role:'assistant',content:'你可以在设置中修改。'};
  });
  const runtime=await f.open('recover-prepare');
  const answer=await runtime.prompt('在哪里改设置？',{runId:'recover-prepare',companionTools:{
    prepareTurn(plan){preparations++;return {prepared:true,mode:plan.mode,saved:[]};},readHistory(){throw Error('不应读取');}}});
  assert.equal(answer,'你可以在设置中修改。');assert.equal(preparations,1);assert.equal(f.requests.length,5);
  assert.ok(f.requests.slice(0,3).every(body=>body.tool_choice.function.name==='prepare_turn'));
  const turns=runtime.recordedTurns();assert.equal(turns.at(-1).assistant.text,answer);
  const bounded=await fixture(t,(_body,n)=>n===1?preparationDelta('once'):{role:'assistant',content:'记下了。'},
    {loop:{maxModelCalls:3,maxToolCalls:8}});
  const fallback=await bounded.open('claim-fallback');
  const notice=await fallback.prompt('你好',{runId:'claim-fallback',companionTools:{prepareTurn:plan=>({prepared:true,mode:plan.mode,saved:[]}),readHistory:()=>[]}});
  assert.match(notice,/没有保存任何新资料/);assert.equal(bounded.requests.length,3);
  assert.equal(fallback.recordedTurns().at(-1).assistant.text,notice);
});

test('真实Pi研究循环：越界材料给出真实范围并可续读，末轮失败有记录，存储故障仍硬停止',async t=>{
  const material={id:'e1',tool:'web_fetch',result:{text:'正文'.repeat(4000)}};
  const reader=new ResearchMaterialReader(id=>id==='e1'?material:undefined),events=[];
  const f=await fixture(t,(body,n)=>{
    if(n===1)return call('read_research_material',{id:'e1',offset:14000},'invalid');
    if(n===2){assert.match(JSON.stringify(body.messages),/invalid_material_offset/);assert.match(JSON.stringify(body.messages),/nextUnreadOffset/);
      return call('read_research_material',{id:'e1',offset:0},'fixed');}
    assert.equal(n,3);assert.match(JSON.stringify(body.messages),/正文/);return {role:'assistant',content:'已读取保存材料的一部分，尚未核验完整原文。'};
  });
  const runtime=await f.open('recover-material',{research:{phase:'collect',maxSearchCalls:0,record:event=>events.push(event),
    readMaterial:(params,limit)=>reader.read(params,limit),materialReadProtocol:'body-v1'}});
  assert.match(await runtime.prompt('读取材料'),/尚未核验/);assert.equal(f.requests.length,3);
  assert.match(events.find(event=>event.kind==='tool_result'&&event.error).error,/invalid_material_offset/);
  assert.ok(events.some(event=>event.kind==='tool_result'&&!event.error));
  const limited=await fixture(t,()=>call('read_research_material',{id:'e1',offset:14000}),{loop:{maxModelCalls:1,maxToolCalls:1}});
  let lastError;
  const last=await limited.open('last-error',{research:{phase:'collect',maxSearchCalls:0,record:event=>{if(event.error)lastError=event.error;},
    readMaterial:(params,limit)=>reader.read(params,limit),materialReadProtocol:'body-v1'}});
  assert.equal(await last.prompt('读取材料'),'');assert.match(lastError,/invalid_material_offset/);assert.equal(limited.requests.length,1);
  const rejected=await fixture(t,()=>({role:'assistant',tool_calls:[
    ...call('read_research_material',{id:'e1',offset:'bad'},'bad-1').tool_calls,
    {...call('read_research_material',{id:'e1',offset:'bad'},'bad-2').tool_calls[0],index:1},
  ]}),{loop:{maxModelCalls:1,maxToolCalls:1}});
  const counts=[];
  const bounded=await rejected.open('rejected-batch',{research:{phase:'collect',maxSearchCalls:0,
    record:e=>{assert.ok(e.toolCalls<=1);counts.push(e.toolCalls);},readMaterial:()=>{throw Error('must not run');}}});
  assert.equal(await bounded.prompt('读取材料'),'');assert.equal(Math.max(...counts),1);assert.equal(rejected.requests.length,1);
  const fatal=await fixture(t,()=>preparationDelta('fatal'));
  const broken=await fatal.open('fatal-storage');
  await assert.rejects(broken.prompt('你好',{runId:'fatal-storage',companionTools:{
    prepareTurn(){throw Error('SQLITE_IOERR fixture');},readHistory(){return [];}}}),/SQLITE_IOERR/);
  assert.equal(fatal.requests.length,1);
});



test('真实Pi研究创建：同批成功任务保留，失败项修正后不重跑成功项，预算耗尽明示部分失败',async t=>{
  for(const repair of [true,false]) {
    const executed=[];
    const f=await fixture(t,(_body,n)=>{
      if(n===1)return preparationDelta('prepare');
      const a=call('create_research',{key:'a',title:'A',goal:'研究A'},'a').tool_calls[0];
      const b=call('create_research',{key:'b',title:'B',goal:'研究B'},'b').tool_calls[0];
      if(n===2)return {role:'assistant',tool_calls:[a,{...b,index:1}]};
      assert.equal(n,3);return repair?call('create_research',{key:'b',title:'B修正',goal:'研究B'},'fixed-b'):{role:'assistant',content:'处理结束'};
    },{research:{enabled:true},loop:{maxModelCalls:repair?5:3,maxToolCalls:8}});
    const runtime=await f.open('partial-create-'+repair);
    const answer=await runtime.prompt('建立A和B研究任务',{runId:'partial-create-'+repair,companionTools:{
      prepareTurn:plan=>({prepared:true,mode:plan.mode,saved:[]}),readHistory:()=>[],research:{execute(_name,params){
        executed.push(params.key);
        if(params.title==='B')throw new MemoryError('B目标不明确');
        return {saved:true,id:params.key,status:'queued',title:params.title};
      }}}});
    assert.match(answer,/《A》/);assert.equal(executed.filter(key=>key==='a').length,1);
    if(repair){assert.match(answer,/《B修正》/);assert.doesNotMatch(answer,/还有研究操作失败/);}
    else assert.match(answer,/还有研究操作失败/);
    assert.equal(runtime.recordedTurns().at(-1).assistant.text,answer);
  }
  const completed=[];
  const lost=await fixture(t,(_body,n)=>{
    if(n===1)return preparationDelta('prepare');
    if(n===2)return {role:'assistant',tool_calls:[
      ...call('create_research',{key:'a',title:'已保存A',goal:'研究A'},'success').tool_calls,
      {...call('create_research',{key:'b',title:'B',goal:'研究B'},'invalid').tool_calls[0],index:1},
    ]};
    return {httpStatus:503};
  },{research:{enabled:true}});
  const interrupted=await lost.open('partial-then-network-error');
  await assert.rejects(interrupted.prompt('建立A和B',{runId:'network',companionTools:{
    prepareTurn:plan=>({prepared:true,mode:plan.mode,saved:[]}),readHistory:()=>[],research:{execute(_name,p){
      if(p.key==='b')throw new MemoryError('目标需澄清');
      completed.push(p.key);return {saved:true,id:'saved-a',status:'queued',title:p.title};
    }}}}),error=>{assert.match(error.confirmedActions.join('\n'),/saved-a/);return true;});
  assert.deepEqual(completed,['a']);assert.equal(lost.requests.length,3);
});
