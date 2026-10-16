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
import { estimateContext } from '../dist/runtime.js';
import { MemoryInputTooLargeError } from '../dist/memory-provider.js';

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
  if (input.mode === 'profiles') return { profiles: input.profiles.map(profile => ({ personId: profile.personId,
    baseVersion: profile.baseVersion, facts: profile.facts, pendingResults: (profile.pending ?? []).map(pending => ({ pendingId: pending.id, status: 'deferred' })) })) };
  const ids = input.messages.filter(message => message.role === 'user').map(message => message.id);
  return { topics: ids.length ? [{ summary: '本批讨论了测试计划。', messageIds: ids }] : [],
    fragments: [], profiles: [], ignoredMessageIds: [],
    ...(input.roomType === 'private' ? { continuationSummary: '已经讨论测试计划，下一步继续执行。' } : {}) };
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

function currentTurnInput(body) {
  const message = body.messages.filter(item => item.role === 'user').at(-1);
  const content = typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('');
  return JSON.parse(content.slice(content.lastIndexOf('\n') + 1));
}

for (const scenario of [
  { name: '不限整理次数超过20次仍继续，失败重试也可恢复', limit: 0, rounds: 21, failures: 1, calls: 22, completed: 21 },
  { name: '有限整理预算仍阻止超过上限的调用', limit: 1, rounds: 2, failures: 0, calls: 1, completed: 1 },
  { name: '不限总次数也不自动重试结果未知的调用', limit: 0, rounds: 1, failures: Infinity, calls: 1, completed: 0 },
]) test(scenario.name, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-memory-limit-'));
  const store = new ConversationStore(join(directory, 'store.sqlite'));
  const conversation = store.ensureConversation('room', join(directory, 'session.jsonl'),
    { channel: 'qq', accountId: 'a', roomId: 'g', roomType: 'group' });
  let calls = 0;
  const background = new BackgroundMemory({ memory: { enabled: true, maxCalls: scenario.limit, timeoutMs: 5000 }, contextWindow: 100000 },
    store.autoMemory, conversation.id, { extract: async input => {
      calls++;
      if (calls <= scenario.failures) throw new Error('fixture failure');
      return extracted(input);
    } });
  t.after(async () => { await background.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  for (let i = 0; i < scenario.rounds; i++) {
    store.recordInbound(conversation.id, 'hello', { eventId: String(i), senderId: 'a', modelInputText: 'hello' });
    background.start('capacity');
    if (i < scenario.completed) {
      if (i === 0 && scenario.failures) {
        await assert.rejects(background.wait(undefined, 3000), /失败/);
        background.retry(store.autoMemory.listJobs()[0].id);
      }
      await background.wait(undefined, 3000);
    }
    else await assert.rejects(background.wait(undefined, 3000), /失败/);
  }
  assert.equal(calls, scenario.calls);
  assert.equal(background.info().calls, scenario.calls);
  assert.equal(store.autoMemory.status(conversation.id).completed, scenario.completed);
});
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
    retryFailed: () => {
      const store = new ConversationStore(join(config.dataDir, 'pa.sqlite'));
      try { for (const job of store.autoMemory.listJobs()) if (job.status === 'failed') store.autoMemory.retry(job.id); }
      finally { store.close(); }
    },
    db: () => new DatabaseSync(join(config.dataDir, 'pa.sqlite')) };
}

test('第50条固定批次后台等待时，新提问仍完成；第51条归下一批', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, async (input, signal) => { started.resolve(); await wait(signal, gate.promise); return extracted(input); });
  const h = f.harness();
  for (let i = 1; i <= 49; i++) await h.handle(f.message(`m${i}`, `消息${i}`));
  assert.equal(f.inputs.length, 0);
  await h.handle(f.message('m50', '消息50')); await started.promise;
  assert.equal(await h.handle(f.message('m51', '此时仍可回答吗', { mentioned: true })), 'sent');
  assert.equal(f.requests.filter(request=>request.messages.at(-1)?.role==='tool').length, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.inputs[0].messages.filter(m => m.role === 'user').length, 50);
  assert.ok(!f.inputs[0].messages.some(m => m.text === '此时仍可回答吗'));
  gate.resolve(); await h.waitForMemory();
  assert.equal(h.info().memory[0].completed, 1);
  const db = f.db();
  try { assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE role='user'").get().n, 51); }
  finally { db.close(); }
});

test('聊天阻塞时继续入站持久化，不同房间仍能回复，同房间消息按顺序', async t => {
  const f = await fixture(t); const h = f.harness();
  const first = h.handle(f.message('block', 'BLOCK_CHAT', { mentioned: true }));
  await f.chatStarted.promise;
  const second = h.handle(f.message('later', '排队的问题', { mentioned: true }));
  assert.equal(await h.handle(f.message('observed', '后台观察', { mentioned: false })), 'observed');
  assert.equal(await h.handle(f.message('other', '另一个房间', { route: f.other, mentioned: true })), 'sent');
  const db = f.db();
  try { assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE external_event_id='later'").get().n, 1); }
  finally { db.close(); }
  f.chatGate.resolve(); assert.equal(await first, 'sent'); assert.equal(await second, 'sent');
  assert.doesNotMatch(JSON.stringify(f.requests[0]), /排队的问题|后台观察/);
});

test('私聊完整50轮后压缩，下一轮使用摘要与新问题；原文保留并可重开', async t => {
  const f = await fixture(t); const h = f.harness();
  for (let i = 1; i <= 50; i++) assert.equal(await h.handle(f.message(`p${i}`, `私聊第${i}轮`, { route: f.privateRoute })), 'sent');
  await h.waitForMemory();
  assert.equal(f.inputs.length, 1);
  assert.equal(f.inputs[0].messages.filter(m => m.role === 'user').length, 50);
  assert.match(JSON.stringify(f.requests.filter(request=>request.messages.at(-1)?.role==='tool')[48]), /私聊第1轮/);
  assert.equal(await h.handle(f.message('p51', '新的问题', { route: f.privateRoute })), 'sent');
  assert.match(JSON.stringify(f.requests.at(-1)), /已经讨论测试计划/);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /私聊第1轮/);
  const db = f.db();
  try { assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE role='user'").get().n, 51); }
  finally { db.close(); }
  await h.close();
  const reopened = f.harness();
  assert.equal(await reopened.handle(f.message('p52', '重开后继续', { route: f.privateRoute })), 'sent');
  assert.match(JSON.stringify(f.requests.at(-1)), /已经讨论测试计划/);
  assert.equal(f.inputs.length, 1);
});

test('不足50轮到容量阈值仍整理，硬上限等待完成后重建请求', async t => {
  const gate = deferred(), started = deferred();
  const f = await fixture(t, async (input, signal) => { started.resolve(); await wait(signal, gate.promise); return extracted(input); }, { contextWindow: 20000 });
  const h = f.harness();
  for (let i = 1; i <= 8; i++) {
    const pending = h.handle(f.message(`capacity${i}`, `${i}:` + 'x'.repeat(3500), { route: f.privateRoute }));
    const state = await Promise.race([pending.then(result => ({ result })), new Promise(resolve => setTimeout(() => resolve({ waiting: true }), 1500))]);
    if (state.waiting) {
      await started.promise; const before = f.requests.filter(request=>request.messages.at(-1)?.role==='tool').length;
      gate.resolve(); assert.equal(await pending, 'sent'); assert.equal(f.requests.filter(request=>request.messages.at(-1)?.role==='tool').length, before + 1);
      await h.waitForMemory(); assert.ok(f.inputs[0].messages.filter(m => m.role === 'user').length < 50); return;
    }
    assert.equal(state.result, 'sent');
  }
  const pending = h.handle(f.message('capacity9', '9:' + 'x'.repeat(3500), { route: f.privateRoute }));
  await started.promise;
  let finished = false; void pending.then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(finished, false);
  const before = f.requests.filter(request=>request.messages.at(-1)?.role==='tool').length; gate.resolve();
  assert.equal(await pending, 'sent'); assert.equal(f.requests.filter(request=>request.messages.at(-1)?.role==='tool').length, before + 1);
  await h.waitForMemory(); assert.ok(f.inputs[0].messages.length < 100);
});

test('单条不可容纳输入不死循环，不发送超限模型请求', async t => {
  const f = await fixture(t, undefined, { contextWindow: 2500 }); const h = f.harness();
  assert.equal(await h.handle(f.message('huge', 'x'.repeat(3999), { route: f.privateRoute })), 'failed');
  assert.equal(f.requests.length, 0); assert.equal(f.inputs.length, 0);
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
  assert.ok(currentTurnInput(f.requests.at(-1)).recentGroupMessages
    .some(message => message.senderId === 'b' && message.text.includes('绘画')));
  assert.equal(await h.handle(f.message('ask-at', '和被提及的人玩什么', { mentioned: true, mentionedSenderIds: ['b', 'b'] })), 'sent');
  const mentionedProfiles = backgroundPayload(f.requests.at(-1)).profiles;
  assert.ok(mentionedProfiles.some(profile => profile.senderIds.includes('a')));
  assert.ok(mentionedProfiles.some(profile => profile.senderIds.includes('b')
    && JSON.stringify(profile).includes('绘画')));
});

test('模型提案不可伪造人物/消息，自述不能引用其他人', () => {
  const input = { job: {}, roomType: 'group', messages: [{ id: 'm1', role: 'user', text: 'hello', personId: 'a' }],
    profiles: [{ personId: 'a', baseVersion: 0, facts: [] }, { personId: 'b', baseVersion: 0, facts: [] }] };
  const base = { topics: [], fragments: [], profiles: [], ignoredMessageIds: ['m1'] };
  assert.deepEqual(validateExtract(base, input), base);
  assert.throws(() => validateExtract({ ...base, ignoredMessageIds: ['fake'] }, input), /消息/);
  assert.throws(() => validateExtract({ ...base, profiles: [{ personId: 'b', baseVersion: 0,
    facts: [{ content: 'B likes tea', sourceType: 'self', messageIds: ['m1'] }] }] }, input), /自述/);
  assert.throws(() => validateExtract({ ...base, continuationSummary: '群摘要' }, input), /群摘要/);
});

test('容量估算包含完整输入和预留输出，明确标注估算方式', () => {
  const low = estimateContext({ system: '规则', profile: '小林', text: 'hi' }, 10000, 1000);
  const high = estimateContext({ system: '规则'.repeat(1000), text: 'hi' }, 10000, 3000);
  assert.equal(low.method, 'utf8-byte-estimate'); assert.equal(low.fits, true);
  assert.ok(high.ratio > low.ratio); assert.ok(high.reservedOutputTokens === 3000);
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

test('群聊容量批次整理保留原文且不创建群摘要', async t => {
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
  const recent = JSON.parse(f.requests.at(-1).messages.filter(message => message.role === 'user').at(-1).content
    .map(part => part.text ?? '').join('').split('\n').at(-1)).recentGroupMessages;
  assert.equal(recent.length, 4);
  assert.ok(recent.every(message => message.text.includes('gggggggggg')));
  assert.equal(h.info().memory[0].summary, undefined);
});

test('超大画像按预算选择完整事实，普通短问题仍可回答且数据库保留完整画像', async t => {
  // Leave room for fixed response guidance while keeping the profile far larger than the window.
  const contextWindow = 40000;
  const f = await fixture(t, undefined, { contextWindow }); const h = f.harness();
  await h.handle(f.message('seed', '首次发言'));
  const db = f.db();
  try {
    const person = db.prepare('SELECT person_id FROM actor_person_bindings JOIN actors ON actors.id=actor_id WHERE external_user_id=?').get('a').person_id;
    const facts = Array.from({ length: 100 }, (_, i) => ({ content: `事实${i}：` + 'a'.repeat(800), sourceType: 'self', messageIds: [] }));
    db.prepare('UPDATE persons SET revision=1 WHERE id=?').run(person);
    db.prepare('INSERT INTO person_profile_revisions VALUES (?,1,?,NULL,?)').run(person, JSON.stringify(facts), new Date().toISOString());
    assert.equal(await h.handle(f.message('short', '你好', { mentioned: true })), 'sent');
    assert.ok(Buffer.byteLength(JSON.stringify(f.requests.at(-1)), 'utf8') < contextWindow);
    const background = f.requests.at(-1).messages.find(message => JSON.stringify(message.content).includes('已保存的候选背景数据'));
    const content = typeof background?.content === 'string' ? background.content : background?.content.map(part => part.text ?? '').join('');
    assert.ok(content);
    const payload = JSON.parse(content.slice(content.lastIndexOf('\n') + 1));
    const selected = payload.profiles.flatMap(profile => profile.archived);
    assert.ok(selected.length > 0 && selected.length < facts.length);
    assert.ok(selected.every(fact => facts.some(original => original.content === fact.content)));
    assert.equal(JSON.parse(db.prepare('SELECT facts_json FROM person_profile_revisions WHERE person_id=? AND revision=1').get(person).facts_json).length, 100);
  } finally { db.close(); }
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
  const input=currentTurnInput(f.requests.at(-1));
  assert.deepEqual(input.deferredRanges,[{startSeq:job.startSeq,endSeq:job.endSeq}]);
  assert.ok(input.history.some(message=>message.text==='PRIVATE_GAP_RAW'));
  const wire=JSON.stringify(f.requests.at(-1).messages);
  assert.match(wire,/conversationSummary仅概括已完成部分，不能视为完整历史/);
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
  assert.deepEqual(store.autoMemory.contextAfterCheckpoint(conversation.id).map(m=>m.id),first.messageIds);
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
  background.start();
  await assert.rejects(background.wait(undefined, 30), /尚未完成/);
  assert.equal(store.autoMemory.status(conversation.id).running, 1);
  gate.resolve(); await background.wait(); assert.equal(store.autoMemory.status(conversation.id).completed, 1);
});
