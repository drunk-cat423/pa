import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ChannelHarness } from '../dist/channel-harness.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-group-context-'));
  const requests = [];
  let release, started;
  const blocked = new Promise(resolve => { release = resolve; });
  const blockingStarted = new Promise(resolve => { started = resolve; });
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    if (raw.includes('BLOCK_FIRST_QUESTION')) { started(); await blocked; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const answer = raw.includes('OLD_TRAVEL_TOPIC') ? 'OLD_TRAVEL_ANSWER' : 'PHYSICS_ANSWER';
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
  const h = new ChannelHarness(config, [route], { send: async () => ({ status: 'sent', externalMessageId: 'out' }) }, 0);
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
  return { h, requests, config, message, input, release, blockingStarted };
}

test('同一成员连发时续问仍按run配对最近问题和回答，不选两个机器人回复', async t => {
  const f = await fixture(t);
  const first = f.h.handle(f.message('first', 'BLOCK_FIRST_QUESTION'));
  await f.blockingStarted;
  const second = f.h.handle(f.message('second', 'SECOND_QUESTION_MARKER'));
  // Await a different sender's unmentioned ingest to establish the queue order.
  await f.h.handle(f.message('observed', 'QUEUE_BARRIER', { senderId: 'bob', mentioned: false }));
  f.release();
  await Promise.all([first, second]);
  await f.h.handle(f.message('follow-up', '继续刚才的问题'));
  const pair = f.input().recentDialogueWithCurrentSender;
  assert.deepEqual(pair.map(message => message.role), ['user', 'assistant']);
  assert.equal(pair[0].text, 'SECOND_QUESTION_MARKER');
  assert.equal(pair[0].senderId, 'alice');
  assert.equal(pair[1].replyToSenderId, 'alice');
  assert.ok(!JSON.stringify(pair).includes('BLOCK_FIRST_QUESTION'));
});

test('独立群问题不带无关闲聊和本人旧话题；明确续问只带本人最近一轮', async t => {
  const f = await fixture(t);
  await f.h.handle(f.message('noise', 'UNRELATED_ROOM_CHAT', { senderId: 'bob', mentioned: false }));
  await f.h.handle(f.message('travel', '讨论一下 OLD_TRAVEL_TOPIC'));
  await f.h.handle(f.message('physics', '解释一下牛顿第二定律'));
  const wire = JSON.stringify(f.requests.at(-1));
  assert.ok(!wire.includes('UNRELATED_ROOM_CHAT'));
  assert.ok(!wire.includes('OLD_TRAVEL_TOPIC'));
  assert.ok(!wire.includes('OLD_TRAVEL_ANSWER'));
  assert.deepEqual(f.input().recentDialogueWithCurrentSender, []);
  await f.h.handle(f.message('follow', '继续解释刚才的力学问题'));
  assert.equal(f.input().recentDialogueWithCurrentSender.length, 2);
  assert.equal(f.input().recentDialogueWithCurrentSender[0].senderId, 'alice');
  assert.equal(f.input().recentDialogueWithCurrentSender[1].replyToSenderId, 'alice');
  assert.ok(JSON.stringify(f.input()).includes('牛顿第二定律'));
  assert.ok(!JSON.stringify(f.input()).includes('OLD_TRAVEL_TOPIC'));
  await f.h.handle(f.message('other-follow', '继续刚才的问题', { senderId: 'bob' }));
  assert.deepEqual(f.input().recentDialogueWithCurrentSender, []);
  assert.equal(f.input().currentMessage.senderId, 'bob');
  assert.ok(!JSON.stringify(f.requests.at(-1)).includes('牛顿第二定律'));
  const db = new DatabaseSync(join(f.config.dataDir, 'pa.sqlite'), { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) n FROM messages WHERE text LIKE '%OLD_TRAVEL_TOPIC%'").get().n, 1); }
  finally { db.close(); }
});

test('明确回顾群聊才读取普通背景，引用消息只使用所选引用', async t => {
  const f = await fixture(t);
  await f.h.handle(f.message('noise', 'ROOM_REVIEW_MARKER', { senderId: 'bob', mentioned: false }));
  await f.h.handle(f.message('previous', '讨论一下 OLD_TRAVEL_TOPIC'));
  await f.h.handle(f.message('review', '刚才群里大家聊了什么？'));
  assert.ok(JSON.stringify(f.input().recentRoomMessages).includes('ROOM_REVIEW_MARKER'));
  assert.equal(f.input().recentRoomMessages[0].senderId, 'bob');
  assert.deepEqual(f.input().recentDialogueWithCurrentSender, []);
  await f.h.handle(f.message('quote', '这个应该怎么回复？', { quote: { inlineMessages: [
    { role: 'user', text: 'SELECTED_QUOTE_MARKER' },
  ] } }));
  assert.ok(JSON.stringify(f.input()).includes('SELECTED_QUOTE_MARKER'));
  assert.ok(!JSON.stringify(f.input()).includes('ROOM_REVIEW_MARKER'));
  assert.ok(!JSON.stringify(f.input()).includes('OLD_TRAVEL_TOPIC'));
  assert.deepEqual(f.input().recentRoomMessages, []);
});
