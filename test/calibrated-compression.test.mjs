import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ChannelHarness } from '../dist/channel-harness.js';
import { companionReply } from './fixtures/companion-tools.mjs';

test('渠道按实测校准跨任务复用，字节超窗口不误压缩，接近实际85%后触发同一整理流程', {timeout:60000}, async t=>{
  const directory=await mkdtemp(join(tmpdir(),'pa-calibrated-compression-'));
  const requests=[],extractions=[],harnesses=[];
  let nearLimit=false,event=0,sent=0;
  const server=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);requests.push(body);
    const reply=companionReply(body,'LOCAL_REPLY');
    const tokens=nearLimit?850000:Math.ceil(Buffer.byteLength(raw)*0.3);
    res.writeHead(200,{'content-type':'text/event-stream'});
    for(const [delta,finish_reason] of [[reply.delta,null],[{},reply.finishReason]])
      res.write(`data: ${JSON.stringify({id:'local',object:'chat.completion.chunk',created:1,model:'fixture',
        choices:[{index:0,delta,finish_reason}]})}\n\n`);
    res.write(`data: ${JSON.stringify({id:'local',object:'chat.completion.chunk',created:1,model:'fixture',choices:[],
      usage:{prompt_tokens:tokens,completion_tokens:16,total_tokens:tokens+16,
        prompt_tokens_details:{cached_tokens:tokens-256}}})}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const config={cwd:directory,dataDir:join(directory,'data'),provider:'deepseek',model:'fixture',apiKey:'local-key',
    baseUrl:`http://127.0.0.1:${server.address().port}`,contextWindow:1000000,maxOutputTokens:256,timeoutMs:10000,
    memory:{enabled:true,maxCalls:10,maxOutputTokens:8192,timeoutMs:10000}};
  const route={channel:'qq',accountId:'local',roomType:'group',roomId:'room'};
  const createHarness=()=>{
    const h=new ChannelHarness(config,[route],{send:async()=>({status:'sent',externalMessageId:`sent-${++sent}`})},0,{version:1,ownerBindings:[]},
      {extract:async input=>{
        extractions.push(input);
        return {topics:[],fragments:[],profiles:[],ignoredMessageIds:input.extractionProtocol === 2 ? [] : input.messages.filter(m=>m.role==='user').map(m=>m.id),
          continuationSummary:'CALIBRATED_ROLLING_SUMMARY'};
      }});
    harnesses.push(h);return h;
  };
  t.after(async()=>{
    await Promise.allSettled(harnesses.map(h=>h.close()));
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    await rm(directory,{recursive:true,force:true});
  });
  let h=createHarness();
  const message=(text,mentioned=false)=>({route,eventId:String(++event),senderId:'alice',text,mentioned,sentAt:new Date().toISOString()});
  const addHistory=async count=>{
    for(let i=0;i<count;i++)assert.equal(await h.handle(message(`${event}:`+'x'.repeat(3500))),'observed');
  };
  await addHistory(60);
  assert.equal(await h.handle(message('warm-up measurement',true)),'sent');
  assert.equal(extractions.length,0);
  // New harness and task sessions must load successful usage from diagnostics.
  await h.close();h=createHarness();
  for(const count of [80,80,80]){
    await addHistory(count);
    assert.equal(await h.handle(message('measure accumulated context',true)),'sent');
    await h.waitForMemory();assert.equal(extractions.length,0);
  }
  assert.ok(requests.some(body=>Buffer.byteLength(JSON.stringify(body))>config.contextWindow),
    'a measured request should pass the hard guard even when JSON bytes exceed the token window');
  nearLimit=true;
  assert.equal(await h.handle(message('report input near the actual threshold',true)),'sent');
  await h.waitForMemory();assert.equal(extractions.length,0);
  assert.equal(await h.handle(message('next turn observes the reported 85 percent',true)),'sent');
  await h.waitForMemory();assert.equal(extractions.length,1);
  assert.equal(extractions[0].contextProtocol,1);
  assert.ok(extractions[0].messages.filter(m=>m.role==='user').length>270);
  const db=new DatabaseSync(join(config.dataDir,'pa.sqlite'),{readOnly:true});
  try{
    const state=db.prepare('SELECT revision,summary FROM conversation_context_state WHERE revision>0').get();
    assert.equal(state.revision,1);assert.equal(state.summary,'CALIBRATED_ROLLING_SUMMARY');
    assert.equal(db.prepare("SELECT count(*) n FROM auto_memory_jobs WHERE reason='count'").get().n,0);
    assert.ok(db.prepare('SELECT count(*) n FROM messages').get().n>280);
  }finally{db.close();}
});
