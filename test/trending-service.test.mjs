import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TrendingService} from '../dist/trending-service.js';
import {TrendingStore} from '../dist/trending-store.js';
import {readTrendingConfig} from '../dist/config.js';
import {DiagnosticPersistenceError} from '../dist/diagnostics.js';

const route={channel:'qq',accountId:'offline',roomType:'group',roomId:'one'};
const at=time=>Date.parse(`2026-10-30T${time}+08:00`);
const snapshot={fetchedAt:'2026-10-30T00:55:00Z',sections:['daily','weekly','monthly'].map((period,index)=>({period,sourceUrl:`https://github.com/trending?since=${period}`,projects:Array.from({length:[5,3,2][index]},(_,i)=>({slug:`owner/project-${period}-${i}`,url:`https://github.com/owner/project-${period}-${i}`,description:'source'}))}))};
const digest={snapshot,sections:snapshot.sections.map(s=>({period:s.period,text:`## ${s.period}\n`+s.projects.map(p=>`### ${p.slug}\n${'中'.repeat(100)}\n${p.url}`).join('\n')}))};
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

test('采集仅3次、模型未知仅1次且不堵次日；10点以后不补历史期',async t=>{
  let collects=0,generates=0;
  const f=fixture(t,{collect:async()=>{collects++;if(collects<=3)throw new Error('offline');return snapshot;},generate:async()=>{generates++;throw new Error('unknown model result');}});
  const service=f.create();await tick(service);await tick(service);assert.equal(collects,1);
  f.clock+=60_000;await tick(service);f.clock+=60_000;await tick(service);assert.equal(collects,3);assert.equal(service.info().errorCode,'collect_exhausted');
  f.clock=Date.parse('2026-10-31T09:10:00+08:00');await tick(service);await tick(service);assert.equal(generates,1);assert.equal(service.info().errorCode,'generation_unknown');
  f.clock=Date.parse('2026-11-01T10:00:00+08:00');await tick(service);assert.equal(generates,1);assert.equal(collects,4);assert.equal(f.messages.length,0);
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
