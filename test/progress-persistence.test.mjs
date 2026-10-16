import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {openRecordedConversation,PersistenceError} from '../dist/conversation.js';

async function fixture(t,phase) {
  const dir=await mkdtemp(join(tmpdir(),'pa-progress-persistence-')),requests=[];
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    const first=requests.length===1;
    const delta=first?{role:'assistant',tool_calls:[{index:0,id:'prepare',type:'function',function:{name:'prepare_turn',
      arguments:JSON.stringify({intent:'question',mode:'professional',updates:[],progressText:'我想想，稍等一下。'})}}]}
      :{role:'assistant',content:'正式回答。'};
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [d,r]of[[delta,null],[{},first?'tool_calls':'stop']])res.write(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',model:'fixture',choices:[{index:0,delta:d,finish_reason:r}]})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={cwd:dir,dataDir:join(dir,'data'),provider:'fixture',model:'fixture',apiKey:'fixture',
    baseUrl:`http://127.0.0.1:${server.address().port}`,contextWindow:32768,maxOutputTokens:512,timeoutMs:3000};
  const route={channel:'qq',accountId:'bot',roomType:'group',roomId:'test'};
  const conversation=await openRecordedConversation(config,'progress',route,undefined,{policy:{version:1,ownerBindings:[]}});
  const inspect=fn=>{const db=new DatabaseSync(conversation.info().databasePath);try{return fn(db);}finally{db.close();}};
  if(phase)inspect(db=>db.exec(phase==='create'
    ?"CREATE TRIGGER fail_progress BEFORE INSERT ON run_progress BEGIN SELECT RAISE(FAIL,'fixture progress create');END"
    :`CREATE TRIGGER fail_progress BEFORE UPDATE ON run_progress WHEN NEW.status='${phase==='start'?'sending':'sent'}' BEGIN SELECT RAISE(FAIL,'fixture progress ${phase}');END`));
  t.after(async()=>{await conversation.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  return {conversation,requests,inspect};
}

for(const phase of ['create','start','ack'])test(`进度${phase}持久化失败停止会话，不伪装成发送失败继续正式回答`,async t=>{
  const f=await fixture(t,phase);
  let began=0,sent=0;
  await assert.rejects(f.conversation.prompt('请详细分析',{eventId:'question',senderId:'member',modelInputText:'请详细分析'},async progress=>{
    began++;progress.begin('passive',1);sent++;
    return {status:'sent',externalMessageId:'progress-message'};
  }),PersistenceError);
  assert.equal(f.requests.length,1);
  assert.equal(began,phase==='create'?0:1);
  assert.equal(sent,phase==='ack'?1:0);
  const rows=f.inspect(db=>db.prepare('SELECT status FROM run_progress').all());
  assert.deepEqual(rows.map(r=>r.status),phase==='create'?[]:[phase==='start'?'pending':'sending']);
  await assert.rejects(f.conversation.prompt('继续',{eventId:'another',senderId:'member',modelInputText:'继续'}),PersistenceError);
  assert.equal(f.requests.length,1);
});

test('输出忙时准入拒绝，不创建进度或占回复槽，仍正常生成正式答案',async t=>{
  const f=await fixture(t);
  let callbacks=0;
  const result=await f.conversation.prompt('请详细分析',{eventId:'question',senderId:'member',modelInputText:'请详细分析'},
    async()=>{callbacks++;throw Error('must not enter a busy output queue');},()=>false);
  assert.equal(result.text,'正式回答。');assert.equal(f.requests.length,2);assert.equal(callbacks,0);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM run_progress').get().n),0);
});
