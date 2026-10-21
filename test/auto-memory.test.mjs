import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { companionReply } from './fixtures/companion-tools.mjs';
import { ChannelHarness, channelConversationKey } from '../dist/channel-harness.js';
import { BackgroundMemory, validateExtract } from '../dist/auto-memory.js';
import { ConversationStore } from '../dist/store.js';
import { MemoryInputTooLargeError } from '../dist/memory-provider.js';
import { conversationContext } from './fixtures/conversation-context.mjs';

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function wait(signal, gate) {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    gate.then(() => { signal.removeEventListener('abort', abort); resolve(); });
  });
}
function extracted(input) {
  if (input.pipeline === 'compression') return { topics: [], fragments: [], profiles: [], ignoredMessageIds: [],
    continuationSummary: '已经讨论测试计划，下一步继续执行。' };
  if (input.mode === 'profiles') return { profiles: input.profiles.map(profile => ({ personId: profile.personId,
    baseVersion: profile.baseVersion, facts: profile.facts, pendingResults: (profile.pending ?? []).map(pending => ({ pendingId: pending.id, status: 'deferred' })) })) };
  const ids = input.messages.filter(message => message.role === 'user').map(message => message.id);
  return { topics: ids.length ? [{ summary: '本批讨论了测试计划。', messageIds: input.extractionProtocol === 2 ? [] : ids }] : [],
    fragments: [], profiles: [], ignoredMessageIds: [],
    ...(input.roomType === 'private' || input.contextProtocol === 1
      ? { continuationSummary: '已经讨论测试计划，下一步继续执行。' } : {}) };
}

function currentMessageText(body) {
  const user = body.messages.filter(message => message.role === 'user').at(-1);
  if (!user) return '';
  const content = typeof user.content === 'string' ? user.content : user.content.map(part => part.text ?? '').join('');
  try { return JSON.parse(content.slice(content.lastIndexOf('\n') + 1)).currentMessage?.text ?? content; }
  catch { return content; }
}

function backgroundPayload(body) {
  const message = body.messages.filter(item => item.role === 'user').findLast(item => {
    const content = typeof item.content === 'string' ? item.content : item.content.map(part => part.text ?? '').join('');
    return content.includes('已保存的候选背景数据');
  });
  assert.ok(message, 'request should carry its bounded background payload');
  const content = typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('');
  return JSON.parse(content.slice(content.lastIndexOf('\n') + 1));
}

async function fixture(t, extract = async input => extracted(input), overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-memory-integration-'));
  const requests = [], sent = [], inputs = [], harnesses = [];
  const chatGate = deferred();
  const chatStarted = deferred();
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    if (currentMessageText(body).includes('BLOCK_CHAT')) { chatStarted.resolve(); await chatGate.promise; }
    const reply = companionReply(body,'继续讨论');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choices of [
      [{ index: 0, delta: reply.delta, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: reply.finishReason }],
    ]) response.write(`data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'deepseek', model: 'fixture',
    apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}`, contextWindow: 1000000,
    maxOutputTokens: 256, timeoutMs: 10000,
    memory: { enabled: true, maxCalls: 100, timeoutMs: 10000 }, ...overrides };
  config.memory = { maxOutputTokens: 8192, ...config.memory };
  const route = { channel: 'qq', accountId: 'bot', roomType: 'group', roomId: 'g1' };
  const other = { ...route, roomId: 'g2' };
  const privateRoute = { ...route, roomType: 'private', roomId: 'private-a' };
  const provider = { extract: async (input, signal) => { inputs.push(structuredClone(input)); return extract(input, signal); } };
  function harness(policy = { version: 1, ownerBindings: [] }) {
    const h = new ChannelHarness(config, [route, other, privateRoute], {
      send: async message => { sent.push(message); return { status: 'sent', externalMessageId: `out-${sent.length}` }; },
    }, 0, policy, provider);
    harnesses.push(h); return h;
  }
  const message = (id, text, options = {}) => ({ route, eventId: id, text, senderId: 'a',
    mentioned: false, sentAt: new Date().toISOString(), ...options });
  t.after(async () => {
    chatGate.resolve();
    await Promise.allSettled(harnesses.map(h => h.close()));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { config, route, other, privateRoute, requests, sent, inputs, harness, message, chatGate, chatStarted,
    reserveCapacity(route) {
      const db = new DatabaseSync(join(config.dataDir, 'pa.sqlite'));
      let conversationId;
      try {
        conversationId = db.prepare(`SELECT c.id FROM conversations c JOIN rooms r ON r.id=c.room_id
          WHERE r.channel=? AND r.account=? AND r.external_chat_id=? AND r.room_type=?`)
          .get(route.channel, route.accountId, route.roomId, route.roomType).id;
      } finally { db.close(); }
      const store = new ConversationStore(join(config.dataDir, 'pa.sqlite'));
      try { return store.autoMemory.reserveBatch(conversationId, 'capacity'); }
      finally { store.close(); }
    },
    retryFailed: () => {
      const store = new ConversationStore(join(config.dataDir, 'pa.sqlite'));
      try { for (const job of store.autoMemory.listJobs()) if (job.status === 'failed') store.autoMemory.retry(job.id); }
      finally { store.close(); }
    },
    db: () => new DatabaseSync(join(config.dataDir, 'pa.sqlite')) };
}

test('群消息超过60条也不按消息数自动压缩', async t => {
  const f = await fixture(t);
  const h = f.harness();
  for (let i = 1; i <= 61; i++) await h.handle(f.message(`g${i}`, `群消息${i}`));
  await h.waitForMemory();
  assert.equal(f.inputs.length, 0);
  assert.equal(h.info().memory.reduce((sum, item) => sum + item.completed, 0), 0);
  const db = f.db();
  try { assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE role='user'").get().n, 61); }
  finally { db.close(); }
});

test('私聊完成50轮且容量较低时不按轮数自动压缩', { timeout: 120_000 }, async t => {
  const f = await fixture(t); const h = f.harness();
  for (let i = 1; i <= 50; i++) assert.equal(await h.handle(f.message(`p${i}`, `私聊第${i}轮`, { route: f.privateRoute })), 'sent');
  await h.waitForMemory();
  assert.equal(f.inputs.length, 0);
  assert.equal(h.info().memory.find(item => item.conversation === channelConversationKey(f.privateRoute)).completed, 0);
  const db = f.db();
  try { assert.equal(db.prepare("SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id JOIN rooms r ON r.id=c.room_id WHERE m.role='user' AND r.room_type='private'").get().n, 50); }
  finally { db.close(); }
});

test('最终上下文达到85%才整理；摘要与检查点后消息跨新轮和重启继续', async t => {
  const gate = deferred(), started = deferred();
  let extractionStarted = false;
  const f = await fixture(t, async (input, signal) => { extractionStarted = true; started.resolve(); await wait(signal, gate.promise); return extracted(input); }, { contextWindow: 20000 });
  const h = f.harness();
  let pending;
  for (let i = 1; i <= 10 && !extractionStarted; i++) {
    pending = h.handle(f.message(`capacity${i}`, `${i}:` + 'x'.repeat(3500), { route: f.privateRoute }));
    const state = await Promise.race([pending.then(result => ({ result })), started.promise.then(() => ({ started: true }))]);
    if (state.started) break;
    assert.equal(state.result, 'sent');
  }
  assert.ok(extractionStarted, 'the measured final request should cross the 85% threshold');
  await started.promise;
  let finished = false; void pending.then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(finished, false);
  const before = f.requests.filter(request=>request.messages.at(-1)?.role==='tool').length; gate.resolve();
  assert.equal(await pending, 'sent'); assert.equal(f.requests.filter(request=>request.messages.at(-1)?.role==='tool').length, before + 1);
  await h.waitForMemory(); assert.equal(f.inputs[0].contextProtocol, 1);
  assert.equal(await h.handle(f.message('capacity-follow-up', 'CAPACITY_FOLLOW_UP', { route: f.privateRoute })), 'sent');
  let context = conversationContext(f.requests.at(-1));
  assert.equal(context.summary.continuationSummary, '已经讨论测试计划，下一步继续执行。');
  assert.ok(context.summary.checkpoint > 0);
  assert.equal(await h.handle(f.message('capacity-tail-check', 'CAPACITY_TAIL_CHECK', { route: f.privateRoute })), 'sent');
  context = conversationContext(f.requests.at(-1));
  assert.ok(context.messages.some(message => message.text === 'CAPACITY_FOLLOW_UP'));
  await h.close();
  const reopened = f.harness();
  assert.equal(await reopened.handle(f.message('capacity-reopened', 'CAPACITY_AFTER_RESTART', { route: f.privateRoute })), 'sent');
  context = conversationContext(f.requests.at(-1));
  assert.equal(context.summary.continuationSummary, '已经讨论测试计划，下一步继续执行。');
  assert.ok(context.messages.some(message => message.text === 'CAPACITY_FOLLOW_UP'));
  assert.ok(!context.messages.some(message => message.text === 'CAPACITY_AFTER_RESTART'));
});

test('仅发送者及真实@对象画像，绑定人物私聊自述可在群使用', async t => {
  const f = await fixture(t); const binding = (route, senderId) => ({ route, senderId });
  const policy = { version: 1, ownerBindings: [], persons: [{ id: 'person-a', bindings: [binding(f.privateRoute, 'a'), binding(f.route, 'a')] }] };
  const h = f.harness(policy);
  assert.equal(await h.handle(f.message('pref-a', '记住我喜欢登山', { route: f.privateRoute })), 'sent');
  assert.equal(await h.handle(f.message('pref-b', '记住我喜欢绘画', { senderId: 'b', mentioned: true })), 'sent');
  assert.equal(await h.handle(f.message('ask-no-at', '和小B玩什么', { mentioned: true })), 'sent');
  const noAtInput = backgroundPayload(f.requests.at(-1));
  assert.ok(noAtInput.profiles.some(profile => profile.senderIds.includes('a')));
  assert.ok(!noAtInput.profiles.some(profile => profile.personId === 'person-b' || profile.senderIds.includes('b')));
  assert.ok(!JSON.stringify(noAtInput.profiles).includes('绘画'));
  assert.ok(conversationContext(f.requests.at(-1)).messages
    .some(message => message.senderId === 'b' && message.text.includes('绘画')));
  assert.equal(await h.handle(f.message('ask-at', '和被提及的人玩什么', { mentioned: true, mentionedSenderIds: ['b', 'b'] })), 'sent');
  const mentionedProfiles = backgroundPayload(f.requests.at(-1)).profiles;
  assert.ok(mentionedProfiles.some(profile => profile.senderIds.includes('a')));
  assert.ok(mentionedProfiles.some(profile => profile.senderIds.includes('b')
    && JSON.stringify(profile).includes('绘画')));
});

test('快速连发私聊独立计算，不将尚未完成的回复伪作历史', async t => {
  const f = await fixture(t); const h = f.harness();
  const first = h.handle(f.message('q1', 'BLOCK_CHAT', { route: f.privateRoute }));
  await f.chatStarted.promise;
  const second = h.handle(f.message('q2', '继续上一轮', { route: f.privateRoute }));
  await h.handle(f.message('unrelated', '确认入站执行过', { route: f.other }));
  f.chatGate.resolve(); assert.equal(await first, 'sent'); assert.equal(await second, 'sent');
  const input = JSON.stringify(f.requests.find(request => JSON.stringify(request.messages.at(-1)).includes('继续上一轮')));
  assert.match(input, /BLOCK_CHAT/); assert.doesNotMatch(input, /继续讨论/); assert.match(input, /继续上一轮/);
});

test('群容量压缩标记新协议、创建群摘要且数据库保留原文', async t => {
  const f = await fixture(t, undefined, { contextWindow: 32768 }); const h = f.harness();
  for (let i = 1; i <= 4; i++) await h.handle(f.message(`g${i}`, `${i}:` + 'g'.repeat(2000)));
  const store=new ConversationStore(join(f.config.dataDir,'pa.sqlite'));
  try {
    const db=f.db();
    try { store.autoMemory.reserveBatch(db.prepare('SELECT id FROM conversations').get().id,'capacity'); } finally {db.close();}
  } finally {store.close();}
  await h.waitForMemory();
  assert.equal(await h.handle(f.message('g-question', '刚才群里讨论了什么？', { mentioned: true })), 'sent');
  assert.equal(f.inputs[0].roomType, 'group'); assert.ok(f.inputs[0].messages.length < 50);
  assert.ok(f.inputs.some(input => input.roomType === 'group' && input.contextProtocol === 1));
  const db=f.db();
  try { assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE text LIKE '%gggggggggg%' AND role='user'").get().n, 4); }
  finally { db.close(); }
  const context=conversationContext(f.requests.at(-1));
  assert.ok(context.summary.continuationSummary);
});

test('画像事实继承按内容与证据集合比较，不注入旧分类字段或依赖JSON键顺序', () => {
  const old = { content: '喜欢茶', sourceType: 'self', messageIds: ['old2', 'old1'], field: 'drink' };
  const input = { job: {}, roomType: 'group', messages: [{ id: 'new', role: 'user', text: 'hello', personId: 'a' }],
    profiles: [{ personId: 'a', baseVersion: 1, facts: [old] }] };
  const reordered = { messageIds: ['old1', 'old2'], sourceType: 'self', content: '喜欢茶' };
  const output = { topics: [], fragments: [], ignoredMessageIds: ['new'], profiles: [{ personId: 'a', baseVersion: 1, facts: [reordered] }] };
  assert.deepEqual(validateExtract(output, input), output);
});

test('长批次拆分检查点在失败重试后续接，不重复已成功的子批次', async t => {
  let smallCalls = 0, failed = false;
  const finished = [];
  const f = await fixture(t, async input => {
    if (input.messages.length > 20) throw new MemoryInputTooLargeError('fixture split');
    smallCalls++;
    if (smallCalls === 2 && !failed) { failed = true; throw new Error('fixture transient'); }
    if (input.mode !== 'profiles') finished.push(input.messages.map(message => message.id));
    return extracted(input);
  }, { memory: { enabled: true, maxCalls: 20, timeoutMs: 5000 } });
  const h = f.harness();
  for (let i = 0; i < 50; i++) await h.handle(f.message(`split-${i}`, `批次消息${i}`));
  assert.ok(f.reserveCapacity(f.route)); h.start();
  await assert.rejects(h.waitForMemory(), /失败/);
  await h.close(); f.retryFailed();
  const next = f.harness(); await next.start(); await next.waitForMemory();
  assert.equal(next.info().memory.find(item=>item.conversation===channelConversationKey(f.route)).completed, 1);
  const ids = finished.flat(); assert.equal(ids.length, 50); assert.equal(new Set(ids).size, 50);
  assert.equal(next.info().memory[0].calls, 9);
});

test('关闭中断的后台批次保留失败，只有显式重试后才继续整理', async t => {
  let calls = 0; const started = deferred();
  const f = await fixture(t, async (input, signal) => {
    calls++;
    if (calls === 1) { started.resolve(); await wait(signal, new Promise(() => {})); }
    return extracted(input);
  });
  const h = f.harness();
  for (let i = 0; i < 50; i++) await h.handle(f.message(`resume-${i}`, `继续${i}`));
  assert.ok(f.reserveCapacity(f.route)); h.start();
  await started.promise; await h.close();
  const stopped = f.harness(); await stopped.start(); await assert.rejects(stopped.waitForMemory(), /失败/);
  assert.equal(calls,1); await stopped.close(); f.retryFailed();
  const next = f.harness(); await next.start(); await next.waitForMemory();
  assert.equal(calls, 2);
  assert.equal(next.info().memory.find(item => item.conversation === channelConversationKey(f.route)).completed, 1);
});

test('后台提供完整旧画像并整体替换收敛结果，不再补回未返回的旧事实', async t => {
  let observedFacts = 0;
  const f = await fixture(t, async input => {
    const result = extracted(input); const person = input.profiles[0];
    if (input.mode === 'messages') return result;
    observedFacts = person.facts.length;
    result.profiles = [{ personId: person.personId, baseVersion: person.baseVersion, facts: [
      { content: '长期兴趣是天文', sourceType: 'self', messageIds: [person.facts[0].messageIds[0]] }] }];
    return result;
  }, { contextWindow: 50000 });
  const h = f.harness(); await h.handle(f.message('profile-base', '首次发言'));
  const db = f.db(); let person;
  try {
    person = db.prepare('SELECT person_id FROM actor_person_bindings JOIN actors ON actors.id=actor_id WHERE external_user_id=?').get('a').person_id;
    const source = db.prepare("SELECT id FROM messages WHERE external_event_id='profile-base'").get().id;
    const facts = Array.from({ length: 200 }, (_, i) => ({ content: `旧事实${i}:` + 'x'.repeat(300), sourceType: 'self', messageIds: [source], field: `old${i}` }));
    db.prepare('UPDATE persons SET revision=1 WHERE id=?').run(person);
    db.prepare('INSERT INTO person_profile_revisions VALUES (?,1,?,NULL,?)').run(person, JSON.stringify(facts), new Date().toISOString());
    for (let i = 1; i < 50; i++) await h.handle(f.message(`profile-${i}`, '天文记录'));
    assert.ok(f.reserveCapacity(f.route)); h.start();
    await h.waitForMemory();
    const row = db.prepare('SELECT facts_json FROM person_profile_revisions WHERE person_id=? ORDER BY revision DESC LIMIT 1').get(person);
    assert.equal(observedFacts, 200);
    assert.deepEqual(JSON.parse(row.facts_json), [{ content: '长期兴趣是天文', sourceType: 'self', messageIds: [source] }]);
    assert.equal(JSON.parse(db.prepare('SELECT facts_json FROM person_profile_revisions WHERE person_id=? AND revision=1').get(person).facts_json).length, 200);
  } finally { db.close(); }
});

test('私聊实际请求标明搁置摘要缺口并保留其原文，暂停时不调用整理模型', async t => {
  const f=await fixture(t,()=>{throw Error('BACKGROUND_MUST_STAY_PAUSED');},{memory:{enabled:false,maxCalls:0,timeoutMs:5000}});
  const h=f.harness();
  await h.handle(f.message('private-gap-source','PRIVATE_GAP_RAW',{route:f.privateRoute}));
  const db=f.db();
  const id=db.prepare("SELECT c.id FROM conversations c JOIN rooms r ON r.id=c.room_id WHERE r.room_type='private'").get().id;
  db.close();
  const store=new ConversationStore(join(f.config.dataDir,'pa.sqlite'));
  let job;
  try {
    store.autoMemory.reserveBatch(id,'capacity');
    job=store.autoMemory.claimNext(id,{owner:'fixture',leaseMs:60000});
    store.autoMemory.fail(job.id,job.leaseToken,'fixture failure');
    store.autoMemory.defer(job.id,'operator deferral');
  } finally {store.close();}
  await h.handle(f.message('private-gap-next','CURRENT_PRIVATE_QUESTION',{route:f.privateRoute}));
  const context=conversationContext(f.requests.at(-1));
  assert.deepEqual(context.summary.deferredRanges,[{startSeq:job.startSeq,endSeq:job.endSeq}]);
  assert.ok(context.messages.some(message=>message.text==='PRIVATE_GAP_RAW'));
  const wire=JSON.stringify(f.requests.at(-1).messages);
  assert.match(wire,/continuationSummary仅概括已完成部分，不能视为完整历史/);
  assert.equal(f.inputs.length,0);
});

test('显式搁置不调模型；暂停与重启保留缺口，恢复调度只执行后续批次', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-memory-deferred-worker-'));
  const store = new ConversationStore(join(directory, 'store.sqlite'));
  const conversation = store.ensureConversation('room', join(directory, 'session.jsonl'),
    { channel: 'qq', accountId: 'a', roomId: 'g', roomType: 'group' });
  const workers = [];
  t.after(async () => { for (const worker of workers) await worker.close(); store.close(); await rm(directory, {recursive:true,force:true}); });
  for (let i=0;i<150;i++) store.recordInbound(conversation.id, `message ${i}`, {eventId:String(i),senderId:'a',modelInputText:`message ${i}`});
  while (store.autoMemory.reserveBatch(conversation.id,'count')) { /* freeze three batches */ }
  const first = store.autoMemory.claimNext(conversation.id,{owner:'old',leaseMs:60000});
  store.autoMemory.saveProgress(first.id,first.leaseToken,{preserved:'partial progress'});
  store.autoMemory.fail(first.id,first.leaseToken,'[fixture] result unknown');
  let calls=0;
  const provider={extract:async input=>{
    calls++;
    assert.notEqual(input.job.id,first.id);
    assert.deepEqual(input.deferredRanges,[{startSeq:first.startSeq,endSeq:first.endSeq}]);
    return extracted(input);
  }};
  const paused=new BackgroundMemory({memory:{enabled:false,maxCalls:0,timeoutMs:5000},contextWindow:100000},store.autoMemory,conversation.id,provider);
  workers.push(paused);
  store.autoMemory.defer(first.id,'operator decision');
  paused.start(); await paused.close();
  assert.equal(calls,0);
  assert.equal(paused.info().deferred,1);
  const enabled=new BackgroundMemory({memory:{enabled:true,maxCalls:0,timeoutMs:5000},contextWindow:100000},store.autoMemory,conversation.id,provider);
  workers.push(enabled); enabled.start(); await enabled.wait();
  assert.equal(calls,2);
  assert.equal(enabled.info().completed,2);
  assert.equal(enabled.info().failed,0);
  assert.equal(enabled.info().deferred,1);
  assert.equal(enabled.info().checkpoint,0);
  const visibleIds = new Set(store.autoMemory.contextAfterCheckpoint(conversation.id).map(m=>m.id));
  assert.ok(first.messageIds.every(id => visibleIds.has(id)));
  assert.throws(()=>store.autoMemory.retry(first.id),/搁置/);
});

test('等待截止时间独立于后台工作结束，超时后后台可以继续', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-memory-wait-'));
  const store = new ConversationStore(join(directory, 'store.sqlite'));
  const conversation = store.ensureConversation('room', join(directory, 'session.jsonl'), { channel: 'qq', accountId: 'a', roomId: 'g', roomType: 'group' });
  for (let i = 0; i < 50; i++) store.recordInbound(conversation.id, 'hello', { eventId: String(i), senderId: 'a', modelInputText: 'hello' });
  const gate = deferred();
  const background = new BackgroundMemory({ memory: { enabled: true, maxCalls: 10, timeoutMs: 5000}, contextWindow: 100000 },
    store.autoMemory, conversation.id, { extract: async (input, signal) => { await wait(signal, gate.promise); return extracted(input); } });
  t.after(async () => { gate.resolve(); await background.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  assert.ok(store.autoMemory.reserveBatch(conversation.id, 'capacity'));
  background.start();
  await assert.rejects(background.wait(undefined, 30), /尚未完成/);
  assert.equal(store.autoMemory.status(conversation.id).running, 1);
  gate.resolve(); await background.wait(); assert.equal(store.autoMemory.status(conversation.id).completed, 1);
});
