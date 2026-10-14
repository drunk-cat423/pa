import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openConversation } from '../dist/runtime.js';
import { MemoryError } from '../dist/memory-types.js';

test('专业提示和最终关闭工具通过SDK转录转换，保持Anthropic原生协议', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pa-anthropic-loop-'));
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    const tool = requests.length === 1;
    const events = [
      ['message_start', { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant',
        content: [], model: 'claude-sonnet-4-5', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: tool
        ? { type: 'tool_use', id: 'depth', name: 'answer_in_depth', input: {} } : { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: tool
        ? { type: 'input_json_delta', partial_json: '{}' } : { type: 'text_delta', text: '专业结论' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    return new Response(events.map(([event, value]) => `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`).join(''),
      { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  let runtime;
  t.after(async () => { globalThis.fetch = originalFetch; await runtime?.close(); await rm(directory, { recursive: true, force: true }); });
  runtime = await openConversation({ cwd: directory, dataDir: directory, provider: 'anthropic', model: 'claude-sonnet-4-5',
    apiKey: 'fixture', contextWindow: 32768, maxOutputTokens: 512, timeoutMs: 5000,
    loop: { maxModelCalls: 2, maxToolCalls: 8 } }, 'anthropic');
  const answer = await runtime.prompt('严谨解释', { runId: 'run', companionTools: {
    updateProfile: () => { throw new Error('not used'); }, readHistory: () => [],
  } });
  assert.equal(answer, '专业结论'); assert.equal(requests.length, 2);
  if (requests[0].tool_choice !== undefined) assert.equal(typeof requests[0].tool_choice, 'object');
  assert.ok(JSON.stringify(requests[1].system).includes('专业回答模式'));
  assert.ok(!requests[1].tools?.length);
  assert.ok(!requests[1].messages.some(message => message.role === 'system'));
});

const call = (name, args, id = name) => ({ id, name, args });
async function fixture(t, respond, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-companion-loop-'));
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
      const answer = await respond(body, requests.length);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = Array.isArray(answer) ? { role: 'assistant', tool_calls: answer.map((tool, index) => ({ index,
        id: tool.id, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } })) }
        : { role: 'assistant', content: answer };
      for (const choices of [[{ index: 0, delta, finish_reason: null }], [{ index: 0, delta: {},
        finish_reason: Array.isArray(answer) ? 'tool_calls' : 'stop' }]]) response.write(`data: ${JSON.stringify({
        id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'test', choices })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const runtime = await openConversation({ cwd: process.cwd(), dataDir: directory, provider: 'fixture',
    model: 'test', apiKey: 'fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    contextWindow: 32768, maxOutputTokens: 512, timeoutMs: 3000, ...overrides }, 'test');
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true }); });
  return { runtime, requests };
}
function context(overrides = {}) {
  return { updateProfile: () => ({ saved: true }), readHistory: () => [], ...overrides };
}
function tools(body) { return body.tools?.map(tool => tool.function.name) ?? []; }

test('自然选择画像和历史工具，同一Pi循环顺序执行且无分类/确认模型', async t => {
  const order = [];
  const f = await fixture(t, (_body, n) => n === 1 ? [
    call('update_profile', { target: 'sender', content: '喜欢简洁回复', sourceType: 'self' }, 'profile'),
    call('read_history', { query: '上次计划', scope: 'room', limit: 5 }, 'history'),
  ] : '已记下，也找到了之前的计划。');
  const answer = await f.runtime.prompt('记一下我的习惯，看看之前的计划', { runId: 'run-one', companionTools: context({
    updateProfile: async (params, id) => { order.push(['profile', params, id]); await new Promise(resolve => setTimeout(resolve, 20)); order.push('saved'); return { saved: true }; },
    readHistory: params => { order.push(['history', params]); return [{ text: '计划证据' }]; },
  }) });
  assert.equal(answer, '已记下，也找到了之前的计划。');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(order, [['profile', { target: 'sender', content: '喜欢简洁回复', sourceType: 'self' }, 'profile'], 'saved', ['history', { query: '上次计划', scope: 'room', limit: 5 }]]);
  assert.equal(f.requests[0].tool_choice, 'auto');
  assert.deepEqual(tools(f.requests[0]), ['update_profile', 'read_history', 'answer_in_depth']);
  assert.equal(f.requests[1].messages.filter(message => message.role === 'tool').length, 2);
  const recorded = f.runtime.recordedTurns();
  assert.equal(recorded.at(-1).runId, 'run-one'); assert.equal(recorded.at(-1).assistant.text, answer);
});

test('工具总额8达到后下一轮仅回答，超额批量调用不能执行回调', async t => {
  let reads = 0;
  const f = await fixture(t, (_body, n) => n === 1 ? Array.from({ length: 12 }, (_, i) => call('read_history', {}, String(i))) : '预算内答案');
  assert.equal(await f.runtime.prompt('历史', { runId: 'budget', companionTools: context({ readHistory: () => { reads++; return []; } }) }), '预算内答案');
  assert.equal(reads, 8); assert.equal(f.requests.length, 2);
  assert.deepEqual(tools(f.requests[1]), []); assert.equal(f.requests[1].tool_choice, 'none');
});

test('最后一次模型请求预留回答；恶意继续调用工具也不执行且不会第7次请求', async t => {
  let reads = 0;
  const f = await fixture(t, (_body, n) => [call('read_history', {}, String(n))]);
  await assert.rejects(f.runtime.prompt('循环', { runId: 'loop', companionTools: context({ readHistory: () => { reads++; return []; } }) }), /次数已达上限/);
  assert.equal(f.requests.length, 6); assert.equal(reads, 5);
  assert.deepEqual(tools(f.requests[5]), []); assert.equal(f.requests[5].tool_choice, 'none');
});

test('专业模式一次进度，共享证据和预算，禁写画像与重复handoff，专业答案直接归本run', async t => {
  const events = [];
  let writes = 0;
  const f = await fixture(t, (body, n) => {
    events.push(['request', n]);
    if (n === 1) return [call('answer_in_depth', { reason: '需要分析' })];
    if (n === 2) {
      assert.ok(!tools(body).includes('update_profile')); assert.ok(!tools(body).includes('answer_in_depth'));
      assert.match(JSON.stringify(body.messages), /专业回答模式/);
      return [call('update_profile', { target: 'sender', content: '不应保存' }), call('answer_in_depth', {}), call('read_history', { query: '证据' })];
    }
    if (n === 3) return '专业结论';
    assert.doesNotMatch(JSON.stringify(body.messages.filter(message => message.role === 'system')), /当前已进入专业回答模式/);
    return '日常回答';
  });
  const answer = await f.runtime.prompt('复杂问题', { runId: 'deep', companionTools: context({
    updateProfile: () => { writes++; }, readHistory: () => [{ text: '证据' }], onProgress: async text => { events.push(['progress', text]); },
  }) });
  assert.equal(answer, '专业结论'); assert.equal(writes, 0);
  assert.deepEqual(events, [['request', 1], ['progress', '我仔细分析一下。'], ['request', 2], ['request', 3]]);
  assert.equal(f.runtime.recordedTurns().at(-1).assistant.text, '专业结论');
  assert.equal(await f.runtime.prompt('下一轮'), '日常回答'); assert.deepEqual(tools(f.requests[3]), []);
});

test('schema拒绝额外人物写入字段；业务工具错误可恢复，持久化错误停止后续模型和会话', async t => {
  let writes = 0;
  const f = await fixture(t, (_body, n) => n === 1 ? [call('update_profile', { target: 'sender', content: '建议', personId: 'other' }, 'invalid'),
    call('update_profile', { target: 'sender', content: '业务错误' }, 'business')] : n === 2 ? '未保存' : [call('update_profile', { target: 'ai_self', content: '建议' }, 'fatal')]);
  assert.equal(await f.runtime.prompt('建议', { runId: 'args', companionTools: context({ updateProfile: () => { writes++; throw new MemoryError('业务错误'); } }) }), '未保存');
  assert.equal(writes, 1); assert.match(JSON.stringify(f.requests[1].messages), /业务错误/);
  await assert.rejects(f.runtime.prompt('保存', { runId: 'fatal', companionTools: context({ updateProfile: () => { throw new Error('落盘失败'); } }) }), /落盘失败/);
  assert.equal(f.requests.length, 3); await assert.rejects(f.runtime.prompt('之后'), /落盘失败/);
});

test('close中断等待中的工具，之后没有新模型请求', async t => {
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, () => [call('read_history', {})]);
  const pending = f.runtime.prompt('等待', { runId: 'cancel', companionTools: context({ readHistory: () => { started(); return new Promise(() => {}); } }) });
  const rejected = assert.rejects(pending, /取消|失败/);
  await waiting; await f.runtime.close(); await rejected; assert.equal(f.requests.length, 1);
});

test('多次请求与工具等待可累计超过单请求超时，只有每次请求独立计时', async t => {
  const f = await fixture(t, async (_body, n) => {
    await new Promise(resolve => setTimeout(resolve, 70));
    return n < 3 ? [call('read_history', {}, String(n))] : '完成';
  }, { timeoutMs: 500, loop: { maxModelCalls: 3, maxToolCalls: 8 } });
  const started = Date.now();
  assert.equal(await f.runtime.prompt('多步处理', { runId: 'multi-step', companionTools: context({
    readHistory: async () => { await new Promise(resolve => setTimeout(resolve, 300)); return []; },
  }) }), '完成');
  assert.ok(Date.now() - started > 500);
  assert.equal(f.requests.length, 3);
});

test('去掉总时限后单个模型请求超时仍会中断', async t => {
  const f = await fixture(t, async () => { await new Promise(resolve => setTimeout(resolve, 200)); return '太晚'; },
    { timeoutMs: 30 });
  await assert.rejects(f.runtime.prompt('单次超时'), error => error.kind === 'timeout');
  assert.equal(f.requests.length, 1);
});

test('工具结果有界且所有下一轮payload经过窗口检查', async t => {
  const f = await fixture(t, (_body, n) => n === 1 ? [call('read_history', {})] : '读到了片段');
  assert.equal(await f.runtime.prompt('长历史', { runId: 'bounded', companionTools: context({ readHistory: () => '证据'.repeat(100000) }) }), '读到了片段');
  const data = f.requests[1].messages.find(message => message.role === 'tool');
  assert.match(JSON.stringify(data), /工具结果已截断/); assert.ok(Buffer.byteLength(JSON.stringify(data)) < 5000);
});
