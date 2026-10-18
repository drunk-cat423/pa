import assert from 'node:assert/strict';
import test from 'node:test';
import { QQChannel, normalizeQQMessage } from '../dist/qq-channel.js';

class FakeSocket {
  readyState = 1;
  listeners = new Map();
  sent = [];
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  send(value) { this.sent.push(JSON.parse(value)); }
  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  message(payload) { this.emit('message', { data: JSON.stringify(payload) }); }
  close() {
    this.readyState = 3;
    this.emit('close', { code: 1000 });
  }
}

class FakeTimers {
  next = 0;
  tasks = new Map();
  setTimeout = (fn, delay) => this.add(fn, delay, false);
  clearTimeout = id => this.tasks.delete(id);
  setInterval = (fn, delay) => this.add(fn, delay, true);
  clearInterval = id => this.tasks.delete(id);
  add(fn, delay, interval) {
    const id = ++this.next;
    this.tasks.set(id, { fn, delay, interval });
    return id;
  }
  run(id) {
    const task = this.tasks.get(id);
    if (!task) return;
    if (!task.interval) this.tasks.delete(id);
    task.fn();
  }
  find(delay) { return [...this.tasks].find(([, task]) => task.delay === delay)?.[0]; }
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (status, body) => ({ status, json: async () => body });
const tokenBody = { access_token: 'test-token', expires_in: 3600 };

test('native Markdown instruction buttons preserve text and optional quote ref_idx for active and passive sends',async()=>{
  const ctx=setup({postResponse:response(200,{id:'native-id',ext_info:{ref_idx:'opaque-index'}})});
  const starting=ctx.channel.start();
  await tick();
  ctx.socket.message({op:10,d:{heartbeat_interval:10000}});
  await tick();
  ctx.socket.message({op:0,t:'READY',d:{session_id:'s',user:{id:'bot'}}});
  await starting;
  for(const deliveryMode of ['passive','active']) {
    assert.deepEqual(await ctx.channel.send({route:{channel:'qq',accountId:'123',roomId:'group',roomType:'group'},
      deliveryMode,replyToMessageId:'input',text:'**结论**\n\n```ts\ncode\n```',markdown:true,
      buttons:[{label:'下一页',command:'/page 123e4567-e89b-12d3-a456-426614174000 1'}]}),
      {status:'sent',externalMessageId:'native-id',referenceIndex:'opaque-index'});
  }
  const bodies=ctx.calls.filter(call=>call.url.endsWith('/messages')).map(call=>JSON.parse(call.init.body));
  for(const body of bodies) {
    assert.equal(body.msg_type,2);
    assert.match(body.markdown.content,/\*\*结论\*\*/);
    const button=body.keyboard.content.rows[0].buttons[0];
    assert.equal(button.action.type,2);
    assert.equal(button.action.enter,true);
    assert.equal(button.action.reply,false);
    assert.deepEqual(button.action.permission,{type:2});
    assert.match(button.action.data,/^\/page /);
  }
  assert.equal(bodies[0].msg_id,'input');
  assert.equal(bodies[1].msg_id,undefined);
  ctx.channel.close();
});

test('harness parts use consecutive msg_seq and preformatted code content is not formatted twice', async () => {
  const ctx = setup();
  const starting = ctx.channel.start();
  await tick();
  ctx.socket.message({ op: 10, d: { heartbeat_interval: 10_000 } });
  await tick();
  ctx.socket.message({ op: 0, t: 'READY', d: { session_id: 's', user: { id: 'bot' } } });
  await starting;
  const route = { channel: 'qq', accountId: '123', roomId: 'group', roomType: 'group' };
  for (let partIndex = 0; partIndex < 3; partIndex++) {
    assert.equal((await ctx.channel.send({ route, replyToMessageId: 'input', text: '# code **literal**', plainText: true, partIndex })).status, 'sent');
  }
  const posts = ctx.calls.filter(call => call.url.endsWith('/messages')).map(call => JSON.parse(call.init.body));
  assert.deepEqual(posts.map(body => body.msg_seq), [1, 2, 3]);
  assert.ok(posts.every(body => body.content === '# code **literal**' && body.msg_id === 'input'));
  assert.equal((await ctx.channel.send({ route, replyToMessageId: 'input', text: 'invalid', partIndex: 5 })).status, 'rejected');
  ctx.channel.close();
});

test('active delivery uses identifier-free payloads for group and private rooms', async () => {
  const ctx = setup();
  const starting = ctx.channel.start();
  await tick();
  ctx.socket.message({ op: 10, d: { heartbeat_interval: 10_000 } });
  await tick();
  ctx.socket.message({ op: 0, t: 'READY', d: { session_id: 's', user: { id: 'bot' } } });
  await starting;

  const groupRoute = { channel: 'qq', accountId: '123', roomId: 'group', roomType: 'group' };
  const privateRoute = { channel: 'qq', accountId: '123', roomId: 'user', roomType: 'private' };
  assert.deepEqual(await ctx.channel.send({ route: groupRoute, deliveryMode: 'active', text: '**group**', partIndex: 8 }),
    { status: 'sent', externalMessageId: 'sent-id' });
  assert.deepEqual(await ctx.channel.send({ route: privateRoute, deliveryMode: 'active', text: 'private', partIndex: 12 }),
    { status: 'sent', externalMessageId: 'sent-id' });

  const posts = ctx.calls.filter(call => call.init.method === 'POST' && call.url.includes('/v2/'));
  assert.deepEqual(posts.map(post => post.url), [
    'https://api.bot.qq.com/v2/groups/group/messages',
    'https://api.bot.qq.com/v2/users/user/messages',
  ]);
  assert.deepEqual(posts.map(post => JSON.parse(post.init.body)), [
    { msg_type: 0, content: 'group' },
    { msg_type: 0, content: 'private' },
  ]);
  ctx.channel.close();
});

test('invalid delivery mode and passive sends without a valid reply ID reject before requesting', async () => {
  const ctx = setup();
  const starting = ctx.channel.start();
  await tick();
  ctx.socket.message({ op: 10, d: { heartbeat_interval: 10_000 } });
  await tick();
  ctx.socket.message({ op: 0, t: 'READY', d: { session_id: 's', user: { id: 'bot' } } });
  await starting;
  const route = { channel: 'qq', accountId: '123', roomId: 'group', roomType: 'group' };
  const before = ctx.calls.length;
  assert.deepEqual(await ctx.channel.send({ route, deliveryMode: 'unsupported', text: 'invalid' }), { status: 'rejected' });
  assert.deepEqual(await ctx.channel.send({ route, text: 'missing reply ID' }), { status: 'rejected' });
  assert.deepEqual(await ctx.channel.send({ route, replyToMessageId: 'bad\nID', text: 'invalid reply ID' }), { status: 'rejected' });
  assert.equal(ctx.calls.length, before);
  ctx.channel.close();
});

test('active definite rejection and timeout are returned once without retry', async () => {
  for (const [options, expected] of [
    [{ postResponse: response(403, {}) }, 'rejected'],
    [{ postError: new Error('timeout') }, 'uncertain'],
  ]) {
    const ctx = setup(options);
    const starting = ctx.channel.start();
    await tick();
    ctx.socket.message({ op: 10, d: { heartbeat_interval: 10_000 } });
    await tick();
    ctx.socket.message({ op: 0, t: 'READY', d: { session_id: 's', user: { id: 'bot' } } });
    await starting;
    assert.deepEqual(await ctx.channel.send({
      route: { channel: 'qq', accountId: '123', roomId: 'group', roomType: 'group' },
      deliveryMode: 'active', text: 'send once',
    }), { status: expected });
    assert.equal(ctx.calls.filter(call => call.url.includes('/v2/groups/')).length, 1);
    ctx.channel.close();
  }
});

function setup({ postResponse = response(200, { id: 'sent-id' }), postError, timers = new FakeTimers(), sockets = [new FakeSocket()] } = {}) {
  let socketCount = 0;
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/app/getAppAccessToken')) return response(200, tokenBody);
    if (url.endsWith('/gateway/bot')) return response(200, { url: 'wss://api.bot.qq.com/gateway' });
    if (postError) throw postError;
    return postResponse;
  };
  const messages = [];
  const statuses = [];
  const channel = new QQChannel({ appId: '123', clientSecret: 'private' }, {
    onMessage: message => messages.push(message),
    onStatus: status => statuses.push(status),
  }, {
    fetch,
    webSocketFactory: () => sockets[socketCount++],
    now: () => Date.parse('2026-10-13T00:00:00.000Z'),
    ...timers,
  });
  return { channel, socket: sockets[0], sockets, calls, messages, statuses, timers };
}

test('normalizeQQMessage uses safe identity metadata, preserves other mentions and ignores bot echoes', () => {
  const base = { op: 0, t: 'GROUP_MESSAGE_CREATE', d: {
    id: 'msg-1', group_openid: 'group-1', content: '<@bot> hello <@someone>',
    timestamp: '2026-10-12T10:00:00.000Z', mentions: [{ id: 'bot', bot: true }, { id: 'someone', bot: false }],
    author: { member_openid: 'member-1', id: 'internal-id', username: 'Alice', bot: false },
  } };
  assert.deepEqual(normalizeQQMessage(base, 'account-1', 'bot'), {
    route: { channel: 'qq', accountId: 'account-1', roomId: 'group-1', roomType: 'group' },
    eventId: 'msg-1', senderId: 'member-1', senderName: 'Alice', text: 'hello <@someone>',
    sentAt: '2026-10-12T10:00:00.000Z', mentioned: true, mentionedSenderIds: ['someone'],
  });
  assert.equal(normalizeQQMessage({ ...base, d: { ...base.d, author: { id: 'bot', bot: true } } }, 'a', 'bot'), undefined);
  assert.equal(normalizeQQMessage({ ...base, t: 'C2C_MESSAGE_CREATE' }, 'a', 'bot'), undefined);
  const noMentionMetadata = { ...base, d: { ...base.d, mentions: undefined, content: '<@!bot> only bot prefix' } };
  assert.equal(normalizeQQMessage(noMentionMetadata, 'a', 'bot').mentioned, true);
  assert.equal(normalizeQQMessage({ ...base, d: { ...base.d, mentions: [], content: '<@bot> text' } }, 'a', 'bot').mentioned, true);
  assert.equal(normalizeQQMessage({ ...base, d: { ...base.d, content: 'text <@bot> tail', mentions: [] } }, 'a', 'bot').mentioned, true);
  assert.equal(normalizeQQMessage({ ...base, d: { ...base.d, content: 'text', mentions: [{ id: 'other', bot: true }] } }, 'a', 'bot').mentioned, false);
  const groupSelf = { ...base, d: { ...base.d, content: '<@group-bot-openid> hello <@other>',
    mentions: [{ id: 'group-bot-openid', member_openid: 'group-member-openid', bot: true, is_you: true }] } };
  assert.equal(normalizeQQMessage(groupSelf, 'a', 'ready-numeric-id').mentioned, true);
  assert.equal(normalizeQQMessage(groupSelf, 'a', 'ready-numeric-id').text, 'hello <@other>');
  assert.equal(normalizeQQMessage({ ...groupSelf, d: { ...groupSelf.d,
    mentions: [{ id: 'group-bot-openid', bot: true, is_you: false }] } }, 'a', 'ready-numeric-id').mentioned, false);
  assert.equal(normalizeQQMessage({ ...base, d: { ...base.d, content: '所有人好',
    mentions: [{ scope: 'all', is_you: true }] } }, 'a', 'bot').mentioned, false);
  const targets = normalizeQQMessage({ ...base, d: { ...base.d, content: '文字 @小明', mentions: [
    { id: 'internal-1', member_openid: 'member-openid-1' },
    { id: 'internal-2', member_openid: 'member-openid-1' },
    { id: 'group-bot', member_openid: 'bot-member', is_you: true },
    { scope: 'all', id: 'everyone' },
    { id: '', member_openid: '' },
    { id: 'malformed\nidentity' },
  ] } }, 'a', 'bot');
  assert.deepEqual(targets.mentionedSenderIds, ['member-openid-1']);
  const literal = normalizeQQMessage({ ...base, d: { ...base.d, content: '文字 @小明', mentions: [] } }, 'a', 'bot');
  assert.equal(literal.mentioned, false);
  assert.equal(literal.mentionedSenderIds, undefined);
  const allOnly = normalizeQQMessage({ ...base, d: { ...base.d, content: '全体好', mentions: [{ scope: 'all', id: 'all' }] } }, 'a', 'bot');
  assert.equal(allOnly.mentioned, false);
  assert.equal(allOnly.mentionedSenderIds, undefined);
  assert.equal(normalizeQQMessage({ ...base, d: { ...base.d, timestamp: undefined, created_at: undefined } }, 'a', 'bot'), undefined);
  assert.equal(normalizeQQMessage({ ...base, d: { ...base.d, id: 'x'.repeat(513) } }, 'a', 'bot'), undefined);
  assert.equal(normalizeQQMessage({ ...base, d: { ...base.d, group_openid: 'x'.repeat(513) } }, 'a', 'bot'), undefined);
  assert.equal(normalizeQQMessage({ ...base, d: { ...base.d, author: { member_openid: 'x'.repeat(513) } } }, 'a', 'bot'), undefined);
});

test('start resolves only after READY, then delivery makes one exact reply request', async () => {
  const ctx = setup();
  const starting = ctx.channel.start();
  await tick();
  ctx.socket.message({ op: 10, d: { heartbeat_interval: 10_000 } });
  await tick();
  assert.deepEqual(ctx.socket.sent[0], {
    op: 2,
    d: { token: 'QQBot test-token', intents: 1 << 25, shard: [0, 1], properties: { $os: process.platform, $browser: 'pa', $device: 'pa' } },
  });
  ctx.socket.message({ op: 0, t: 'READY', d: { session_id: 'session-1', user: { id: 'bot-id' } } });
  await starting;
  ctx.socket.message({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {
    id: 'incoming', group_openid: 'group', content: '<@bot-id> question',
    timestamp: '2026-10-13T00:00:00.000Z',
    author: { member_openid: 'member', bot: false },
  } });
  await tick();
  assert.equal(ctx.messages.length, 1);
  assert.equal(ctx.messages[0].text, 'question');
  assert.equal(ctx.messages[0].mentioned, true);
  const wrongAccount = await ctx.channel.send({
    route: { channel: 'qq', accountId: 'other-app', roomId: 'group', roomType: 'group' },
    replyToMessageId: 'incoming', text: 'must not send',
  });
  assert.deepEqual(wrongAccount, { status: 'rejected' });
  assert.equal(ctx.calls.filter(call => call.url.includes('/v2/groups/')).length, 0);
  const result = await ctx.channel.send({
    route: { channel: 'qq', accountId: '123', roomId: 'group', roomType: 'group' },
    replyToMessageId: 'incoming', text: 'reply',
  });
  assert.deepEqual(result, { status: 'sent', externalMessageId: 'sent-id' });
  const posts = ctx.calls.filter(call => call.init.method === 'POST' && call.url.includes('/v2/groups/'));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://api.bot.qq.com/v2/groups/group/messages');
  assert.equal(posts[0].init.headers.Authorization, 'QQBot test-token');
  assert.deepEqual(JSON.parse(posts[0].init.body), { msg_type: 0, content: 'reply', msg_id: 'incoming', msg_seq: 1 });
  ctx.channel.close();
});

test('QQ官方引用树仅规范化引用正文与公开作者，不保存scene令牌或把索引当消息ID', () => {
  const event = { op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: {
    id: 'question', group_openid: 'group', content: '解释这句话', timestamp: '2026-10-13T00:00:00Z',
    author: { member_openid: 'asker' }, message_type: 103,
    message_scene: { ext: ['msg_idx=current-index', 'ref_msg_idx=quote-index', 'auth_token=SECRET_TOKEN'] },
    msg_elements: [{ content: '被引用的原话', author: { member_openid: 'original-author', username: '原作者' },
      attachments: [{ url: 'SECRET_ATTACHMENT_URL' }], ark_data: { fields: { token: 'SECRET_CARD' } } }],
  } };
  const message = normalizeQQMessage(event, 'account', 'bot');
  assert.equal(message.text, '解释这句话');
  assert.deepEqual(message.quote, { referenceIndex: 'quote-index', inlineMessages: [
    { text: '被引用的原话', senderId: 'original-author', senderName: '原作者' },
  ] });
  assert.doesNotMatch(JSON.stringify(message), /SECRET|current-index/);
  const referenceOnly = normalizeQQMessage({ ...event, d: { ...event.d, msg_elements: undefined } }, 'account', 'bot');
  assert.deepEqual(referenceOnly.quote, { referenceIndex: 'quote-index' });
  const legacy = normalizeQQMessage({ ...event, d: { ...event.d, message_type: 0, message_scene: undefined,
    msg_elements: undefined, message_reference: { message_id: 'actual-message-id' } } }, 'account', 'bot');
  assert.deepEqual(legacy.quote, { messageId: 'actual-message-id' });
  const unquoted = normalizeQQMessage({ ...event, d: { ...event.d, message_type: 0, message_scene: undefined,
    msg_elements: [{ content: '普通消息元素' }] } }, 'account', 'bot');
  assert.equal(unquoted.quote, undefined);
  const nested = normalizeQQMessage({ ...event, d: { ...event.d, message_type: 101, message_scene: undefined,
    msg_elements: [{ content: '普通消息元素', msg_elements: [{ message_type: 103, content: '嵌套引用' }] }] } }, 'account', 'bot');
  assert.deepEqual(nested.quote, { inlineMessages: [{ text: '嵌套引用' }] });
});

test('引用提取限制深度、节点数和UTF8正文预算；只有引用不凭空创建当前问题', () => {
  const base = { op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'question', group_openid: 'group', content: '问题',
    timestamp: '2026-10-13T00:00:00Z', author: { member_openid: 'asker' }, message_type: 103 } };
  const huge = normalizeQQMessage({ ...base, d: { ...base.d,
    msg_elements: [{ content: '中'.repeat(10000) }, { content: '不会超限进入' }] } }, 'account', 'bot');
  assert.equal(huge.quote.truncated, true);
  assert.ok(Buffer.byteLength(huge.quote.inlineMessages.map(item => item.text).join('')) <= 8000);
  let deep = { content: 'TOO_DEEP' };
  for (let depth = 0; depth < 5; depth++) deep = { msg_elements: [deep] };
  const bounded = normalizeQQMessage({ ...base, d: { ...base.d, msg_elements: [deep] } }, 'account', 'bot');
  assert.equal(bounded.quote.truncated, true);
  assert.doesNotMatch(JSON.stringify(bounded), /TOO_DEEP/);
  const many = normalizeQQMessage({ ...base, d: { ...base.d,
    msg_elements: Array.from({ length: 50 }, (_, index) => ({ content: `quote-${index}` })) } }, 'account', 'bot');
  assert.equal(many.quote.inlineMessages.length, 8);
  assert.equal(many.quote.truncated, true);
  const blank = normalizeQQMessage({ ...base, d: { ...base.d, content: ' ', msg_elements: [{ content: '引用原话' }] } }, 'account', 'bot');
  assert.equal(blank.text, ' ');
});

test('QQ发送只转换传输副本，常见Markdown变纯文本，代码和符号原样保留', async () => {
  const ctx = setup();
  const starting = ctx.channel.start();
  await tick();
  ctx.socket.message({ op: 10, d: { heartbeat_interval: 10_000 } });
  await tick();
  ctx.socket.message({ op: 0, t: 'READY', d: { session_id: 's', user: { id: 'bot' } } });
  await starting;
  const message = { route: { channel: 'qq', accountId: '123', roomId: 'g', roomType: 'group' }, replyToMessageId: 'in',
    text: '# 标题\n**重点** 和 *说明*\n```js\nconst a_b = 2 * 3; // #原文\n```\n[官网](https://example.com/a_b?q=*x*)' };
  await ctx.channel.send(message);
  const post = ctx.calls.find(call => call.url.includes('/v2/groups/'));
  assert.equal(JSON.parse(post.init.body).content,
    '标题\n重点 和 说明\nconst a_b = 2 * 3; // #原文\n官网 (https://example.com/a_b?q=*x*)');
  assert.ok(message.text.startsWith('# 标题'));
  const sentCount = ctx.calls.filter(call => call.url.includes('/v2/groups/')).length;
  assert.deepEqual(await ctx.channel.send({ ...message, text: '---\n***' }), { status: 'rejected' });
  assert.equal(ctx.calls.filter(call => call.url.includes('/v2/groups/')).length, sentCount);
  ctx.channel.close();
});

test('C2C uses user_openid exclusively, forwards without @ and replies through the private endpoint', async () => {
  const event = { op: 0, t: 'C2C_MESSAGE_CREATE', d: {
    id: 'private-in', content: '<@bot-id> literal text', timestamp: new Date().toISOString(),
    author: { user_openid: 'user-1', member_openid: 'group-member', id: 'fallback-id' },
  } };
  const normalized = normalizeQQMessage(event, '123', 'bot-id');
  assert.equal(normalized.route.roomType, 'private');
  assert.equal(normalized.route.roomId, 'user-1');
  assert.equal(normalized.senderId, 'user-1');
  assert.equal(normalized.mentioned, false);
  assert.equal(normalized.text, event.d.content);
  for (const user_openid of [undefined, '', 'x'.repeat(513)]) {
    assert.equal(normalizeQQMessage({ ...event, d: { ...event.d, author: { ...event.d.author, user_openid } } }, '123', 'bot-id'), undefined);
  }
  const ctx = setup();
  const starting = ctx.channel.start();
  await tick();
  ctx.socket.message({ op: 10, d: { heartbeat_interval: 10_000 } });
  await tick();
  ctx.socket.message({ op: 0, t: 'READY', d: { session_id: 's', user: { id: 'bot-id' } } });
  await starting;
  ctx.socket.message(event);
  await tick();
  assert.deepEqual(ctx.messages, [normalized]);
  assert.deepEqual(await ctx.channel.send({ route: normalized.route, replyToMessageId: normalized.eventId, text: 'private reply' }),
    { status: 'sent', externalMessageId: 'sent-id' });
  const posts = ctx.calls.filter(call => call.url.includes('/v2/'));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://api.bot.qq.com/v2/users/user-1/messages');
  assert.deepEqual(JSON.parse(posts[0].init.body), { msg_type: 0, content: 'private reply', msg_id: 'private-in', msg_seq: 1 });
  ctx.channel.close();
});

test('send classifies explicit business rejection, transient errors and missing IDs without retry', async () => {
  for (const [postResponse, expected] of [
    [response(200, { err_code: 11253, message: 'private text' }), 'rejected'],
    [response(403, {}), 'rejected'],
    [response(500, {}), 'uncertain'],
    [response(200, { code: 0 }), 'uncertain'],
    [response(200, { code: 'not-a-code' }), 'uncertain'],
    [response(200, { code: true }), 'uncertain'],
    [null, 'uncertain'],
  ]) {
    const ctx = setup({ ...(postResponse ? { postResponse } : { postError: new Error('network') }) });
    const starting = ctx.channel.start();
    await tick();
    ctx.socket.message({ op: 10, d: { heartbeat_interval: 10_000 } });
    await tick();
    ctx.socket.message({ op: 0, t: 'READY', d: { session_id: 'session', user: { id: 'bot' } } });
    await starting;
    const result = await ctx.channel.send({ route: { channel: 'qq', accountId: '123', roomId: 'g', roomType: 'group' }, replyToMessageId: 'm', text: 'once' });
    assert.deepEqual(result, { status: expected });
    assert.equal(ctx.calls.filter(call => call.url.includes('/v2/groups/')).length, 1);
    ctx.channel.close();
  }
});

test('close cancels pending reconnect and does not create another socket', async () => {
  const ctx = setup();
  const starting = ctx.channel.start();
  await tick();
  ctx.socket.message({ op: 10, d: { heartbeat_interval: 10_000 } });
  await tick();
  ctx.socket.message({ op: 0, t: 'READY', d: { session_id: 'session', user: { id: 'bot' } } });
  await starting;
  ctx.socket.message({ op: 7 });
  await tick();
  const reconnectId = ctx.timers.find(500);
  assert.ok(reconnectId);
  ctx.channel.close();
  ctx.timers.run(reconnectId);
  await tick();
  assert.equal(ctx.calls.filter(call => call.url.endsWith('/gateway/bot')).length, 1);
  assert.ok(ctx.statuses.includes('QQ Gateway READY'));
});

test('OP 7 reconnect resumes the previous session with OP 6; close before start rejects', async () => {
  const ctx = setup({ sockets: [new FakeSocket(), new FakeSocket()] });
  const starting = ctx.channel.start();
  await tick();
  ctx.sockets[0].message({ op: 10, d: { heartbeat_interval: 10_000 } });
  await tick();
  ctx.sockets[0].message({ op: 0, t: 'READY', s: 8, d: { session_id: 'session', user: { id: 'bot' } } });
  await starting;
  ctx.sockets[0].message({ op: 7 });
  await tick();
  const reconnectId = ctx.timers.find(500);
  assert.ok(reconnectId);
  ctx.timers.run(reconnectId);
  await tick();
  ctx.sockets[1].message({ op: 10, d: { heartbeat_interval: 10_000 } });
  await tick();
  assert.deepEqual(ctx.sockets[1].sent[0], {
    op: 6, d: { token: 'QQBot test-token', session_id: 'session', seq: 8 },
  });
  // Delayed notifications from the old connection must not close the replacement.
  ctx.sockets[0].emit('close');
  ctx.sockets[0].emit('error');
  ctx.sockets[0].emit('message', { data: 'malformed old payload' });
  await tick();
  assert.equal(ctx.sockets[1].readyState, 1);
  assert.equal(ctx.timers.find(1_000), undefined);
  ctx.channel.close();

  const closed = setup();
  closed.channel.close();
  await assert.rejects(closed.channel.start(), /closed/);
});

test('each reconnect has a handshake deadline and exhausts bounded attempts', async () => {
  const sockets = Array.from({ length: 6 }, () => new FakeSocket());
  const ctx = setup({ sockets });
  const starting = ctx.channel.start();
  await tick();
  sockets[0].message({ op: 10, d: { heartbeat_interval: 10_000 } });
  await tick();
  sockets[0].message({ op: 0, t: 'READY', s: 1, d: { session_id: 'session', user: { id: 'bot' } } });
  await starting;
  sockets[0].message({ op: 7 });
  await tick();
  for (const [index, delay] of [500, 1_000, 2_000, 4_000, 8_000].entries()) {
    const reconnect = ctx.timers.find(delay);
    assert.ok(reconnect);
    ctx.timers.run(reconnect);
    await tick();
    // Some connections never HELLO; others HELLO but never RESUMED.
    if (index % 2) {
      sockets[index + 1].message({ op: 10, d: { heartbeat_interval: 10_000 } });
      await tick();
    }
    const handshake = ctx.timers.find(30_000);
    assert.ok(handshake);
    ctx.timers.run(handshake);
    await tick();
  }
  assert.ok(ctx.statuses.includes('connection_failed'));
  assert.equal(ctx.timers.tasks.size, 0);
  assert.equal(ctx.calls.filter(call => call.url.endsWith('/gateway/bot')).length, 6);
});

test('close while token refresh is pending prevents a later message POST', async () => {
  let clock = Date.parse('2026-10-13T00:00:00.000Z');
  let tokenCalls = 0;
  let releaseToken;
  const delayedToken = new Promise(resolve => { releaseToken = resolve; });
  const socket = new FakeSocket();
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/app/getAppAccessToken')) {
      tokenCalls += 1;
      return tokenCalls === 1 ? response(200, tokenBody) : delayedToken;
    }
    if (url.endsWith('/gateway/bot')) return response(200, { url: 'wss://api.bot.qq.com/gateway' });
    return response(200, { id: 'unexpected' });
  };
  const channel = new QQChannel({ appId: '123', clientSecret: 'private' }, { onMessage() {} }, {
    fetch, webSocketFactory: () => socket, now: () => clock,
  });
  const starting = channel.start();
  await tick();
  socket.message({ op: 10, d: { heartbeat_interval: 10_000 } });
  await tick();
  socket.message({ op: 0, t: 'READY', d: { session_id: 'session', user: { id: 'bot' } } });
  await starting;
  clock += 3_600_000;
  const sending = channel.send({
    route: { channel: 'qq', accountId: '123', roomId: 'group', roomType: 'group' },
    replyToMessageId: 'incoming', text: 'reply',
  });
  await tick();
  channel.close();
  releaseToken(response(200, tokenBody));
  assert.deepEqual(await sending, { status: 'rejected' });
  assert.equal(calls.filter(call => call.url.includes('/v2/groups/')).length, 0);
});
