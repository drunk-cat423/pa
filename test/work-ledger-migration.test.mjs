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

test('schema32台账迁移保留schema31原表、备份及研究清理契约，不生成历史工作',t=>{
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
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version,32);
  for(const [name,value] of before)assert.equal(hash(store.db.prepare(`SELECT * FROM "${name}"`).all()),value,name);
  assert.equal(store.db.prepare('SELECT count(*) n FROM work_items').get().n,0);
  assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.deepEqual({...validateResearchRetentionContract(store.db)},{domain:'research-retention',version:1});
  assert.equal(store.db.prepare("SELECT version FROM maintenance_contracts WHERE domain='work-ledger'").get().version,1);
  const backups=readdirSync(dir).filter(name=>name.includes('.v31.')&&name.endsWith('.bak'));assert.equal(backups.length,1);
  const snapshot=new DatabaseSync(join(dir,backups[0]),{readOnly:true});
  try{
    assert.equal(snapshot.prepare('PRAGMA user_version').get().user_version,31);
    assert.equal(snapshot.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='work_items'").get().n,0);
    assert.equal(snapshot.prepare("SELECT text FROM messages WHERE external_event_id='original'").get().text,'原始聊天只保留，不自动变成任务');
  }finally{snapshot.close();}
});
