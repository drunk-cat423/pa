import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { applyResearchCleanup, previewResearchCleanup, runResearchCleanup } from '../scripts/deployment/research-retention.mjs';
import { ConversationStore } from '../dist/store.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const budget = { maxModelCalls:12,maxToolCalls:24,maxSearchCalls:6 };
const plan = { version:1,sections:[{id:'s1',title:'证据',objective:'核对原文',acceptance:'结论有来源'}] };
const retentionTables = ['research_tasks','research_attempts','research_workflow_plans','research_workflow_cycles',
  'research_collection_cycles','research_workflow_sections','research_workflow_versions','research_workflow_reviews',
  'research_reports','research_deliveries','research_evidence','research_task_archives'];

function retentionRecoveryHash(db, taskId) {
  const rows = Object.fromEntries(retentionTables.map(table=>[
    table,db.prepare(`SELECT * FROM ${table} WHERE ${table==='research_tasks'?'id':'task_id'}=? ORDER BY rowid`).all(taskId)
  ]));
  delete rows.research_deliveries;
  if (rows.research_tasks[0]?.status !== 'failed') delete rows.research_task_archives;
  return hash(JSON.stringify(rows));
}

function retentionTombstones(db, taskId) {
  const fields = {research_evidence:['evidence_json'],research_workflow_cycles:['input_json'],
    research_collection_cycles:['input_json','result_json']}, result = [];
  for (const [table,columns] of Object.entries(fields)) for (const column of columns) {
    for (const row of db.prepare(`SELECT rowid,* FROM ${table} WHERE task_id=? ORDER BY rowid`).all(taskId)) {
      if (row[column] !== null && JSON.parse(row[column]).retained === false) {
        result.push({table,rowid:row.rowid,column,value:row[column]});
      }
    }
  }
  return result;
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(),'pa-research-retention-')), path = join(directory,'pa.sqlite');
  let store = new ConversationStore(path), db = new DatabaseSync(path), serial = 0;
  const conversation = store.ensureConversation('group','/fixture/group.jsonl',
    {channel:'qq',accountId:'fixture',roomType:'group',roomId:'group'});
  const message = (senderId='alice') => {
    const eventId = `event-${++serial}`;
    store.recordInbound(conversation.id,'调研资料整理',{eventId,senderId,sentAt:new Date().toISOString(),modelInputText:'调研资料整理'});
    return store.externalMessage(conversation.id,eventId);
  };
  const source = message();
  const create = key => {
    const input = message();
    return store.research.create(conversation.id,input.id,{key,title:`资料整理 ${key}`,goal:'核对资料并整理报告'});
  };
  const complete = (key, { withPlan=true, status='completed', archived=true, at='2026-09-01T00:00:00.000Z', archivedAt=at }={}) => {
    const task = create(key);
    store.research.claim(task.id,budget);
    if (withPlan) {
      const workflow = store.research.workflow;
      let cycle = workflow.begin(task.id,1,{phase:'plan',input:{goal:task.goal,private:'固定计划输入'}});
      workflow.savePlan(task.id,1,cycle,plan);
      cycle = workflow.begin(task.id,1,{phase:'write',sectionId:'s1',expectedVersion:0,input:{private:'第一版输入'}});
      workflow.saveSection(task.id,1,cycle,{sectionId:'s1',expectedVersion:0,mode:'replace',status:'draft',
        markdown:'第一版章节正文',summary:'初稿',sources:['https://example.com/1'],gaps:[]});
      cycle = workflow.begin(task.id,1,{phase:'write',sectionId:'s1',expectedVersion:1,input:{private:'第二版输入'}});
      workflow.saveSection(task.id,1,cycle,{sectionId:'s1',expectedVersion:1,mode:'replace',status:'written',
        markdown:'当前章节正文',summary:'最终稿',sources:['https://example.com/2'],gaps:[]});
      cycle = workflow.begin(task.id,1,{phase:'review',sectionId:'s1',expectedVersion:2,input:{private:'评审输入'}});
      workflow.saveReview(task.id,1,cycle,{sectionId:'s1',expectedVersion:2,verdict:'pass',reason:'核验通过'});
      store.research.checkpoint(task.id,1,{modelCalls:2,toolCalls:1,searchCalls:1,
        evidence:{tool:'fetch',input:{url:'https://example.com/private'},result:'需要被保留哈希的证据正文'}});
    }
    store.research.finish(task.id,1,['completed','partial'].includes(status)
      ? {status,markdown:'# 正式报告\n\n报告原文必须保留。',abstract:'报告摘要',keywords:['资料']}
      : {status,reason:'保留未完成研究'});
    if (archived) store.research.archive(conversation.id,source.id,{ids:[task.id],reason:'测试归档'});
    const completedAt = new Date(at).toISOString(), archiveTime = new Date(archivedAt).toISOString();
    db.prepare('UPDATE research_tasks SET updated_at=? WHERE id=?').run(completedAt,task.id);
    db.prepare('UPDATE research_attempts SET updated_at=? WHERE task_id=? AND attempt=1').run(completedAt,task.id);
    db.prepare('UPDATE research_task_archives SET created_at=? WHERE task_id=?').run(archiveTime,task.id);
    return task;
  };
  t.after(() => { db.close(); store.close(); rmSync(directory,{recursive:true,force:true}); });
  return {directory,path,conversation,source,create,complete,get store(){return store;},get db(){return db;}};
}

function files(root) {
  const result = {};
  const visit = dir => {
    for (const name of readdirSync(dir,{withFileTypes:true})) {
      const path = join(dir,name.name);
      if (name.isDirectory()) visit(path);
      else result[relative(root,path).replaceAll('\\','/')] = hash(readFileSync(path));
    }
  };
  visit(root);
  return result;
}

test('preview is read-only and expires completed content from completion time at the exact 30-day boundary', t => {
  const f = fixture(t), now = new Date('2026-10-23T00:00:00.000Z');
  const boundary = f.complete('boundary',{at:'2026-09-23T00:00:00.000Z'});
  const recentlyArchived = f.complete('recent-archive',{at:'2026-09-01T00:00:00.000Z',archivedAt:'2026-09-24T00:00:00.000Z'});
  const partial = f.complete('partial',{status:'partial',at:'2026-08-01T00:00:00.000Z'});
  const legacy = f.complete('legacy',{withPlan:false,at:'2026-08-01T00:00:00.000Z'});
  const dbHash = hash(readFileSync(f.path)), beforeFiles = Object.fromEntries(
    Object.entries(files(f.directory)).filter(([path])=>path.startsWith('research/')));

  const result = previewResearchCleanup(f.directory,{now});

  assert.equal(hash(readFileSync(f.path)),dbHash);
  assert.deepEqual(Object.fromEntries(Object.entries(files(f.directory)).filter(([path])=>path.startsWith('research/'))),beforeFiles);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_retention_runs'").get(),undefined);
  assert.deepEqual(new Set(result.candidates.map(row=>row.taskId)),new Set([boundary.id,recentlyArchived.id,legacy.id]));
  const boundaryCandidate = result.candidates.find(row=>row.taskId===boundary.id);
  const recentArchiveCandidate = result.candidates.find(row=>row.taskId===recentlyArchived.id);
  const legacyCandidate = result.candidates.find(row=>row.taskId===legacy.id);
  assert.equal(boundaryCandidate.eligibleSince,'2026-09-23T00:00:00.000Z');
  assert.equal(boundaryCandidate.protectedFiles.length,0);
  assert.equal(boundaryCandidate.files.length,4);
  assert.equal(recentArchiveCandidate.eligibleSince,'2026-09-01T00:00:00.000Z');
  assert.equal(legacyCandidate.files.length,2);
  assert.ok(result.skipped.some(row=>row.taskId===partial.id && row.reason==='unfinished_protected'));
});

test('apply tombstones database payloads and removes all completed reports and section versions', t => {
  const f = fixture(t), task = f.complete('apply',{archived:false});
  const root = join(f.directory,'research',task.id), report = join(root,'1.md');
  const current = join(root,'sections','s1','2.md');
  const oldSection = join(root,'sections','s1','1.md');
  const orphanSection = join(root,'sections','s1','orphan.md');
  writeFileSync(orphanSection,'无版本元数据的孤儿文件');
  const planResult = previewResearchCleanup(f.directory,{now:new Date('2026-10-23T00:00:00.000Z')});

  const result = applyResearchCleanup(f.directory,planResult,{now:new Date('2026-10-23T00:00:00.000Z')});

  assert.equal(result.status,'done');
  assert.equal(existsSync(oldSection),false);
  assert.equal(readFileSync(orphanSection,'utf8'),'无版本元数据的孤儿文件');
  assert.equal(existsSync(report),false);
  assert.equal(existsSync(join(root,'1.txt')),false);
  assert.equal(existsSync(current),false);
  assert.equal(existsSync(oldSection),false);
  assert.equal(f.store.research.workflow.load(task.id).sections[0].contentExpired,true);
  const evidence = f.db.prepare('SELECT evidence_json FROM research_evidence WHERE task_id=?').get(task.id).evidence_json;
  const tombstone = JSON.parse(evidence);
  assert.equal(tombstone.retained,false);
  assert.equal(tombstone.sha256,hash(JSON.stringify({tool:'fetch',input:{url:'https://example.com/private'},result:'需要被保留哈希的证据正文'})));
  assert.equal(tombstone.bytes,Buffer.byteLength(JSON.stringify({tool:'fetch',input:{url:'https://example.com/private'},result:'需要被保留哈希的证据正文'})));
  assert.equal(f.db.prepare('SELECT status FROM research_retention_runs').get().status,'done');
  assert.equal(f.db.prepare('SELECT count(*) n FROM research_reports WHERE task_id=?').get(task.id).n,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM research_workflow_versions WHERE task_id=?').get(task.id).n,2);
});

test('expired legacy completed content is reported as cleaned and cannot be read, sent, or retried', t => {
  const f = fixture(t), task = f.complete('expired-legacy',{withPlan:false,archived:false,at:'2026-09-01T00:00:00.000Z'});
  f.db.prepare('UPDATE research_attempts SET usage_json=? WHERE task_id=? AND attempt=1')
    .run(JSON.stringify({modelCalls:2,toolCalls:1,searchCalls:1}),task.id);
  const now = new Date('2026-10-23T00:00:00.000Z'), cleanupPlan = previewResearchCleanup(f.directory,{now});
  assert.deepEqual(cleanupPlan.candidates.map(row=>row.taskId),[task.id]);
  applyResearchCleanup(f.directory,cleanupPlan,{now});

  const savedTask = f.db.prepare('SELECT status,reason,latest_version FROM research_tasks WHERE id=?').get(task.id);
  assert.equal(savedTask.status,'completed');
  assert.equal(savedTask.reason,null);
  assert.equal(savedTask.latest_version,1);
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT usage_json FROM research_attempts WHERE task_id=?').get(task.id).usage_json),
    {modelCalls:2,toolCalls:1,searchCalls:1});
  assert.equal(f.store.externalMessage(f.conversation.id,'event-1').text,'调研资料整理');
  assert.throws(()=>f.store.research.read(f.conversation.id,f.source.id,{id:task.id}),/清理/);
  assert.throws(()=>f.store.research.report(task.id,1),/清理/);
  const deliveryCount = f.db.prepare('SELECT count(*) n FROM research_deliveries WHERE task_id=?').get(task.id).n;
  assert.throws(()=>f.store.research.reserveDelivery(f.conversation.id,f.source.id,{id:task.id,format:'md'}),/清理/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM research_deliveries WHERE task_id=?').get(task.id).n,deliveryCount);
  assert.throws(()=>f.store.research.retry(f.conversation.id,f.source.id,{id:task.id,key:'retry-after-expiry'}),/清理/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM research_attempts WHERE task_id=?').get(task.id).n,1);
});

test('apply preserves messages and person records plus partial, unarchived failed, queued, and running tasks', t => {
  const f = fixture(t), task = f.complete('only-complete-candidate',{archived:false});
  const partial = f.complete('partial-protected',{status:'partial'});
  const failed = f.complete('failed-protected',{status:'failed',archived:false});
  const queued = f.create('queued-protected');
  f.store.research.archive(f.conversation.id,f.source.id,{ids:[queued.id],reason:'归档排队任务'});
  const running = f.create('running-protected');
  f.store.research.claim(running.id,budget);
  const tableSnapshot = names => Object.fromEntries(names.map(name=>[
    name,hash(JSON.stringify(f.db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()))]));
  const immutableBefore = tableSnapshot(['messages','actors','persons','person_bindings']);
  const taskBefore = Object.fromEntries([partial,failed,queued,running].map(row=>[
    row.id,hash(JSON.stringify(f.db.prepare('SELECT * FROM research_tasks WHERE id=?').get(row.id)))]));
  const cleanupPlan = previewResearchCleanup(f.directory,{now:new Date('2026-10-23T00:00:00.000Z')});
  assert.deepEqual(cleanupPlan.candidates.map(row=>row.taskId),[task.id]);

  applyResearchCleanup(f.directory,cleanupPlan,{now:new Date('2026-10-23T00:00:00.000Z')});

  assert.deepEqual(tableSnapshot(['messages','actors','persons','person_bindings']),immutableBefore);
  for (const id of Object.keys(taskBefore)) {
    assert.equal(hash(JSON.stringify(f.db.prepare('SELECT * FROM research_tasks WHERE id=?').get(id))),taskBefore[id]);
  }
  assert.equal(f.store.research.get(partial.id).status,'partial');
  assert.equal(f.store.research.get(failed.id).status,'failed');
  assert.equal(f.store.research.get(queued.id).status,'queued');
  assert.equal(f.store.research.get(running.id).status,'running');
});

test('failed cleanup eligibility uses archive age, including tasks without a plan or report', t => {
  const f = fixture(t), now = new Date('2026-10-23T00:00:00.000Z');
  const oldFailure = f.complete('old-failure',{status:'failed',withPlan:false,at:'2026-10-20T00:00:00.000Z',archivedAt:'2026-09-23T00:00:00.000Z'});
  const recentFailure = f.complete('recent-failure',{status:'failed',withPlan:false,at:'2026-08-01T00:00:00.000Z',archivedAt:'2026-09-24T00:00:00.000Z'});
  const unarchivedFailure = f.complete('unarchived-failure',{status:'failed',withPlan:false,archived:false,at:'2026-08-01T00:00:00.000Z'});

  const result = previewResearchCleanup(f.directory,{now});

  assert.deepEqual(result.candidates.map(row=>row.taskId),[oldFailure.id]);
  assert.equal(result.candidates[0].eligibleSince,'2026-09-23T00:00:00.000Z');
  assert.ok(result.skipped.some(row=>row.taskId===recentFailure.id && row.reason==='retention_30_days'));
  assert.ok(result.skipped.some(row=>row.taskId===unarchivedFailure.id && row.reason==='unfinished_protected'));
});

test('failed archived cleanup keeps causes and usage, and expires reports and every versioned draft', t => {
  const f = fixture(t), task = f.complete('failed-artifacts',{status:'failed'}), now = new Date('2026-10-23T00:00:00.000Z');
  const root = join(f.directory,'research',task.id), draft = join(root,'sections','s1','1.md');
  const currentDraft = join(root,'sections','s1','2.md');
  const reportText = '# 保留的历史报告\n\n失败前已保存的报告。';
  const reportHash = hash(reportText);
  writeFileSync(join(root,'1.md'),reportText); writeFileSync(join(root,'1.txt'),reportText);
  f.db.prepare(`INSERT INTO research_reports(task_id,version,attempt,status,abstract,keywords_json,content_hash,created_at)
    VALUES(?,1,1,'partial','保留的报告摘要','["资料"]',?,?)`).run(task.id,reportHash,task.updatedAt);

  const planResult = previewResearchCleanup(f.directory,{now});
  assert.deepEqual(planResult.candidates.map(row=>row.taskId),[task.id]);
  assert.equal(planResult.candidates[0].files.length,4);
  assert.equal(planResult.candidates[0].protectedFiles.length,0);
  assert.throws(()=>applyResearchCleanup(f.directory,planResult,{now,afterCommit(){throw new Error('failed-task cleanup crash');}}),/failed-task cleanup crash/);
  assert.equal(existsSync(currentDraft),true);
  assert.equal(f.store.research.workflow.load(task.id).sections[0].contentExpired,true);
  assert.match(f.store.research.read(f.conversation.id,f.source.id,{id:task.id,draft:true}).text,/清理/);
  const cleanup = applyResearchCleanup(f.directory,planResult,{now});

  assert.equal(cleanup.status,'done');
  assert.equal(existsSync(draft),false);
  assert.equal(existsSync(currentDraft),false);
  assert.equal(existsSync(join(root,'1.md')),false);
  assert.equal(existsSync(join(root,'1.txt')),false);
  assert.equal(f.db.prepare('SELECT reason FROM research_tasks WHERE id=?').get(task.id).reason,'保留未完成研究');
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT usage_json FROM research_attempts WHERE task_id=?').get(task.id).usage_json),
    {modelCalls:2,toolCalls:1,searchCalls:1});
  assert.equal(f.db.prepare('SELECT count(*) n FROM research_reports WHERE task_id=?').get(task.id).n,1);
  assert.equal(f.store.externalMessage(f.conversation.id,`event-1`).text,'调研资料整理');

  const workflow = f.store.research.workflow.load(task.id);
  assert.equal(workflow.sections[0].version,2);
  assert.equal(workflow.sections[0].contentExpired,true);
  const draftResult = f.store.research.read(f.conversation.id,f.source.id,{id:task.id,draft:true});
  assert.match(draftResult.text,/清理|已过期/);
  assert.doesNotMatch(draftResult.text,/ENOENT|no such file/i);

  const resumed = runResearchCleanup(f.directory,{now});
  assert.equal(resumed.result.status,'empty');
  assert.equal(applyResearchCleanup(f.directory,planResult,{now}).repeated,true);
});

test('stale database state, tampered plans, and changed file hashes are rejected without deleting artifacts', t => {
  const f = fixture(t), stale = f.complete('stale');
  const stalePlan = previewResearchCleanup(f.directory,{now:new Date('2026-10-23T00:00:00.000Z')});
  const legacyPreview = structuredClone(stalePlan);
  delete legacyPreview.policy;
  for (const candidate of legacyPreview.candidates) delete candidate.cleanupKind;
  assert.throws(()=>applyResearchCleanup(f.directory,legacyPreview,{now:new Date('2026-10-23T00:00:00.000Z')}),/计划|协议|修改/);
  assert.ok(existsSync(join(f.directory,'research',stale.id,'sections','s1','1.md')));
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_retention_runs'").get(),undefined);
  f.db.prepare("UPDATE research_tasks SET reason='changed after preview' WHERE id=?").run(stale.id);
  assert.throws(()=>applyResearchCleanup(f.directory,stalePlan,{now:new Date('2026-10-23T00:00:00.000Z')}),/过期|修改/);
  assert.ok(existsSync(join(f.directory,'research',stale.id,'sections','s1','1.md')));

  const changed = f.complete('changed-file');
  const changedPlan = previewResearchCleanup(f.directory,{now:new Date('2026-10-23T00:00:00.000Z')});
  writeFileSync(join(f.directory,'research',changed.id,'sections','s1','1.md'),'篡改后的文件');
  assert.throws(()=>applyResearchCleanup(f.directory,changedPlan,{now:new Date('2026-10-23T00:00:00.000Z')}),/过期|哈希/);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_retention_runs'").get(),undefined);

  const tampered = structuredClone(stalePlan);
  if (tampered.candidates.length) tampered.candidates[0].files[0].path = '../outside.md';
  assert.throws(()=>applyResearchCleanup(f.directory,tampered,{now:new Date('2026-10-23T00:00:00.000Z')}),/修改|越界/);
});

test('committed cleanup resumes after a post-commit crash and repeated apply is idempotent', t => {
  const f = fixture(t), task = f.complete('crash'), now = new Date('2026-10-23T00:00:00.000Z');
  const planResult = previewResearchCleanup(f.directory,{now});
  const oldSection = join(f.directory,'research',task.id,'sections','s1','1.md');
  assert.throws(()=>applyResearchCleanup(f.directory,planResult,{now,afterCommit(){throw new Error('simulated crash');}}),/simulated crash/);
  assert.ok(existsSync(oldSection));
  assert.equal(f.db.prepare('SELECT status FROM research_retention_runs').get().status,'pending');
  assert.equal(JSON.parse(f.db.prepare('SELECT evidence_json FROM research_evidence WHERE task_id=?').get(task.id).evidence_json).retained,false);
  unlinkSync(oldSection);

  assert.equal(applyResearchCleanup(f.directory,planResult,{now}).status,'done');
  assert.equal(existsSync(oldSection),false);
  const repeated = applyResearchCleanup(f.directory,planResult,{now});
  assert.equal(repeated.status,'done');
  assert.equal(repeated.repeated,true);
});

test('a committed legacy v1 pending plan resumes by its manifest, then v3 expires remaining content', t => {
  const f = fixture(t), task = f.complete('legacy-pending'), now = new Date('2026-10-23T00:00:00.000Z');
  const currentPlan = previewResearchCleanup(f.directory,{now});
  assert.throws(()=>applyResearchCleanup(f.directory,currentPlan,{now,afterCommit(){throw new Error('pause after commit');}}),/pause after commit/);

  const legacyPlan = structuredClone(currentPlan);
  delete legacyPlan.policy;
  for (const candidate of legacyPlan.candidates) {
    delete candidate.cleanupKind;
    candidate.protectedFiles = [...candidate.protectedFiles,...candidate.files.filter(file=>!file.path.endsWith('/sections/s1/1.md'))];
    candidate.files = candidate.files.filter(file=>file.path.endsWith('/sections/s1/1.md'));
  }
  const legacyJson = JSON.stringify(legacyPlan), legacyId = hash(legacyJson);
  for (const [table,column] of [['research_evidence','evidence_json'],['research_workflow_cycles','input_json'],
    ['research_collection_cycles','input_json'],['research_collection_cycles','result_json']]) {
    for (const row of f.db.prepare(`SELECT rowid,${column} value FROM ${table} WHERE task_id=?`).all(task.id)) {
      if (row.value === null) continue;
      const value = JSON.parse(row.value);
      if (value.retained === false) {
        value.cleanupId = legacyId;
        f.db.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`).run(JSON.stringify(value),row.rowid);
      }
    }
  }
  const legacyTombstones = retentionTombstones(f.db,task.id);
  assert.ok(legacyTombstones.length > 0);
  assert.ok(legacyTombstones.every(row=>JSON.parse(row.value).cleanupId===legacyId));
  f.db.prepare('UPDATE research_retention_runs SET id=?,plan_json=?,post_hashes_json=?')
    .run(legacyId,legacyJson,JSON.stringify({[task.id]:retentionRecoveryHash(f.db,task.id)}));

  const recovered = applyResearchCleanup(f.directory,legacyPlan,{now});

  assert.equal(recovered.status,'done');
  assert.equal(recovered.cleanupId,legacyId);
  assert.equal(existsSync(join(f.directory,'research',task.id,'sections','s1','1.md')),false);
  assert.equal(existsSync(join(f.directory,'research',task.id,'sections','s1','2.md')),true);
  assert.equal(existsSync(join(f.directory,'research',task.id,'1.md')),true);
  assert.equal(f.db.prepare('SELECT status FROM research_retention_runs WHERE id=?').get(legacyId).status,'done');

  const upgraded = previewResearchCleanup(f.directory,{now});
  assert.deepEqual(upgraded.candidates.map(row=>row.taskId),[task.id]);
  assert.ok(upgraded.candidates[0].files.some(file=>file.path===`research/${task.id}/sections/s1/2.md`));
  assert.ok(upgraded.candidates[0].files.some(file=>file.path===`research/${task.id}/1.md`));
  assert.equal(applyResearchCleanup(f.directory,upgraded,{now}).status,'done');
  assert.deepEqual(retentionTombstones(f.db,task.id),legacyTombstones);
  assert.equal(existsSync(join(f.directory,'research',task.id,'sections','s1','2.md')),false);
  assert.equal(existsSync(join(f.directory,'research',task.id,'1.md')),false);
});

test('pending cleanup rejects a changed old file without deleting the changed bytes', t => {
  const f = fixture(t), task = f.complete('pending-file-change'), now = new Date('2026-10-23T00:00:00.000Z');
  const cleanupPlan = previewResearchCleanup(f.directory,{now});
  const oldSection = join(f.directory,'research',task.id,'sections','s1','1.md');
  assert.throws(()=>applyResearchCleanup(f.directory,cleanupPlan,{now,afterCommit(){throw new Error('pause after commit');}}),/pause after commit/);
  writeFileSync(oldSection,'pending 时被替换的内容');

  assert.throws(()=>applyResearchCleanup(f.directory,cleanupPlan,{now}),/哈希|状态已变化/);

  assert.equal(readFileSync(oldSection,'utf8'),'pending 时被替换的内容');
  assert.equal(f.db.prepare('SELECT status FROM research_retention_runs').get().status,'pending');
});

test('pending cleanup rejects a symlink or junction replacing a section parent and leaves its target untouched', t => {
  const f = fixture(t), task = f.complete('pending-section-link'), now = new Date('2026-10-23T00:00:00.000Z');
  const cleanupPlan = previewResearchCleanup(f.directory,{now});
  const section = join(f.directory,'research',task.id,'sections','s1');
  const moved = join(f.directory,'research',task.id,'sections','s1-saved');
  const outside = mkdtempSync(join(tmpdir(),'pa-retention-outside-'));
  const outsideFile = join(outside,'1.md');
  writeFileSync(outsideFile,'外部内容必须保持');
  t.after(()=>rmSync(outside,{recursive:true,force:true}));
  assert.throws(()=>applyResearchCleanup(f.directory,cleanupPlan,{now,afterCommit(){throw new Error('pause after commit');}}),/pause after commit/);
  renameSync(section,moved);
  symlinkSync(outside,section,process.platform==='win32'?'junction':'dir');

  assert.throws(()=>applyResearchCleanup(f.directory,cleanupPlan,{now}),/符号链接|symlink/);

  assert.equal(readFileSync(outsideFile,'utf8'),'外部内容必须保持');
  assert.equal(f.db.prepare('SELECT status FROM research_retention_runs').get().status,'pending');
});

test('future preview plans and changed report or current files are rejected before any write', t => {
  for (const kind of ['future','report','current-section']) {
    const f = fixture(t), task = f.complete(`protected-${kind}`), previewAt = new Date('2026-10-23T00:00:00.000Z');
    const cleanupPlan = previewResearchCleanup(f.directory,{now:kind==='future'
      ? new Date('2026-10-24T00:00:00.000Z') : previewAt});
    if (kind === 'future') {
      assert.throws(()=>applyResearchCleanup(f.directory,cleanupPlan,{now:previewAt}),/未来/);
    } else {
      const protectedPath = kind==='report'
        ? join(f.directory,'research',task.id,'1.md')
        : join(f.directory,'research',task.id,'sections','s1','2.md');
      writeFileSync(protectedPath,'被保护文件外部修改');
      assert.throws(()=>applyResearchCleanup(f.directory,cleanupPlan,{now:previewAt}),/过期|哈希|修改/);
      assert.equal(readFileSync(protectedPath,'utf8'),'被保护文件外部修改');
      assert.equal(existsSync(join(f.directory,'research',task.id,'sections','s1','1.md')),true);
    }
    assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_retention_runs'").get(),undefined);
    assert.equal(f.db.prepare('SELECT evidence_json FROM research_evidence WHERE task_id=?').get(task.id).evidence_json.includes('需要被保留哈希的证据正文'),true);
  }
});

test('an unarchived completed task remains eligible and database failures roll back before file deletion', t => {
  const f = fixture(t), task = f.complete('unarchived-eligible',{archived:false});
  const now = new Date('2026-10-23T00:00:00.000Z'), cleanupPlan = previewResearchCleanup(f.directory,{now});
  assert.deepEqual(cleanupPlan.candidates.map(row=>row.taskId),[task.id]);
  const oldSection = join(f.directory,'research',task.id,'sections','s1','1.md');
  const evidenceBefore = f.db.prepare('SELECT evidence_json FROM research_evidence WHERE task_id=?').get(task.id).evidence_json;
  f.db.exec(`CREATE TRIGGER fail_retention_payload BEFORE UPDATE OF evidence_json ON research_evidence
    BEGIN SELECT RAISE(ABORT,'simulated evidence failure'); END;`);

  assert.throws(()=>applyResearchCleanup(f.directory,cleanupPlan,{now}),/simulated evidence failure/);

  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_retention_runs'").get(),undefined);
  assert.equal(f.db.prepare('SELECT evidence_json FROM research_evidence WHERE task_id=?').get(task.id).evidence_json,evidenceBefore);
  assert.equal(existsSync(oldSection),true);
});

test('pending cleanup blocks new report delivery after commit and resumes without a receipt', t => {
  const f = fixture(t), task = f.complete('delivery-during-recovery'), now = new Date('2026-10-23T00:00:00.000Z');
  const cleanupPlan = previewResearchCleanup(f.directory,{now});
  const reportPath = join(f.directory,'research',task.id,'1.md');
  assert.throws(()=>applyResearchCleanup(f.directory,cleanupPlan,{now,afterCommit(){throw new Error('pause after commit');}}),/pause after commit/);

  assert.throws(()=>f.store.research.reserveDelivery(f.conversation.id,f.source.id,{id:task.id,format:'md'}),/清理/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM research_deliveries WHERE task_id=?').get(task.id).n,0);

  const run = runResearchCleanup(f.directory,{now});

  assert.equal(run.resumed.length,1);
  assert.equal(run.resumed[0].status,'done');
  assert.equal(run.result.status,'empty');
  assert.equal(existsSync(reportPath),false);
  assert.equal(existsSync(join(f.directory,'research',task.id,'1.txt')),false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM research_deliveries WHERE task_id=?').get(task.id).n,0);
  assert.equal(existsSync(join(f.directory,'research',task.id,'sections','s1','1.md')),false);
  assert.equal(existsSync(join(f.directory,'research',task.id,'sections','s1','2.md')),false);
  assert.equal(f.db.prepare('SELECT status FROM research_retention_runs').get().status,'done');
});
