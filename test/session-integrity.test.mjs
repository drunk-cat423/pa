import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openRecordedConversation } from '../dist/conversation.js';
import { ConversationStore } from '../dist/store.js';
import { SessionIntegrity, SessionIntegrityError } from '../dist/session-integrity.js';
import {DiagnosticLog} from '../dist/diagnostics.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(),'pa-session-integrity-'));
  const config = {cwd:directory,dataDir:join(directory,'data'),provider:'fixture',model:'fixture',apiKey:'offline',
    baseUrl:'http://127.0.0.1:1/v1',contextWindow:32768,maxOutputTokens:1024,timeoutMs:50};
  const key = 'room';
  const route={channel:'qq',accountId:'fixture',roomType:'group',roomId:'room'};
  const canonical = join(config.dataDir,createHash('sha256').update(key).digest('hex'),'session.jsonl');
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

test('实际启动不再读取旧Pi历史或改写其核对状态；离线账本分页索引保留',async t=>{
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
    assert.equal(reads,0);assert.equal(stats,0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM session_integrity WHERE status='dirty'").get().n,8);
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

test('显式离线审计仍发现旧SQL/Pi关联改写并保留corrupt证据',async t=>{
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

test('已返回但无最终业务证据的旧Pi/模型运行保持interrupted，完整诊断答案只补SQL且不重发',async t=>{
  const f=await fixture(t),unknown=await f.seed(1,false),complete=await f.seed(2,false);
  const diagnostics=new DiagnosticLog(f.config.dataDir),answer='已通过业务校验的最终回答';
  diagnostics.event({traceId:complete.run.id,runId:complete.run.id,conversationId:f.conversation.id},'answer','turn.completed',
    {answer,inputSha256:createHash('sha256').update(complete.run.inputText).digest('hex'),answerSha256:createHash('sha256').update(answer).digest('hex')});
  // A damaged/missing old file has no role in new execution or recovery.
  await fs.writeFile(unknown.file,'{broken\n');await fs.unlink(complete.file);
  const opened=await openRecordedConversation(f.config,f.key,f.route);
  try {
    assert.equal(f.db.prepare('SELECT status FROM agent_runs WHERE id=?').get(unknown.run.id).status,'interrupted');
    const row=f.db.prepare('SELECT status,recovered FROM agent_runs WHERE id=?').get(complete.run.id);
    assert.equal(row.status,'completed');assert.equal(row.recovered,1);
    assert.equal(f.db.prepare('SELECT text FROM messages WHERE id=(SELECT response_message_id FROM agent_runs WHERE id=?)').get(complete.run.id).text,answer);
    assert.equal(f.db.prepare('SELECT status FROM deliveries WHERE run_id=?').get(complete.run.id).status,'uncertain');
    assert.equal(opened.persistenceStatus().status,'ready');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM agent_runs').get().n,2);
  } finally {await opened.close();}
  const next=await openRecordedConversation(f.config,f.key,f.route);await next.close();
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM deliveries').get().n,1);
});

test('旧Pi损坏保留显式离线审计结果，不隔离房间；真实SQLite操作失败仍停止',async t=>{
  const f=await fixture(t),item=await f.seed(1);await fs.appendFile(item.file,'{broken\n');
  await assert.rejects(f.verifier.dirty(),SessionIntegrityError);
  const opened=await openRecordedConversation(f.config,f.key,f.route);
  try {
    assert.equal(opened.persistenceStatus().status,'ready');
    assert.equal(f.store.sessionIntegrity.forFile(item.file).status,'corrupt');
    f.db.exec('DROP TABLE channel_tasks');
    assert.throws(()=>opened.queuedTaskCount(),/持久化失败/);
    assert.equal(opened.persistenceStatus().status,'fatal');
  } finally {await opened.close();}
});

test('诊断证据缺失、不完整或脱敏改变答案均不恢复业务，也不重新执行模型',async t=>{
  const f=await fixture(t),first=await f.seed(1,false),second=await f.seed(2,false);
  const diagnostics=new DiagnosticLog(f.config.dataDir);
  diagnostics.event({traceId:first.run.id,runId:first.run.id,conversationId:f.conversation.id},'answer','turn.completed',{answer:'已改变的内容',answerSha256:'invalid'});
  diagnostics.event({traceId:second.run.id,runId:second.run.id,conversationId:f.conversation.id},'answer','turn.failed',{code:'unknown'});
  const opened=await openRecordedConversation(f.config,f.key,f.route);await opened.close();
  assert.deepEqual(f.db.prepare('SELECT status FROM agent_runs ORDER BY rowid').all().map(row=>row.status),['interrupted','interrupted']);
  assert.equal(f.db.prepare('SELECT count(*) n FROM deliveries').get().n,0);
});

test('真实模型回复已返回但SQLite完成失败时，重启只恢复最终诊断答案并保持未知投递',async t=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'pa-final-answer-recovery-'));let calls=0,modelAnswer='完整最终答案';
  const server=createServer(async(request,response)=>{
    for await (const chunk of request) void chunk;
    calls++;
    response.writeHead(200,{'content-type':'text/event-stream'});
    response.write(`data: ${JSON.stringify({id:'fixture',choices:[{index:0,delta:{role:'assistant',content:modelAnswer},finish_reason:null}]})}\n\n`);
    response.write(`data: ${JSON.stringify({id:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={cwd:directory,dataDir:join(directory,'data'),provider:'fixture',model:'fixture',apiKey:'fixture-key',
    baseUrl:`http://127.0.0.1:${server.address().port}/v1`,contextWindow:32768,maxOutputTokens:1024,timeoutMs:5000};
  let opened;
  t.after(async()=>{await opened?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});});
  opened=await openRecordedConversation(config,'recovery');
  const original=ConversationStore.prototype.completeRun;
  ConversationStore.prototype.completeRun=function(){throw new Error('injected business commit failure');};
  try{await assert.rejects(opened.prompt('只执行一次的输入'),/持久化失败/);}
  finally{ConversationStore.prototype.completeRun=original;await opened.close();}
  assert.equal(calls,1);
  opened=await openRecordedConversation(config,'recovery');
  assert.equal(calls,1,'restart cannot repeat a completed or unknown billed request');
  const db=new DatabaseSync(join(config.dataDir,'pa.sqlite'),{readOnly:true});
  try{
    assert.deepEqual({...db.prepare('SELECT status,recovered FROM agent_runs').get()},{status:'completed',recovered:1});
    assert.equal(db.prepare("SELECT text FROM messages WHERE role='assistant'").get().text,'完整最终答案');
    assert.equal(db.prepare('SELECT status FROM deliveries').get().status,'uncertain');
    assert.equal(db.prepare('SELECT pi_session_file FROM agent_runs').get().pi_session_file,null);
    assert.ok(db.prepare('SELECT pi_entry_id FROM messages').all().every(row=>row.pi_entry_id===null));
  }finally{db.close();}
  assert.equal(opened.info().sessionFile,undefined);
  await opened.close();opened=await openRecordedConversation(config,'recovery');assert.equal(calls,1);
  await opened.close();
  // A valid answer larger than the event bound keeps the existing response
  // artifact and normal SQL commit, instead of becoming a diagnostic failure.
  modelAnswer='x'.repeat(250*1024);
  opened=await openRecordedConversation(config,'long-answer');
  const longReply=await opened.prompt('超长但合法的回答');assert.equal(longReply.text,modelAnswer);assert.equal(calls,2);
  const evidence=new DiagnosticLog(config.dataDir).events({traceId:longReply.runId}).find(event=>event.event==='turn.completed');
  assert.equal(evidence.details.answer,undefined);
  assert.equal(evidence.details.answerOmittedReason,'final_answer_exceeds_inline_evidence_limit');
  const committed=new DatabaseSync(join(config.dataDir,'pa.sqlite'),{readOnly:true});
  try{assert.equal(committed.prepare('SELECT m.text FROM agent_runs r JOIN messages m ON m.id=r.response_message_id WHERE r.id=?').get(longReply.runId).text,modelAnswer);}
  finally{committed.close();}
});
