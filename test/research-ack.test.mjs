import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openConversation } from '../dist/runtime.js';
import { openRecordedConversation } from '../dist/conversation.js';
import { MemoryError } from '../dist/memory-types.js';
import { readRecordedTurns } from '../dist/transcript.js';
import { isPreparationRequest, preparationDelta } from './fixtures/turn-preparation.mjs';

const create = (key = 'one') => ['create_research', { key, title: key, goal: '研究同一主题' }];
const queued = (id = 'task-one') => ({ id, title: id, saved: true, status: 'queued' });
const toolDelta = (calls, content = '未经后台报告支持的长结论。'.repeat(300)) => ({ role: 'assistant', content,
  tool_calls: calls.map(([name, args], index) => ({ index, id: `call-${index}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) } })) });

async function fixture(t, steps, execute = async () => queued(), preparationPlan = { intent: 'research', mode: 'standard', updates: [] }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'pa-research-ack-'));
  const requests = [], executions = [], opened = [], errors = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); requests.push(body);
      const preparing = isPreparationRequest(body);
      const next = preparing ? preparationDelta(`prepare-${requests.length}`, preparationPlan) : steps.shift();
      assert.ok(next, '不应追加未计划的模型请求');
      const delta = typeof next === 'function' ? next(body) : next;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [value, finish] of [[delta, null], [{}, delta.tool_calls ? 'tool_calls' : 'stop']]) {
        response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1,
          model: 'fixture', choices: [{ index: 0, delta: value, finish_reason: finish }] })}\n\n`);
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); response.writeHead(500); response.end('fixture failure'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: process.cwd(), dataDir, provider: 'fixture', model: 'fixture', apiKey: 'fixture-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 131072, maxOutputTokens: 4096,
    timeoutMs: 3000, research: { enabled: true, maxModelCalls: 16, maxToolCalls: 24, maxSearchCalls: 6 },
    fetch: { enabled: true, timeoutMs: 1000, maxResponseBytes: 1048576, maxTextChars: 8000 } };
  const research = { execute: async (name, params) => { executions.push([name, params]); return execute(name, params); } };
  const companionTools = { prepareTurn: async plan => ({ prepared: true, mode: plan.mode, saved: [] }),
    readHistory: async () => { throw new Error('本轮不应读取历史'); }, research };
  t.after(async () => {
    await Promise.allSettled(opened.map(runtime => runtime.close()));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const runtime = await openConversation(config, 'research-ack', { enableSearch: true }); opened.push(runtime);
  return { runtime, requests, executions, config, companionTools, research, opened,
    prompt: (extra = {}) => runtime.prompt('把这个加入研究清单', { runId: 'run-ack', companionTools: { ...companionTools, ...extra } }) };
}

test('研究入队后替换同条长结论，不再请求模型；短确认与持久历史一致，链接无需当场读取', async t => {
  const f = await fixture(t, [body => {
    assert.equal(body.tool_choice, 'auto');
    return toolDelta([create()]);
  }]);
  const text = await f.prompt({ verifyLink: 'https://example.com/source' });
  assert.match(text, /已加入研究队列/); assert.ok(text.length < 100);
  assert.doesNotMatch(text, /长结论/); assert.equal(f.requests.length, 2);
  assert.deepEqual(f.executions.map(([name]) => name), ['create_research']);
  assert.equal(f.runtime.recordedTurns().at(-1).assistant.text, text);
  const file = f.runtime.info().sessionFile;
  const entries = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const assistants = entries.filter(entry => entry.message?.role === 'assistant').map(entry => entry.message);
  assert.equal(assistants.at(-2).stopReason, 'toolUse');
  assert.match(JSON.stringify(assistants.at(-2)), /长结论/);
  assert.equal(assistants.at(-1).stopReason, 'stop');
  assert.equal(assistants.at(-1).usage.totalTokens, 0);
  assert.equal((await readRecordedTurns(file)).at(-1).assistant.text, text);
});

test('同批多个研究逐项执行，新增要求原样传递，成功后不执行其他工具', async t => {
  const requirements = '补充实际部署条件并更新原报告';
  const f = await fixture(t, [toolDelta([create(), ['continue_research', { id: 'task-two', key: 'next', requirements }],
    ['archive_research', { id: 'untouched' }]])], async (name, params) => queued(name === 'create_research' ? 'task-one' : params.id));
  const text = await f.prompt();
  assert.match(text, /task-one/); assert.match(text, /task-two/); assert.match(text, /其他操作未执行/);
  assert.deepEqual(f.executions, [create(), ['continue_research', { id: 'task-two', key: 'next', requirements }]]);
  assert.equal(f.requests.length, 2);
});

test('幂等回执已完成不能说重新排队', async t => {
  const f = await fixture(t, [toolDelta([create()])], async () => ({ ...queued(), status: 'completed' }));
  const text = await f.prompt();
  assert.match(text, /已有完成的报告/); assert.match(text, /未重新排队/); assert.doesNotMatch(text, /已加入研究队列/);
  assert.equal(f.requests.length, 2);
});

test('幂等回执失败状态如实说明，不能声称已排队', async t => {
  const f = await fixture(t, [toolDelta([create()])], async () => ({ ...queued(), status: 'failed' }));
  const text = await f.prompt();
  assert.match(text, /当前研究失败/); assert.match(text, /未重新排队/); assert.doesNotMatch(text, /已加入研究队列/);
  assert.equal(f.requests.length, 2);
});

test('拒绝回执和不完整回执不能触发成功确认', async t => {
  for (const receipt of [{ saved: false, id: 'task', status: 'rejected', error: '没有权限' },
    { saved: true, id: 'task' }]) {
    await t.test(JSON.stringify(receipt), async t => {
      const f = await fixture(t, [toolDelta([create()]), { role: 'assistant', content: '未能加入研究清单。' }], async () => receipt);
      const text = await f.prompt();
      assert.equal(text, '未能加入研究清单。'); assert.equal(f.requests.length, 3);
    });
  }
});

test('同批研究工具失败或未知工具不能被成功回执吞掉', async t => {
  for (const unknown of [false, true]) await t.test(unknown ? 'unknown' : 'execution error', async t => {
    const f = await fixture(t, [toolDelta([create(), unknown ? ['unknown_tool', {}] : create('two')])], async (_name, params) => {
      if (params.key === 'two') throw new MemoryError('第二项拒绝');
      return queued();
    });
    await assert.rejects(f.prompt(), /工具执行失败/);
    assert.equal(f.requests.length, 2); assert.notEqual(f.runtime.recordedTurns().at(-1).assistant.stopReason, 'stop');
  });
});

test('同批研究的拒绝回执不能被另一项成功吞掉', async t => {
  const f = await fixture(t, [toolDelta([create(), create('two')])], async (_name, params) => params.key === 'two'
    ? { saved: false, id: 'task-two', status: 'rejected', error: '第二项拒绝' } : queued());
  await assert.rejects(f.prompt(), /工具执行失败/); assert.equal(f.requests.length, 2);
});

test('持久化失败与取消不能转成成功确认', async t => {
  await t.test('persistence', async t => {
    const f = await fixture(t, [toolDelta([create()])], async () => { throw new Error('存储不可写'); });
    await assert.rejects(f.prompt(), /存储不可写/); assert.equal(f.requests.length, 2);
  });
  await t.test('cancel', async t => {
    let runtime;
    const f = await fixture(t, [toolDelta([create()])], async () => { void runtime.abort(); return queued(); });
    runtime = f.runtime;
    await assert.rejects(f.prompt(), /取消/); assert.equal(f.requests.length, 2);
  });
});

test('普通聊天保持正常回答', async t => {
  const f = await fixture(t, [{ role: 'assistant', content: '你好，今天怎么样？' }]);
  assert.equal(await f.prompt(), '你好，今天怎么样？');
  assert.equal(f.requests.length, 2); assert.deepEqual(f.executions, []);
});

test('研究入队不发送前台研究进度，普通professional进度保持', async t => {
  await t.test('research queue', async t => {
    const progress = [];
    const f = await fixture(t, [toolDelta([create()])], undefined,
      { intent: 'research', mode: 'professional', updates: [], progressText: '我去读仓库并核验实现。' });
    assert.match(await f.prompt({ onProgress: async text => { progress.push(text); } }), /已加入研究队列/);
    assert.deepEqual(progress, []);
  });
  await t.test('ordinary professional', async t => {
    const progress = [];
    const f = await fixture(t, [{ role: 'assistant', content: '这是普通即时问题的回答。' }], undefined,
      { intent: 'question', mode: 'professional', updates: [], progressText: '我仔细想一下。' });
    await f.prompt({ onProgress: async text => { progress.push(text); } });
    assert.deepEqual(progress, ['我仔细想一下。']);
  });
});

test('仅research意图不能豁免链接读取，必须有真实入队回执', async t => {
  const f = await fixture(t, [{ role: 'assistant', content: '能看到网页内容。' }]);
  await assert.rejects(f.prompt({ verifyLink: 'https://example.com/source' }), /尚未实际读取/);
  assert.deepEqual(f.executions, []);
});

test('正常渠道会话的投递正文和已送达历史均为程序短确认', async t => {
  const f = await fixture(t, [toolDelta([create()])]);
  const route = { channel: 'fixture', accountId: 'bot', roomType: 'group', roomId: 'room' };
  const conversation = await openRecordedConversation(f.config, 'recorded-ack', route, { researchContext: () => f.research });
  f.opened.push(conversation);
  const reply = await conversation.prompt('加入研究清单', { eventId: 'evt-ack', senderId: 'alice', modelInputText: '加入研究清单' });
  assert.match(reply.text, /已加入研究队列/); assert.doesNotMatch(reply.text, /长结论/);
  conversation.acknowledge(reply.deliveryId, 'sent', 'sent-ack');
  assert.equal(conversation.history().findLast(message => message.role === 'assistant').text, reply.text);
  assert.equal(f.requests.length, 2);
});
