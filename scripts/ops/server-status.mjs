#!/opt/node-v24.15.0/bin/node
// Read-only, dependency-free production status collection. Safe to pipe to remote Node.
import { readFileSync, realpathSync, statfsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const VERSION = 1;
const TABLES = ['channel_tasks','deliveries','research_tasks','research_attempts','auto_memory_jobs',
  'auto_memory_recoveries','auto_memory_job_deferrals','auto_memory_job_retirements','auto_memory_legacy_isolations'];
const nowIso = () => new Date().toISOString();
const safeInt = value => value===null||value===undefined||value===''||value==='max'||value==='infinity' ? null : Number.isSafeInteger(Number(value)) ? Number(value) : null;

export function parseArgs(args) {
  const options = { hours: 24, expectedRelease: null, dataDir: '/var/lib/pa', current: '/opt/pa/current', help: false };
  for (let i=0; i<args.length; i++) {
    const arg=args[i];
    if (arg==='--help' || arg==='-h') { options.help=true; continue; }
    if (!['--hours','--expected-release','--data-dir','--current'].includes(arg)) throw new Error('unknown_option');
    const value=args[++i]; if (value===undefined || value.startsWith('--')) throw new Error('invalid_argument');
    if (arg==='--hours') { if (!/^\d+$/.test(value) || Number(value)<1 || Number(value)>168) throw new Error('invalid_hours'); options.hours=Number(value); }
    if (arg==='--expected-release') { if (!/^[a-fA-F0-9]{40}$/.test(value)) throw new Error('invalid_expected_release'); options.expectedRelease=value.toLowerCase(); }
    if (arg==='--data-dir') options.dataDir=resolve(value);
    if (arg==='--current') options.current=resolve(value);
  }
  return options;
}

function finding(code,severity,message,details={}) { return {code,severity,message,...details}; }
function command(file,args,maxBuffer=1024*1024) {
  try { return execFileSync(file,args,{encoding:'utf8',timeout:15000,maxBuffer,stdio:['ignore','pipe','ignore']}).trim(); }
  catch { return null; }
}
function readText(path) { try { return readFileSync(path,'utf8').trim(); } catch { return null; } }
function tableSet(db) { return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>String(x.name))); }
function columns(db, table) { return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map(x=>String(x.name))); }
function countByStatus(db, table, where='1=1', params=[]) {
  const rows=db.prepare(`SELECT status,COUNT(*) AS n FROM "${table}" WHERE ${where} GROUP BY status`).all(...params);
  return Object.fromEntries(rows.map(r=>[String(r.status),Number(r.n)]));
}
function ageCount(db, table, timeColumn, cutoff) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${timeColumn}" >= ?`).get(cutoff).n);
}
function addCount(target,key,count){target[key]=(target[key]??0)+Number(count);}
const DIAG_STATUS=new Set(['started','completed','failed','unknown']);
const DIAG_PHASE=new Set(['claim','input','request','response','parse','validate','commit','ledger','completed','http','prepare','answer','tool','attribution','checkpoint','recover','extract','plan','collect','write','review','persist','send','profile_capacity','profile_refine','model_proposal']);
const DIAG_CODES=new Set(['model_length','model_request','model_empty','model_json','model_contract','state_persistence','obsolete_personal_memory',
  'profile_protocol','profile_capacity','profile_refinement','output_budget','input_too_large','profile_conflict','budget','closed','unexpected',
  'model_proposal_rejected','search_request_failed','search_http_failed','search_parse_failed','search_response_failed','search_persistence_failed']);
function fixedPhase(value){return typeof value==='string'&&DIAG_PHASE.has(value)?value:'other';}
function fixedCode(value){
  if(typeof value!=='string')return 'other';
  const bracket=value.match(/^\[([a-z][a-z0-9_]*)\]/)?.[1];
  const direct=value.match(/^([a-z][a-z0-9_]*)$/)?.[1];
  const code=bracket??direct;return code&&DIAG_CODES.has(code)?code:'other';
}
function safeTokenCount(value){return Number.isSafeInteger(value)&&value>=0?value:null;}
function safePositiveTokenCount(value){return Number.isSafeInteger(value)&&value>0?value:null;}
function safeFingerprint(value){return typeof value==='string'&&/^[a-f0-9]{64}$/i.test(value)?value.toLowerCase():null;}
function cacheStage(value){return value==='prepare'||value==='answer'?value:null;}
function median(values){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;}
function cacheRate(usage){
  if(!usage||typeof usage!=='object'||Array.isArray(usage))return null;
  const keys=['input','cacheRead','cacheWrite','output','totalTokens'];
  if(!keys.every(key=>Number.isSafeInteger(usage[key])&&usage[key]>=0))return null;
  const input=usage.input+usage.cacheRead+usage.cacheWrite;
  if(!Number.isSafeInteger(input)||input<=0||input+usage.output!==usage.totalTokens)return null;
  return {input,cacheRead:usage.cacheRead,rate:usage.cacheRead/input};
}
function sqliteReport(path, hours, findings, now, system) {
  const report={status:'unknown',schemaVersion:null,integrity:null,tables:{},recent:{},active:[]};
  let db;
  try {
    db=new DatabaseSync(path,{readOnly:true});
    db.exec('PRAGMA busy_timeout=3000');
    db.exec('BEGIN');
    const version=db.prepare('PRAGMA user_version').get(); report.schemaVersion=Number(Object.values(version)[0]);
    const quick=db.prepare('PRAGMA quick_check').all().map(x=>String(Object.values(x)[0]));
    const fk=db.prepare('PRAGMA foreign_key_check').all();
    report.integrity={quickCheck:quick.length===1&&quick[0]==='ok'?'ok':'failed',foreignKeyViolations:fk.length};
    if (report.integrity.quickCheck!=='ok') findings.push(finding('database_quick_check_failed','critical','SQLite quick_check reported a problem.'));
    if (fk.length) findings.push(finding('database_foreign_key_violations','critical','SQLite foreign_key_check found violations.',{count:fk.length}));
    const available=tableSet(db);
    const expected=Number(report.schemaVersion)===33;
    for (const table of TABLES) {
      if (!available.has(table)) { report.tables[table]={status:'unsupported'}; findings.push(finding('schema_table_missing','attention','A monitored table is unavailable.',{table})); continue; }
      const cols=columns(db,table);
      if (!cols.has('status')) {
        // These audit tables deliberately have no status column; presence and row count
        // distinguish recovery/deferral/retirement/isolation without reading reasons.
        if(['auto_memory_recoveries','auto_memory_job_deferrals','auto_memory_job_retirements','auto_memory_legacy_isolations'].includes(table)) {
          const required={auto_memory_recoveries:['failed_job_id','attempt','due_at','replacement_job_id'],auto_memory_job_deferrals:['job_id'],
            auto_memory_job_retirements:['job_id'],auto_memory_legacy_isolations:['job_id']}[table];
          if(required.some(column=>!columns(db,table).has(column))) { report.tables[table]={status:'unsupported'};findings.push(finding('schema_table_unsupported','attention','A monitored table has an unsupported layout.',{table}));continue; }
          report.tables[table]={status:'ok',count:Number(db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n)};
          continue;
        }
        report.tables[table]={status:'unsupported'}; findings.push(finding('schema_table_unsupported','attention','A monitored table has an unsupported layout.',{table})); continue;
      }
      const value={status:'ok',byStatus:countByStatus(db,table)};
      const dateCol=cols.has('updated_at')?'updated_at':cols.has('created_at')?'created_at':null;
      if (dateCol) { try { value.recent=ageCount(db,table,dateCol,new Date(now-hours*3600000).toISOString()); } catch { value.status='unsupported'; } }
      report.tables[table]=value;
      if(table==='deliveries'&&Number(value.byStatus.uncertain??0)>0)findings.push(finding('delivery_uncertain','attention','Some message deliveries have an uncertain outcome.',{count:Number(value.byStatus.uncertain)}));
      if(table==='research_tasks'&&Number(value.byStatus.blocked??0)>0)findings.push(finding('research_blocked','attention','Some research tasks are blocked and require their recorded resume path.',{count:Number(value.byStatus.blocked)}));
      if (table==='channel_tasks' || table==='research_tasks' || table==='auto_memory_jobs') {
        const dependencies=table==='auto_memory_jobs'?['auto_memory_job_deferrals','auto_memory_job_retirements','auto_memory_legacy_isolations','auto_memory_recoveries']:[];
        if(dependencies.some(name=>!available.has(name))){report.tables[table]={status:'unsupported'};findings.push(finding('schema_table_unsupported','attention','A monitored table has missing recovery ledgers.',{table}));continue;}
        let q;
        if (table==='channel_tasks' && cols.has('created_at') && cols.has('updated_at')) q=db.prepare("SELECT id,status,created_at,updated_at FROM channel_tasks WHERE status IN ('queued','running') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,created_at LIMIT 20");
        if (table==='research_tasks' && cols.has('created_at') && cols.has('updated_at')) q=db.prepare("SELECT id,status,created_at,updated_at FROM research_tasks WHERE status IN ('queued','running','blocked') ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END,created_at LIMIT 20");
        if (table==='auto_memory_jobs' && cols.has('created_at') && cols.has('pipeline') && cols.has('lease_until')) q=db.prepare(`SELECT j.id,j.status,j.pipeline,j.created_at,j.lease_until,
          EXISTS(SELECT 1 FROM auto_memory_job_deferrals d WHERE d.job_id=j.id) AS deferred,
          EXISTS(SELECT 1 FROM auto_memory_job_retirements r WHERE r.job_id=j.id) AS retired,
          EXISTS(SELECT 1 FROM auto_memory_legacy_isolations i WHERE i.job_id=j.id) AS isolated,
          EXISTS(SELECT 1 FROM auto_memory_recoveries r WHERE r.failed_job_id=j.id AND r.replacement_job_id IS NULL AND r.attempt<3) AS retryableGap,
          EXISTS(SELECT 1 FROM auto_memory_recoveries r WHERE r.failed_job_id=j.id AND r.replacement_job_id IS NULL AND r.attempt>=3) AS exhaustedGap,
          EXISTS(SELECT 1 FROM auto_memory_recoveries r WHERE r.failed_job_id=j.id AND r.replacement_job_id IS NOT NULL) AS replacementCreated
          FROM auto_memory_jobs j WHERE j.status IN ('queued','running')
            AND NOT EXISTS(SELECT 1 FROM auto_memory_job_deferrals d WHERE d.job_id=j.id)
            AND NOT EXISTS(SELECT 1 FROM auto_memory_job_retirements r WHERE r.job_id=j.id)
            AND NOT EXISTS(SELECT 1 FROM auto_memory_legacy_isolations i WHERE i.job_id=j.id)
          ORDER BY CASE j.status WHEN 'running' THEN 0 ELSE 1 END,j.created_at LIMIT 20`);
        if (!q) {report.tables[table]={status:'unsupported'};findings.push(finding('schema_table_unsupported','attention','A monitored table has an unsupported layout.',{table}));continue;}
        if (q) report.active.push(...q.all().map(row=>{
          const item={table,id:String(row.id),status:String(row.status),createdAt:row.created_at==null?null:String(row.created_at)};
          if (row.pipeline!=null) item.pipeline=String(row.pipeline);
          if (row.lease_until!=null) item.leaseUntil=safeInt(row.lease_until);
          if (row.deferred!=null) Object.assign(item,{deferred:Boolean(row.deferred),retired:Boolean(row.retired),isolated:Boolean(row.isolated),
            recoveryGapWaiting:Boolean(row.retryableGap),recoveryGapExhausted:Boolean(row.exhaustedGap),replacementCreated:Boolean(row.replacementCreated)});
          return item;
        }));
      }
    }
    report.active.sort((a,b)=>({running:0,blocked:1,queued:2}[a.status]??3)-({running:0,blocked:1,queued:2}[b.status]??3)
      || String(a.createdAt??'').localeCompare(String(b.createdAt??'')));
    report.active=report.active.slice(0,20);
    const memoryCols=columns(db,'auto_memory_jobs');
    if(memoryCols.has('pipeline')) {
      const classes=db.prepare(`SELECT CASE
          WHEN EXISTS(SELECT 1 FROM auto_memory_job_retirements t WHERE t.job_id=j.id) THEN 'retired'
          WHEN EXISTS(SELECT 1 FROM auto_memory_legacy_isolations i WHERE i.job_id=j.id) THEN 'isolated'
          WHEN EXISTS(SELECT 1 FROM auto_memory_recoveries r WHERE r.failed_job_id=j.id AND r.replacement_job_id IS NOT NULL) THEN 'replacement_created'
          WHEN EXISTS(SELECT 1 FROM auto_memory_recoveries r WHERE r.failed_job_id=j.id AND r.attempt>=3) THEN 'recovery_exhausted'
          WHEN EXISTS(SELECT 1 FROM auto_memory_recoveries r WHERE r.failed_job_id=j.id AND r.replacement_job_id IS NULL) THEN 'recovery_waiting'
          WHEN EXISTS(SELECT 1 FROM auto_memory_job_deferrals d WHERE d.job_id=j.id) THEN 'deferred'
          WHEN j.status='failed' AND j.pipeline IN ('materials','compression') THEN 'failed_without_recovery'
          WHEN j.status='failed' THEN 'failed_closed'
          WHEN j.status='done' THEN 'completed' ELSE 'active'
        END AS classification,COUNT(*) AS n FROM auto_memory_jobs j GROUP BY classification`).all();
      report.memoryJobs={byClass:Object.fromEntries(classes.map(x=>[String(x.classification),Number(x.n)]))};
      if(report.memoryJobs.byClass.failed_without_recovery) findings.push(finding('memory_failure_untracked','attention',
        'Some failed material or compression attempts lack a recovery registration.',{count:report.memoryJobs.byClass.failed_without_recovery}));
      const gapRow=db.prepare(`SELECT
        SUM(CASE WHEN d.job_id IS NOT NULL THEN 1 ELSE 0 END) AS deferred,
        SUM(CASE WHEN t.job_id IS NOT NULL THEN 1 ELSE 0 END) AS retired,
        SUM(CASE WHEN t.job_id IS NULL AND i.job_id IS NOT NULL THEN 1 ELSE 0 END) AS isolated,
        SUM(CASE WHEN t.job_id IS NULL AND i.job_id IS NULL AND r.attempt>=3 THEN 1 ELSE 0 END) AS exhausted,
        SUM(CASE WHEN t.job_id IS NULL AND i.job_id IS NULL AND r.attempt<3 THEN 1 ELSE 0 END) AS waiting,
        SUM(CASE WHEN t.job_id IS NULL AND i.job_id IS NULL AND r.attempt<3 AND r.due_at<=? THEN 1 ELSE 0 END) AS due
        FROM auto_memory_jobs j JOIN auto_memory_recoveries r ON r.failed_job_id=j.id
        LEFT JOIN auto_memory_job_deferrals d ON d.job_id=j.id LEFT JOIN auto_memory_job_retirements t ON t.job_id=j.id
        LEFT JOIN auto_memory_legacy_isolations i ON i.job_id=j.id
        WHERE j.status='failed' AND r.replacement_job_id IS NULL AND j.pipeline IN ('materials','compression')`).get(now);
      const gaps=Object.fromEntries(['waiting','exhausted','deferred','retired','isolated','due'].map(key=>[key,Number(gapRow[key]??0)]));
      report.memoryRecoveryGaps=gaps;
      if(gaps.due)findings.push(finding('memory_recovery_due','attention','Memory recovery gaps are due for a fresh bounded recovery attempt.',{count:gaps.due}));
      if(gaps.exhausted)findings.push(finding('memory_recovery_exhausted','attention','Some automatic memory recovery gaps have exhausted their retry allowance.',{count:gaps.exhausted}));
    } else findings.push(finding('memory_pipeline_unsupported','attention','Memory pipeline column is unavailable.'));
    if(memoryCols.has('lease_until')) {
      const missingLease=Number(db.prepare("SELECT COUNT(*) AS n FROM auto_memory_jobs WHERE status='running' AND lease_until IS NULL").get().n);
      if(missingLease)findings.push(finding('memory_job_lease_unknown','attention','Running memory jobs have no lease deadline.',{count:missingLease}));
      const expiredCount=Number(db.prepare("SELECT COUNT(*) AS n FROM auto_memory_jobs WHERE status='running' AND lease_until IS NOT NULL AND lease_until<=?").get(now).n);
      if(expiredCount){const expiredRows=db.prepare("SELECT id FROM auto_memory_jobs WHERE status='running' AND lease_until IS NOT NULL AND lease_until<=? ORDER BY lease_until LIMIT 20").all(now);
        findings.push(finding('memory_job_lease_expired','attention','Active memory jobs have expired leases.',{count:expiredCount,ids:expiredRows.map(x=>String(x.id))}));}
    }
    if (!expected) findings.push(finding('schema_version_unexpected','attention','Database schema version differs from the expected production schema.',{version:report.schemaVersion}));
    report.status='ok';
    db.exec('COMMIT');
  } catch {
    try { db?.exec('ROLLBACK'); } catch {}
    report.status='failed';
    findings.push(finding('database_read_failed','critical','SQLite data could not be collected.'));
  } finally { try { db?.close(); } catch {} }
  return report;
}

function serviceStatus(unit, findings, system) {
  const props=['ActiveState','SubState','MainPID','NRestarts','MemoryCurrent','MemoryHigh','MemoryMax','ControlGroup'];
  const raw=system.command('systemctl',['show',unit,...props.flatMap(p=>['-p',p])]);
  if (raw===null) { findings.push(finding('systemd_status_unavailable','attention','A systemd service status could not be collected.',{unit})); return {status:'unknown'}; }
  const result={};
  for (const line of raw.split(/\r?\n/)) { const at=line.indexOf('='); if(at<0) continue; const key=line.slice(0,at),value=line.slice(at+1); if(key==='ActiveState'||key==='SubState')result[key]=value; else if(key==='ControlGroup'&&/^\/system\.slice\/[A-Za-z0-9_.@:-]+\.service$/.test(value))result.controlGroup=value; else if(['MainPID','NRestarts','MemoryCurrent','MemoryHigh','MemoryMax'].includes(key))result[key]=value==='infinity'?value:safeInt(value); }
  if(result.ActiveState===undefined||result.MainPID==null||result.MainPID<1||result.NRestarts==null||result.MemoryCurrent==null)findings.push(finding('service_status_incomplete','attention','A required systemd service status field is unavailable.',{unit}));
  if(result.ActiveState!=='active')findings.push(finding('service_not_active','critical','A monitored service is not active.',{unit}));
  return result;
}

function timerStatus(timer, service, findings, system) {
  const serviceRaw=system.command('systemctl',['show',service,'-p','Result','-p','ExecMainStatus','-p','ActiveState']);
  const timerRaw=system.command('systemctl',['show',timer,'-p','NextElapseUSecRealtime','-p','LastTriggerUSec','-p','ActiveState','-p','UnitFileState']);
  if(serviceRaw===null||timerRaw===null){findings.push(finding('timer_status_unavailable','attention','A retention service or timer status could not be collected.',{unit:timer}));return {status:'unknown'};}
  const result={}; for(const line of serviceRaw.split(/\r?\n/)){const i=line.indexOf('=');if(i>=0)result[line.slice(0,i)]=line.slice(i+1);}
  for(const line of timerRaw.split(/\r?\n/)){const i=line.indexOf('=');if(i>=0)result[line.slice(0,i)]=line.slice(i+1);}
  result.timerActiveState=result.ActiveState;delete result.ActiveState;
  if(!result.Result||result.ExecMainStatus===undefined||!result.NextElapseUSecRealtime||!result.LastTriggerUSec||!result.timerActiveState||!result.UnitFileState){
    findings.push(finding('timer_status_unavailable','attention','A required retention service or timer field is unavailable.',{unit:timer}));return {status:'unknown'};
  }
  if((result.Result&&result.Result!=='success')||result.ExecMainStatus!=='0')findings.push(finding('retention_service_failed','attention','A retention service reports a failed result or exit status.',{unit:service}));
  if(result.timerActiveState!=='active')findings.push(finding(result.UnitFileState==='enabled'?'retention_timer_enabled_inactive':'retention_timer_inactive','attention',
    result.UnitFileState==='enabled'?'An enabled retention timer is inactive.':'A retention timer is not active.',{unit:timer}));
  return result;
}

function statusProjection(path, findings, expectedPid) {
  try {
    const raw=JSON.parse(readFileSync(path,'utf8'));
    const out={};
    for(const key of ['state','pid','updatedAt'])if(['string','number'].includes(typeof raw[key]))out[key]=raw[key];
    if(typeof raw.state!=='string'||raw.pid==null||raw.updatedAt==null)findings.push(finding('status_file_incomplete','attention','The service status file is missing required health fields.'));
    // state is the latest transport/task event, not a persistent ready flag.
    // A successful delivery replaces READY with "sent"; accepting work is normal.
    const healthyStates=['ready_waiting_for_mention','QQ Gateway READY','QQ Gateway 已恢复','accepted','sent'];
    const attentionStates=['QQ 正在重连','uncertain','rejected','failed','budget_exhausted'];
    const stoppedStates=['stopped','test_budget_complete','persistence_failed','connection_failed'];
    if(attentionStates.includes(raw.state))findings.push(finding('last_service_event_attention','attention','The latest transport or task event needs attention.'));
    else if(stoppedStates.includes(raw.state))findings.push(finding('worker_not_ready','critical','The PA status records a stopped or failed worker.'));
    else if(!healthyStates.includes(raw.state))findings.push(finding('status_state_unrecognized','attention','The latest service state is not recognized by this collector.'));
    if(expectedPid==null||safeInt(raw.pid)==null)findings.push(finding('worker_pid_unknown','attention','The worker PID could not be confirmed.'));
    else if(safeInt(raw.pid)!==expectedPid)findings.push(finding('worker_pid_mismatch','attention','The worker PID does not match the systemd main process.'));
    if(raw.failed===true||raw.state==='persistence_failed'||raw.state==='connection_failed')findings.push(finding('worker_failed','critical','The service status reports a worker failure.'));
    const reminders=raw.reminders;
    if(reminders&&typeof reminders==='object'){
      const projected={};for(const key of ['started','failed'])if(typeof reminders[key]==='boolean')projected[key]=reminders[key];
      if(typeof reminders.started!=='boolean'||typeof reminders.failed!=='boolean')findings.push(finding('status_reminders_unknown','attention','Reminder worker health fields are missing.'));
      else if(!reminders.started)findings.push(finding('reminder_worker_not_started','attention','Reminder worker has not started.'));
      if(reminders.failed===true){findings.push(finding('reminder_worker_failed','attention','Reminder worker reports a failure.'));findings.push(finding('worker_failed','critical','The service status reports a worker failure.'));}
      out.reminders=projected;
    } else findings.push(finding('status_reminders_unknown','attention','Reminder worker health is not present in the status file.'));
    if(raw.research&&typeof raw.research==='object'&&typeof raw.research.failed==='boolean'){
      out.research={failed:raw.research.failed};if(raw.research.failed){findings.push(finding('research_worker_failed','attention','Research worker reports a failure.'));findings.push(finding('worker_failed','critical','The service status reports a worker failure.'));}
    } else findings.push(finding('status_research_unknown','attention','Research worker health is not present in the status file.'));
    if(Array.isArray(raw.isolatedRooms)){out.isolatedRooms=raw.isolatedRooms.length;if(raw.isolatedRooms.length)findings.push(finding('rooms_isolated','attention','One or more rooms are isolated.',{count:raw.isolatedRooms.length}));}
    else findings.push(finding('status_isolation_unknown','attention','Room isolation count is unavailable.'));
    if(Array.isArray(raw.integrity))out.integrity={status:raw.integrity.some(x=>x?.status!=='healthy')?'attention':'healthy'};
    else if(raw.integrity&&typeof raw.integrity==='object'&&typeof raw.integrity.status==='string')out.integrity={status:raw.integrity.status};
    else findings.push(finding('status_integrity_unknown','attention','Session integrity status is unavailable.'));
    if(out.integrity?.status!=='healthy')findings.push(finding('session_integrity_attention','attention','Session integrity reports an unhealthy or unknown state.'));
    return out;
  } catch { findings.push(finding('status_file_unavailable','attention','The service status file could not be read.'));return {status:'unknown'}; }
}

function diagnosticsSummary(path,hours,findings,now) {
  let db;
  try {
    db=new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA busy_timeout=3000');
    db.exec('BEGIN');
    const version=Number(db.prepare('PRAGMA user_version').get()?.user_version);
    const names=tableSet(db);
    if(version!==1||!names.has('calls')||!names.has('events')) throw new Error('unsupported');
    const callCols=columns(db,'calls'),eventCols=columns(db,'events');
    if(!['call_id','record_json'].every(c=>callCols.has(c))||!['id','event_json'].every(c=>eventCols.has(c)))throw new Error('unsupported');
    const cutoff=new Date(now-hours*3600000).toISOString();
    const malformedCalls=Number(db.prepare("SELECT COUNT(*) AS n FROM calls WHERE NOT json_valid(record_json)").get().n);
    const malformedEvents=Number(db.prepare("SELECT COUNT(*) AS n FROM events WHERE NOT json_valid(event_json)").get().n);
    if(malformedCalls+malformedEvents)findings.push(finding('diagnostics_malformed_rows','attention','Diagnostics index contains malformed JSON rows.',{count:malformedCalls+malformedEvents}));
    const callCount=Number(db.prepare("SELECT COUNT(*) AS n FROM calls WHERE json_valid(record_json) AND json_extract(record_json,'$.updatedAt')>=?").get(cutoff).n);
    const eventCount=Number(db.prepare("SELECT COUNT(*) AS n FROM events WHERE json_valid(event_json) AND json_extract(event_json,'$.at')>=?").get(cutoff).n);
    const callRows=db.prepare(`SELECT json_extract(record_json,'$.status') AS status,json_extract(record_json,'$.phase') AS phase
      FROM calls WHERE json_valid(record_json) AND json_extract(record_json,'$.updatedAt')>=? LIMIT ?`).all(cutoff,Math.min(callCount,5000));
    const eventRows=db.prepare(`SELECT json_extract(event_json,'$.phase') AS phase,json_extract(event_json,'$.details.failure') AS failure
      FROM events WHERE json_valid(event_json) AND json_extract(event_json,'$.at')>=? LIMIT ?`).all(cutoff,Math.min(eventCount,5000));
    if(callCount>5000||eventCount>5000){findings.push(finding('diagnostics_summary_truncated','attention','Recent diagnostics exceeded the fixed summary row limit.'));}
    const result={status:'ok',calls:callCount,events:eventCount,callsByStatus:{},callsByStage:{},eventsByStage:{},errorCodes:{},unclassified:0};
    for(const row of callRows.slice(0,5000)){
      const status=DIAG_STATUS.has(String(row.status))?String(row.status):'other';
      if(status==='other'||typeof row.phase!=='string'||fixedPhase(row.phase)==='other')result.unclassified++;
      addCount(result.callsByStatus,status,1);addCount(result.callsByStage,fixedPhase(row.phase),1);
    }
    for(const row of eventRows.slice(0,5000)){
      if(typeof row.phase!=='string'||fixedPhase(row.phase)==='other')result.unclassified++;
      addCount(result.eventsByStage,fixedPhase(row.phase),1);
      if(row.failure!==null){const code=fixedCode(row.failure);addCount(result.errorCodes,code,1);if(code==='other')result.unclassified++;}
    }
    if(result.unclassified)findings.push(finding('diagnostics_unclassified','attention','Some diagnostic statuses, phases, or error codes are outside the fixed summary vocabulary.',{count:result.unclassified}));
    if(result.callsByStatus.failed)findings.push(finding('recent_model_call_failed','attention','Recent diagnostic calls ended in failure.',{count:result.callsByStatus.failed}));
    if(result.callsByStatus.unknown)findings.push(finding('recent_model_call_unknown','attention','Recent diagnostic calls have unknown outcomes; they must not be automatically retried.',{count:result.callsByStatus.unknown}));
    const failures=Object.values(result.errorCodes).reduce((sum,n)=>sum+n,0);
    if(failures)findings.push(finding('recent_diagnostic_failure','attention','Recent diagnostic events include recorded failures.',{count:failures}));

    // Cache health is an intentionally small metadata-only view of recent completed
    // foreground calls. Never select artifacts, prompts, messages, or full JSON blobs.
    const contextCache={status:'ok',sampleLimit:160,sampledCalls:0,truncated:false,sampleBoundary:{oldestUpdatedAt:null,newestUpdatedAt:null},
      contextKind:{channel:0,legacy:0,excludedResearch:0,excludedCli:0,excludedReview:0,missingStage:0,unknown:0,classificationScannedCalls:0,classificationScanTruncated:false},
      legacyClassificationLimited:true,legacyClassificationNote:'Unmarked records use legacy chat classification and are not confirmed channel calls.',
      stages:{prepare:{samples:0,withUsage:0,inputTokens:{min:null,median:null,max:null},weightedCacheRate:null,latestInputToWindowRatio:null,latestUsage:{callId:null,inputTokens:null,contextWindow:null},missingUsage:0,missingPrefix:0,largeInputLowCache:0},
      answer:{samples:0,withUsage:0,inputTokens:{min:null,median:null,max:null},weightedCacheRate:null,latestInputToWindowRatio:null,latestUsage:{callId:null,inputTokens:null,contextWindow:null},missingUsage:0,missingPrefix:0,largeInputLowCache:0}},cacheDrops:[]};
    const hasCallId=eventCols.has('call_id'),hasEventAt=eventCols.has('event_json');
    if(hasCallId&&hasEventAt&&callCols.has('call_id')){
      const sampled=db.prepare(`SELECT call_id AS callId,
        json_extract(record_json,'$.kind') AS kind,json_extract(record_json,'$.status') AS status,
        json_extract(record_json,'$.provider') AS provider,json_extract(record_json,'$.model') AS model,
        json_extract(record_json,'$.conversationId') AS conversationId,
        json_extract(record_json,'$.contextCalibration.key') AS calibrationKey,
        json_extract(record_json,'$.usage.input') AS input,json_extract(record_json,'$.usage.cacheRead') AS cacheRead,
        json_extract(record_json,'$.usage.cacheWrite') AS cacheWrite,json_extract(record_json,'$.usage.output') AS output,
        json_extract(record_json,'$.usage.totalTokens') AS totalTokens,
        json_extract(record_json,'$.updatedAt') AS updatedAt
        FROM calls WHERE json_valid(record_json) AND json_extract(record_json,'$.kind')='chat'
        AND json_extract(record_json,'$.status')='completed' AND json_extract(record_json,'$.updatedAt')>=?
        ORDER BY json_extract(record_json,'$.updatedAt') DESC LIMIT 5001`).all(cutoff);
      const callIds=sampled.map(row=>String(row.callId));
      const metadata=new Map(),otherStages=new Map();
      if(callIds.length){
        const placeholders=callIds.map(()=>'?').join(',');
        const eventMeta=db.prepare(`SELECT call_id AS callId,
          json_extract(event_json,'$.at') AS at,json_extract(event_json,'$.event') AS event,
          json_extract(event_json,'$.details.stage') AS stage,
          json_extract(event_json,'$.details.contextKind') AS contextKind,
          json_extract(event_json,'$.details.cachePrefix.version') AS prefixVersion,
          json_extract(event_json,'$.details.cachePrefix.systemHash') AS systemHash,
          json_extract(event_json,'$.details.cachePrefix.toolsHash') AS toolsHash,
          json_extract(event_json,'$.details.contextWindow') AS contextWindow
          FROM events WHERE call_id IN (${placeholders}) AND json_valid(event_json)
          AND json_extract(event_json,'$.event')='model.request_prepared'
          ORDER BY json_extract(event_json,'$.at')`).all(...callIds);
        for(const event of eventMeta){const stage=cacheStage(event.stage);if(!stage){
          otherStages.set(String(event.callId),event.stage==='attribution_review'?'review':event.contextKind);
          continue;
        }
          metadata.set(String(event.callId),{stage,at:typeof event.at==='string'?event.at:null,
            contextKind:event.contextKind===null?null:event.contextKind==='channel'||event.contextKind==='research'||event.contextKind==='cli'?event.contextKind:'unknown',
            systemHash:event.prefixVersion===1?safeFingerprint(event.systemHash):null,
            toolsHash:event.prefixVersion===1?safeFingerprint(event.toolsHash):null,
            contextWindow:safePositiveTokenCount(event.contextWindow)});}
      }
      const eligibleRows=[];
      for(const row of sampled){const meta=metadata.get(String(row.callId));
        contextCache.contextKind.classificationScannedCalls++;
        if(!meta){const kind=otherStages.get(String(row.callId));
          if(kind==='review')contextCache.contextKind.excludedReview++;
          else if(kind==='research')contextCache.contextKind.excludedResearch++;
          else if(kind==='cli')contextCache.contextKind.excludedCli++;
          else contextCache.contextKind.missingStage++;
          continue;
        }
        if(meta.contextKind==='research'){contextCache.contextKind.excludedResearch++;continue;}
        if(meta.contextKind==='cli'){contextCache.contextKind.excludedCli++;continue;}
        if(meta.contextKind!=='channel'&&meta.contextKind!==null){contextCache.contextKind.unknown++;continue;}
        eligibleRows.push(row);
      }
      contextCache.contextKind.classificationScanTruncated=sampled.length>5000;
      if(contextCache.contextKind.missingStage){
        contextCache.status='partial';
        findings.push(finding('cache_stage_metadata_missing','attention','Some completed chat calls lack valid stage metadata; cache statistics are incomplete.',
          {count:contextCache.contextKind.missingStage}));
      }
      const sampledRows=eligibleRows.slice(0,contextCache.sampleLimit);contextCache.sampledCalls=sampledRows.length;
      contextCache.truncated=eligibleRows.length>contextCache.sampleLimit||sampled.length>5000;
      for(const row of sampledRows){const kind=metadata.get(String(row.callId))?.contextKind;
        if(kind==='channel')contextCache.contextKind.channel++;else contextCache.contextKind.legacy++;}
      if(sampledRows.length){contextCache.sampleBoundary.newestUpdatedAt=String(sampledRows[0].updatedAt??'')||null;
        contextCache.sampleBoundary.oldestUpdatedAt=String(sampledRows.at(-1).updatedAt??'')||null;}
      const grouped=new Map(),stageInputs={prepare:[],answer:[]},stageUsage={prepare:[],answer:[]},latestByStage={prepare:null,answer:null};
      for(const row of sampledRows){
        const provider=typeof row.provider==='string'&&/^[\w.-]{1,80}$/.test(row.provider)?row.provider:'unknown';
        const model=typeof row.model==='string'&&/^[\w./:-]{1,120}$/.test(row.model)?row.model:'unknown';
        const usage=cacheRate({input:row.input,cacheRead:row.cacheRead,cacheWrite:row.cacheWrite,output:row.output,totalTokens:row.totalTokens});
        const scope=typeof row.calibrationKey==='string'&&row.calibrationKey.length?row.calibrationKey:
          typeof row.conversationId==='string'&&row.conversationId.length?row.conversationId:null;
        const meta=metadata.get(String(row.callId));if(meta){
          const stageResult=contextCache.stages[meta.stage];stageResult.samples++;
          if(!meta.systemHash||!meta.toolsHash)stageResult.missingPrefix++;
          if(!usage){stageResult.missingUsage++;continue;}
          stageResult.withUsage++;stageInputs[meta.stage].push(usage.input);stageUsage[meta.stage].push(usage);
          if(!latestByStage[meta.stage]||String(row.updatedAt??'')>latestByStage[meta.stage].at)
            latestByStage[meta.stage]={at:String(row.updatedAt??''),callId:String(row.callId),inputTokens:usage.input,contextWindow:meta.contextWindow};
          if(scope!==null){
            const bucketKey=`${scope}\u0000${provider}\u0000${model}\u0000${meta.stage}`;
            const bucket=grouped.get(bucketKey)??[];bucket.push({callId:String(row.callId),scope,provider,model,stage:meta.stage,at:meta.at??String(row.updatedAt??''),
              input:usage.input,cacheRead:usage.cacheRead,rate:usage.rate,systemHash:meta.systemHash,toolsHash:meta.toolsHash,contextWindow:meta.contextWindow});grouped.set(bucketKey,bucket);
          }
          if(usage.input>=50000&&usage.rate<0.2)stageResult.largeInputLowCache++;
        }
      }
      for(const stage of ['prepare','answer']){
        const latest=latestByStage[stage];
        if(latest){contextCache.stages[stage].latestUsage={callId:latest.callId,inputTokens:latest.inputTokens,contextWindow:latest.contextWindow};
          contextCache.stages[stage].latestInputToWindowRatio=latest.contextWindow>0?latest.inputTokens/latest.contextWindow:null;}
      }
      for(const [stage,values] of Object.entries(stageInputs))if(values.length){
        const info=contextCache.stages[stage];info.inputTokens={min:Math.min(...values),median:median(values),max:Math.max(...values)};
      }
      for(const bucket of grouped.values()){
        bucket.sort((a,b)=>a.at.localeCompare(b.at));
        for(let i=1;i<bucket.length;i++){
          const previous=bucket[i-1],current=bucket[i];
          if(current.input<50000||current.rate>=0.2||previous.rate<0.8)continue;
          const reason=!current.systemHash||!current.toolsHash||!previous.systemHash||!previous.toolsHash?'unknown_prefix':
            current.systemHash!==previous.systemHash?'system_prefix_changed':current.toolsHash!==previous.toolsHash?'tool_schema_changed':'prefix_unchanged_or_provider';
          const pair={scope:current.scope===null?null:'scoped',provider:current.provider,model:current.model,stage:current.stage,
            previous:{callId:previous.callId,at:previous.at,inputTokens:previous.input,cacheRate:previous.rate},
            current:{callId:current.callId,at:current.at,inputTokens:current.input,cacheRate:current.rate,
              systemHash:current.systemHash,toolsHash:current.toolsHash},
            fingerprintChanges:{system:previous.systemHash&&current.systemHash?previous.systemHash!==current.systemHash:null,
              tools:previous.toolsHash&&current.toolsHash?previous.toolsHash!==current.toolsHash:null},reason};
          contextCache.cacheDrops.push(pair);
          findings.push(finding('context_cache_efficiency_drop','attention',
            'A large model request had a sharp cache hit-rate drop compared with an earlier call in the same scope and stage.',pair));
        }
      }
      contextCache.cacheDrops.sort((a,b)=>String(a.current.at).localeCompare(String(b.current.at)));
      for(const stage of ['prepare','answer']){
        const values=stageUsage[stage],total=values.reduce((sum,sample)=>sum+sample.input,0),cached=values.reduce((sum,sample)=>sum+sample.cacheRead,0);
        contextCache.stages[stage].weightedCacheRate=total?cached/total:null;
      }
    }
    result.contextCache=contextCache;
    db.exec('COMMIT');return result;
  } catch(error) {
    try{db?.exec('ROLLBACK');}catch{}
    findings.push(finding(error instanceof Error&&error.message==='unsupported'?'diagnostics_unsupported':'diagnostics_unavailable',
      'attention','Diagnostics schema or recent status summary could not be collected.'));
    return {status:error instanceof Error&&error.message==='unsupported'?'unsupported':'unknown'};
  } finally {try{db?.close();}catch{}}
}

function journalSummary(hours,findings,system,now) {
  const args=['-u','pa.service','-u','mihomo-pa.service','--since',new Date(now-hours*3600000).toISOString(),'--priority=warning','--output=json','--no-pager'];
  try {
    const output=system.journal(args);
    const counts={warning:0,error:0,total:0};
    for(const line of output.split(/\r?\n/)){
      if(!line)continue;
      let row;try{row=JSON.parse(line);}catch{findings.push(finding('journal_output_incomplete','attention','Journal output could not be fully parsed.'));return {status:'incomplete'};}
      const p=String(row.PRIORITY??'');if(!/^[0-4]$/.test(p)){findings.push(finding('journal_output_incomplete','attention','Journal output lacked fixed priority metadata.'));return {status:'incomplete'};}
      if(p==='4')counts.warning++;else counts.error++;
    }
    counts.total=counts.warning+counts.error;
    if(counts.total)findings.push(finding('service_journal_warnings','attention','Monitored services recorded warning/error journal entries.',{count:counts.total}));
    return {status:'ok',units:['pa.service','mihomo-pa.service'],...counts};
  } catch(error) {
    const limited=error?.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    findings.push(finding(limited?'journal_output_limit':'journal_unavailable','attention',limited?'Journal output exceeded the 1 MiB collection limit.':'Journal warning/error counts could not be collected.'));
    return {status:'incomplete'};
  }
}

export function collectStatus({dataDir='/var/lib/pa',current='/opt/pa/current',hours=24,expectedRelease=null,now=Date.now(),
  system={command,readText,statfs:statfsSync,journal:args=>execFileSync('journalctl',args,{encoding:'utf8',timeout:15000,maxBuffer:1024*1024,stdio:['ignore','pipe','ignore']})}}={}) {
  if(!Number.isInteger(hours)||hours<1||hours>168)throw new Error('invalid_hours');
  if(expectedRelease!==null&&!/^[a-fA-F0-9]{40}$/.test(expectedRelease))throw new Error('invalid_expected_release');
  dataDir=resolve(dataDir);current=resolve(current);
    const findings=[];const report={version:VERSION,collectedAt:new Date(now).toISOString(),windowHours:hours,ok:true,complete:true,status:'ok',findings:[],services:{},host:{},release:{},statusFile:{},database:{},diagnostics:{status:'unsupported'},journal:{status:'unsupported'},retention:{}};
  report.services.pa=serviceStatus('pa.service',findings,system);report.services.mihomo=serviceStatus('mihomo-pa.service',findings,system);
  for(const unit of ['pa','mihomo']){
    const service=report.services[unit],currentBytes=service.MemoryCurrent,high=service.MemoryHigh,max=service.MemoryMax;
    if(currentBytes===null||high===null&&max===null)findings.push(finding('service_memory_unknown','attention','A service memory usage limit is unknown.',{unit}));
    else {
      const highHit=high!==null&&currentBytes>=high*0.9;const maxHit=max!==null&&currentBytes/max>=0.9;
      if(highHit||maxHit)findings.push(finding('service_memory_pressure','attention','A service is at least 90% of its soft or hard memory limit; inspect cache and OOM counters before taking action.',{unit,currentBytes,highBytes:high,maxBytes:max}));
    }
  }
  try {
    const mem=system.readText('/proc/meminfo');const m=mem?.match(/^MemAvailable:\s+(\d+)\s+kB$/m);report.host.memAvailableBytes=m?Number(m[1])*1024:null;
    if(!m)findings.push(finding('host_memory_unavailable','attention','Host available memory could not be read.'));
    else if(report.host.memAvailableBytes<128*1024*1024)findings.push(finding('host_memory_low',report.host.memAvailableBytes===0?'critical':'attention',
      'Host available memory is below 128 MiB.',{availableBytes:report.host.memAvailableBytes}));
  } catch {}
  try {
    const fs=system.statfs(dataDir);report.host.dataFilesystem={totalBytes:Number(fs.blocks)*Number(fs.bsize),availableBytes:Number(fs.bavail)*Number(fs.bsize)};
    const {totalBytes,availableBytes}=report.host.dataFilesystem;
    if(availableBytes<1024**3||availableBytes<totalBytes*0.05)findings.push(finding('host_disk_low',availableBytes===0?'critical':'attention',
      'PA filesystem has less than 1 GiB or 5% available.',{availableBytes,totalBytes}));
  }
  catch { findings.push(finding('host_disk_unavailable','attention','PA data filesystem capacity could not be read.')); }
  const group=report.services.pa.controlGroup;
  const cgroupPath=group?join('/sys/fs/cgroup',group.replace(/^\/+/,'')):null;
  const events=cgroupPath?system.readText(join(cgroupPath,'memory.events')):null;
  const memStat=cgroupPath?system.readText(join(cgroupPath,'memory.stat')):null;
  if(events!==null){report.host.cgroupMemoryEvents={scope:'pa.service',cumulative:true};for(const line of events.split(/\r?\n/)){const m=line.match(/^(oom|oom_kill|oom_group_kill|high|max)\s+(\d+)$/);if(m)report.host.cgroupMemoryEvents[m[1]]=Number(m[2]);}
    if(report.host.cgroupMemoryEvents.oom===undefined||report.host.cgroupMemoryEvents.oom_kill===undefined)findings.push(finding('cgroup_memory_events_incomplete','attention','Cgroup OOM counters are missing.'));}
  else findings.push(finding('cgroup_memory_events_unavailable','attention','Cgroup memory event counters could not be read.'));
  if(memStat!==null){report.host.cgroupMemoryStat={scope:'pa.service',anonBytes:null,fileBytes:null,inactiveFileBytes:null};for(const line of memStat.split(/\r?\n/)){const m=line.match(/^(anon|file|inactive_file)\s+(\d+)$/);if(m){const key={anon:'anonBytes',file:'fileBytes',inactive_file:'inactiveFileBytes'}[m[1]];report.host.cgroupMemoryStat[key]=Number(m[2]);}}
    if(Object.values(report.host.cgroupMemoryStat).some(v=>v===null))findings.push(finding('cgroup_memory_stat_incomplete','attention','Cgroup memory composition fields are missing.'));}
  else findings.push(finding('cgroup_memory_stat_unavailable','attention','Cgroup memory composition could not be read.'));
  try {const target=realpathSync(current);const base=target.split(/[\\/]/).filter(Boolean).at(-1)||null;report.release={currentPath:target,revision:/^[a-f0-9]{40}$/i.test(base??'')?base.toLowerCase():null,expected:expectedRelease?.toLowerCase()??null};
    if(expectedRelease&&report.release.revision!==expectedRelease.toLowerCase())findings.push(finding('release_mismatch','attention','Current release does not match the expected revision.'));
  } catch {report.release={status:'unknown'};findings.push(finding('release_unavailable','attention','Current release path could not be resolved.'));}
  report.statusFile=statusProjection(join(dataDir,'qq-service','status.json'),findings,report.services.pa.MainPID);
  const oom=report.host.cgroupMemoryEvents?.oom??0,oomKills=report.host.cgroupMemoryEvents?.oom_kill??0;if(oom>0||oomKills>0)findings.push(finding('cgroup_oom_events','critical','Cgroup OOM counters are nonzero; values are cumulative.',{oom,oomKills}));
  report.database=sqliteReport(join(dataDir,'pa.sqlite'),hours,findings,now,system);
  report.retention['pa-retention.timer']=timerStatus('pa-retention.timer','pa-retention.service',findings,system);
  report.retention['pa-research-retention.timer']=timerStatus('pa-research-retention.timer','pa-research-retention.service',findings,system);
  report.diagnostics=diagnosticsSummary(join(dataDir,'diagnostics','index.sqlite'),hours,findings,now);
  report.journal=journalSummary(hours,findings,system,now);
  report.findings=findings;report.ok=findings.length===0;
  report.complete=!findings.some(x=>['database_read_failed','schema_table_missing','schema_table_unsupported','schema_version_unexpected','diagnostics_unsupported','diagnostics_summary_truncated','diagnostics_malformed_rows','diagnostics_unclassified','memory_pipeline_unsupported','memory_job_lease_unknown','service_memory_unknown',
    'systemd_status_unavailable','service_status_incomplete','timer_status_unavailable','status_file_unavailable','host_memory_unavailable','host_disk_unavailable',
    'status_file_incomplete','status_state_unrecognized','status_reminders_unknown','worker_pid_unknown','status_research_unknown','status_isolation_unknown','status_integrity_unknown',
    'cgroup_memory_events_unavailable','cgroup_memory_events_incomplete','cgroup_memory_stat_unavailable','cgroup_memory_stat_incomplete','release_unavailable','diagnostics_unavailable','journal_output_incomplete','journal_output_limit','journal_unavailable'].includes(x.code));
  report.status=!report.complete?'incomplete':report.ok?'ok':'attention';
  return report;
}

export const HELP=`Read-only PA server status collector\n\nUsage: node --input-type=module - --hours 24 --expected-release <40-hex-sha> [--data-dir /var/lib/pa] [--current /opt/pa/current]\n       node scripts/ops/server-status.mjs [options]\n\nOptions: --hours 1..168 (default 24), --expected-release SHA, --data-dir PATH, --current PATH, --help\nExit: 0 complete with no findings, 1 complete with attention findings, 2 incomplete/collection failure or invalid arguments.`;

// With `node --input-type=module -`, argv[1] is `-`; file execution has a file path.
if(process.argv[1]==='-' || (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))) {
  let status=2;
  try {
    const options=parseArgs(process.argv.slice(2));
    if(options.help){process.stdout.write(`${HELP}\n`);process.exitCode=0;}
    else {const {help,...args}=options;const report=collectStatus(args);process.stdout.write(`${JSON.stringify(report)}\n`);status=!report.complete?2:report.ok?0:1;process.exitCode=status;}
  } catch(error) {
    const report={version:VERSION,collectedAt:nowIso(),ok:false,complete:false,status:'failed',findings:[finding('collection_failed','critical','Collection failed due to invalid options or an unavailable system source.')]};
    process.stdout.write(`${JSON.stringify(report)}\n`);process.exitCode=2;
  }
}
