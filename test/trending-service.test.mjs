import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {generateTrendingDigest} from '../dist/trending-content.js';
import {TrendingService} from '../dist/trending-service.js';
import {TrendingStore} from '../dist/trending-store.js';
import {readTrendingConfig} from '../dist/config.js';
import {DiagnosticPersistenceError} from '../dist/diagnostics.js';

const route={channel:'qq',accountId:'offline',roomType:'group',roomId:'one'};
const at=time=>Date.parse(`2026-10-30T${time}+08:00`);
const snapshot={fetchedAt:'2026-10-30T00:55:00Z',sections:['daily','weekly','monthly'].map((period,index)=>({period,sourceUrl:`https://github.com/trending?since=${period}`,projects:Array.from({length:[5,3,2][index]},(_,i)=>({slug:`owner/project-${period}-${i}`,url:`https://github.com/owner/project-${period}-${i}`,description:'source'}))}))};
const digest={snapshot,sections:snapshot.sections.map(s=>({period:s.period,text:`## ${s.period}\n\n`+s.projects.map(p=>`### ${p.slug}\n${'中'.repeat(100)}\n${p.url}`).join('\n\n')}))};
function fixture(t,{clock=at('08:55:00'),routes=[route],collect=async()=>snapshot,generate=async()=>digest,send=async()=>({status:'sent',externalMessageId:'receipt'}),allowed}={}){
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

test('8:55持久生成、9点按完整批次分段主动Markdown投递，同日重启幂等且正文独立',async t=>{
  let collects=0,generates=0,batches=0;
  const f=fixture(t,{collect:async()=>{collects++;return snapshot;},generate:async()=>{generates++;return digest;}});
  let service=f.create({output:async(_route,operation)=>{batches++;await operation();}});
  await tick(service);assert.equal(collects,1);assert.equal(generates,1);assert.equal(f.messages.length,0);
  await service.close();f.clock=at('09:00:00');service=f.create({output:async(_route,operation)=>{batches++;await operation();}});
  await tick(service);assert.equal(batches,1);assert.ok(f.messages.length>1&&f.messages.length<=5);
  assert.ok(f.messages.every(m=>m.deliveryMode==='active'&&m.markdown===true&&Buffer.byteLength(m.text)<=1500));
  for(const section of snapshot.sections)for(const p of section.projects)assert.ok(f.messages.map(m=>m.text).join('').includes(p.url));
  for(const section of snapshot.sections)for(const p of section.projects)assert.ok(f.messages.some(m=>m.text.includes(`### ${p.slug}\n${'中'.repeat(100)}\n${p.url}`)),'project description and URL stay in one message');
  assert.equal(service.info().status,'sent');assert.equal(existsSync(join(f.dir,'pa.sqlite')),false);
  const count=f.messages.length;await service.close();service=f.create();await tick(service);
  assert.equal(f.messages.length,count);assert.equal(generates,1);assert.equal(collects,1);
});

test('部分sent和未知回执不重发，未知段停止该群整批；无外部ID也保留uncertain',async t=>{
  let calls=0;
  const f=fixture(t,{clock:at('09:05:00'),send:async()=>{calls++;return calls===2?{status:'sent',externalMessageId:''}:{status:'sent',externalMessageId:`id-${calls}`};}});
  let service=f.create();await tick(service);assert.equal(f.messages.length,2);assert.match(f.messages[0].text,/延迟补发/);
  await service.close();service=f.create();await tick(service);
  const store=f.inspect();try{
    const parts=store.parts('2026-10-30',route);assert.equal(parts[0].status,'sent');assert.equal(parts[1].status,'uncertain');
    assert.ok(parts.slice(2).every(p=>p.status==='pending'));assert.equal(f.messages.length,2);assert.equal(store.get('2026-10-30').state,'uncertain');
  }finally{store.close();}
  assert.equal(service.info().status,'delivery_uncertain');assert.equal(service.info().errorCode,'delivery_uncertain');
  const count=f.messages.length;await tick(service);assert.equal(f.messages.length,count);
});

test('采集仅3次、模型失败单次降级且不堵次日；10点以后不补历史期',async t=>{
  let collects=0,generates=0;
  const f=fixture(t,{collect:async()=>{collects++;if(collects<=3)throw new Error('offline');return snapshot;},generate:async()=>{generates++;throw new Error('unknown model result');}});
  const service=f.create();await tick(service);await tick(service);assert.equal(collects,1);
  f.clock+=60_000;await tick(service);f.clock+=60_000;await tick(service);assert.equal(collects,3);assert.equal(service.info().errorCode,'collect_exhausted');
  f.clock=Date.parse('2026-10-31T09:10:00+08:00');await tick(service);await tick(service);assert.equal(generates,1);assert.equal(service.info().status,'sent');assert.equal(service.info().degraded.length,10);
  const sent=f.messages.length;assert.ok(sent>0);
  f.clock=Date.parse('2026-11-01T10:00:00+08:00');await tick(service);assert.equal(generates,1);assert.equal(collects,4);assert.equal(f.messages.length,sent);
});

test('持久manual请求由运行harness消费，跨进程幂等、不占正式日期，群路由冻结且分段CAS',async t=>{
  let generates=0;
  const f=fixture(t,{clock:at('12:00:00'),generate:async()=>{generates++;return digest;}}),service=f.create();
  const writer=f.inspect();try{
    const first=writer.requestManual('acceptance-1',[route],f.clock);
    assert.equal(writer.requestManual('acceptance-1',[route],f.clock).id,first.id);
    assert.throws(()=>writer.requestManual('acceptance-1',[{...route,roomId:'other'}],f.clock),/不能变更/);
  }finally{writer.close();}
  await tick(service);assert.equal(generates,1);assert.ok(f.messages.length);await tick(service);assert.equal(generates,1);
  const store=f.inspect();try{assert.equal(store.get('2026-10-30'),undefined);assert.equal(store.get('manual:acceptance-1').state,'delivered');
    store.requestManual('claim',[route],f.clock);assert.ok(store.claimCollection('manual:claim',f.clock));assert.equal(store.claimCollection('manual:claim',f.clock),undefined);
  }finally{store.close();}
});

test('排队输出前关闭/撤销路由不会发出，关闭中已开始的投递等待平台确认',async t=>{
  let release,entered;const enteredPromise=new Promise(r=>entered=r),receipt=new Promise(r=>release=r);
  const f=fixture(t,{clock:at('09:00:00'),send:async()=>{entered();await receipt;return {status:'sent',externalMessageId:'after-close'};}}),service=f.create();
  service.poll();await enteredPromise;let closed=false;const closing=service.close().then(()=>closed=true);
  await new Promise(r=>setTimeout(r,10));assert.equal(closed,false);release();await closing;assert.equal(f.messages.length,1);
  const store=f.inspect();try{assert.equal(store.parts('2026-10-30',route)[0].status,'sent');assert.ok(store.parts('2026-10-30',route).slice(1).every(p=>p.status==='pending'));}finally{store.close();}
  const allowed=[];
  const blocked=new TrendingService(f.config,[route],()=>allowed,(_r,op)=>op(),async()=>{assert.fail('route revoked');},e=>f.errors.push(e),{now:()=>f.clock,collector:async()=>snapshot,generator:async()=>digest});
  await tick(blocked);assert.equal(blocked.info().errorCode,'route_unavailable');await blocked.close();
});

test('关闭中止模型等待，生成中崩溃/发送中崩溃恢复均保留未知结果',async t=>{
  let entered,rejectCleanup;const enteredPromise=new Promise(r=>entered=r);
  const f=fixture(t,{generate:async(_c,_s,signal)=>{entered();return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{rejectCleanup=()=>reject(new DiagnosticPersistenceError());},{once:true}));}}),service=f.create();
  service.poll();await enteredPromise;await service.close();
  rejectCleanup();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.errors.length,1,'关闭完成后晚到的诊断持久化失败仍需通知harness');assert.ok(f.errors.pop() instanceof DiagnosticPersistenceError);
  const store=f.inspect();try{assert.equal(store.get('2026-10-30').state,'uncertain');
    const e=store.requestManual('crash',[route],f.clock);store.claimCollection(e.id,f.clock);store.update(e.id,row=>row.state='generating');store.recover(f.clock);
    assert.equal(store.get(e.id).code,'generation_unknown');
    const d=store.requestManual('send-crash',[route],f.clock);store.prepareParts(d.id,['part'],f.clock);assert.equal(store.beginPart(d.id,route,0),true);assert.equal(store.beginPart(d.id,route,0),false);store.recover(f.clock);
    assert.equal(store.parts(d.id,route)[0].status,'uncertain');assert.equal(store.beginPart(d.id,route,0),false);
  }finally{store.close();}
  // Reproduce timeout -> delayed diagnostic failure: no fallback may leave before cleanup settles.
  const timed=fixture(t,{clock:at('09:00:00'),generate:async(_c,_s,signal)=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>setTimeout(()=>reject(new DiagnosticPersistenceError()),30),{once:true});
  })});
  timed.config.timeoutMs=20;
  const timedService=timed.create();await tick(timedService);
  assert.equal(timed.messages.length,0);assert.equal(timedService.info().errorCode,'persistence_failed');
  assert.equal(timed.errors.length,1);assert.ok(timed.errors.pop() instanceof DiagnosticPersistenceError);
  // Ordinary cleanup completes before the fallback is sent.
  let cleaned=false;
  const clean=fixture(t,{clock:at('09:00:00'),generate:async(_c,_s,signal)=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>setTimeout(()=>{cleaned=true;reject(new Error('model cancelled'));},30),{once:true});
  }),send:async()=>{assert.equal(cleaned,true);return {status:'sent',externalMessageId:'after-cleanup'};}});
  clean.config.timeoutMs=20;const cleanService=clean.create();await tick(cleanService);
  assert.equal(cleanService.info().status,'sent');assert.ok(clean.messages.length);
  // A cleanup that never settles is bounded, keeps this edition unknown, and releases the next day's schedule.
  let abandon;
  const stuck=fixture(t,{clock:at('09:00:00')});
  stuck.config.timeoutMs=20;let modelCalls=0;
  const stuckService=stuck.create({deps:{generator:async(c,s,signal)=>{modelCalls++;return modelCalls===1?new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>{abandon=()=>reject(new DiagnosticPersistenceError());},{once:true});
  }):digest;}}});
  await tick(stuckService);assert.equal(stuck.messages.length,0);assert.equal(stuckService.info().errorCode,'generation_unknown');
  stuck.clock=Date.parse('2026-10-31T09:00:00+08:00');await tick(stuckService);
  assert.equal(modelCalls,2);assert.equal(stuckService.info().status,'sent');
  abandon();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(stuck.errors.length,1);assert.ok(stuck.errors.pop() instanceof DiagnosticPersistenceError);

});

test('开启要求显式当前QQ群子集，过长日报不裁链接、不发送，普通失败不触发fatal',async t=>{
  assert.deepEqual(readTrendingConfig({}),{enabled:false,groupIds:[]});
  assert.throws(()=>readTrendingConfig({PA_TRENDING_ENABLED:'true',PA_QQ_ALLOWED_GROUPS:'one'}),/非空子集/);
  assert.throws(()=>readTrendingConfig({PA_TRENDING_ENABLED:'true',PA_QQ_ALLOWED_GROUPS:'one',PA_TRENDING_GROUP_IDS:'private'}),/非空子集/);
  const f=fixture(t,{clock:at('09:00:00'),generate:async()=>({...digest,sections:[{period:'daily',text:'中'.repeat(4000)+'https://github.com/owner/repo'}]})}),service=f.create();
  await tick(service);assert.equal(service.info().status,'failed');assert.equal(service.info().errorCode,'digest_invalid');assert.equal(f.messages.length,0);
  const fatal=f.create({deps:{now:()=>Date.parse('2026-10-31T09:00:00+08:00'),generator:async()=>{throw new DiagnosticPersistenceError();}}});
  await tick(fatal);assert.equal(fatal.info().failed,true);assert.equal(f.errors.length,1);assert.ok(f.errors.pop() instanceof DiagnosticPersistenceError);
});


test('真实故障3条有效7条typo占位逐项降级，真实Pi/SQLite正式期恢复与投递幂等',async t=>{
  let requests=0,mode='recorded';
  const server=createServer(async(request,response)=>{
    let raw='';for await(const chunk of request)raw+=chunk;
    const body=JSON.parse(raw);requests++;
    const input=JSON.parse(body.messages.find(message=>message.role==='user').content);
    if(mode==='timeout')return;
    if(mode==='transport'){response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'fixture unavailable'}}));return;}
    let text='{invalid json';
    if(mode==='recorded'){
      const projects=input.projects.map((p,index)=>({slug:p.slug,...(index<3?{introduction:`有效简介：管理文件的工具${index}。`}:{indroduction:'placeholder'})}));
      text=JSON.stringify({projects});
    }else if(mode==='tolerant'){
      const projects=input.projects.map(p=>({slug:p.slug,indroduction:'  管理文件的\n中文工具。 ',extra:true,url:'https://invented.example'})).reverse();
      projects.push({slug:'invented/project',introduction:'伪造项目'});
      projects.push({...projects.find(p=>p.slug===input.projects[0].slug)}); // ambiguous duplicate falls back, other items survive
      text='```json\n'+JSON.stringify({projects,extra:'ignored'})+'\n```';
    }else if(mode==='mapping'){
      text=JSON.stringify(Object.fromEntries(input.projects.map(p=>[p.slug,'管理文件。'.repeat(200)])));
    }
    response.writeHead(200,{'content-type':'text/event-stream'});
    response.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'deepseek-v4.1-flash',choices:[{index:0,delta:{role:'assistant',content:text},finish_reason:null}]})}\n\n`);
    response.end(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'deepseek-v4.1-flash',choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const f=fixture(t,{clock:at('09:00:00')}),base={...f.config,provider:'bailian',model:'deepseek-v4.1-flash',apiKey:'fixture-key',baseUrl:`http://127.0.0.1:${server.address().port}/v1`};
  let batches=0;
  const generator=(_config,frozen,signal)=>generateTrendingDigest(base,frozen,signal);
  let service=f.create({deps:{generator},output:async(_route,op)=>{batches++;await op();}});
  await tick(service);
  assert.equal(requests,1);assert.equal(batches,1);assert.equal(service.info().status,'sent');
  assert.equal(service.info().failed,false);assert.equal(service.info().degraded.length,7);
  let store=f.inspect();try{
    const edition=store.get('2026-10-30');assert.equal(edition.state,'delivered');assert.equal(edition.digest.degraded.length,7);
    const text=f.messages.map(m=>m.text).join('\n');
    assert.match(text,/有效简介：管理文件的工具0。/);assert.match(text,/原始描述：source/);assert.ok(!text.includes('placeholder'));
    let position=-1;for(const section of snapshot.sections)for(const project of section.projects){const next=text.indexOf(project.url);assert.ok(next>position);position=next;}
    assert.ok(f.messages.length<=5&&f.messages.every(m=>Buffer.byteLength(m.text)<=1500&&!m.text.includes('试运行')));
    assert.throws(()=>store.requestRecovery('2026-10-30',f.clock),/从未开始投递/);
  }finally{store.close();}
  const count=f.messages.length;await service.close();service=f.create({deps:{generator}});await tick(service);
  assert.equal(f.messages.length,count);assert.equal(requests,1);
  // Small protocol/transport variations share the same real Pi endpoint; each edition still makes exactly one call.
  for(const scenario of ['tolerant','json','transport','timeout','mapping']){
    mode=scenario;const before=requests;
    const frozen=structuredClone(snapshot);
    if(mode==='mapping')for(const section of frozen.sections)for(const [index,p]of section.projects.entries()){
      const repo=section.period+'-'+index;p.slug='a'.repeat(39)+'/'+repo+'x'.repeat(100-repo.length);p.url='https://github.com/'+p.slug;
    }
    if(mode==='json')frozen.sections[0].projects[0].description='';
    const generated=await generateTrendingDigest(mode==='timeout'?{...base,timeoutMs:1000}:base,frozen);
    assert.equal(requests,before+1);
    if(mode==='tolerant'){assert.equal(generated.degraded.length,1);assert.match(generated.sections[0].text,/管理文件的 中文工具。/);assert.ok(!generated.sections[0].text.includes('invented'));}
    if(mode==='json'||mode==='transport'||mode==='timeout'){assert.equal(generated.degraded.length,10);assert.match(generated.sections[0].text,mode==='json'?/资料有限/:/原始描述：/);}
    const id='scenario-'+scenario;
    const writer=f.inspect();try{writer.requestManual(id,[route],f.clock);writer.update('manual:'+id,e=>{e.snapshot=frozen;e.digest=generated;e.state='ready';});}finally{writer.close();}
    await tick(service);const inspector=f.inspect();try{assert.equal(inspector.get('manual:'+id).state,'delivered');}finally{inspector.close();}
    assert.equal(requests,before+1,'sending a persisted digest never calls the model');
  }
  await service.close();
  // Model failures from a previous release are explicitly recovered on the same formal edition, after 10:00.
  f.clock=Date.parse('2026-10-31T12:00:00+08:00');store=f.inspect();try{
    store.create({id:'2026-10-31',date:'2026-10-31',manual:false,state:'uncertain',code:'generation_unknown',snapshot,routes:[route],attempts:1,nextAttemptAt:0,createdAt:f.clock,updatedAt:f.clock});
    const recovered=store.requestRecovery('2026-10-31',f.clock);assert.equal(recovered.recovery.previousCode,'generation_unknown');
    assert.deepEqual(store.requestRecovery('2026-10-31',f.clock).recovery,recovered.recovery);
    assert.throws(()=>store.requestRecovery('2026-10-30',f.clock),/今天/);
  }finally{store.close();}
  const beforeRecovery=requests,priorMessages=f.messages.length;service=f.create({deps:{generator}});await tick(service);
  assert.equal(requests,beforeRecovery);assert.equal(service.info().status,'sent');assert.equal(service.info().failed,false);
  assert.ok(f.messages.length>priorMessages);assert.ok(f.messages.slice(priorMessages).every(m=>m.text.includes('2026-10-31')||!m.text.includes('GitHub Trending ·')));
  store=f.inspect();try{
    const recovered=store.get('2026-10-31');assert.equal(recovered.state,'delivered');assert.equal(recovered.recovery.previousState,'uncertain');assert.equal(recovered.recovery.previousCode,'generation_unknown');assert.equal(recovered.recovery.status,'completed');
  }finally{store.close();}
  const recoveredMessages=f.messages.length;await service.close();service=f.create({deps:{generator}});await tick(service);
  assert.equal(requests,beforeRecovery);assert.equal(f.messages.length,recoveredMessages);
  await service.close();f.clock=Date.parse('2026-11-01T23:59:00+08:00');store=f.inspect();try{
    store.create({id:'2026-11-01',date:'2026-11-01',manual:false,state:'uncertain',code:'generation_unknown',snapshot,routes:[route],attempts:1,nextAttemptAt:0,createdAt:f.clock,updatedAt:f.clock});
    store.prepareParts('2026-11-01',['must not retry'],f.clock);store.beginPart('2026-11-01',route,0);
    store.update('2026-11-01',e=>{e.state='uncertain';e.code='generation_unknown';});
    assert.throws(()=>store.requestRecovery('2026-11-01',f.clock),/从未开始投递/);
  }finally{store.close();}
  f.clock=Date.parse('2026-11-02T08:00:00+08:00');service=f.create({deps:{generator}});await tick(service);
  assert.equal(requests,beforeRecovery);assert.equal(f.messages.length,recoveredMessages);
});
