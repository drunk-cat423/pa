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
  diag.exec('PRAGMA user_version=1; CREATE TABLE calls(call_id,record_json); CREATE TABLE events(id,event_json);');
  diag.prepare('INSERT INTO calls VALUES (?,?)').run('call',JSON.stringify({updatedAt:at,status:'completed',phase:'response',privateText:'NEVER_OUTPUT_PRIVATE_TEXT'}));
  for(const phase of ['claim','input'])diag.prepare('INSERT INTO events VALUES (?,?)').run(phase,JSON.stringify({at,phase,details:{privateText:'NEVER_OUTPUT_PRIVATE_TEXT'}}));
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
