import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ChannelHarness } from '../dist/channel-harness.js';
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
