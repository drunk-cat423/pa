import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync } from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {collectTrending,generateTrendingDigest} from '../dist/trending-content.js';
import {TrendingService} from '../dist/trending-service.js';
import {TrendingStore} from '../dist/trending-store.js';

const route={channel:'qq',accountId:'offline',roomType:'group',roomId:'one'};
const at=time=>Date.parse(`2026-10-30T${time}+08:00`);
const snapshot={fetchedAt:'2026-10-30T00:55:00Z',sections:['daily','weekly','monthly'].map((period,index)=>({period,sourceUrl:`https://github.com/trending?since=${period}`,projects:Array.from({length:[5,3,2][index]},(_,i)=>({slug:`owner/project-${period}-${i}`,url:`https://github.com/owner/project-${period}-${i}`,description:'source'}))}))};
const digest={snapshot,sections:snapshot.sections.map(s=>({period:s.period,text:`## ${s.period}\n\n`+s.projects.map(p=>`### ${p.slug}\n${'中'.repeat(100)}\n${p.url}`).join('\n\n')}))};
function fixture(t,{clock=at('08:45:00'),routes=[route],collect=async()=>snapshot,generate=async()=>digest,send=async()=>({status:'sent',externalMessageId:'receipt'}),allowed}={}){
  const dir=mkdtempSync(join(tmpdir(),'pa-trending-')),services=[],errors=[],messages=[];
  const config={cwd:dir,dataDir:dir,provider:'offline',model:'offline',apiKey:'offline',contextWindow:32768,maxOutputTokens:2048,timeoutMs:2000,trending:{enabled:true,groupIds:routes.map(r=>r.roomId)}};
  const f={dir,config,errors,messages,clock,create(options={}){
    const service=new TrendingService(config,routes,allowed??(()=>routes),options.output??((_r,operation)=>operation()),async m=>{messages.push(m);return send(m);},e=>errors.push(e),{now:()=>f.clock,collector:collect,generator:generate,...options.deps});
    services.push(service);return service;
  },inspect(){return new TrendingStore(join(dir,'trending.sqlite'));}};
  t.after(async()=>{for(const service of services)await service.close();rmSync(dir,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  return f;
}
async function tick(service){service.poll();await service.wait();}

test('代理公网DNS隧道超时耗尽采集，恢复后仅显式补发且保留原失败期',async t=>{
  // Reproduce the 2026-11-04 outage through the real fetch/collector pipeline.
  // This local proxy reports an upstream timeout; it never opens an external connection.
  const tunnels=[],sockets=new Set();
  const proxy=createServer();
  proxy.on('connect',(request,socket)=>{
    sockets.add(socket);socket.once('close',()=>sockets.delete(socket));
    tunnels.push(request.url);
    socket.end('HTTP/1.1 504 Gateway Timeout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(()=>{for(const socket of sockets)socket.destroy();return new Promise(resolve=>proxy.close(resolve));});
  let restored=false,collects=0,generates=0;
  const day='2026-11-04';
  const f=fixture(t,{clock:Date.parse(`${day}T08:55:00+08:00`),collect:async(config,signal)=>{
    collects++;
    if(!restored)return collectTrending(config,signal);
    return collectTrending(config,signal,{fetchDocument:async url=>{
      const section=snapshot.sections.find(s=>s.sourceUrl===url);
      assert.ok(section,'only current daily/weekly/monthly pages are requested');
      return {url,statusCode:200,contentType:'text/html',fetchedAt:new Date(f.clock).toISOString(),body:section.projects.map(p=>
        `<article class="Box-row"><h2 class="h3 lh-condensed"><a href="/${p.slug}">${p.slug}</a></h2><p class="col-9">source</p></article>`).join('')};
    },now:()=>new Date(f.clock)});
  },generate:async(_config,current)=>{generates++;return {...digest,snapshot:current};}});
  f.config.fetch={enabled:true,publicDns:true,proxyUrl:`http://127.0.0.1:${proxy.address().port}`,timeoutMs:1000,maxResponseBytes:1048576,maxTextChars:8000};
  let service=f.create();
  await tick(service);await tick(service);assert.equal(collects,1);
  f.clock+=60_000;await tick(service);f.clock+=60_000;await tick(service);
  assert.deepEqual(tunnels,['1.1.1.1:443','1.1.1.1:443','1.1.1.1:443']);
  assert.equal(generates,0);assert.equal(f.messages.length,0);
  let failed;
  const reader=f.inspect();try{
    const edition=reader.get(day);
    assert.equal(edition.state,'failed');assert.equal(edition.code,'collect_exhausted');assert.equal(edition.attempts,3);
    assert.equal(edition.snapshot,undefined);assert.equal(edition.digest,undefined);assert.deepEqual(reader.parts(day,route),[]);
    failed=JSON.stringify(edition);
  }finally{reader.close();}
  restored=true;await service.close();f.clock=Date.parse(`${day}T09:10:00+08:00`);service=f.create();await tick(service);
  assert.equal(collects,3);assert.equal(generates,0);assert.equal(f.messages.length,0,'network recovery/restart alone must not reopen exhausted work');
  const writer=f.inspect();try{writer.requestManual('proxy-backfill',[route],f.clock);}finally{writer.close();}
  await tick(service);assert.equal(collects,4);assert.equal(generates,1);assert.ok(f.messages.length);
  const store=f.inspect();try{
    assert.equal(JSON.stringify(store.get(day)),failed,'manual backfill must not reset the original failed edition');
    assert.equal(store.get('manual:proxy-backfill').state,'delivered');
    assert.ok(store.parts('manual:proxy-backfill',route).every(p=>p.status==='sent'&&p.externalMessageId));
    store.requestManual('proxy-backfill',[route],f.clock);
  }finally{store.close();}
  const sent=f.messages.length;await tick(service);assert.equal(generates,1);assert.equal(f.messages.length,sent);
});


test('真实故障3条有效7条错参经Pi校验仅修复缺项，全量AI总结与恢复补充投递幂等',async t=>{
  const requests=[];let mode='repair';
  const server=createServer(async(request,response)=>{
    let raw='';for await(const chunk of request)raw+=chunk;
    const body=JSON.parse(raw),input=JSON.parse(body.messages.find(message=>message.role==='user').content);
    requests.push({body,input});
    // Before every network call the SQLite generation ledger has already spent this attempt.
    const reader=f.inspect();try{
      const active=reader.get(activeId);assert.equal(active.generation.attempts,requests.length-callOffset+spentOffset);
    }finally{reader.close();}
    if(mode==='broken'&&requests.length-callOffset===1){response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'fixture unavailable'}}));return;}
    let args;
    if(mode==='repair'&&input.projects.length===10||mode==='broken'){
      args=Object.fromEntries(input.projects.map((p,index)=>[p.slug,index<3&&input.projects.length===10?`有效简介：管理文件的工具${index}。`:{indroduction:'placeholder'}]));
    }else args=Object.fromEntries(input.projects.map(p=>[p.slug,' **管理文件的\n中文工具。** '.repeat(20)]));
    args['invented/project']='无关字段应忽略。';
    response.writeHead(200,{'content-type':'text/event-stream'});
    response.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'deepseek-v4.1-flash',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'call-'+requests.length,type:'function',function:{name:body.tools[0].function.name,arguments:JSON.stringify(args)}}]},finish_reason:null}]})}\n\n`);
    response.end(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'deepseek-v4.1-flash',choices:[{index:0,delta:{},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const f=fixture(t,{clock:at('09:00:00')}),base={...f.config,provider:'bailian',model:'deepseek-v4.1-flash',apiKey:'fixture-key',baseUrl:`http://127.0.0.1:${server.address().port}/v1`};
  const generator=(_config,frozen,signal,deps)=>generateTrendingDigest(base,frozen,signal,deps);
  let activeId='2026-10-30',callOffset=0,spentOffset=0;
  let service=f.create({deps:{generator}});await tick(service);
  assert.equal(requests.length,2);assert.equal(service.info().status,'sent');assert.equal(service.info().failed,false);
  assert.deepEqual(requests[1].input.projects.map(p=>p.slug),snapshot.sections.flatMap(s=>s.projects).slice(3).map(p=>p.slug));
  assert.match(requests[1].input.correction,/schema 校验/);
  for(const {body,input}of requests){
    assert.equal(body.tools[0].function.strict,true);assert.equal(body.response_format,undefined);
    assert.deepEqual(body.tools[0].function.parameters.required,input.projects.map(p=>p.slug));
    assert.deepEqual(body.tool_choice,{type:'function',function:{name:body.tools[0].function.name}});
  }
  let store=f.inspect();try{
    const edition=store.get(activeId);assert.equal(edition.state,'delivered');assert.equal(edition.digest.degraded,undefined);
    assert.equal(edition.generation.attempts,2);assert.equal(Object.keys(edition.generation.introductions).length,10);
    const text=f.messages.map(m=>m.text).join('\n');
    assert.match(text,/有效简介：管理文件的工具0。/);assert.ok(!/placeholder|原始描述|invented/.test(text));
    let position=-1;for(const section of snapshot.sections)for(const project of section.projects){const next=text.indexOf(project.url);assert.ok(next>position);position=next;}
    assert.ok(f.messages.length<=5&&f.messages.every(m=>Buffer.byteLength(m.text)<=1500&&!m.text.includes('试运行')));
    assert.throws(()=>store.requestRecovery(activeId,f.clock),/从未开始投递/);
  }finally{store.close();}
  const sent=f.messages.length;await service.close();service=f.create({deps:{generator}});await tick(service);
  assert.equal(f.messages.length,sent);assert.equal(requests.length,2);
  // Three failed calls retain the valid three items; neither polling nor restart reopens the paid budget.
  await service.close();mode='broken';f.clock=Date.parse('2026-10-31T09:00:00+08:00');activeId='2026-10-31';callOffset=requests.length;
  service=f.create({deps:{generator}});await tick(service);await tick(service);
  assert.equal(requests.length-callOffset,3);assert.equal(f.messages.length,sent);assert.equal(service.info().status,'failed');
  store=f.inspect();try{
    const failed=store.get(activeId);assert.equal(failed.generation.attempts,3);assert.equal(failed.generation.limit,3);
    assert.equal(Object.keys(failed.generation.introductions).length,3);assert.equal(failed.parts,undefined);assert.deepEqual(failed.snapshot,snapshot);
  }finally{store.close();}
  await service.close();service=f.create({deps:{generator}});await tick(service);assert.equal(requests.length-callOffset,3);
  // Explicit same-day recovery adds one three-call allowance, and keeps successful introductions unchanged.
  await service.close();f.clock=Date.parse('2026-10-31T12:00:00+08:00');mode='valid';
  store=f.inspect();try{
    const first=store.requestRecovery(activeId,f.clock);assert.equal(first.generation.limit,6);
    assert.deepEqual(store.requestRecovery(activeId,f.clock).recovery,first.recovery);assert.equal(store.get(activeId).generation.limit,6);
    store.prepareRecovery(activeId,f.clock);store.recover(f.clock); // crash after claiming the recovery, before its next call
    assert.equal(store.get(activeId).state,'uncertain');
    assert.equal(store.requestRecovery(activeId,f.clock).recovery.status,'requested');assert.equal(store.get(activeId).generation.limit,6);
    // The final allowed call saved all fields, then the process died before digest/ready was committed.
    store.prepareRecovery(activeId,f.clock);
    store.update(activeId,e=>{e.generation.attempts=6;for(const section of snapshot.sections)for(const p of section.projects){
      e.generation.introductions[p.slug]??='已保存的中文用途总结。';
    }});
    store.recover(f.clock);assert.equal(store.get(activeId).state,'uncertain');
    assert.equal(store.requestRecovery(activeId,f.clock).recovery.status,'requested');assert.equal(store.get(activeId).generation.limit,6);
  }finally{store.close();}
  service=f.create({deps:{generator}});await tick(service);
  assert.equal(requests.length-callOffset,3,'saved complete recovery makes no model call');assert.equal(service.info().status,'sent');
  store=f.inspect();try{
    const recovered=store.get(activeId);assert.equal(recovered.recovery.status,'completed');assert.equal(recovered.generation.attempts,6);
    assert.equal(recovered.generation.introductions[snapshot.sections[0].projects[0].slug],'有效简介：管理文件的工具0。');
    // Simulate today's already sent old-release original-text edition. Its parts and receipts must remain intact.
    store.update(activeId,e=>{e.digest.degraded=[{slug:snapshot.sections[0].projects[0].slug,reason:'model_contract'}];});
    const old=store.requestManual('old-ready',[route],f.clock);
    store.update(old.id,e=>{e.state='ready';e.snapshot=snapshot;e.digest={...digest,degraded:[{slug:snapshot.sections[0].projects[0].slug,reason:'model_contract'}]};});
    const originalParts=store.parts(activeId,route),original=store.get(activeId);
    const supplement=store.requestAiSupplement(activeId,f.clock);assert.equal(supplement.id,'manual:ai-summary-'+activeId);
    assert.equal(supplement.supplementOf,activeId);assert.deepEqual(supplement.snapshot,original.snapshot);assert.deepEqual(supplement.routes,original.routes);
    assert.equal(store.requestAiSupplement(activeId,f.clock).id,supplement.id);assert.deepEqual(store.parts(activeId,route),originalParts);
    assert.deepEqual(store.get(activeId),original);
    // A generation crash spends its call, retains valid fields, and can use only the existing remaining budget.
    store.update(supplement.id,e=>{e.state='generating';e.generation={attempts:1,limit:3,
      introductions:Object.fromEntries(Object.entries(original.generation.introductions).slice(0,3))};});
    store.recover(f.clock);assert.equal(store.get(supplement.id).state,'uncertain');
    const resumed=store.requestAiSupplement(activeId,f.clock);assert.equal(resumed.state,'pending');
    assert.equal(resumed.generation.attempts,1);assert.equal(resumed.generation.limit,3);
    assert.deepEqual(store.requestAiSupplement(activeId,f.clock).generation,resumed.generation);
    // The same zero-call completion must work at the supplement's final 3/3 attempt.
    store.update(supplement.id,e=>{e.state='generating';e.generation={attempts:3,limit:3,
      introductions:structuredClone(original.generation.introductions)};});
    store.recover(f.clock);assert.equal(store.get(supplement.id).state,'uncertain');
    const completed=store.requestAiSupplement(activeId,f.clock);assert.equal(completed.state,'pending');
    assert.equal(completed.generation.attempts,3);assert.equal(completed.generation.limit,3);
  }finally{store.close();}
  const beforeSupplement=f.messages.length;activeId='manual:ai-summary-2026-10-31';callOffset=requests.length;spentOffset=3;
  await tick(service);assert.equal(requests.length-callOffset,0);assert.equal(f.messages.length,beforeSupplement);
  store=f.inspect();try{assert.equal(store.get('manual:old-ready').state,'failed');assert.equal(store.get('manual:old-ready').parts,undefined);}finally{store.close();}
  await tick(service);assert.equal(requests.length-callOffset,0,'saved complete supplement makes no model call');assert.ok(f.messages.length>beforeSupplement);
  assert.match(f.messages[beforeSupplement].text,/AI总结补充/);assert.ok(!f.messages[beforeSupplement].text.includes('试运行'));
  store=f.inspect();try{assert.equal(store.get(activeId).state,'delivered');assert.equal(store.requestAiSupplement('2026-10-31',f.clock).id,activeId);}finally{store.close();}
  const finalCount=f.messages.length,finalCalls=requests.length;await service.close();service=f.create({deps:{generator}});await tick(service);
  assert.equal(f.messages.length,finalCount);assert.equal(requests.length,finalCalls);
  // Pending supplements expire at the date boundary and cannot be automatically chased tomorrow.
  await service.close();store=f.inspect();try{
    store.update(activeId,e=>{e.state='pending';delete e.parts;});
    assert.throws(()=>store.requestRecovery('2026-10-30',f.clock),/今天/);
  }finally{store.close();}
  f.clock=Date.parse('2026-11-01T08:00:00+08:00');service=f.create({deps:{generator}});await tick(service);
  assert.equal(f.messages.length,finalCount);assert.equal(requests.length,finalCalls);
  store=f.inspect();try{assert.equal(store.get(activeId).state,'expired');assert.throws(()=>store.requestAiSupplement('2026-10-31',f.clock),/今天/);}finally{store.close();}
  // Legacy failures have no generation ledger: close their one old unknown call, then grant exactly three new calls.
  activeId='2026-11-01';callOffset=requests.length;spentOffset=1;mode='broken';
  store=f.inspect();try{
    store.create({id:activeId,date:activeId,manual:false,state:'uncertain',code:'generation_unknown',snapshot,
      routes:[route],attempts:1,nextAttemptAt:0,createdAt:f.clock,updatedAt:f.clock});
    const legacy=store.requestRecovery(activeId,f.clock);
    assert.equal(legacy.generation.attempts,1);assert.equal(legacy.generation.limit,4);
    assert.equal(legacy.recovery.previousCode,'generation_unknown');
    assert.deepEqual(store.requestRecovery(activeId,f.clock).generation,legacy.generation);
  }finally{store.close();}
  await tick(service);assert.equal(requests.length-callOffset,3);assert.equal(f.messages.length,finalCount);
  store=f.inspect();try{
    const exhausted=store.get(activeId);assert.equal(exhausted.state,'failed');
    assert.equal(exhausted.generation.attempts,4);assert.equal(exhausted.generation.limit,4);
    assert.equal(store.requestRecovery(activeId,f.clock).generation.limit,4);
  }finally{store.close();}
  await tick(service);assert.equal(requests.length-callOffset,3);
  // Store completeness is not semantic acceptance; exhausted invalid saved text still fails without another call.
  store=f.inspect();try{
    store.update(activeId,e=>{e.generation.introductions=Object.fromEntries(snapshot.sections.flatMap(s=>s.projects).map(p=>[p.slug,'placeholder']));});
    assert.equal(store.requestRecovery(activeId,f.clock).recovery.status,'requested');
  }finally{store.close();}
  await tick(service);assert.equal(requests.length-callOffset,3);assert.equal(f.messages.length,finalCount);
  store=f.inspect();try{assert.equal(store.get(activeId).state,'failed');}finally{store.close();}
});
