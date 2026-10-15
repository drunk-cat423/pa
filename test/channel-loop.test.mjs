import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ChannelHarness } from '../dist/channel-harness.js';
import { openRecordedConversation } from '../dist/conversation.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-channel-loop-'));
  const requests = [], sent = [], plans = new Map();
  let onRequest = () => {};
  const current = body => {
    const user = body.messages.findLast(m => m.role === 'user');
    const raw = typeof user.content === 'string' ? user.content : user.content.map(b => b.text ?? '').join('');
    return JSON.parse(raw.slice(raw.lastIndexOf('\n') + 1)).currentMessage;
  };
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body); onRequest(body);
    const input = current(body);
    const plan = plans.get(input.text) ?? [{ answer: '本轮回答完成。' }];
    const step = plan.shift() ?? { answer: '本轮回答完成。' };
    if (step.error) { res.writeHead(500); res.end('fixture failure'); return; }
    const delta = step.tool ? { role: 'assistant', tool_calls: [{ index: 0,
      id: `call-${requests.length}`, type: 'function', function: { name: step.tool,
        arguments: JSON.stringify(step.args ?? {}) } }] } : { role: 'assistant', content: step.answer };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [value, reason] of [[delta, null], [{}, step.tool ? 'tool_calls' : 'stop']]) {
      res.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
        model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'fixture', model: 'fixture',
    apiKey: 'local-key', baseUrl: `http://127.0.0.1:${server.address().port}`, contextWindow: 32768,
    maxOutputTokens: 512, timeoutMs: 5000 };
  const route = { channel: 'qq', accountId: 'bot', roomType: 'group', roomId: 'one' };
  const other = { ...route, roomId: 'two' };
  const privateRoute = { ...route, roomType: 'private', roomId: 'alice' };
  const db = () => new DatabaseSync(join(config.dataDir, 'pa.sqlite'), { readOnly: true });
  const h = new ChannelHarness(config, [route, other, privateRoute], { send: async message => {
    const check = db();
    try {
      if (message.text === '我仔细分析一下。') assert.equal(check.prepare('SELECT status FROM run_progress').get().status, 'sending');
    } finally { check.close(); }
    sent.push(message); return { status: 'sent', externalMessageId: `out-${sent.length}` };
  } }, 0, { version: 1, ownerBindings: [{ route, senderId: 'owner' }] });
  const message = (eventId, text, extra = {}) => ({ route, eventId, text, senderId: 'alice', mentioned: true,
    sentAt: new Date().toISOString(), ...extra });
  t.after(async () => { await h.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true }); });
  return { h, db, message, requests, sent, plans, route, other, privateRoute, onRequest: cb => { onRequest = cb; } };
}

test('群聊与私聊每轮刷新北京时间，固定系统前缀不变且原文不混入时钟', async t => {
  const f = await fixture(t);
  const realNow = Date.now.bind(Date);
  let offset = 0;
  t.mock.method(Date, 'now', () => realNow() + offset);
  const userText = body => {
    const content = body.messages.findLast(m => m.role === 'user').content;
    return typeof content === 'string' ? content : content.map(b => b.text ?? '').join('');
  };
  const clock = body => JSON.parse(userText(body).split('\n')[1]);
  const before = Date.now();
  await f.h.handle(f.message('clock-group', '今天是几号？', { sentAt: new Date(before - 60000).toISOString() }));
  const first = clock(f.requests[0]);
  assert.equal(first.timeZone, 'Asia/Shanghai');
  assert.ok(Date.parse(first.currentTime) >= Math.floor(before / 1000) * 1000);
  assert.ok(Date.parse(first.currentTime) <= Date.now());
  offset = 60000;
  await f.h.handle(f.message('clock-private', '现在几点？', { route: f.privateRoute, mentioned: false }));
  assert.ok(Date.parse(clock(f.requests[1]).currentTime) - Date.parse(first.currentTime) >= 60000);
  const fixed = body => body.messages.filter(m => m.role === 'system');
  assert.ok(fixed(f.requests[0]).length > 0);
  assert.deepEqual(fixed(f.requests[0]), fixed(f.requests[1]));
  assert.ok(!JSON.stringify(fixed(f.requests[0])).includes('本轮时间环境'));
  const db = f.db();
  try {
    const rows = db.prepare("SELECT text,model_input_text FROM messages WHERE role='user' ORDER BY ingest_seq").all();
    assert.deepEqual(rows.map(row => row.text), ['今天是几号？', '现在几点？']);
    assert.equal(rows[0].model_input_text, userText(f.requests[0]));
    assert.equal(rows[1].model_input_text, userText(f.requests[1]));
  } finally { db.close(); }
});

test('普通自然语言由Pi自主调用画像工具，无分类；pending下轮可用且不串人', async t => {
  const f = await fixture(t);
  const text = '我喜欢登山，你可以记下来';
  f.plans.set(text, [{ tool: 'update_profile', args: { target: 'sender', content: '我喜欢登山', sourceType: 'self' } },
    { answer: '记住了。' }]);
  f.onRequest(() => {
    if (f.requests.length !== 1) return;
    const db = f.db(); try { assert.equal(db.prepare('SELECT count(*) n FROM person_profile_pending').get().n, 0); }
    finally { db.close(); }
  });
  assert.equal(await f.h.handle(f.message('pref', text)), 'sent');
  assert.equal(f.requests.length, 2);
  assert.equal(f.sent.at(-1).text, '记住了。');
  assert.ok(f.requests[0].tools.some(t => t.function.name === 'update_profile'));
  assert.equal(f.requests[0].tools.find(t => t.function.name === 'update_profile').function.parameters.properties.field, undefined);
  const db = f.db();
  try { assert.equal(db.prepare('SELECT content,archived_revision FROM person_profile_pending').get().content, '我喜欢登山');
    assert.equal(db.prepare('SELECT content,archived_revision FROM person_profile_pending').get().archived_revision, null); }
  finally { db.close(); }
  await f.h.handle(f.message('alice-question', '周末建议做什么？'));
  assert.ok(JSON.stringify(f.requests.at(-1)).includes('我喜欢登山'));
  assert.ok(JSON.stringify(f.requests.at(-1)).includes('pending'));
  await f.h.handle(f.message('bob-question', '周末建议做什么？', { senderId: 'bob' }));
  assert.ok(!JSON.stringify(f.requests.at(-1)).includes('我喜欢登山'));
  await f.h.handle(f.message('mention', '被提及的人适合做什么？', { senderId: 'bob', mentionedSenderIds: ['alice'] }));
  assert.ok(JSON.stringify(f.requests.at(-1)).includes('我喜欢登山'));
});

test('历史由工具按当前房间检索，保留真人和机器人身份；已完成回复不串群', async t => {
  const f = await fixture(t);
  await f.h.handle(f.message('old', '咖啡让我睡不着', { senderId: 'bob', mentioned: false }));
  await f.h.handle(f.message('other', '咖啡 OTHER_ROOM_SECRET', { route: f.other, senderId: 'bob', mentioned: false }));
  f.plans.set('群里有人讨论咖啡吗？', [{ tool: 'read_history', args: { query: '咖啡', scope: 'room' } }, { answer: '有，Bob提到了咖啡。' }]);
  await f.h.handle(f.message('read', '群里有人讨论咖啡吗？'));
  const tool = f.requests.at(-1).messages.findLast(m => m.role === 'tool');
  assert.ok(tool.content.includes('咖啡让我睡不着'));
  assert.ok(tool.content.includes('bob'));
  assert.ok(!tool.content.includes('OTHER_ROOM_SECRET'));
});

test('专业切换先持久化并发送进度，最终答案继续使用下一个QQ回复槽位', async t => {
  const f = await fixture(t);
  f.plans.set('请严格推导这个问题', [{ tool: 'answer_in_depth' }, { answer: '根据前提，推导结果如下。' }]);
  assert.equal(await f.h.handle(f.message('depth', '请严格推导这个问题')), 'sent');
  assert.deepEqual(f.sent.map(m => m.text), ['我仔细分析一下。', '根据前提，推导结果如下。']);
  assert.deepEqual(f.sent.map(m => m.partIndex), [0, 1]);
  assert.equal(f.requests.length, 2);
  assert.ok(JSON.stringify(f.requests[1].messages[0]).includes('专业回答模式'));
  assert.ok(JSON.stringify(f.requests[1].messages[0]).includes('不超过307 tokens'));
  const db = f.db();
  try { assert.equal(db.prepare('SELECT status,external_message_id FROM run_progress').get().status, 'sent');
    assert.equal(db.prepare('SELECT count(*) n FROM agent_runs').get().n, 1);
    assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE role='assistant'").get().n, 1); }
  finally { db.close(); }
});

test('纯提问不写画像、模型失败不保存；显式管理保留鉴权且事件不重复执行', async t => {
  const f = await fixture(t);
  await f.h.handle(f.message('question', '你知道登山是什么意思吗？'));
  const text = '记住我喜欢登山'; f.plans.set(text, [{ error: true }]);
  assert.equal(await f.h.handle(f.message('failed', text)), 'failed');
  const db = f.db(); try { assert.equal(db.prepare('SELECT count(*) n FROM person_profile_pending').get().n, 0); }
  finally { db.close(); }
  const calls = f.requests.length;
  await f.h.handle(f.message('unauthorized', '/memory remember room forbidden'));
  assert.equal(f.requests.length, calls);
  await f.h.handle(f.message('admin', '/memory remember room allowed', { senderId: 'owner' }));
  assert.equal(await f.h.handle(f.message('admin', '/memory remember room duplicate', { senderId: 'owner' })), 'duplicate');
  const audit = f.db(); try { assert.equal(audit.prepare('SELECT count(*) n FROM memories').get().n, 1); }
  finally { audit.close(); }
});

test('取消上下文准备中的embedding后不会继续请求聊天模型', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-preparation-cancel-'));
  const provider = { extract: async () => { throw new Error('not used'); },
    embedding: { model: 'fixture', dimensions: 2, inputVersion: 1, embed: () => new Promise(() => {}) } };
  const config = { cwd: directory, dataDir: directory, provider: 'fixture', model: 'fixture', apiKey: 'local',
    baseUrl: 'http://127.0.0.1:1', contextWindow: 32768, maxOutputTokens: 512, timeoutMs: 5000,
    memory: { enabled: true, maxCalls: 0, maxRetries: 1, timeoutMs: 5000,
      embedding: { url: 'http://127.0.0.1:1', model: 'fixture', apiKey: 'local', dimensions: 2, maxCalls: 10 } },
    loop: { maxModelCalls: 6, maxToolCalls: 8 } };
  const conversation = await openRecordedConversation(config, 'cancel', undefined, undefined, { memoryProvider: provider });
  t.after(async () => { await conversation.close(); await rm(directory, { recursive: true, force: true }); });
  const pending = conversation.prompt('取消准备阶段');
  const rejected = assert.rejects(pending, error => error.kind === 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 10));
  await conversation.abort();
  await rejected;
  assert.equal(conversation.info().messageCount, 0);
});
