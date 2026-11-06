import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openRecordedConversation } from '../dist/conversation.js';
import { ConversationStore } from '../dist/store.js';
import { SessionIntegrity } from '../dist/session-integrity.js';
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
