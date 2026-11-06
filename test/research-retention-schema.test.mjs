import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ConversationStore } from '../dist/store.js';
import { applyResearchCleanup, previewResearchCleanup } from '../scripts/deployment/research-retention.mjs';

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




test('structure drift between audit commit and unlink is refused, leaving files and pending audit',t=>{
  const {db,directory,task}=eligibleFixture(t),plan=previewResearchCleanup(directory,{now});
  assert.throws(()=>applyResearchCleanup(directory,plan,{now,afterCommit:()=>db.exec(
    "CREATE TRIGGER unsafe_journal AFTER UPDATE ON research_retention_runs BEGIN DELETE FROM messages; END")}),/未核验触发器/);
  assert.equal(db.prepare('SELECT status FROM research_retention_runs').get().status,'pending');
  assert.equal(existsSync(join(directory,'research',task.id,'1.md')),true);
});
