import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ChannelHarness } from '../dist/channel-harness.js';
import { ConversationStore } from '../dist/store.js';
import { isPreparationRequest, preparationDelta, totalModelCalls } from './fixtures/turn-preparation.mjs';
import { conversationContext } from './fixtures/conversation-context.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-group-context-'));
  const requests = [], planningRequests = [];
  let release, started, nextSend;
  const blocked = new Promise(resolve => { release = resolve; });
  const blockingStarted = new Promise(resolve => { started = resolve; });
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (isPreparationRequest(body)) {
      planningRequests.push(body);
      const delta = preparationDelta(`prepare-${planningRequests.length}`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [value, finish_reason] of [[delta, null], [{}, 'tool_calls']]) {
        res.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'fixture',
          choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    requests.push(body);
    const lastUser = body.messages.filter(message => message.role === 'user').at(-1);
    const userText = typeof lastUser.content === 'string' ? lastUser.content : lastUser.content.map(part => part.text ?? '').join('');
    const input = JSON.parse(userText.slice(userText.lastIndexOf('\n') + 1));
    if (input.currentMessage.text.includes('BLOCK_FIRST_QUESTION')) { started(); await blocked; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const answer = input.currentMessage.text.includes('OLD_TRAVEL_TOPIC') ? 'OLD_TRAVEL_ANSWER' : 'PHYSICS_ANSWER';
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: answer }, null], [{}, 'stop']]) {
      res.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'fixture',
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'fixture', model: 'fixture',
    apiKey: 'fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}`, contextWindow: 32768,
    maxOutputTokens: 256, timeoutMs: 5000 };
  const route = { channel: 'qq', accountId: 'bot', roomId: 'group', roomType: 'group' };
  const h = new ChannelHarness(config, [route], { send: async () => {
    const current = nextSend; nextSend = undefined;
    if (current) { current.started(); await current.gate; }
    return { status: 'sent', externalMessageId: 'out' };
  } }, 0);
  const message = (id, text, extra = {}) => ({ route, eventId: id, text, senderId: 'alice',
    mentioned: true, sentAt: new Date().toISOString(), ...extra });
  const input = () => {
    const messages = requests.at(-1).messages;
    const user = messages.filter(m => m.role === 'user').at(-1);
    const text = typeof user.content === 'string' ? user.content : user.content.map(b => b.text ?? '').join('');
    return JSON.parse(text.slice(text.lastIndexOf('\n') + 1));
  };
  t.after(async () => {
    await h.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const holdNextSend = () => {
    let finish, begin;
    const gate = new Promise(resolve => { finish = resolve; });
    const sendStarted = new Promise(resolve => { begin = resolve; });
    nextSend = { gate, started: begin };
    return { sendStarted, release: finish };
  };
  return { h, requests, planningRequests, totalCalls: () => totalModelCalls(requests, planningRequests), config, message, input, release, blockingStarted, holdNextSend };
}

test('群请求只注入画像与群记忆，旧个人记录及事件pending保留但不进入请求', async t => {
  const f=await fixture(t);
  await f.h.handle(f.message('profile-source','我喜欢茶',{mentioned:false}));
  const file=join(f.config.dataDir,'pa.sqlite');
  const db=new DatabaseSync(file);
  const row=db.prepare("SELECT m.id,m.conversation_id,m.actor_id,p.person_id FROM messages m JOIN actor_person_bindings p ON p.actor_id=m.actor_id WHERE m.external_event_id='profile-source'").get();
  const store=new ConversationStore(file);
  let personal;
  try {
    store.rememberMemory(row.conversation_id,{content:'GROUP_SHARED_RECORD',sourceMessageId:row.id});
    personal=store.rememberMemory(row.conversation_id,{content:'LEGACY_PERSONAL_RECORD_ONLY',sourceMessageId:row.id}).memory.id;
    db.prepare("UPDATE memories SET scope_type='actor',subject_actor_id=?,person_id=? WHERE id=?").run(row.actor_id,row.person_id,personal);
    db.prepare("INSERT INTO person_profile_pending(id,person_id,content,source_message_id,source_type,created_at,purpose) VALUES ('old-event',?, 'LEGACY_PENDING_EVENT_ONLY',?,'self',?,'memory')")
      .run(row.person_id,row.id,new Date().toISOString());
    store.autoMemory.addProfilePending(row.person_id,row.id,'喜欢茶','self');
  } finally {store.close();db.close();}
  assert.equal(await f.h.handle(f.message('profile-question','你好')), 'sent');
  for(const request of [...f.planningRequests,...f.requests]) {
    const text=JSON.stringify(request);
    assert.match(text,/喜欢茶/);
    assert.match(text,/GROUP_SHARED_RECORD/);
    assert.doesNotMatch(text,/LEGACY_PERSONAL_RECORD_ONLY|LEGACY_PENDING_EVENT_ONLY|pendingMemories/);
  }
  const retained=new DatabaseSync(file,{readOnly:true});
  try {
    assert.equal(retained.prepare('SELECT content FROM memories WHERE id=?').get(personal).content,'LEGACY_PERSONAL_RECORD_ONLY');
    assert.equal(retained.prepare("SELECT content FROM person_profile_pending WHERE id='old-event'").get().content,'LEGACY_PENDING_EVENT_ONLY');
  } finally {retained.close();}
});

test('当前请求入队后的群消息不会进入该轮背景', async t => {
  const f = await fixture(t);
  const first = f.h.handle(f.message('first', 'BLOCK_FIRST_QUESTION'));
  await f.blockingStarted;
  const later = f.h.handle(f.message('later', 'ARRIVED_AFTER_CURRENT_QUESTION', { senderId: 'bob', mentioned: false }));
  f.release();
  await Promise.all([first, later]);
  assert.deepEqual(conversationContext(f.requests[0]).messages, []);
  assert.ok(!JSON.stringify(f.requests[0]).includes('ARRIVED_AFTER_CURRENT_QUESTION'));
  await f.h.handle(f.message('follow-later', 'FOLLOW_UP_AFTER_LATER_MESSAGE'));
  assert.deepEqual(conversationContext(f.requests.at(-1)).messages.filter(message => message.role === 'user').map(message => message.text),
    ['BLOCK_FIRST_QUESTION', 'ARRIVED_AFTER_CURRENT_QUESTION']);
  assert.equal(f.input().currentMessage.text, 'FOLLOW_UP_AFTER_LATER_MESSAGE');
  assert.equal(f.totalCalls(), 4);
});

test('较早回复延迟确认送达时，不插入已排队问题的历史前缀', async t => {
  const f = await fixture(t);
  const first = f.h.handle(f.message('first-late', 'BLOCK_FIRST_QUESTION'));
  await f.blockingStarted;
  const delivery = f.holdNextSend();
  const queued = f.h.handle(f.message('queued-later', 'QUEUED_CURRENT_QUESTION'));
  f.release();
  await delivery.sendStarted;
  delivery.release();
  await Promise.all([first, queued]);
  const queuedRequest = f.requests.find(request => JSON.stringify(request).includes('QUEUED_CURRENT_QUESTION'));
  assert.ok(queuedRequest);
  const context = conversationContext(queuedRequest);
  assert.ok(!context.messages.some(message => message.text === 'PHYSICS_ANSWER'));
  assert.ok(!context.messages.some(message => message.text === 'QUEUED_CURRENT_QUESTION'));
  assert.equal(f.input().currentMessage.text, 'QUEUED_CURRENT_QUESTION');
});

test('群完整上下文跨越60条并保留身份；当前问题只在末尾，稳定历史逐字延续', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 61; index++) {
    await f.h.handle(f.message(`history-${index}`, `HISTORY_${index}`, {
      senderId: index % 2 ? 'bob' : 'carol', senderName: index % 2 ? 'Bob' : 'Carol', mentioned: false,
      sentAt: '2020-01-01T00:00:00.000Z',
    }));
  }
  await f.h.handle(f.message('current', 'CURRENT_QUESTION'));
  const first = conversationContext(f.requests.at(-1));
  assert.equal(first.messages.length, 61);
  assert.deepEqual(first.messages.map(message => message.text), Array.from({ length: 61 }, (_, index) => `HISTORY_${index}`));
  assert.deepEqual(first.messages.map(message => message.senderId), Array.from({ length: 61 }, (_, index) => index % 2 ? 'bob' : 'carol'));
  assert.equal(first.messages[0].senderName, 'Carol');
  assert.ok(first.messages.every(message => message.role === 'user'));
  assert.ok(!JSON.stringify(first).includes('CURRENT_QUESTION'));
  assert.equal(f.input().currentMessage.text, 'CURRENT_QUESTION');
  assert.ok(!Object.hasOwn(f.input(), 'recentGroupMessages'));
  const time = f.requests.at(-1).messages.findIndex(message => /服务器时间|当前时间/.test(JSON.stringify(message)));
  const contextIndex = f.requests.at(-1).messages.findIndex(message => JSON.stringify(message).includes('[最近一次会话压缩摘要]'));
  const memoryIndex = f.requests.at(-1).messages.findIndex(message => JSON.stringify(message).includes('GROUP_SHARED_RECORD'));
  if (time >= 0) assert.ok(contextIndex < time);
  if (memoryIndex >= 0) assert.ok(contextIndex < memoryIndex);
  const previousHistory = first.historyRaw;
  await f.h.handle(f.message('follow-up', 'FOLLOW_UP_QUESTION'));
  const second = conversationContext(f.requests.at(-1));
  assert.ok(second.historyRaw.startsWith(previousHistory));
  assert.equal(f.input().currentMessage.text, 'FOLLOW_UP_QUESTION');
  assert.ok(!second.messages.some(message => message.text === 'FOLLOW_UP_QUESTION'));
  const systemPrompt = f.requests.at(-1).messages.filter(message => message.role === 'system')
    .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
  assert.doesNotMatch(systemPrompt, /recentGroupMessages|身份卡、服务器时间/);
  assert.equal(f.totalCalls(), 4);
});

test('背景与明确引用分开传递，普通回顾不把背景当作当前请求', async t => {
  const f = await fixture(t);
  await f.h.handle(f.message('noise', 'ROOM_REVIEW_MARKER', { senderId: 'bob', mentioned: false }));
  await f.h.handle(f.message('previous', '讨论一下 OLD_TRAVEL_TOPIC'));
  await f.h.handle(f.message('review', '刚才群里大家聊了什么？'));
  assert.deepEqual(conversationContext(f.requests.at(-1)).messages.map(message => message.text),
    ['ROOM_REVIEW_MARKER', '讨论一下 OLD_TRAVEL_TOPIC', 'OLD_TRAVEL_ANSWER']);
  assert.equal(f.input().currentMessage.text, '刚才群里大家聊了什么？');
  await f.h.handle(f.message('quote', '这个应该怎么回复？', { quote: { inlineMessages: [
    { role: 'user', text: 'SELECTED_QUOTE_MARKER' },
  ] } }));
  assert.equal(f.input().currentMessage.text, '这个应该怎么回复？');
  assert.ok(JSON.stringify(f.input().currentMessage.quotedMessage).includes('SELECTED_QUOTE_MARKER'));
  assert.ok(!JSON.stringify(conversationContext(f.requests.at(-1)).messages).includes('SELECTED_QUOTE_MARKER'));
  assert.deepEqual(conversationContext(f.requests.at(-1)).messages.map(message => message.text), [
    'ROOM_REVIEW_MARKER', '讨论一下 OLD_TRAVEL_TOPIC', 'OLD_TRAVEL_ANSWER',
    '刚才群里大家聊了什么？', 'PHYSICS_ANSWER',
  ]);
  assert.equal(f.totalCalls(), 6);
});

test('群内记忆控制与结果指令及其回复不进入后续会话前缀', async t => {
  const f = await fixture(t);
  assert.equal(await f.h.handle(f.message('control-memory', '/memory remember room CONTROL_ONLY_MARKER')), 'sent');
  assert.equal(await f.h.handle(f.message('control-result', '/result')), 'sent');
  assert.equal(await f.h.handle(f.message('after-control', '普通问题')), 'sent');
  const context = conversationContext(f.requests.at(-1));
  assert.ok(!JSON.stringify(context.messages).includes('/memory'));
  assert.ok(!JSON.stringify(context.messages).includes('/result'));
  assert.ok(!JSON.stringify(context.messages).includes('CONTROL_ONLY_MARKER'));
  assert.equal(f.input().currentMessage.text, '普通问题');
});
