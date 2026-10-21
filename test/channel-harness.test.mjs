import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ChannelHarness,  } from '../dist/channel-harness.js';
import { isPreparationRequest, preparationDelta, totalModelCalls } from './fixtures/turn-preparation.mjs';
import { conversationContext } from './fixtures/conversation-context.mjs';

async function fixture(t, delivery = { status: 'sent', externalMessageId: 'qq-output' }, reply = '群聊回复') {
  const directory = await mkdtemp(join(tmpdir(), 'pa-channel-'));
  const requests = [], planningRequests = [], sent = [], harnesses = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    if (isPreparationRequest(payload)) {
      planningRequests.push({ path: request.url, body: payload });
      const delta = preparationDelta(`prepare-${planningRequests.length}`);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const choices of [
        [{ index: 0, delta, finish_reason: null }],
        [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      ]) response.write(`data: ${JSON.stringify({ id: 'fixture-response', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    requests.push({ path: request.url, body: payload });
    if (currentInput({ body: payload }).input.currentMessage.text.includes('MODEL_FAILURE')) {
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
    const h = new ChannelHarness(config, routes, { send: async message => { sent.push(message); return typeof delivery === 'function' ? delivery(message, sent.length) : delivery; } }, maxCalls);
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
  return { config, directory, route, other, requests, planningRequests,
    totalCalls: () => totalModelCalls(requests, planningRequests), sent, harness, message };
}

test('长回答按实际Markdown分段数选择主动发送，/page不触发读取行为', async t => {
  const original='结论。\n\n'+'详细内容😀。'.repeat(500);
  const f=await fixture(t,(_message,index)=>({status:'sent',externalMessageId:`part-${index}`}),original);
  const h=f.harness(0);
  assert.equal(await h.handle(f.message('expired','旧问题',{sentAt:new Date(Date.now()-300_001).toISOString()})),'sent');
  assert.ok(f.sent.length>1 && f.sent.every(part=>part.deliveryMode==='active' && part.markdown));
  const count=f.sent.length;
  await h.handle(f.message('page','/page ignored 1'));
  assert.equal(f.requests.length,2);
  assert.ok(f.sent.length>count);
  assert.ok(f.sent.at(-1).markdown);
});

test('全量消息落库，明确@才调用真实Pi；身份、上下文、去重、群隔离和调用预算', async t => {
  const f = await fixture(t);
  const h = f.harness();
  assert.equal(await h.handle(f.message('outside', '不允许的群', { route: { ...f.route, roomId: 'outside' } })), 'ignored');
  assert.equal(await h.handle(f.message('background', '周末准备爬山', { mentioned: false, senderId: 'member-B' })), 'observed');
  assert.equal(f.requests.length, 0);
  assert.equal(await h.handle(f.message('one', '刚才群里说的爬山，建议怎么准备？')), 'sent');
  assert.equal(await h.handle(f.message('one', '重复事件')), 'duplicate');
  assert.equal(f.requests.length, 1);
  assert.equal(f.totalCalls(), 2);
  const request = f.requests[0];
  assert.equal(request.path, '/chat/completions');
  assert.equal(request.body.model, 'deepseek-flash');
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.equal(request.body.max_tokens, 1024);
  const user = request.body.messages.filter(m => m.role === 'user').at(-1);
  const text = typeof user.content === 'string' ? user.content : user.content.map(p => p.text).join('');
  const input = JSON.parse(text.slice(text.lastIndexOf('\n') + 1));
  assert.equal(input.currentMessage.senderId, 'member-A');
  assert.deepEqual(conversationContext(request.body).messages.map(({ role, senderId, text }) => ({ role, senderId, text })), [
    { role: 'user', senderId: 'member-B', text: '周末准备爬山' },
  ]);
  assert.equal(input.roomType, 'group');
  assert.ok(!Object.hasOwn(input, 'recentGroupMessages'));
  assert.ok(!Object.hasOwn(input, 'recentDialogueWithCurrentSender'));
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
      ['周末准备爬山', '刚才群里说的爬山，建议怎么准备？', '我更喜欢海边', '另外一个群', '超出预算']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM deliveries WHERE external_message_id = ?').get('qq-output').n, 3);
  } finally { db.close(); }
  await h.close();
  const reopened = f.harness();
  assert.equal(await reopened.handle(f.message('one', '重启后的重复事件')), 'duplicate');
  assert.equal(await reopened.handle(f.message('background', '背景重复', { mentioned: false })), 'duplicate');
  assert.equal(f.requests.length, 3);
  assert.equal(f.totalCalls(), 6);
});

function currentInput(request) {
  const user = request.body.messages.filter(message => message.role === 'user').at(-1);
  const text = typeof user.content === 'string' ? user.content : user.content.map(part => part.text).join('');
  return { text, input: JSON.parse(text.slice(text.lastIndexOf('\n') + 1)) };
}

test('不限次数模式超过三轮继续响应，普通消息不调用，单轮模型失败后新@可继续', async t => {
  const f = await fixture(t);
  const h = f.harness(0);
  for (let i = 0; i < 4; i++) {
    assert.equal(await h.handle(f.message(`unlimited-${i}`, `第${i}轮`)), 'sent');
  }
  assert.equal(await h.handle(f.message('background', '普通群消息', { mentioned: false })), 'observed');
  assert.equal(f.requests.length, 4);
  assert.equal(f.totalCalls(), 8);
  assert.equal(await h.handle(f.message('failure', 'MODEL_FAILURE')), 'failed');
  assert.equal(await h.handle(f.message('failure', 'MODEL_FAILURE')), 'duplicate');
  assert.equal(await h.handle(f.message('after-failure', '继续交流')), 'sent');
  assert.equal(h.info().calls, 6); assert.equal(h.info().maxCalls, 0);
  assert.equal(h.info().memory[0].enabled, false);
  assert.equal(f.requests.length, 6);
  assert.equal(f.totalCalls(), 12);
  assert.equal(f.sent.length, 5);
});
