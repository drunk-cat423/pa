import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openConversation } from '../dist/runtime.js';
import { MemoryError } from '../dist/memory-types.js';

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
const plan = (mode = 'standard', updates = []) => ({ intent: updates.length ? 'memory_update' : 'question', mode, updates });
const prepare = (value = plan()) => [call('prepare_turn', value)];
function context(overrides = {}) {
  return { prepareTurn: p => ({ prepared: true, mode: p.mode, saved: [] }), readHistory: () => [], ...overrides };
}
function tools(body) { return body.tools?.map(tool => tool.function.name) ?? []; }

test('统一准备落库后再读取历史，单个Pi循环按顺序回答且移除旧工具', async t => {
  const order = [];
  const updates = [{ target: 'sender', content: '喜欢简洁回复', sourceType: 'self' }];
  const f = await fixture(t, (_body, n) => n === 1 ? prepare(plan('standard', updates))
    : n === 2 ? [call('read_history', { query: '上次计划', scope: 'room', limit: 5 })] : '已记下，也找到了之前的计划。');
  const answer = await f.runtime.prompt('记一下我的习惯，看看之前的计划', { runId: 'run-one', companionTools: context({
    prepareTurn: async p => { order.push(['prepare', p]); await new Promise(resolve => setTimeout(resolve, 20)); order.push('saved');
      return { prepared: true, mode: p.mode, saved: [{ target: 'sender', status: 'saved_pending' }] }; },
    readHistory: params => { order.push(['history', params]); return [{ text: '计划证据' }]; },
  }) });
  assert.equal(answer, '已记下，也找到了之前的计划。');
  assert.equal(f.requests.length, 3);
  assert.deepEqual(order, [['prepare', plan('standard', updates)], 'saved', ['history', { query: '上次计划', scope: 'room', limit: 5 }]]);
  assert.deepEqual(tools(f.requests[0]), ['prepare_turn']);
  assert.deepEqual(tools(f.requests[1]), ['read_history']);
  const recorded = f.runtime.recordedTurns();
  assert.equal(recorded.at(-1).runId, 'run-one'); assert.equal(recorded.at(-1).assistant.text, answer);
});

test('工具总额8包含准备调用，超额批量调用不执行，下一请求仅回答', async t => {
  let reads = 0;
  const f = await fixture(t, (_body, n) => n === 1 ? prepare() : n === 2
    ? Array.from({ length: 12 }, (_, i) => call('read_history', {}, String(i))) : '预算内答案');
  assert.equal(await f.runtime.prompt('历史', { runId: 'budget', companionTools: context({ readHistory: () => { reads++; return []; } }) }), '预算内答案');
  assert.equal(reads, 7); assert.equal(f.requests.length, 3);
  assert.deepEqual(tools(f.requests[2]), []); assert.equal(f.requests[2].tool_choice, 'none');
});

test('最后一次模型请求预留回答；恶意继续调用不会执行或发第7次请求', async t => {
  let reads = 0;
  const f = await fixture(t, (_body, n) => n === 1 ? prepare() : [call('read_history', {}, String(n))]);
  await assert.rejects(f.runtime.prompt('循环', { runId: 'loop', companionTools: context({ readHistory: () => { reads++; return []; } }) }), /次数已达上限/);
  assert.equal(f.requests.length, 6); assert.equal(reads, 4);
  assert.deepEqual(tools(f.requests[5]), []); assert.equal(f.requests[5].tool_choice, 'none');
});

test('专业表达由准备模式指定，一次进度与证据共用当前run，下一CLI轮无工具', async t => {
  const events = [];
  const f = await fixture(t, (body, n) => {
    events.push(['request', n]);
    if (n === 1) return prepare(plan('professional'));
    if (n === 2) {
      assert.deepEqual(tools(body), ['read_history']);
      assert.match(JSON.stringify(body.messages), /本轮采用专业回答/);
      return [call('read_history', { query: '证据' })];
    }
    if (n === 3) return '专业结论';
    return '日常回答';
  });
  assert.equal(await f.runtime.prompt('复杂问题', { runId: 'deep', companionTools: context({
    readHistory: () => [{ text: '证据' }], onProgress: async text => { events.push(['progress', text]); },
  }) }), '专业结论');
  assert.deepEqual(events, [['request', 1], ['progress', '我仔细想一下。'], ['request', 2], ['request', 3]]);
  assert.equal(f.runtime.recordedTurns().at(-1).assistant.text, '专业结论');
  assert.equal(await f.runtime.prompt('下一轮'), '日常回答'); assert.deepEqual(tools(f.requests[3]), []);
});

test('准备业务错误形成空回执继续回答，持久化错误停止后续请求和会话', async t => {
  const f = await fixture(t, (_body, n) => n === 1 || n === 3 ? prepare() : '未保存');
  assert.equal(await f.runtime.prompt('建议', { runId: 'business', companionTools: context({
    prepareTurn: () => { throw new MemoryError('业务错误'); },
  }) }), '未保存');
  assert.match(JSON.stringify(f.requests[1].messages), /业务错误/);
  await assert.rejects(f.runtime.prompt('保存', { runId: 'fatal', companionTools: context({
    prepareTurn: () => { throw new Error('落盘失败'); },
  }) }), /落盘失败/);
  assert.equal(f.requests.length, 3); await assert.rejects(f.runtime.prompt('之后'), /落盘失败/);
});

test('close中断等待中的工具，之后没有新模型请求', async t => {
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, (_body, n) => n === 1 ? prepare() : [call('read_history', {})]);
  const pending = f.runtime.prompt('等待', { runId: 'cancel', companionTools: context({
    readHistory: () => { started(); return new Promise(() => {}); },
  }) });
  const rejected = assert.rejects(pending, /取消|失败/);
  await waiting; await f.runtime.close(); await rejected; assert.equal(f.requests.length, 2);
});

test('多次请求与工具等待可累计超过单请求超时，每个模型请求独立计时', async t => {
  const f = await fixture(t, async (_body, n) => {
    await new Promise(resolve => setTimeout(resolve, 70));
    return n === 1 ? prepare() : n === 2 ? [call('read_history', {})] : '完成';
  }, { timeoutMs: 500, loop: { maxModelCalls: 3, maxToolCalls: 8 } });
  const started = Date.now();
  assert.equal(await f.runtime.prompt('多步处理', { runId: 'multi-step', companionTools: context({
    readHistory: async () => { await new Promise(resolve => setTimeout(resolve, 350)); return []; },
  }) }), '完成');
  assert.ok(Date.now() - started > 500); assert.equal(f.requests.length, 3);
});

test('单个模型请求超时仍会中断', async t => {
  const f = await fixture(t, async () => { await new Promise(resolve => setTimeout(resolve, 200)); return '太晚'; }, { timeoutMs: 30 });
  await assert.rejects(f.runtime.prompt('单次超时'), error => error.kind === 'timeout'); assert.equal(f.requests.length, 1);
});

test('工具结果有界且下一轮payload经过窗口检查', async t => {
  const f = await fixture(t, (_body, n) => n === 1 ? prepare() : n === 2 ? [call('read_history', {})] : '读到了片段');
  assert.equal(await f.runtime.prompt('长历史', { runId: 'bounded', companionTools: context({ readHistory: () => '证据'.repeat(100000) }) }), '读到了片段');
  const data = f.requests[2].messages.findLast(message => message.role === 'tool');
  assert.match(JSON.stringify(data), /工具结果已截断/); assert.ok(Buffer.byteLength(data.content) <= 4096);
});
