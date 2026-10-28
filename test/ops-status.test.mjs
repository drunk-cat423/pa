import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {collectStatus} from '../scripts/ops/server-status.mjs';

function fixture(t){
  const parent=resolve(tmpdir()),dir=mkdtempSync(join(parent,'pa-ops-'));
  const current=join(dir,'a'.repeat(40)),now=Date.parse('2026-10-28T12:00:00Z'),at=new Date(now).toISOString();
  mkdirSync(current);mkdirSync(join(dir,'qq-service'));mkdirSync(join(dir,'diagnostics'));
  const status={state:'sent',pid:42,updatedAt:at,reminders:{started:true,failed:false},research:{failed:false},isolatedRooms:[],integrity:[{status:'healthy'}]};
  writeFileSync(join(dir,'qq-service/status.json'),JSON.stringify(status));
  const db=new DatabaseSync(join(dir,'pa.sqlite'));
  db.exec(`PRAGMA user_version=33;
    CREATE TABLE channel_tasks(id,status,created_at,updated_at);
    CREATE TABLE deliveries(status,created_at);
    CREATE TABLE research_tasks(id,status,created_at,updated_at);
    CREATE TABLE research_attempts(status,created_at);
    CREATE TABLE auto_memory_jobs(id,status,pipeline,created_at,lease_until);
    CREATE TABLE auto_memory_recoveries(failed_job_id,attempt,due_at,replacement_job_id);
    CREATE TABLE auto_memory_job_deferrals(job_id);
    CREATE TABLE auto_memory_job_retirements(job_id);
    CREATE TABLE auto_memory_legacy_isolations(job_id);`);
  const diag=new DatabaseSync(join(dir,'diagnostics/index.sqlite'));
  diag.exec('PRAGMA user_version=1; CREATE TABLE calls(call_id,record_json); CREATE TABLE events(id,call_id,event_json);');
  diag.prepare('INSERT INTO calls VALUES (?,?)').run('call',JSON.stringify({updatedAt:at,status:'completed',phase:'response',privateText:'NEVER_OUTPUT_PRIVATE_TEXT'}));
  for(const phase of ['claim','input'])diag.prepare('INSERT INTO events(id,event_json) VALUES (?,?)').run(phase,JSON.stringify({at,phase,details:{privateText:'NEVER_OUTPUT_PRIVATE_TEXT'}}));
  const files=[join(dir,'pa.sqlite'),join(dir,'diagnostics/index.sqlite')];
  const fingerprint=()=>files.map(path=>createHash('sha256').update(readFileSync(path)).digest('hex'));
  const system=zero=>({
    command:(_command,args)=>args[1].endsWith('.timer')
      ?'ActiveState=active\nUnitFileState=enabled\nNextElapseUSecRealtime=later\nLastTriggerUSec=earlier'
      :args.includes('Result')||args.includes('-p')&&args.includes('ExecMainStatus')
        ?'Result=success\nExecMainStatus=0\nActiveState=inactive'
        :'MainPID=42\nNRestarts=0\nMemoryCurrent=1000000\nMemoryHigh=100000000\nMemoryMax=200000000\nActiveState=active\nSubState=running\nControlGroup=/system.slice/pa.service',
    readText:path=>path.endsWith('meminfo')?`MemAvailable: ${zero?0:1048576} kB`
      :path.endsWith('memory.events')?'high 0\nmax 0\noom 0\noom_kill 0'
      :'anon 1000\nfile 2000\ninactive_file 1000',
    statfs:()=>({blocks:40*1024,bsize:1024*1024,bavail:zero?0:30*1024}),
    journal:args=>{assert.deepEqual(args.slice(0,4),['-u','pa.service','-u','mihomo-pa.service']);return '';},
  });
  t.after(()=>{diag.close();db.close();const target=resolve(dir);assert.ok(target.startsWith(parent+sep));rmSync(target,{recursive:true,force:true});});
  return {db,diag,now,at,status,fingerprint,collect:zero=>collectStatus({dataDir:dir,current,now,system:system(zero)}),
    writeStatus:()=>writeFileSync(join(dir,'qq-service/status.json'),JSON.stringify(status))};
}

test('巡检不把sent和正常claim/input阶段报异常，隔离旧队列不掩盖当前活动且仅读元数据',t=>{
  const f=fixture(t);
  for(let n=0;n<25;n++){
    f.db.prepare('INSERT INTO auto_memory_jobs VALUES (?,\'queued\',\'legacy\',?,NULL)').run('old-'+n,f.at);
    f.db.prepare('INSERT INTO auto_memory_job_retirements VALUES (?)').run('old-'+n);
  }
  f.db.prepare('INSERT INTO auto_memory_jobs VALUES (?,\'running\',\'materials\',?,?)').run('current',f.at,f.now+60000);
  const before=f.fingerprint(),r=f.collect(false);
  assert.equal(r.complete,true);assert.equal(r.ok,true,JSON.stringify(r.findings));
  assert.deepEqual(r.database.active.map(x=>x.id),['current']);assert.equal(r.diagnostics.events,2);
  assert.equal(JSON.stringify(r).includes('NEVER_OUTPUT_PRIVATE_TEXT'),false);assert.deepEqual(f.fingerprint(),before);
});

test('自动搁置不能隐藏耗尽缺口，资源耗尽和新unknown调用必须报出',t=>{
  const f=fixture(t);
  f.db.prepare('INSERT INTO auto_memory_jobs VALUES (?,\'failed\',\'materials\',?,NULL)').run('gap',f.at);
  f.db.prepare('INSERT INTO auto_memory_recoveries VALUES (?,3,?,NULL)').run('gap',f.now-1);
  f.db.prepare('INSERT INTO auto_memory_job_deferrals VALUES (?)').run('gap');
  f.diag.prepare('INSERT INTO calls VALUES (?,?)').run('unknown',JSON.stringify({updatedAt:f.at,status:'unknown',phase:'response'}));
  const before=f.fingerprint(),r=f.collect(true),codes=r.findings.map(x=>x.code);
  assert.equal(r.complete,true);assert.equal(r.ok,false);assert.equal(r.database.memoryRecoveryGaps.exhausted,1);
  for(const code of ['memory_recovery_exhausted','host_memory_low','host_disk_low','recent_model_call_unknown'])assert.ok(codes.includes(code),code);
  assert.deepEqual(f.fingerprint(),before);
});

test('缓存巡检按scope和stage发现命中骤降且不读取正文或修改诊断库',t=>{
  const f=fixture(t),systemA='a'.repeat(64),systemB='b'.repeat(64),tools='c'.repeat(64);
  let sequence=0;
  const add=(callId,{scope='room-a',stage='prepare',cacheRead,input=100000,systemHash=systemA,toolsHash=tools,usage=true,window=200000,
    prefix=true,contextKind}={})=>{
    const at=new Date(f.now+sequence++).toISOString();
    const usageData=usage?{input:0,cacheRead,cacheWrite:input-cacheRead,output:100,totalTokens:input+100}:undefined;
    const record={kind:'chat',provider:'anthropic',model:'claude-test',conversationId:scope,contextCalibration:{key:`cal-${scope}`},
      status:'completed',phase:'response',createdAt:at,updatedAt:at,...(usage?{usage:usageData}:{})};
    f.diag.prepare('INSERT INTO calls VALUES (?,?)').run(callId,JSON.stringify(record));
    const event={at,phase:'request',event:'model.request_prepared',callId,details:{stage,requestNumber:1,
      cachePrefix:prefix&&systemHash&&toolsHash?{version:1,systemHash,toolsHash}:undefined,contextWindow:window,
      ...(contextKind?{contextKind}:{}),
      privateText:'NEVER_OUTPUT_CACHE_BODY'}};
    f.diag.prepare('INSERT INTO events(id,call_id,event_json) VALUES (?,?,?)').run(`event-${callId}`,callId,JSON.stringify(event));
  };
  add('high-system',{cacheRead:90000});
  add('low-system',{cacheRead:7000,systemHash:systemB});
  add('answer-only',{scope:'room-a',stage:'answer',cacheRead:7000});
  add('high-same-prefix',{scope:'room-c',cacheRead:90000});
  add('low-same-prefix',{scope:'room-c',cacheRead:7000});
  add('cold-room',{scope:'room-cold',cacheRead:7000});
  add('high-unknown-prefix',{scope:'room-d',cacheRead:90000,prefix:false});
  add('low-unknown-prefix',{scope:'room-d',cacheRead:7000,prefix:false});
  add('newest-without-window',{cacheRead:90000,window:null});
  add('missing-usage',{cacheRead:0,usage:false,contextKind:'channel'});
  add('research-call',{scope:'research-room',cacheRead:7000,contextKind:'research'});
  add('cli-call',{scope:'cli-room',cacheRead:7000,contextKind:'cli'});
  add('review-call',{scope:'review-room',stage:'attribution_review',cacheRead:7000,contextKind:'channel'});
  add('missing-stage',{scope:'missing-room',cacheRead:7000,contextKind:'channel'});
  f.diag.prepare('DELETE FROM events WHERE call_id=?').run('missing-stage');
  f.diag.prepare('INSERT INTO events(id,call_id,event_json) VALUES (?,?,?)').run('duplicate-prepared','high-system',
    JSON.stringify({at:new Date(f.now).toISOString(),phase:'request',event:'model.request_prepared',callId:'high-system',
      details:{stage:'prepare',requestNumber:2,contextWindow:200000,cachePrefix:{version:1,systemHash:systemA,toolsHash:tools}}}));
  const before=f.fingerprint(),r=f.collect(false),cache=r.diagnostics.contextCache;
  assert.equal(r.complete,true);assert.equal(cache.sampledCalls,10);
  assert.equal(cache.contextKind.channel,1);assert.equal(cache.contextKind.legacy,9);
  assert.equal(cache.contextKind.excludedResearch,1);assert.equal(cache.contextKind.excludedCli,1);
  assert.equal(cache.contextKind.excludedReview,1);assert.equal(cache.contextKind.missingStage,1);
  assert.equal(cache.status,'partial');
  assert.ok(r.findings.some(item=>item.code==='cache_stage_metadata_missing'));
  assert.equal(cache.truncated,false);assert.equal(cache.sampleBoundary.newestUpdatedAt,new Date(f.now+9).toISOString());
  assert.equal(cache.stages.prepare.missingUsage,1);
  assert.equal(cache.stages.prepare.samples,9);
  assert.equal(cache.stages.prepare.latestUsage.callId,'newest-without-window');
  assert.equal(cache.stages.prepare.latestUsage.contextWindow,null);
  assert.equal(cache.stages.prepare.latestInputToWindowRatio,null);
  assert.deepEqual(cache.cacheDrops.map(drop=>[drop.previous.callId,drop.current.callId,drop.reason]),[
    ['high-system','low-system','system_prefix_changed'],['high-same-prefix','low-same-prefix','prefix_unchanged_or_provider'],
    ['high-unknown-prefix','low-unknown-prefix','unknown_prefix'],
  ]);
  assert.equal(cache.cacheDrops[0].fingerprintChanges.system,true);
  assert.equal(cache.cacheDrops[2].fingerprintChanges.system,null);
  assert.equal(cache.stages.answer.largeInputLowCache,1);
  assert.equal(r.findings.filter(item=>item.code==='context_cache_efficiency_drop').length,3);
  assert.equal(JSON.stringify(r).includes('NEVER_OUTPUT_CACHE_BODY'),false);
  assert.deepEqual(f.fingerprint(),before);
});
