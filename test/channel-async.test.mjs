import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ChannelHarness,  } from '../dist/channel-harness.js';
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
  function harness(maxCalls = 0) {
    const h = new ChannelHarness(config, [route, other], { send: async message => {
      const persisted = inspect(db => db.prepare(`SELECT status,delivery_mode,reply_slot FROM delivery_parts
        WHERE status='sending' AND text=? UNION ALL
        SELECT status,delivery_mode,reply_slot FROM run_progress WHERE status='sending' AND text=?`).all(message.text, message.text));
      sent.push({ ...message, persisted });
      return send(message, sent.length);
    } }, maxCalls);
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
  await until(() => f.tasks().find(task => task.eventId === 'depth')?.status === 'completed', '专业回答等待输出队列');
  const normal = h.handle(f.message('normal', '普通问题', { senderId: 'carol' }));
  await until(() => f.tasks().find(task => task.eventId === 'normal')?.status === 'completed', '其它回答等待输出');
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
  assert.equal(f.sent.filter(message => message.text === '我仔细分析一下。').length, 0);
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM run_progress').get().n), 0);
  assert.equal(f.totalCalls(), 6);
});

test('过期问题主动投递完整回答，超时不重发且结果只由本人同房间领取', async t => {
  const f = await fixture(t), h = f.harness();
  f.preparations.set('expired', { intent: 'question', mode: 'professional', progressText: '我仔细分析一下。', updates: [] });
  f.plans.set('expired', [{ answer: '可领取的完整回答' }]);
  f.send(async (message, index) => {
    if (message.text.includes('可领取的完整回答')) throw Object.assign(new Error('transport timeout'), { code: 'ETIMEDOUT' });
    return { status: 'sent', externalMessageId: `out-${index}` };
  });
  assert.equal(await h.handle(f.message('expired', '旧问题', { sentAt: new Date(Date.now() - 300_001).toISOString() })), 'uncertain');
  assert.equal(f.sent.length, 1);
  assert.doesNotMatch(f.sent[0].text, /我仔细分析一下/);
  assert.equal(f.sent[0].deliveryMode, 'active');
  assert.equal(Object.hasOwn(f.sent[0], 'replyToMessageId'), false);
  assert.ok(f.sent[0].persisted.some(row => row.status === 'sending' && row.delivery_mode === 'active' && row.reply_slot === null));
  assert.match(f.sent[0].text, /回复 甲 · [0-9a-f]{8}\n问题：旧问题/);
  const task = f.tasks().find(task => task.eventId === 'expired');
  assert.equal(f.totalCalls(), 2);
  assert.equal(task.status, 'completed');
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) n FROM run_progress').get().n), 0);
  const modelCalls = f.requests.length, totalCalls = f.totalCalls(), attempts = f.sent.length;
  await h.close();
  const reopened = f.harness();
  await reopened.start();
  assert.equal(await reopened.handle(f.message('expired', '旧问题')), 'duplicate');
  assert.equal(f.requests.length, modelCalls);
  assert.equal(f.totalCalls(), totalCalls);
  assert.equal(f.sent.length, attempts);
  f.send(async (_message, index) => ({ status: 'sent', externalMessageId: `result-${index}` }));
  await reopened.handle(f.message('bob-result', `/result ${task.id}`, { senderId: 'bob' }));
  assert.match(f.sent.at(-1).text, /没有找到/);
  await reopened.handle(f.message('other-result', `/result ${task.id}`, { route: f.other }));
  assert.match(f.sent.at(-1).text, /没有找到/);
  await reopened.handle(f.message('alice-result', `/result ${task.id.slice(0, 8)}`));
  assert.match(f.sent.at(-1).text, /可领取的完整回答/);
  await reopened.handle(f.message('alice-missing', '/result deadbeef'));
  assert.match(f.sent.at(-1).text, /没有找到/);
  await reopened.handle(f.message('alice-control', '/memory query'));
  await reopened.handle(f.message('alice-latest', '/result'));
  assert.match(f.sent.at(-1).text, /可领取的完整回答/);
  assert.equal(f.requests.length, modelCalls);
});
