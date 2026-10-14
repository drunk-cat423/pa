import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
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
  const ids = input.messages.filter(message => message.role === 'user').map(message => message.id);
  return { topics: ids.length ? [{ summary: '本批讨论了测试计划。', messageIds: ids }] : [],
    fragments: [], profiles: [], ignoredMessageIds: [],
    ...(input.roomType === 'private' ? { continuationSummary: '已经讨论测试计划，下一步继续执行。' } : {}) };
}

for (const scenario of [
  { name: '不限整理次数超过20次仍继续，失败重试也可恢复', limit: 0, rounds: 21, failures: 1, calls: 22, completed: 21 },
  { name: '有限整理预算仍阻止超过上限的调用', limit: 1, rounds: 2, failures: 0, calls: 1, completed: 1 },
  { name: '不限总次数仍保留每个任务的三次失败重试上限', limit: 0, rounds: 1, failures: Infinity, calls: 3, completed: 0 },
]) test(scenario.name, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-memory-limit-'));
  const store = new ConversationStore(join(directory, 'store.sqlite'));
  const conversation = store.ensureConversation('room', join(directory, 'session.jsonl'),
    { channel: 'qq', accountId: 'a', roomId: 'g', roomType: 'group' });
  let calls = 0;
  const background = new BackgroundMemory({ memory: { enabled: true, maxCalls: scenario.limit, timeoutMs: 5000, maxRetries: 3 }, contextWindow: 100000 },
    store.autoMemory, conversation.id, { extract: async input => {
      calls++;
      if (calls <= scenario.failures) throw new Error('fixture failure');
      return extracted(input);
    } });
  t.after(async () => { await background.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  for (let i = 0; i < scenario.rounds; i++) {
    store.recordInbound(conversation.id, 'hello', { eventId: String(i), senderId: 'a', modelInputText: 'hello' });
    background.start('capacity');
    if (i < scenario.completed) await background.wait(undefined, 3000);
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
    if (JSON.stringify(body.messages.at(-1)).includes('BLOCK_CHAT')) { chatStarted.resolve(); await chatGate.promise; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choices of [
      [{ index: 0, delta: { role: 'assistant', content: '继续讨论' }, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: 'stop' }],
    ]) response.write(`data: ${JSON.stringify({ id: 'reply', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'deepseek', model: 'fixture',
    apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}`, contextWindow: 1000000,
    maxOutputTokens: 256, timeoutMs: 10000,
    memory: { enabled: true, maxCalls: 100, maxRetries: 1, timeoutMs: 10000 }, ...overrides };
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
  assert.equal(f.requests.length, 1);
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
  assert.match(JSON.stringify(f.requests[48]), /私聊第1轮/);
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
  const f = await fixture(t, async (input, signal) => { started.resolve(); await wait(signal, gate.promise); return extracted(input); }, { contextWindow: 10000 });
  const h = f.harness();
  for (let i = 1; i <= 3; i++) {
    const pending = h.handle(f.message(`capacity${i}`, `${i}:` + 'x'.repeat(2500), { route: f.privateRoute }));
    const state = await Promise.race([pending.then(result => ({ result })), new Promise(resolve => setTimeout(() => resolve({ waiting: true }), 1500))]);
    if (state.waiting) {
      await started.promise; const before = f.requests.length;
      gate.resolve(); assert.equal(await pending, 'sent'); assert.equal(f.requests.length, before + 1);
      await h.waitForMemory(); assert.ok(f.inputs[0].messages.filter(m => m.role === 'user').length < 50); return;
    }
    assert.equal(state.result, 'sent');
  }
  const pending = h.handle(f.message('capacity4', '4:' + 'x'.repeat(2500), { route: f.privateRoute }));
  await started.promise;
  let finished = false; void pending.then(() => { finished = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(finished, false);
  const before = f.requests.length; gate.resolve();
  assert.equal(await pending, 'sent'); assert.equal(f.requests.length, before + 1);
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
  assert.match(JSON.stringify(f.requests.at(-1)), /登山/);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /绘画/);
  assert.equal(await h.handle(f.message('ask-at', '和被提及的人玩什么', { mentioned: true, mentionedSenderIds: ['b', 'b'] })), 'sent');
  const last = JSON.stringify(f.requests.at(-1)); assert.match(last, /登山/); assert.match(last, /绘画/);
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

test('快速连发私聊按提问顺序保留已经发送的上一轮回复', async t => {
  const f = await fixture(t); const h = f.harness();
  const first = h.handle(f.message('q1', 'BLOCK_CHAT', { route: f.privateRoute }));
  await f.chatStarted.promise;
  const second = h.handle(f.message('q2', '继续上一轮', { route: f.privateRoute }));
  await h.handle(f.message('unrelated', '确认入站执行过', { route: f.other }));
  f.chatGate.resolve(); assert.equal(await first, 'sent'); assert.equal(await second, 'sent');
  const input = JSON.stringify(f.requests.at(-1));
  assert.match(input, /BLOCK_CHAT/); assert.match(input, /继续讨论/); assert.match(input, /继续上一轮/);
});

test('群聊因历史超限时等待整理后重建输入，不创建群摘要', async t => {
  const f = await fixture(t, undefined, { contextWindow: 7000 }); const h = f.harness();
  for (let i = 1; i <= 4; i++) await h.handle(f.message(`g${i}`, `${i}:` + 'g'.repeat(2000)));
  assert.equal(await h.handle(f.message('g-question', '现在可以继续吗', { mentioned: true })), 'sent');
  await h.waitForMemory();
  assert.equal(f.inputs[0].roomType, 'group'); assert.ok(f.inputs[0].messages.length < 50);
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /gggggggggg/);
  assert.equal(h.info().memory[0].summary, undefined);
});

test('超大画像按预算选择完整事实，普通短问题仍可回答且数据库保留完整画像', async t => {
  const f = await fixture(t, undefined, { contextWindow: 7000 }); const h = f.harness();
  await h.handle(f.message('seed', '首次发言'));
  const db = f.db();
  try {
    const person = db.prepare('SELECT person_id FROM actor_person_bindings JOIN actors ON actors.id=actor_id WHERE external_user_id=?').get('a').person_id;
    const facts = Array.from({ length: 100 }, (_, i) => ({ content: `事实${i}：` + 'a'.repeat(800), sourceType: 'self', messageIds: [] }));
    db.prepare('UPDATE persons SET revision=1 WHERE id=?').run(person);
    db.prepare('INSERT INTO person_profile_revisions VALUES (?,1,?,NULL,?)').run(person, JSON.stringify(facts), new Date().toISOString());
    assert.equal(await h.handle(f.message('short', '你好', { mentioned: true })), 'sent');
    assert.ok(JSON.stringify(f.requests.at(-1)).length < 7000);
    assert.equal(JSON.parse(db.prepare('SELECT facts_json FROM person_profile_revisions WHERE person_id=? AND revision=1').get(person).facts_json).length, 100);
  } finally { db.close(); }
});

test('画像事实继承按字段与证据集合比较，不依赖JSON键顺序', () => {
  const old = { content: '喜欢茶', sourceType: 'self', messageIds: ['old2', 'old1'], field: 'drink' };
  const input = { job: {}, roomType: 'group', messages: [{ id: 'new', role: 'user', text: 'hello', personId: 'a' }],
    profiles: [{ personId: 'a', baseVersion: 1, facts: [old] }] };
  const reordered = { messageIds: ['old1', 'old2'], field: 'drink', sourceType: 'self', content: '喜欢茶' };
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
    finished.push(input.messages.map(message => message.id));
    return extracted(input);
  }, { memory: { enabled: true, maxCalls: 20, maxRetries: 2, timeoutMs: 5000 } });
  const h = f.harness();
  for (let i = 0; i < 50; i++) await h.handle(f.message(`split-${i}`, `批次消息${i}`));
  await h.waitForMemory();
  assert.equal(h.info().memory[0].completed, 1);
  const ids = finished.flat(); assert.equal(ids.length, 50); assert.equal(new Set(ids).size, 50);
  assert.equal(h.info().memory[0].calls, 5);
});

test('关闭中断的后台批次重新排队，重启无需新消息也继续整理', async t => {
  let calls = 0; const started = deferred();
  const f = await fixture(t, async (input, signal) => {
    calls++;
    if (calls === 1) { started.resolve(); await wait(signal, new Promise(() => {})); }
    return extracted(input);
  });
  const h = f.harness();
  for (let i = 0; i < 50; i++) await h.handle(f.message(`resume-${i}`, `继续${i}`));
  await started.promise; await h.close();
  const next = f.harness(); await next.start(); await next.waitForMemory();
  assert.equal(calls, 2);
  assert.equal(next.info().memory.find(item => item.conversation === channelConversationKey(f.route)).completed, 1);
});

test('后台有限画像视图新增事实后保留超过200条的完整旧证据', async t => {
  const f = await fixture(t, async input => {
    const result = extracted(input); const person = input.profiles[0];
    result.profiles = [{ ...person, facts: [...person.facts,
      { content: '新兴趣是天文', sourceType: 'self', messageIds: [input.messages.find(m => m.role === 'user').id], field: 'astronomy' }] }];
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
    assert.equal(JSON.parse(row.facts_json).length, 201);
  } finally { db.close(); }
});

test('等待截止时间独立于后台工作结束，超时后后台可以继续', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-memory-wait-'));
  const store = new ConversationStore(join(directory, 'store.sqlite'));
  const conversation = store.ensureConversation('room', join(directory, 'session.jsonl'), { channel: 'qq', accountId: 'a', roomId: 'g', roomType: 'group' });
  for (let i = 0; i < 50; i++) store.recordInbound(conversation.id, 'hello', { eventId: String(i), senderId: 'a', modelInputText: 'hello' });
  const gate = deferred();
  const background = new BackgroundMemory({ memory: { enabled: true, maxCalls: 10, timeoutMs: 5000, maxRetries: 1 }, contextWindow: 100000 },
    store.autoMemory, conversation.id, { extract: async (input, signal) => { await wait(signal, gate.promise); return extracted(input); } });
  t.after(async () => { gate.resolve(); await background.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  background.start();
  await assert.rejects(background.wait(undefined, 30), /尚未完成/);
  assert.equal(store.autoMemory.status(conversation.id).running, 1);
  gate.resolve(); await background.wait(); assert.equal(store.autoMemory.status(conversation.id).completed, 1);
});
