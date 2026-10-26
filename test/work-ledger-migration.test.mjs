import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {ConversationStore} from '../dist/store.js';
import {downgradeSchema31} from './fixtures/legacy-schema.mjs';
import {validateResearchRetentionContract} from '../scripts/deployment/research-retention-contract.mjs';

test('schema33升级保留schema31原文与schema32已有提醒，备份及清理契约兼容',t=>{
  const dir=mkdtempSync(join(tmpdir(),'pa-work-migrate-')),path=join(dir,'pa.sqlite');
  let store=new ConversationStore(path);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const route={channel:'qq',accountId:'fixture',roomType:'private',roomId:'private'};
  const room=store.ensureConversation('room',join(dir,'session.jsonl'),route);
  store.recordInbound(room.id,'原始聊天只保留，不自动变成任务',{eventId:'original',senderId:'alice',modelInputText:'原始聊天只保留，不自动变成任务'});
  store.close();
  const db=new DatabaseSync(path);
  downgradeSchema31(db);db.exec('PRAGMA user_version=31');
  const hash=rows=>createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'maintenance_contracts' ORDER BY name").all();
  const before=new Map(tables.map(({name})=>[name,hash(db.prepare(`SELECT * FROM "${name}"`).all())]));
  db.close();store=new ConversationStore(path);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,33);
  for(const [name,value] of before)assert.equal(hash(store.db.prepare(`SELECT * FROM "${name}"`).all()),value,name);
  assert.equal(store.db.prepare('SELECT count(*) n FROM work_items').get().n,0);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.deepEqual({...validateResearchRetentionContract(store.db)},{domain:'research-retention',version:1});
  assert.equal(store.db.prepare("SELECT version FROM maintenance_contracts WHERE domain='work-ledger'").get().version,2);
  const backups=readdirSync(dir).filter(name=>name.includes('.v31.')&&name.endsWith('.bak'));assert.equal(backups.length,1);
  const snapshot=new DatabaseSync(join(dir,backups[0]),{readOnly:true});
  try{
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version,31);
    assert.equal(snapshot.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='work_items'").get().n,0);
    assert.equal(snapshot.prepare("SELECT text FROM messages WHERE external_event_id='original'").get().text,'原始聊天只保留，不自动变成任务');
  }finally{snapshot.close();}
  const source=store.externalMessage(room.id,'original');
  const work=store.workLedger.createReminder(room.id,source.id,{key:'preserve',goal:'保留已有提醒',remindAt:new Date(Date.now()+3600_000).toISOString(),timezone:'Asia/Shanghai'});
  const workTables=['work_items','work_authorizations','work_attempts','work_events','work_notifications'];
  const oldWork=workTables.map(name=>[name,hash(store.db.prepare(`SELECT * FROM ${name}`).all())]);
  store.db.exec(`DROP TABLE work_delivery_receipts; DROP INDEX work_notifications_sending_expiry; DROP INDEX work_attempts_running_expiry;
    UPDATE maintenance_contracts SET version=1 WHERE domain='work-ledger'; PRAGMA user_version=32;`);
  store.close();store=new ConversationStore(path);
  for(const [name,value]of oldWork)assert.equal(hash(store.db.prepare(`SELECT * FROM ${name}`).all()),value);
  assert.equal(store.workLedger.getReminder(room.id,source.id,work.id).status,'scheduled');
  assert.equal(readdirSync(dir).filter(name=>name.includes('.v32.')&&name.endsWith('.bak')).length,1);
});
