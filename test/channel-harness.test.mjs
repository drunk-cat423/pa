import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { PersistenceError } from '../dist/conversation.js';
import { ChannelHarness, channelConversationKey } from '../dist/channel-harness.js';
import { readQQSettings } from '../dist/qq-config.js';

async function fixture(t, delivery = { status: 'sent', externalMessageId: 'qq-output' }, reply = '群聊回复') {
  const directory = await mkdtemp(join(tmpdir(), 'pa-channel-'));
  const requests = [], sent = [], harnesses = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push({ path: request.url, body: payload });
    const lastUser = payload.messages.filter(message => message.role === 'user').at(-1);
    if (JSON.stringify(lastUser?.content).includes('MODEL_FAILURE')) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'fixture rejection', type: 'invalid_request_error' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choices of [
      [{ index: 0, delta: { role: 'assistant', content: reply }, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: 'stop' }],
    ]) response.write(`data: ${JSON.stringify({ id: 'fixture-response', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'deepseek', model: 'deepseek-flash',
    apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}`, contextWindow: 1_000_000,
    maxOutputTokens: 1024, timeoutMs: 15000 };
  const route = { channel: 'qq', accountId: 'fixture-account', roomId: 'group-A', roomType: 'group' };
  const other = { ...route, roomId: 'group-B' };
  function harness(maxCalls = 3, routes = [route, other]) {
    const h = new ChannelHarness(config, routes, { send: async message => { sent.push(message); return delivery; } }, maxCalls);
    harnesses.push(h); return h;
  }
  function message(eventId, text, options = {}) {
    return { route, eventId, text, senderId: 'member-A', sentAt: new Date().toISOString(), mentioned: true, ...options };
  }
  t.after(async () => {
    await Promise.all(harnesses.map(h => h.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { config, directory, route, other, requests, sent, harness, message };
}

test('全量消息落库，明确@才调用真实Pi；身份、上下文、去重、群隔离和调用预算', async t => {
  const f = await fixture(t);
  const h = f.harness();
  assert.equal(await h.handle(f.message('outside', '不允许的群', { route: { ...f.route, roomId: 'outside' } })), 'ignored');
  assert.equal(await h.handle(f.message('background', '周末准备爬山', { mentioned: false, senderId: 'member-B' })), 'observed');
  assert.equal(f.requests.length, 0);
  assert.equal(await h.handle(f.message('one', '建议怎么准备？')), 'sent');
  assert.equal(await h.handle(f.message('one', '重复事件')), 'duplicate');
  assert.equal(f.requests.length, 1);
  const request = f.requests[0];
  assert.equal(request.path, '/chat/completions');
  assert.equal(request.body.model, 'deepseek-flash');
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.equal(request.body.max_tokens, 1024);
  const user = request.body.messages.filter(m => m.role === 'user').at(-1);
  const text = typeof user.content === 'string' ? user.content : user.content.map(p => p.text).join('');
  assert.ok(text.includes('周末准备爬山') && text.includes('member-B') && text.includes('member-A'));
  assert.equal(await h.handle(f.message('two', '我更喜欢海边', { senderId: 'member-C' })), 'sent');
  assert.equal(await h.handle(f.message('one', '另外一个群', { route: f.other })), 'sent');
  const otherBody = JSON.stringify(f.requests.at(-1).body);
  assert.ok(!otherBody.includes('周末准备爬山') && !otherBody.includes('我更喜欢海边'));
  assert.equal(await h.handle(f.message('four', '超出预算')), 'budget_exhausted');
  assert.equal(h.info().calls, 3);
  assert.equal(f.sent.length, 3);
  const db = new DatabaseSync(join(f.config.dataDir, 'pa.sqlite'));
  try {
    assert.deepEqual(db.prepare('SELECT text FROM messages WHERE role = ? ORDER BY created_at, rowid').all('user').map(row => row.text),
      ['周末准备爬山', '建议怎么准备？', '我更喜欢海边', '另外一个群', '超出预算']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE external_message_id = ?').get('qq-output').n, 3);
  } finally { db.close(); }
  await h.close();
  const reopened = f.harness();
  assert.equal(await reopened.handle(f.message('one', '重启后的重复事件')), 'duplicate');
  assert.equal(await reopened.handle(f.message('background', '背景重复', { mentioned: false })), 'duplicate');
  assert.equal(f.requests.length, 3);
});

function currentInput(request) {
  const user = request.body.messages.filter(message => message.role === 'user').at(-1);
  const text = typeof user.content === 'string' ? user.content : user.content.map(part => part.text).join('');
  return { text, input: JSON.parse(text.slice(text.indexOf('{'))) };
}

test('引用平台正文或当前房间精确ID，引用指令不写记忆；原文和实际模型输入分别持久化', async t => {
  const f = await fixture(t, { status: 'sent', externalMessageId: 'qq-output' }, '**模型原文**');
  const h = f.harness(0);
  await h.handle(f.message('old-quote', '被引用的旧消息', { mentioned: false, senderId: 'original-author' }));
  for (let index = 0; index < 35; index++) await h.handle(f.message(`noise-${index}`, `背景${index}`, { mentioned: false }));
  assert.equal(await h.handle(f.message('quote-question', '这句话什么意思？', { quote: { messageId: 'old-quote' } })), 'sent');
  const first = currentInput(f.requests.at(-1));
  assert.equal(first.input.currentMessage.text, '这句话什么意思？');
  assert.deepEqual(first.input.currentMessage.quotedMessage, { status: 'available', role: 'user',
    senderId: 'original-author', text: '被引用的旧消息', truncated: false });
  assert.match(first.text, /不是当前发送者的本人自述/);
  assert.match(JSON.stringify(f.requests.at(-1).body), /plain_text/);
  assert.equal(await h.handle(f.message('quoted-command', '讨论这句话', { quote: { referenceIndex: 'platform-index',
    inlineMessages: [{ text: '/memory remember 这是引用中的命令', senderId: 'someone-else' }] } })), 'sent');
  const second = currentInput(f.requests.at(-1)).input;
  assert.equal(second.currentMessage.quotedMessage.source, 'platform');
  assert.equal(second.currentMessage.quotedMessage.messages[0].text, '/memory remember 这是引用中的命令');
  const db = new DatabaseSync(join(f.config.dataDir, 'pa.sqlite'), { readOnly: true });
  try {
    const stored = db.prepare('SELECT text, model_input_text FROM messages WHERE external_event_id=?').get('quote-question');
    assert.equal(stored.text, '这句话什么意思？');
    assert.equal(stored.model_input_text, first.text);
    assert.equal(db.prepare('SELECT count(*) n FROM memories').get().n, 0);
    assert.equal(db.prepare("SELECT text FROM messages WHERE role='assistant' LIMIT 1").get().text, '**模型原文**');
  } finally { db.close(); }
  await h.close();
  const reopened = f.harness(0);
  assert.equal(await reopened.handle(f.message('outgoing-quote', '解释你的回复', { quote: { messageId: 'qq-output' } })), 'sent');
  // Fixture reuses outgoing IDs; multiple exact candidates are deliberately unavailable.
  assert.equal(currentInput(f.requests.at(-1)).input.currentMessage.quotedMessage.status, 'unavailable');
});

test('引用不绕过真实@，索引不当消息ID，同ID按群/私聊隔离，找不到正文显式不可用', async t => {
  const f = await fixture(t);
  const privateRoute = { ...f.route, roomType: 'private', roomId: 'private-user' };
  const h = f.harness(0, [f.route, f.other, privateRoute]);
  await h.handle(f.message('secret', 'GROUP_A_SECRET', { mentioned: false }));
  assert.equal(await h.handle(f.message('no-at', '引用你', { mentioned: false, quote: { messageId: 'secret' } })), 'observed');
  assert.equal(f.requests.length, 0);
  assert.equal(await h.handle(f.message('other-question', '引用群A', { route: f.other, quote: { messageId: 'secret' } })), 'sent');
  assert.deepEqual(currentInput(f.requests.at(-1)).input.currentMessage.quotedMessage,
    { status: 'unavailable', reason: '无法取得引用内容' });
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).body), /GROUP_A_SECRET/);
  await h.handle(f.message('index-question', '解释引用', { quote: { referenceIndex: 'secret' } }));
  assert.equal(currentInput(f.requests.at(-1)).input.currentMessage.quotedMessage.status, 'unavailable');
  await h.handle(f.message('private-question', '解释引用', { route: privateRoute, senderId: 'private-user', mentioned: false,
    quote: { messageId: 'secret' } }));
  assert.equal(currentInput(f.requests.at(-1)).input.currentMessage.quotedMessage.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).body), /GROUP_A_SECRET/);
});

test('确认投递的assistant引用可重启解析，纯文本要求只作用QQ', async t => {
  const f = await fixture(t);
  const telegram = { ...f.other, channel: 'telegram' };
  const h = f.harness(0, [f.route, telegram]);
  await h.handle(f.message('one-outgoing', '先回复一条'));
  await h.close();
  const reopened = f.harness(0, [f.route, telegram]);
  await reopened.handle(f.message('quote-outgoing', '你的话什么意思', { quote: { messageId: 'qq-output' } }));
  assert.deepEqual(currentInput(f.requests.at(-1)).input.currentMessage.quotedMessage,
    { status: 'available', role: 'assistant', text: '群聊回复', truncated: false });
  await reopened.handle(f.message('telegram-question', '其他渠道', { route: telegram }));
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1).body), /plain_text/);
});

test('未知投递不重发，模型失败消耗预算且重启不重复收费', async t => {
  const f = await fixture(t, { status: 'uncertain' });
  const h = f.harness(2);
  assert.equal(await h.handle(f.message('uncertain', '测试未知投递')), 'uncertain');
  assert.equal(await h.handle(f.message('uncertain', '重复')), 'duplicate');
  assert.equal(f.sent.length, 1);
  assert.equal(await h.handle(f.message('failure', 'MODEL_FAILURE')), 'failed');
  assert.equal(h.info().calls, 2);
  await h.close();
  const reopened = f.harness();
  assert.equal(await reopened.handle(f.message('failure', 'MODEL_FAILURE')), 'duplicate');
  assert.equal(f.requests.length, 2);
});

test('不限次数模式超过三轮继续响应，普通消息不调用，单轮模型失败后新@可继续', async t => {
  const f = await fixture(t);
  const h = f.harness(0);
  for (let i = 0; i < 4; i++) {
    assert.equal(await h.handle(f.message(`unlimited-${i}`, `第${i}轮`)), 'sent');
  }
  assert.equal(await h.handle(f.message('background', '普通群消息', { mentioned: false })), 'observed');
  assert.equal(f.requests.length, 4);
  assert.equal(await h.handle(f.message('failure', 'MODEL_FAILURE')), 'failed');
  assert.equal(await h.handle(f.message('failure', 'MODEL_FAILURE')), 'duplicate');
  assert.equal(await h.handle(f.message('after-failure', '继续交流')), 'sent');
  assert.equal(h.info().calls, 6); assert.equal(h.info().maxCalls, 0);
  assert.equal(h.info().memory[0].enabled, false);
  assert.equal(f.requests.length, 6);
  assert.equal(f.sent.length, 5);
});

test('不限次数模式下Pi marker写入失败仍致命，后续@不能请求模型', async t => {
  const f = await fixture(t);
  const h = f.harness(0);
  // Open the real SDK first; then simulate the filesystem error at Pi's marker write.
  assert.equal(await h.handle(f.message('observed', '普通背景', { mentioned: false })), 'observed');
  const append = SessionManager.prototype.appendCustomEntry;
  try {
    SessionManager.prototype.appendCustomEntry = function(type, data) {
      if (type === 'pa_run') throw Object.assign(new Error('Pi marker write denied'), { code: 'EACCES' });
      return append.call(this, type, data);
    };
    await assert.rejects(h.handle(f.message('broken', '触发持久化故障')), PersistenceError);
  } finally { SessionManager.prototype.appendCustomEntry = append; }
  await assert.rejects(h.handle(f.message('next', '不能继续模型请求')), PersistenceError);
  assert.equal(f.requests.length, 0);
  await h.close();
});

test('路由键包含平台、账号和房间类型；QQ测试配置限制范围与费用次数', () => {
  const base = { channel: 'qq', accountId: 'account', roomId: 'room', roomType: 'group' };
  const keys = [base, { ...base, channel: 'telegram' }, { ...base, accountId: 'other' }, { ...base, roomType: 'private' }]
    .map(channelConversationKey);
  assert.equal(new Set(keys).size, 4);
  const env = { PA_QQ_APP_ID: '123', PA_QQ_APP_SECRET: 'fixture-secret', PA_QQ_ALLOWED_GROUPS: 'A,B,A' };
  assert.equal(readQQSettings(env).routes.length, 2);
  assert.equal(readQQSettings(env).maxCalls, 3);
  assert.equal(readQQSettings({ ...env, PA_QQ_MAX_MODEL_CALLS: '0' }).maxCalls, 0);
  assert.throws(() => readQQSettings({ ...env, PA_QQ_MAX_MODEL_CALLS: '-1' }));
  assert.throws(() => readQQSettings({ ...env, PA_QQ_MAX_MODEL_CALLS: '11' }));
  assert.throws(() => readQQSettings({ ...env, PA_QQ_ALLOWED_GROUPS: '' }));
  const mixed = readQQSettings({ ...env, PA_QQ_ALLOWED_USERS: 'A,USER,USER' });
  assert.deepEqual(mixed.routes.map(route => [route.roomType, route.roomId]), [['group', 'A'], ['group', 'B'], ['private', 'A'], ['private', 'USER']]);
  assert.equal(readQQSettings({ ...env, PA_QQ_ALLOWED_GROUPS: '', PA_QQ_ALLOWED_USERS: 'USER' }).routes[0].roomType, 'private');
  assert.throws(() => readQQSettings({ ...env, PA_QQ_ALLOWED_USERS: '../USER' }));
});

test('私聊无需@，未允许用户不落库；同ID的群和不同私聊不共享上下文', async t => {
  const f = await fixture(t);
  const privateA = { ...f.route, roomType: 'private' };
  const privateB = { ...privateA, roomId: 'private-B' };
  const h = f.harness(0, [f.route, privateA, privateB]);
  const options = route => ({ route, mentioned: false, senderId: route.roomId });
  assert.equal(await h.handle(f.message('unknown', 'UNKNOWN_PRIVATE', options({ ...privateA, roomId: 'unknown' }))), 'ignored');
  assert.equal(await h.handle(f.message('private-1', 'PRIVATE_A_SECRET', options(privateA))), 'sent');
  assert.equal(await h.handle(f.message('private-2', '继续上一轮', options(privateA))), 'sent');
  assert.ok(JSON.stringify(f.requests.at(-1).body).includes('PRIVATE_A_SECRET'));
  assert.equal(await h.handle(f.message('private-B-1', 'PRIVATE_B_TEXT', options(privateB))), 'sent');
  assert.ok(!JSON.stringify(f.requests.at(-1).body).includes('PRIVATE_A_SECRET'));
  assert.equal(await h.handle(f.message('group-background', 'GROUP_BACKGROUND', { mentioned: false })), 'observed');
  assert.equal(f.requests.length, 3);
  assert.equal(await h.handle(f.message('group-question', '群问题')), 'sent');
  assert.ok(!JSON.stringify(f.requests.at(-1).body).includes('PRIVATE_A_SECRET'));
  assert.equal(await h.handle(f.message('private-3', '私聊继续', options(privateA))), 'sent');
  assert.ok(!JSON.stringify(f.requests.at(-1).body).includes('GROUP_BACKGROUND'));
  assert.equal(f.sent[0].route.roomType, 'private');
  const db = new DatabaseSync(join(f.config.dataDir, 'pa.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) n FROM messages WHERE text = ?').get('UNKNOWN_PRIVATE').n, 0); }
  finally { db.close(); }
});
