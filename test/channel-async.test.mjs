import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ChannelHarness, channelConversationKey } from '../dist/channel-harness.js';
import { openConversation } from '../dist/runtime.js';
import { ConversationStore } from '../dist/store.js';
import { downgradeSchema30 } from './fixtures/legacy-schema.mjs';
import { isPreparationRequest, preparationDelta, totalModelCalls } from './fixtures/turn-preparation.mjs';

async function until(predicate, description) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function currentInput(body) {
  const user = body.messages.findLast(message => message.role === 'user');
  const raw = typeof user.content === 'string' ? user.content : user.content.map(part => part.text ?? '').join('');
  return JSON.parse(raw.slice(raw.lastIndexOf('\n') + 1));
}

async function fixture(t, maxConcurrent = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-channel-async-'));
  const requests = [], planningRequests = [], sent = [], plans = new Map(), preparations = new Map(), gates = [], harnesses = [], errors = [];
  let send = async (_message, index) => ({ status: 'sent', externalMessageId: `out-${index}` });
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), input = currentInput(body);
      if (isPreparationRequest(body)) {
        planningRequests.push({ body, input });
        const delta = preparationDelta(`prepare-${planningRequests.length}`, preparations.get(input.currentMessage.eventId));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [value, finish] of [[delta, null], [{}, 'tool_calls']]) {
          response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
            model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
        }
        response.end('data: [DONE]\n\n');
        return;
      }
      requests.push({ body, input });
      const step = plans.get(input.currentMessage.eventId)?.shift() ?? { answer: `回答：${input.currentMessage.text}` };
      if (step.gate) await step.gate.promise;
      if (response.destroyed) return;
      const delta = step.tool ? { role: 'assistant', tool_calls: [{ index: 0,
        id: `call-${requests.length}`, type: 'function', function: { name: step.tool, arguments: '{}' } }] }
        : { role: 'assistant', content: step.answer };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [value, finish] of [[delta, null], [{}, step.tool ? 'tool_calls' : 'stop']]) {
        response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
          model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); response.destroy(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'fixture', model: 'fixture',
    apiKey: 'local-key', baseUrl: `http://127.0.0.1:${server.address().port}`, contextWindow: 32768,
    maxOutputTokens: 2048, timeoutMs: 10000, tasks: { maxConcurrent } };
  const route = { channel: 'qq', accountId: 'bot', roomType: 'group', roomId: 'one' };
  const other = { ...route, roomId: 'two' };
  function inspect(operation) {
    const db = new DatabaseSync(join(config.dataDir, 'pa.sqlite'), { readOnly: true });
    try { return operation(db); } finally { db.close(); }
  }
  function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    const value = { promise, release }; gates.push(value); return value;
  }
  function harness(maxCalls = 0,onError) {
    const h = new ChannelHarness(config, [route, other], { send: async message => {
      const persisted = inspect(db => db.prepare(`SELECT status,delivery_mode,reply_slot FROM delivery_parts
        WHERE status='sending' AND text=? UNION ALL
        SELECT status,delivery_mode,reply_slot FROM run_progress WHERE status='sending' AND text=? UNION ALL
        SELECT status,delivery_mode,reply_slot FROM channel_task_failures WHERE status='sending' AND text=?`).all(message.text, message.text, message.text));
      sent.push({ ...message, persisted });
      return send(message, sent.length);
    } }, maxCalls,undefined,undefined,onError);
    harnesses.push(h); return h;
  }
  const message = (eventId, text, extra = {}) => ({ route, eventId, text, senderId: 'alice', senderName: '甲',
    mentioned: true, sentAt: new Date().toISOString(), ...extra });
  function tasks() {
    return inspect(db => db.prepare(`SELECT t.id,t.status,m.external_event_id AS eventId,r.pi_session_file AS session,
      a.external_user_id AS senderId,r.input_message_id AS runInput,t.message_id AS taskInput
      FROM channel_tasks t JOIN messages m ON m.id=t.message_id JOIN actors a ON a.id=m.actor_id
      LEFT JOIN agent_runs r ON r.input_message_id=t.message_id ORDER BY t.rowid`).all());
  }
  t.after(async () => {
    // Release both HTTP and transport gates even if an assertion fails.
    gates.forEach(value => value.release());
    await Promise.all(harnesses.map(h => h.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  return { config, route, other, requests, planningRequests, totalCalls: () => totalModelCalls(requests, planningRequests), sent, plans, preparations, inspect, gate, harness, message, tasks,
    send: operation => { send = operation; } };
}

test('真实@从渠道首次入库保留到重启后的资料快照，文本伪@不获得权限', async t=>{
  const f=await fixture(t),h=f.harness();
  assert.equal(await h.handle(f.message('person-b','我来了',{senderId:'bob',mentioned:false})), 'observed');
  assert.equal(await h.handle(f.message('real-mention','<@bob> 喜欢阅读',{mentioned:false,mentionedSenderIds:['bob','bob']})), 'observed');
  assert.equal(await h.handle(f.message('text-mention','文字里写 <@bob>',{mentioned:false})), 'observed');
  assert.equal(f.totalCalls(),0);
  assert.equal(await h.handle(f.message('active-mention','看看 <@bob> 的资料',{mentionedSenderIds:['bob']})), 'sent');
  await h.close();
  const oldDb=new DatabaseSync(join(f.config.dataDir,'pa.sqlite'));
  try {
    oldDb.prepare('DELETE FROM message_profile_context WHERE message_id=(SELECT id FROM messages WHERE external_event_id=?)').run('active-mention');
    downgradeSchema30(oldDb);
    oldDb.exec('DROP TABLE IF EXISTS auto_memory_component_results; PRAGMA user_version=29;');
  } finally {oldDb.close();}
  const store=new ConversationStore(join(f.config.dataDir,'pa.sqlite'));
  try {
    const room=f.inspect(db=>db.prepare('SELECT conversation_id FROM messages WHERE external_event_id=?').get('real-mention').conversation_id);
    const now=Date.now();store.autoMemory.reserveMaterialsIfDue(room,now);
    assert.ok(store.autoMemory.reserveMaterialsIfDue(room,now+600001));
    const job=store.autoMemory.claimNext(room,{pipeline:'materials',owner:'mention-check',leaseMs:30000});
    const input=store.autoMemory.taskInput(job);
    const source=store.externalMessage(room,'real-mention').id,plain=store.externalMessage(room,'text-mention').id;
    assert.deepEqual(input.messages.find(message=>message.id===source).mentionedSenderIds,['bob']);
    assert.deepEqual(input.messages.find(message=>message.id===plain).mentionedSenderIds??[],[]);
    const repaired=store.externalMessage(room,'active-mention').id;
    assert.deepEqual(input.messages.find(message=>message.id===repaired).mentionedSenderIds,['bob'],'migration must recover only persisted platform mention metadata');
  } finally {store.close();}
});

test('请求失败真实发送短回执，预算前置拒绝和未知投递重启后不重发', async t => {
  const f=await fixture(t), gate=f.gate();
  f.config.timeoutMs=300;
  const h=f.harness(1);
  f.plans.set('timeout',[{gate,answer:'不应送达的迟到回答'}]);
  assert.equal(await h.handle(f.message('timeout','这个请求会超时')), 'failed');
  gate.release();
  assert.equal(f.sent.length,1);
  assert.match(f.sent[0].text,/这次请求超时/);
  assert.equal(f.sent[0].persisted[0].status,'sending');
  assert.equal(f.tasks()[0].status,'failed');
  const first=f.inspect(db=>db.prepare(`SELECT cf.status,cf.message_id,m.text FROM channel_task_failures cf
    JOIN messages m ON m.id=cf.message_id WHERE cf.status='sent'`).get());
  assert.match(first.text,/超时/);
  assert.equal(f.inspect(db=>db.prepare('SELECT count(*) n FROM conversation_context_messages WHERE message_id=?').get(first.message_id).n),1);
  f.send(async()=>{throw new Error('unknown delivery');});
  const blocked=f.message('budget','下一条提问');
  const calls=f.totalCalls();
  assert.equal(await h.handle(blocked),'budget_exhausted');
  assert.equal(f.totalCalls(),calls);
  assert.equal(f.sent.length,2);
  assert.equal(f.inspect(db=>db.prepare("SELECT count(*) n FROM channel_task_failures WHERE status='uncertain' AND message_id IS NULL").get().n),1);
  assert.equal(f.tasks()[1].runInput,null);
  await h.close();
  const reopened=f.harness(1); await reopened.start();
  assert.equal(await reopened.handle(blocked),'duplicate');
  assert.equal(f.sent.length,2); assert.equal(f.totalCalls(),calls);
});

test('同群长回答分段与其它回答按队列顺序完成', async t => {
  const f = await fixture(t), output = f.gate(), h = f.harness();
  const answer = '甲'.repeat(450) + '乙'.repeat(450) + '丙'.repeat(200);
  f.plans.set('long', [{ answer }]);
  f.preparations.set('depth', { intent: 'question', mode: 'professional', progressText: '我仔细分析一下。', updates: [] });
  f.plans.set('depth', [{ answer: '专业最终回答' }]);
  f.send(async (message, index) => {
    if (message.replyToMessageId === 'long' && message.partIndex === 0) await output.promise;
    return { status: 'sent', externalMessageId: `out-${index}` };
  });
  const first = h.handle(f.message('long', '长问题'));
  await until(() => f.sent.length === 1, '第一段进入发送');
  const depth = h.handle(f.message('depth', '深入推导', { senderId: 'bob' }));
  await until(() => f.tasks().find(task => task.eventId === 'depth')?.status === 'queued', '专业回答留在持久队列');
  const normal = h.handle(f.message('normal', '普通问题', { senderId: 'carol' }));
  await until(() => f.tasks().find(task => task.eventId === 'normal')?.status === 'queued', '其它回答留在持久队列');
  assert.equal(f.totalCalls(),2,'慢投递期间本房间不产生更多模型调用');
  assert.equal(f.sent.length, 1);
  output.release();
  assert.deepEqual(await Promise.all([first, depth, normal]), ['sent', 'sent', 'sent']);
  assert.match(f.sent[0].text,/^甲/);
  assert.equal(f.sent[0].replyToMessageId,'long');
  assert.ok(f.sent.slice(1).some(message => message.text === '回答：普通问题'));
  assert.ok(f.sent.slice(1).some(message => message.text === '专业最终回答'));
  assert.ok(f.planningRequests.some(request => request.input.currentMessage.eventId === 'depth'));
  assert.equal(f.inspect(db => JSON.parse(db.prepare(`SELECT p.plan_json FROM turn_preparations p
    JOIN messages m ON m.id=p.source_message_id WHERE m.external_event_id='depth'`).get().plan_json).mode), 'professional');
  assert.equal(f.sent.filter(message => message.text === '我仔细分析一下。').length, 1);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM run_progress').get().n), 1);
  assert.equal(f.totalCalls(), 6);
});

test('慢房间投递不阻塞其他房间，生产入口立即入库返回，后续同房间任务重启恢复', async t => {
  const f=await fixture(t,1),blocked=f.gate(),h=f.harness();
  f.send(async(message,index)=>{
    if(message.replyToMessageId==='a1') await blocked.promise;
    return {status:'sent',externalMessageId:`sent-${index}`};
  });
  const first=h.handle(f.message('a1','房间A第一问'));
  await until(()=>f.sent.length===1,'A开始慢投递');
  assert.equal(await h.handle(f.message('a2','房间A第二问'),{waitForResult:false}),'accepted');
  assert.equal(await h.handle(f.message('b1','房间B第一问',{route:f.other})),'sent');
  assert.equal(f.tasks().find(task=>task.eventId==='a2').status,'queued');
  assert.equal(f.totalCalls(),4);
  assert.equal(h.info().queued,1);
  const closing=h.close();blocked.release();
  assert.equal(await first,'sent');await closing;
  assert.equal(f.tasks().find(task=>task.eventId==='a2').status,'queued');
  const reopened=f.harness();await reopened.start();await reopened.waitForTasks();
  assert.equal(f.tasks().find(task=>task.eventId==='a2').status,'completed');
  assert.equal(f.sent.filter(message=>message.replyToMessageId==='a2').length,1);
  assert.equal(f.totalCalls(),6);
});

test('持续热房间队列按房间轮转，单房间保持入队顺序',async t=>{
  const f=await fixture(t,1),gate=f.gate(),h=f.harness();
  f.plans.set('a0',[{gate,answer:'first'}]);
  const first=h.handle(f.message('a0','first'));
  await until(()=>f.requests.length===1,'第一请求占据计算槽');
  for(let i=1;i<=8;i++) assert.equal(await h.handle(f.message(`a${i}`,`A ${i}`),{waitForResult:false}),'accepted');
  assert.equal(await h.handle(f.message('b','B',{route:f.other}),{waitForResult:false}),'accepted');
  gate.release();await first;await h.waitForTasks();
  assert.deepEqual(f.requests.map(r=>r.input.currentMessage.eventId),['a0','b',...Array.from({length:8},(_,i)=>`a${i+1}`)]);
});

test('claim到执行之间关闭时，尚无run的任务安全退回queued，重启只执行一次',async t=>{
  const f=await fixture(t),h=f.harness();await h.start();
  const original=ConversationStore.prototype.claimNextChannelTask;
  let closing;
  ConversationStore.prototype.claimNextChannelTask=function(id){
    const task=original.call(this,id);
    if(task&&!closing) closing=h.close();
    return task;
  };
  try {assert.equal(await h.handle(f.message('close-gap','不能丢掉的任务')),'ignored');await closing;}
  finally{ConversationStore.prototype.claimNextChannelTask=original;}
  assert.equal(f.tasks()[0].status,'queued');assert.equal(f.totalCalls(),0);
  const next=f.harness();await next.start();await next.waitForTasks();
  assert.equal(f.tasks()[0].status,'completed');assert.equal(f.totalCalls(),2);
});

test('旧SQL损坏隔离一间房并保留新任务，另一个房间继续回答',async t=>{
  const f=await fixture(t),h=f.harness();
  assert.equal(await h.handle(f.message('original','原始问题')),'sent');
  const mutator=new ConversationStore(join(f.config.dataDir,'pa.sqlite'));
  try{mutator.db.prepare("UPDATE messages SET text='篡改原文' WHERE external_event_id='original'").run();}
  finally{mutator.close();}
  assert.equal(await h.handle(f.message('blocked','原文异常时不可调用模型')),'failed');
  await h.waitForTasks();
  assert.equal(f.tasks().find(task=>task.eventId==='blocked').status,'queued');
  assert.equal(f.totalCalls(),2);
  assert.equal(h.info().isolatedRooms.length,1);
  assert.equal(await h.handle(f.message('safe','另一个房间',{route:f.other})),'sent');
  assert.equal(f.totalCalls(),4);
});

test('损坏canonical JSONL只隔离所属房间，不阻止其他房间启动',async t=>{
  const f=await fixture(t);
  const rt=await openConversation(f.config,channelConversationKey(f.route));
  const file=rt.info().sessionFile;await rt.close();await writeFile(file,'{broken\n');
  const h=f.harness();await h.start();
  assert.equal(h.info().isolatedRooms.length,1);
  assert.equal(await h.handle(f.message('safe','正常问题',{route:f.other})),'sent');
  assert.equal(await h.handle(f.message('bad','异常房间问题')),'failed');
  assert.equal(f.totalCalls(),2);
});

test('隔离时退回未执行任务遇到持久化失败必须全局停调度并上报',async t=>{
  const f=await fixture(t);let fatal=0;const h=f.harness(0,()=>fatal++);
  assert.equal(await h.handle(f.message('original','原始问题')),'sent');
  const mutator=new ConversationStore(join(f.config.dataDir,'pa.sqlite'));
  try{mutator.db.prepare("UPDATE messages SET text='篡改' WHERE external_event_id='original'").run();}finally{mutator.close();}
  const release=ConversationStore.prototype.releaseUnstartedChannelTask;
  ConversationStore.prototype.releaseUnstartedChannelTask=()=>{throw new Error('injected rollback persistence failure');};
  try{
    await h.handle(f.message('blocked','新问题')).catch(()=>{});await h.waitForTasks();
    assert.equal(fatal,1);
    await assert.rejects(h.handle(f.message('other','另一个房间',{route:f.other})),/持久化失败/);
    assert.equal(f.totalCalls(),2);
  }finally{ConversationStore.prototype.releaseUnstartedChannelTask=release;}
});
