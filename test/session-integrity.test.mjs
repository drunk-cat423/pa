import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openRecordedConversation } from '../dist/conversation.js';
import { openConversation } from '../dist/runtime.js';
import { ConversationStore } from '../dist/store.js';
import { SessionIntegrity, SessionIntegrityError } from '../dist/session-integrity.js';
import {BackgroundMemory} from '../dist/auto-memory.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(),'pa-session-integrity-'));
  const config = {cwd:directory,dataDir:join(directory,'data'),provider:'fixture',model:'fixture',apiKey:'offline',
    baseUrl:'http://127.0.0.1:1/v1',contextWindow:32768,maxOutputTokens:1024,timeoutMs:50};
  const key = 'room';
  const route={channel:'qq',accountId:'fixture',roomType:'group',roomId:'room'};
  const runtime = await openConversation(config,key);
  const canonical = runtime.info().sessionFile;
  await runtime.close();
  const store = new ConversationStore(join(config.dataDir,'pa.sqlite'));
  const db = store.db;
  const conversation = store.ensureConversation(key,canonical,route);
  const verifier = new SessionIntegrity(store.sessionIntegrity,conversation.id,key,canonical);
  t.after(async () => { store.close(); await fs.rm(directory,{recursive:true,force:true}); });
  async function seed(n, completed = true) {
    const external = {eventId:`event-${n}`,senderId:'person',modelInputText:`question-${n}`};
    store.recordInbound(conversation.id,`question-${n}`,external);
    const source = store.externalMessage(conversation.id,external.eventId);
    const file = join(dirname(dirname(canonical)),createHash('sha256').update(`${key}:task:${source.id}`).digest('hex'),'session.jsonl');
    const run = store.beginRun(conversation.id,`question-${n}`,'fixture','fixture',[],{...external,existingMessageId:source.id},undefined,file);
    const at = new Date().toISOString();
    const lines = [
      {type:'session',version:3,id:`session-${n}`,timestamp:at,cwd:directory},
      {type:'custom',customType:'pa_run',id:`marker-${n}`,parentId:null,timestamp:at,data:{runId:run.id}},
      {type:'message',id:`user-${n}`,parentId:`marker-${n}`,timestamp:at,message:{role:'user',content:`question-${n}`}},
      {type:'message',id:`assistant-${n}`,parentId:`user-${n}`,timestamp:at,message:{role:'assistant',content:[{type:'text',text:`answer-${n}`}],stopReason:'stop'}},
    ];
    await fs.mkdir(dirname(file),{recursive:true});
    await fs.writeFile(file,lines.map(line=>JSON.stringify(line)).join('\n')+'\n');
    if(completed) store.completeRun(run.id,`answer-${n}`,`user-${n}`,`assistant-${n}`);
    return {file,run,lines};
  }
  return {config,key,route,canonical,conversation,store,db,verifier,seed};
}

test('实际启动：首次核对历史任务，二次启动不stat/read已verified JSONL；分页SQL不扫描任务消息',async t=>{
  const f = await fixture(t);
  const files = new Set();
  for(let n=0;n<8;n++) files.add((await f.seed(n)).file);
  const originalRead = fs.readFile, originalStat = fs.lstat;
  let reads=0, stats=0;
  fs.readFile = async (file,...args) => { if(files.has(String(file))) reads++; return originalRead(file,...args); };
  fs.lstat = async (file,...args) => { if(files.has(String(file))) stats++; return originalStat(file,...args); };
  syncBuiltinESMExports();
  try {
    const first=await openRecordedConversation(f.config,f.key,f.route); await first.close();
    assert.ok(reads>=8); assert.ok(stats>=8);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM session_integrity WHERE status='verified'").get().n,8);
    reads=0;stats=0;
    const second=await openRecordedConversation(f.config,f.key,f.route); await second.close();
    assert.equal(reads,0);assert.equal(stats,0);
  } finally {fs.readFile=originalRead;fs.lstat=originalStat;syncBuiltinESMExports();}
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM session_integrity_canonical_messages').get().n,0);
  const canonicalPlan=f.db.prepare(`EXPLAIN QUERY PLAN SELECT m.rowid FROM session_integrity_canonical_messages link
    JOIN messages m ON m.rowid=link.message_rowid AND m.id=link.message_id
    WHERE link.conversation_id=? AND link.message_rowid>? ORDER BY link.message_rowid LIMIT ?`).all(f.conversation.id,0,64);
  assert.match(JSON.stringify(canonicalPlan),/session_integrity_canonical_page/);
  assert.doesNotMatch(JSON.stringify(canonicalPlan),/SCAN m|TEMP B-TREE/);
  const pagePlan=f.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM session_integrity WHERE conversation_id=? AND id>? ORDER BY id LIMIT ?').all(f.conversation.id,0,64);
  assert.match(JSON.stringify(pagePlan),/session_integrity_pages/);assert.doesNotMatch(JSON.stringify(pagePlan),/TEMP B-TREE/);
});

test('SQL输入/输出变更和删除留下dirty记录，核对失败留corrupt并隔离房间',async t=>{
  const f=await fixture(t);const item=await f.seed(1);await f.verifier.dirty();
  f.db.prepare('UPDATE messages SET text=? WHERE id=?').run('tampered',item.run.inputMessageId);
  assert.equal(f.store.sessionIntegrity.forFile(item.file).status,'dirty');
  await assert.rejects(f.verifier.dirty(),SessionIntegrityError);
  assert.equal(f.store.sessionIntegrity.forFile(item.file).status,'corrupt');
  const other=f.store.ensureConversation('other','other.jsonl');
  assert.equal(f.store.sessionIntegrity.problem(other.id),undefined);
  const g=await fixture(t);const deleted=await g.seed(2);await g.verifier.dirty();
  g.db.exec('PRAGMA foreign_keys=OFF');
  g.db.prepare('DELETE FROM agent_runs WHERE id=?').run(deleted.run.id);
  assert.equal(g.store.sessionIntegrity.forFile(deleted.file).status,'dirty');
  await assert.rejects(g.verifier.dirty(),/关联已删除/);
  assert.equal(g.store.sessionIntegrity.forFile(deleted.file).status,'corrupt');
  const h=await fixture(t);const response=await h.seed(3);await h.verifier.dirty();h.db.exec('PRAGMA foreign_keys=OFF');
  h.db.prepare('DELETE FROM messages WHERE id=(SELECT response_message_id FROM agent_runs WHERE id=?)').run(response.run.id);
  assert.equal(h.store.sessionIntegrity.forFile(response.file).status,'dirty');
  await assert.rejects(h.verifier.dirty(),/回复不一致/);
});

test('运行关联改路径同时标记OLD和NEW；CAS无法清除核对期间的新变更',async t=>{
  const f=await fixture(t);const item=await f.seed(1);await f.verifier.dirty();
  const old=f.store.sessionIntegrity.forFile(item.file);
  f.db.prepare('UPDATE agent_runs SET error_kind=? WHERE id=?').run('audit',item.run.id);
  assert.equal(f.store.sessionIntegrity.verified(old,old.hash,old.sqlHash),false);
  assert.equal(f.store.sessionIntegrity.forFile(item.file).status,'dirty');
  await f.verifier.dirty();
  f.db.prepare('UPDATE agent_runs SET pi_session_file=? WHERE id=?').run('different.jsonl',item.run.id);
  assert.equal(f.store.sessionIntegrity.forFile(item.file).status,'dirty');
  assert.equal(f.store.sessionIntegrity.forFile('different.jsonl').status,'dirty');
  await assert.rejects(f.verifier.dirty(),/关联已删除或发生不一致/);
});

test('JSONL离线篡改由持久分页hash巡检发现，SQL无关更新不能洗掉已有hash',async t=>{
  const f=await fixture(t);const a=await f.seed(1),b=await f.seed(2);await f.verifier.dirty();
  assert.equal(await f.verifier.audit({limit:1}),1);
  const cursor=f.store.sessionIntegrity.sweepCursor(f.conversation.id);assert.ok(cursor>0);
  await fs.appendFile(b.file,'\n');
  await assert.rejects(f.verifier.audit({limit:1}),/哈希发生变化/);
  assert.equal(f.store.sessionIntegrity.forFile(b.file).status,'corrupt');
  assert.equal(f.store.sessionIntegrity.forFile(a.file).status,'verified');
  const g=await fixture(t);const c=await g.seed(3);await g.verifier.dirty();await fs.appendFile(c.file,'\n');
  g.db.prepare('UPDATE agent_runs SET error_kind=? WHERE id=?').run('no-op',c.run.id);
  await assert.rejects(g.verifier.dirty(),/哈希发生变化/);
  await assert.rejects(g.verifier.audit({full:true,recheckCorrupt:true}),/哈希发生变化/);
  await fs.writeFile(c.file,c.lines.map(line=>JSON.stringify(line)).join('\n')+'\n');
  assert.equal(await g.verifier.audit({full:true,recheckCorrupt:true}),1);
  assert.equal(g.store.sessionIntegrity.forFile(c.file).status,'verified');
});

test('JSONL语法/链接损坏不降级；真实文件与SQL回执逐项绑定',async t=>{
  const f=await fixture(t);const item=await f.seed(1);await fs.appendFile(item.file,'{broken\n');
  await assert.rejects(f.verifier.dirty(),SessionIntegrityError);
  assert.equal(f.store.sessionIntegrity.forFile(item.file).status,'corrupt');
  const g=await fixture(t);const linked=await g.seed(2);const target=linked.file+'.hardlink';await fs.link(linked.file,target);
  await assert.rejects(g.verifier.dirty(),/文件损坏、不可读/);
  const h=await fixture(t);const mismatch=await h.seed(3);
  h.db.prepare('UPDATE messages SET pi_entry_id=? WHERE id=(SELECT response_message_id FROM agent_runs WHERE id=?)').run('wrong-entry',mismatch.run.id);
  await assert.rejects(h.verifier.dirty(),/回复不一致/);
});

test('未完成成功JSONL恢复仅补SQL并保留unknown投递，不重发、不调用模型；普通请求前拒绝dirty损坏',async t=>{
  const f=await fixture(t);const pending=await f.seed(1,false);
  const opened=await openRecordedConversation(f.config,f.key,f.route);
  try {
    const row=f.db.prepare('SELECT status,recovered FROM agent_runs WHERE id=?').get(pending.run.id);
    assert.equal(row.status,'completed');assert.equal(row.recovered,1);
    assert.equal(f.db.prepare('SELECT status FROM deliveries WHERE run_id=?').get(pending.run.id).status,'uncertain');
    assert.equal(f.store.sessionIntegrity.forFile(pending.file).status,'verified');
    f.db.prepare('UPDATE messages SET text=? WHERE id=?').run('changed',pending.run.inputMessageId);
    await assert.rejects(opened.prompt('must not call model'),SessionIntegrityError);
    assert.equal(opened.integrityStatus().status,'corrupt');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_runs').get().n,1);
  } finally {await opened.close();}
});

test('巡检发现损坏立即关闭本房间后台；数据库错误立即上报服务',async t=>{
  const f=await fixture(t),item=await f.seed(1);await f.verifier.dirty();
  let halted=0;const original=BackgroundMemory.prototype.close;
  BackgroundMemory.prototype.close=async function(){halted++;return original.call(this);};
  const failures=[];
  const opened=await openRecordedConversation(f.config,f.key,f.route,{onIntegrityFailure:error=>failures.push(error)});
  try{
    await fs.appendFile(item.file,'\n');
    await assert.rejects(opened.auditSessions(),SessionIntegrityError);
    assert.equal(halted,1);assert.equal(failures.length,1);
    assert.equal(opened.integrityStatus().status,'corrupt');
  }finally{await opened.close();BackgroundMemory.prototype.close=original;}
  const g=await fixture(t);await g.seed(2);await g.verifier.dirty();
  const dbFailures=[];const next=await openRecordedConversation(g.config,g.key,g.route,{onIntegrityFailure:error=>dbFailures.push(error)});
  try{
    g.db.exec('DROP TABLE session_integrity_sweeps');
    await assert.rejects(next.auditSessions(),/持久化失败/);
    assert.equal(dbFailures.length,1);assert.equal(next.integrityStatus().status,'fatal');
  }finally{await next.close();}
});
