import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { SESSION_INTEGRITY_TRIGGER_SQL } from '../dist/session-integrity-store.js';
import { applyResearchCleanup, previewResearchCleanup } from '../scripts/deployment/research-retention.mjs';
import { RESEARCH_COLUMNS, researchProjection } from '../scripts/deployment/research-retention-contract.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const budget = { maxModelCalls:12,maxToolCalls:24,maxSearchCalls:6 };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pa-retention-schema-'));
  const dbPath = join(directory, 'pa.sqlite');
  const store = new ConversationStore(dbPath);
  const db = new DatabaseSync(dbPath);
  t.after(() => { db.close(); store.close(); rmSync(directory, { recursive:true, force:true }); });
  return { directory, db, store };
}

function tableSnapshot(db, excluded = new Set()) {
  const snapshots = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().filter(({name}) => !excluded.has(name)).map(({name}) => {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all().sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return [name, hash(JSON.stringify(rows))];
    });
  return Object.fromEntries(snapshots);
}

test('current schema preview/apply protects unfinished research, ordinary chat and profiles; stale plans fail closed', t => {
  const f = fixture(t), {db,store,directory} = f;
  assert.equal(Number(db.prepare('PRAGMA user_version').get().user_version),33);
  const route = { channel:'qq', accountId:'fixture', roomType:'group', roomId:'room' };
  const conversation = store.ensureConversation('room', join(directory,'ordinary-chat.jsonl'), route);
  writeFileSync(join(directory,'ordinary-chat.jsonl'),'ordinary session stays\n');
  db.prepare('INSERT INTO persons(id,revision,created_at) VALUES(?,?,?)').run('person-fixture',1,'2030-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO person_profile_revisions(person_id,revision,facts_json,job_id,created_at) VALUES(?,?,?,?,?)')
    .run('person-fixture',1,'[{"content":"keep profile"}]',null,'2030-01-01T00:00:00.000Z');
  const now = new Date('2030-04-01T00:00:00.000Z');
  let serial = 0;
  const create = (key, text) => {
    const eventId = `retention-${++serial}`;
    store.recordInbound(conversation.id, text, { eventId, senderId:'alice', sentAt:now.toISOString(), modelInputText:text });
    const message = store.externalMessage(conversation.id,eventId);
    return store.research.create(conversation.id,message.id,{key,title:key,goal:'保留任务内容'});
  };
  const eligible = create('eligible','completed task');
  store.research.claim(eligible.id,budget);
  store.research.finish(eligible.id,1,{status:'completed',markdown:'# report\n\ncontent',abstract:'summary',keywords:['test']});
  const unfinished = create('unfinished','queued task');
  const failed = create('failed','failed task');
  store.research.claim(failed.id,budget);
  store.research.finish(failed.id,1,{status:'failed',reason:'kept'});
  db.prepare("UPDATE research_tasks SET updated_at=? WHERE id=?").run('2030-02-01T00:00:00.000Z',eligible.id);
  db.prepare("UPDATE research_attempts SET updated_at=? WHERE task_id=?").run('2030-02-01T00:00:00.000Z',eligible.id);

  const nowCut = new Date('2030-04-01T00:00:00.000Z');
  const plan = previewResearchCleanup(directory,{now:nowCut});
  assert.deepEqual(plan.candidates.map(candidate=>candidate.taskId),[eligible.id]);
  assert.ok(plan.skipped.some(item=>item.taskId===unfinished.id&&item.reason==='unfinished_protected'));
  assert.ok(plan.skipped.some(item=>item.taskId===failed.id&&item.reason==='unfinished_protected'));
  assert.deepEqual(plan.database.contract,{domain:'research-retention',version:1});
  const userDataBefore = tableSnapshot(db,new Set(['research_retention_runs']));

  const expired = structuredClone(plan);
  expired.createdAt = '2030-03-30T22:59:59.999Z';
  assert.throws(()=>applyResearchCleanup(directory,expired,{now:nowCut}),/预览已超过24小时|已过期或被修改/);
  const changed = structuredClone(plan);
  changed.skipped.reverse();
  assert.throws(()=>applyResearchCleanup(directory,changed,{now:nowCut}),/已过期或被修改/);
  assert.deepEqual(tableSnapshot(db,new Set(['research_retention_runs'])),userDataBefore);

  assert.deepEqual(applyResearchCleanup(directory,plan,{now:nowCut}),{cleanupId:hash(JSON.stringify(plan)),status:'done',tasks:1});
  assert.equal(existsSync(join(directory,'research',eligible.id,'1.md')),false);
  assert.equal(db.prepare('SELECT status FROM research_tasks WHERE id=?').get(unfinished.id).status,'queued');
  assert.equal(db.prepare('SELECT status FROM research_tasks WHERE id=?').get(failed.id).status,'failed');
  assert.deepEqual(tableSnapshot(db,new Set(['research_retention_runs'])),userDataBefore);
  assert.equal(existsSync(join(directory,'ordinary-chat.jsonl')),true);
  assert.equal(readFileSync(join(directory,'ordinary-chat.jsonl'),'utf8'),'ordinary session stays\n');

  const beforeUnknown = tableSnapshot(db);
  const hadMarker=!!db.prepare("SELECT 1 FROM sqlite_master WHERE name='maintenance_contracts'").get();
  db.exec(`CREATE TABLE IF NOT EXISTS maintenance_contracts(domain TEXT PRIMARY KEY,version INTEGER NOT NULL);
    INSERT OR REPLACE INTO maintenance_contracts VALUES('research-retention',2); PRAGMA user_version=999`);
  assert.throws(()=>previewResearchCleanup(directory,{now:nowCut}),/未知 maintenance contract/);
  db.prepare("UPDATE maintenance_contracts SET version=1 WHERE domain='research-retention'").run();
  if(!hadMarker) {
    db.exec('DROP TABLE maintenance_contracts');
    assert.throws(()=>previewResearchCleanup(directory,{now:nowCut}),/缺少 maintenance contract/);
  }
  assert.deepEqual(tableSnapshot(db),beforeUnknown);
});

const now = new Date('2030-04-01T00:00:00.000Z');
function eligibleFixture(t) {
  const f=fixture(t), {store,db,directory}=f;
  const conversation=store.ensureConversation('retention',join(directory,'ordinary.jsonl'),
    {channel:'qq',accountId:'fixture',roomType:'group',roomId:'retention'});
  store.recordInbound(conversation.id,'research',{eventId:'event',senderId:'alice',sentAt:now.toISOString(),modelInputText:'research'});
  const task=store.research.create(conversation.id,store.externalMessage(conversation.id,'event').id,{key:'research',title:'research',goal:'goal'});
  store.research.claim(task.id,budget);
  store.research.finish(task.id,1,{status:'completed',markdown:'# report',abstract:'summary',keywords:[]});
  db.prepare('UPDATE research_tasks SET updated_at=? WHERE id=?').run('2030-02-01T00:00:00.000Z',task.id);
  db.prepare('UPDATE research_attempts SET updated_at=? WHERE task_id=?').run('2030-02-01T00:00:00.000Z',task.id);
  return {...f,task};
}
function compatibleFuture(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS maintenance_contracts(domain TEXT PRIMARY KEY,version INTEGER NOT NULL);
    INSERT OR IGNORE INTO maintenance_contracts VALUES('research-retention',1); PRAGMA user_version=999;
    CREATE TABLE unrelated_future(data TEXT); ALTER TABLE research_tasks ADD COLUMN unrelated_note TEXT;
    ALTER TABLE conversations ADD COLUMN unrelated_flag INTEGER`);
}

test('unrelated future schema, tables and additive columns preserve a frozen v2 plan',t=>{
  const {db,directory,task}=eligibleFixture(t);
  const plan=previewResearchCleanup(directory,{now});
  compatibleFuture(db);
  assert.deepEqual(previewResearchCleanup(directory,{now}),plan);
  assert.equal(applyResearchCleanup(directory,plan,{now}).status,'done');
  assert.equal(existsSync(join(directory,'research',task.id,'1.md')),false);
});

test('legacy schemas27–30 use the same read-only structural contract; unmarked future versions reject',t=>{
  const {db,directory}=eligibleFixture(t);
  db.exec('DROP TABLE IF EXISTS maintenance_contracts');
  const before=tableSnapshot(db);
  for(const version of [27,28,29,30]) {
    db.exec(`PRAGMA user_version=${version}`);
    assert.equal(previewResearchCleanup(directory,{now}).candidates.length,1);
    assert.deepEqual(tableSnapshot(db),before);
  }
  db.exec('PRAGMA user_version=999');
  assert.throws(()=>previewResearchCleanup(directory,{now}),/缺少 maintenance contract/);
  assert.deepEqual(tableSnapshot(db),before);
});

test('pending v2 resumes across unrelated upgrade without changing its manifest or hash',t=>{
  const {db,directory,task}=eligibleFixture(t), plan=previewResearchCleanup(directory,{now});
  assert.throws(()=>applyResearchCleanup(directory,plan,{now,afterCommit:()=>{throw new Error('crash');}}),/crash/);
  const before=db.prepare('SELECT id,plan_json,post_hashes_json FROM research_retention_runs').get();
  assert.equal(existsSync(join(directory,'research',task.id,'1.md')),true);
  compatibleFuture(db);
  assert.equal(applyResearchCleanup(directory,plan,{now}).status,'done');
  assert.deepEqual(db.prepare('SELECT id,plan_json,post_hashes_json FROM research_retention_runs').get(),before);
});

test('committed legacy pending resumes across compatible upgrade; uncommitted legacy preview is refused',t=>{
  const {db,directory,task}=eligibleFixture(t), plan=previewResearchCleanup(directory,{now});
  plan.version=1;
  plan.database={dev:plan.database.dev,ino:plan.database.ino,schemaVersion:30};
  assert.throws(()=>applyResearchCleanup(directory,plan,{now}),/旧未提交预览/);
  const rows={};
  for(const table of Object.keys(RESEARCH_COLUMNS)) {
    if(['research_deliveries','research_task_archives'].includes(table)) continue;
    rows[table]=db.prepare(`SELECT ${researchProjection(table)} FROM ${table} WHERE ${table==='research_tasks'?'id':'task_id'}=? ORDER BY rowid`).all(task.id);
  }
  const json=JSON.stringify(plan),id=hash(json),post=JSON.stringify({[task.id]:hash(JSON.stringify(rows))});
  db.exec(`CREATE TABLE research_retention_runs(id TEXT PRIMARY KEY,policy_version INTEGER NOT NULL,
    plan_json TEXT NOT NULL,post_hashes_json TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,completed_at TEXT)`);
  db.prepare("INSERT INTO research_retention_runs VALUES(?,1,?,?,'pending',?,NULL)").run(id,json,post,now.toISOString());
  compatibleFuture(db);
  assert.equal(applyResearchCleanup(directory,plan,{now}).status,'done');
  assert.deepEqual({...db.prepare('SELECT id,plan_json,post_hashes_json FROM research_retention_runs').get()},{id,plan_json:json,post_hashes_json:post});
});

for(const [name,sql] of [
  ['required research column', 'ALTER TABLE research_tasks RENAME COLUMN status TO broken_status'],
  ['ordinary session protection', 'ALTER TABLE agent_runs RENAME COLUMN pi_session_file TO broken_session'],
  ['unknown contract',"CREATE TABLE IF NOT EXISTS maintenance_contracts(domain TEXT PRIMARY KEY,version INTEGER NOT NULL); INSERT OR REPLACE INTO maintenance_contracts VALUES('research-retention',99)"],
  ['dangerous trigger',"CREATE TRIGGER unsafe_cleanup AFTER UPDATE OF evidence_json ON research_evidence BEGIN DELETE FROM messages; END"],
  ['incoming payload foreign key','CREATE TABLE unsafe_child(body TEXT REFERENCES research_evidence(evidence_json) ON UPDATE CASCADE)'],
  ['unsafe payload unique index','CREATE UNIQUE INDEX unsafe_payload_unique ON research_evidence(evidence_json)'],
  ['shadowed physical row order','ALTER TABLE research_evidence ADD COLUMN rowid INTEGER'],
  ['required payload type',`DROP TABLE research_evidence; CREATE TABLE research_evidence(
    task_id TEXT NOT NULL,attempt INTEGER NOT NULL,ordinal INTEGER NOT NULL,evidence_json INTEGER NOT NULL,
    created_at TEXT NOT NULL,PRIMARY KEY(task_id,attempt,ordinal))`],
  ['required composite primary key',`DROP TABLE research_evidence; CREATE TABLE research_evidence(
    task_id TEXT NOT NULL,attempt INTEGER NOT NULL,ordinal INTEGER NOT NULL,evidence_json TEXT NOT NULL,created_at TEXT NOT NULL)`],
  ['ledger trigger chain',"CREATE TRIGGER unsafe_ledger AFTER UPDATE ON session_integrity BEGIN DELETE FROM messages; END"],
  ['canonical ledger delete trigger',"CREATE TRIGGER unsafe_canonical AFTER DELETE ON session_integrity_canonical_messages BEGIN DELETE FROM messages; END"],
  ['ledger incoming foreign key','CREATE TABLE unsafe_ledger_child(file TEXT REFERENCES session_integrity(file) ON UPDATE CASCADE)'],
  ['canonical ledger incoming cascade','CREATE TABLE unsafe_canonical_child(message_id TEXT REFERENCES session_integrity_canonical_messages(message_id) ON DELETE CASCADE)'],
  ['ledger outgoing foreign key','ALTER TABLE session_integrity ADD COLUMN unsafe_parent TEXT REFERENCES messages(id)'],
  ['ledger unique key','CREATE UNIQUE INDEX unsafe_ledger_unique ON session_integrity(run_id)'],
  ['ledger required column','ALTER TABLE session_integrity_sweeps RENAME COLUMN last_id TO broken_id'],
]) test(`${name} rejects preview/apply before deleting any data`,t=>{
  const {db,directory,task}=eligibleFixture(t),plan=previewResearchCleanup(directory,{now});
  db.exec(sql);
  const before=tableSnapshot(db);
  assert.throws(()=>previewResearchCleanup(directory,{now}),/结构契约不兼容/);
  assert.throws(()=>applyResearchCleanup(directory,plan,{now}),/结构契约不兼容/);
  assert.deepEqual(tableSnapshot(db),before);
  assert.equal(existsSync(join(directory,'research',task.id,'1.md')),true);
});

function diagnosticFixture(t) {
  const f=eligibleFixture(t),{db,directory,task}=f;
  const callId='00000000-0000-4000-8000-000000000001',traceId='00000000-0000-4000-8000-000000000002';
  const callDirectory=join(directory,'diagnostics','calls',callId);
  mkdirSync(callDirectory,{recursive:true});
  const request='{"request":"research content"}',requestPath=join(callDirectory,'request.json');
  writeFileSync(requestPath,request);
  const diagnostics=new DatabaseSync(join(directory,'diagnostics','index.sqlite'));
  diagnostics.exec('PRAGMA user_version=1; CREATE TABLE calls(call_id TEXT PRIMARY KEY,job_id TEXT,task_id TEXT,trace_id TEXT NOT NULL,record_json TEXT NOT NULL)');
  diagnostics.prepare('INSERT INTO calls VALUES(?,NULL,?,?,?)').run(callId,task.id,traceId,JSON.stringify({callId,taskId:task.id,
    conversationId:task.conversationId??db.prepare('SELECT conversation_id FROM research_tasks WHERE id=?').get(task.id).conversation_id,
    traceId,runId:traceId,kind:'chat',requestRef:{path:`calls/${callId}/request.json`,sha256:hash(request),bytes:Buffer.byteLength(request)}}));
  diagnostics.close();
  const sessionKey=`research:${task.id}:1`,sessionPath=`${hash(sessionKey)}/session.jsonl`;
  mkdirSync(join(directory,hash(sessionKey)));
  writeFileSync(join(directory,sessionPath),JSON.stringify({type:'session'})+'\n'+JSON.stringify({type:'custom',customType:'pa_run',data:{runId:traceId}})+'\n');
  return {...f,requestPath,sessionPath};
}

test('diagnostic additive columns remain compatible and registered ordinary Pi session is preserved',t=>{
  const {db,directory,task,requestPath,sessionPath}=diagnosticFixture(t);
  db.prepare('UPDATE conversations SET pi_session_file=?').run(sessionPath);
  const plan=previewResearchCleanup(directory,{now});
  assert.equal(plan.candidates.length,1);
  assert.ok(plan.candidates[0].evidence.excluded.some(item=>item.reason==='ordinary_session_protected'));
  assert.ok(plan.candidates[0].files.some(item=>item.kind==='diagnostic'));
  assert.ok(plan.candidates[0].files.every(item=>item.kind!=='pi_session'));
  const diagnostic=new DatabaseSync(join(directory,'diagnostics','index.sqlite'));
  diagnostic.exec('ALTER TABLE calls ADD COLUMN unrelated_metadata TEXT');
  diagnostic.close();
  assert.equal(applyResearchCleanup(directory,plan,{now}).status,'done');
  assert.equal(existsSync(requestPath),false);
  assert.equal(existsSync(join(directory,'research',task.id,'1.md')),false);
  assert.equal(existsSync(join(directory,sessionPath)),true);
});

test('broken diagnostic ownership structure protects all task files',t=>{
  const {directory,task,requestPath,sessionPath}=diagnosticFixture(t);
  const diagnostic=new DatabaseSync(join(directory,'diagnostics','index.sqlite'));
  diagnostic.exec('ALTER TABLE calls RENAME COLUMN task_id TO broken_task_id');
  diagnostic.close();
  const plan=previewResearchCleanup(directory,{now});
  assert.equal(plan.candidates.length,0);
  assert.ok(plan.skipped.some(item=>item.reason==='missing_or_unsafe_artifacts'));
  assert.equal(applyResearchCleanup(directory,plan,{now}).status,'empty');
  assert.ok([requestPath,join(directory,sessionPath),join(directory,'research',task.id,'1.md')].every(existsSync));
});

test('structure drift between audit commit and unlink is refused, leaving files and pending audit',t=>{
  const {db,directory,task}=eligibleFixture(t),plan=previewResearchCleanup(directory,{now});
  assert.throws(()=>applyResearchCleanup(directory,plan,{now,afterCommit:()=>db.exec(
    "CREATE TRIGGER unsafe_journal AFTER UPDATE ON research_retention_runs BEGIN DELETE FROM messages; END")}),/未核验触发器/);
  assert.equal(db.prepare('SELECT status FROM research_retention_runs').get().status,'pending');
  assert.equal(existsSync(join(directory,'research',task.id,'1.md')),true);
});

test('exact session-integrity ledger triggers are compatible; same-name altered SQL is refused',t=>{
  const {db,directory}=eligibleFixture(t);
  for(const sql of SESSION_INTEGRITY_TRIGGER_SQL.filter(sql=>sql.includes('ON agent_runs'))) {
    const name=sql.match(/^CREATE TRIGGER (\S+)/)[1];
    db.exec(`DROP TRIGGER IF EXISTS ${name}`);
    db.exec(sql);
  }
  assert.equal(previewResearchCleanup(directory,{now}).candidates.length,1);
  db.exec('DROP TRIGGER session_integrity_runs_update');
  db.exec("CREATE TRIGGER session_integrity_runs_update AFTER UPDATE ON agent_runs BEGIN DELETE FROM messages; END");
  assert.throws(()=>previewResearchCleanup(directory,{now}),/未核验触发器/);
});

test('ledger trigger added after audit commit stops unlink and preserves raw chat',t=>{
  const {db,directory,task}=eligibleFixture(t),plan=previewResearchCleanup(directory,{now});
  const messagesBefore=db.prepare('SELECT * FROM messages ORDER BY rowid').all();
  assert.throws(()=>applyResearchCleanup(directory,plan,{now,afterCommit:()=>db.exec(
    'CREATE TRIGGER unsafe_ledger_late AFTER UPDATE ON session_integrity BEGIN DELETE FROM messages; END')}),/未核验触发器/);
  assert.deepEqual(db.prepare('SELECT * FROM messages ORDER BY rowid').all(),messagesBefore);
  assert.equal(db.prepare('SELECT status FROM research_retention_runs').get().status,'pending');
  assert.equal(existsSync(join(directory,'research',task.id,'1.md')),true);
});
