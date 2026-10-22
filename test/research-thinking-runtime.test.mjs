import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DiagnosticLog } from '../dist/diagnostics.js';
import { openConversation } from '../dist/runtime.js';
import { WebFetchReader } from '../dist/web-fetch-reader.js';
import { preparationDelta } from './fixtures/turn-preparation.mjs';

async function fixture(t, respond, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-research-thinking-'));
  const requests = [], errors = [], runtimes = [];
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw); requests.push(body);
      const step = respond(body, requests.length);
      if (step.error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'fixture request failed' } })); return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: 'fixture',
        model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      for (const part of step.reasoning ?? []) emit({ reasoning_content: part });
      emit(step.delta ?? { role: 'assistant', content: step.answer ?? '阶段结果' });
      emit({}, step.delta?.tool_calls ? 'tool_calls' : step.finishReason ?? 'stop');
      response.write(`data: ${JSON.stringify({ id: 'fixture', choices: [], usage: { prompt_tokens: 100,
        completion_tokens: 20, total_tokens: 120, completion_tokens_details: { reasoning_tokens: 12 } } })}\n\n`);
      response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(error); response.writeHead(500); response.end('fixture failure'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'fixture', model: 'fixture',
    apiKey: 'local-fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    contextWindow: 131072, maxOutputTokens: 4096, timeoutMs: 5000,
    loop: { maxModelCalls: 4, maxToolCalls: 8 },
    search: { enabled: true }, fetch: { enabled: true, publicDns: true, timeoutMs: 1000,
      maxResponseBytes: 1048576, maxTextChars: 8000 }, ...overrides };
  t.after(async () => {
    await Promise.allSettled(runtimes.map(runtime => runtime.close()));
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  return { config, requests, log: new DiagnosticLog(config.dataDir), async open(id, research) {
    const runtime = await openConversation(config, id, { enableSearch: true, ...(research ? { research } : {}) });
    runtimes.push(runtime); return runtime;
  } };
}

function assertThinking(body) {
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(Object.hasOwn(body, 'max_tokens'), false);
  assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
  assert.ok(['auto', 'none'].includes(body.tool_choice));
}

for (const phase of ['plan', 'review']) test(`研究${phase}零工具额度时high思考并使用阶段提示`, async t => {
  const events = [], final = [];
  const f = await fixture(t, () => ({ reasoning: ['阶段分析'], answer: '{"stage":"result"}' }));
  const runtime = await f.open(phase, { phase, systemPrompt: `STAGE_${phase.toUpperCase()}`,
    maxToolCalls: 0, maxSearchCalls: 6, record: event => events.push(event), onFinalResponse: response => final.push(response) });
  assert.equal(runtime.estimate('研究输入').reservedOutputTokens, 65536);
  assert.equal(await runtime.prompt('研究输入', { runId: phase }), '{"stage":"result"}');
  assert.equal(f.requests.length, 1); assertThinking(f.requests[0]);
  assert.deepEqual(f.requests[0].tools, []); assert.equal(f.requests[0].tool_choice, 'none');
  assert.match(JSON.stringify(f.requests[0].messages), new RegExp(`STAGE_${phase.toUpperCase()}`));
  assert.doesNotMatch(JSON.stringify(f.requests[0].messages), /research_report/);
  assert.deepEqual(final, [{ stopReason: 'stop' }]);
  assert.equal(events.filter(event => event.kind === 'model_request').length, 1);
});

test('研究write只读材料计预算，SDK工具循环完整回传reasoning_content，最后关闭工具', async t => {
  const events = [], materialReads = [], firstReasoning = '第一段思考\n完整保留。', secondReasoning = '第二轮思考';
  const f = await fixture(t, (_body, number) => number <= 2 ? {
    reasoning: number === 1 ? ['第一段思考\n', '完整保留。'] : [secondReasoning],
    delta: { role: 'assistant', tool_calls: [{ index: 0, id: `material-${number}`, type: 'function', function: {
      name: 'read_research_material', arguments: JSON.stringify({ id: 'material-a', ...(number === 2 ? { offset: 20 } : {}) }),
    } }] },
  } : { reasoning: ['最终分析'], answer: '# 研究正文' });
  const runtime = await f.open('write', { phase: 'write', systemPrompt: '只输出研究正文。', maxToolCalls: 2,
    maxSearchCalls: 6, record: event => events.push(event), readMaterial: params => {
      materialReads.push(params); return { text: '绑定材料正文', nextOffset: 20 };
    } });
  assert.equal(await runtime.prompt('写本节', { runId: 'write' }), '# 研究正文');
  assert.equal(f.requests.length, 3); f.requests.forEach(assertThinking);
  assert.deepEqual(f.requests[0].tools.map(tool => tool.function.name).sort(), ['read_research_material', 'web_fetch', 'web_search']);
  const spec = f.requests[0].tools.find(tool => tool.function.name === 'read_research_material').function.parameters;
  assert.deepEqual(Object.keys(spec.properties).sort(), ['id', 'offset']); assert.equal(spec.additionalProperties, false);
  assert.deepEqual(materialReads, [{ id: 'material-a' }, { id: 'material-a', offset: 20 }]);
  assert.equal(f.requests[1].messages.find(message => message.role === 'assistant').reasoning_content, firstReasoning);
  assert.deepEqual(f.requests[2].messages.filter(message => message.role === 'assistant').map(message => message.reasoning_content),
    [firstReasoning, secondReasoning]);
  assert.equal(f.requests[2].tool_choice, 'none'); assert.deepEqual(f.requests[2].tools, []);
  assert.ok(events.some(event => event.kind === 'tool_result' && event.tool === 'read_research_material' && event.toolCalls === 2));
  const calls = f.log.calls({ traceId: 'write' }); assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.status === 'completed' && call.usage.output === 20));
  const responses = calls.map(call => f.log.artifact(call.callId, 'response'));
  assert.ok(responses.some(response => response.content.some(part => part.type === 'thinking'
    && part.thinking === firstReasoning && part.thinkingSignature === 'reasoning_content')));
});

test('研究最后一次模型请求关闭工具，write允许零工具额度', async t => {
  const f = await fixture(t, () => ({ answer: '结果' }), { loop: { maxModelCalls: 1, maxToolCalls: 8 } });
  const runtime = await f.open('last-call', { phase: 'write', maxSearchCalls: 1, record() {} });
  assert.equal(await runtime.prompt('研究输入'), '结果');
  assertThinking(f.requests[0]); assert.deepEqual(f.requests[0].tools, []); assert.equal(f.requests[0].tool_choice, 'none');
  const noTool = await f.open('zero-tool', { phase: 'write', maxToolCalls: 0, maxSearchCalls: 1, record() {} });
  await noTool.prompt('研究输入'); assert.deepEqual(f.requests[1].tools, []);
});

test('64K思考预留超过低窗口时发送前拒绝，不计入已发送请求', async t => {
  const f = await fixture(t, () => ({ answer: '不应发送' }), { contextWindow: 32768 });
  const runtime = await f.open('too-small', { phase: 'plan', maxToolCalls: 0, maxSearchCalls: 0, record() {} });
  const estimate = runtime.estimate('短输入'); assert.equal(estimate.reservedOutputTokens, 65536); assert.equal(estimate.fits, false);
  await assert.rejects(runtime.prompt('短输入'), /超过上下文窗口/); assert.equal(f.requests.length, 0);
});

test('生产DeepSeek前台仍关闭思考且强制prepare_turn', async t => {
  const f = await fixture(t, (_body, number) => number === 1 ? { delta: preparationDelta('prepare') } : { answer: '前台回答' },
    { provider: 'deepseek', model: 'deepseek-flash' });
  const runtime = await f.open('foreground');
  assert.equal(await runtime.prompt('你好', { runId: 'foreground', companionTools: {
    prepareTurn: plan => ({ prepared: true, mode: plan.mode, saved: [] }), readHistory: () => [],
  } }), '前台回答');
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[0].tool_choice, { type: 'function', function: { name: 'prepare_turn' } });
  assert.equal(f.requests[0].parallel_tool_calls, false);
  assert.ok(f.requests.every(body => body.thinking?.type === 'disabled' && body.max_tokens === 4096));
});

test('研究请求失败不自动重试', async t => {
  const f = await fixture(t, () => ({ error: true }));
  const runtime = await f.open('failed', { phase: 'plan', maxSearchCalls: 0, record() {} });
  await assert.rejects(runtime.prompt('研究输入')); assert.equal(f.requests.length, 1);
});

test('DeepSeek生产provider研究请求同样启用high思考', async t => {
  const f = await fixture(t, () => ({ reasoning: ['生产协议思考'], answer: '审查结果' }),
    { provider: 'deepseek', model: 'deepseek-flash' });
  const runtime = await f.open('deepseek-review', { phase: 'review', maxSearchCalls: 0, record() {} });
  assert.equal(await runtime.prompt('核查章节'), '审查结果'); assertThinking(f.requests[0]);
});

test('plan返回违规工具调用时不执行材料读取，也不追加模型请求', async t => {
  let reads = 0;
  const f = await fixture(t, () => ({ reasoning: ['违规工具测试'], delta: { role: 'assistant', tool_calls: [
    { index: 0, id: 'forbidden', type: 'function', function: { name: 'read_research_material', arguments: '{"id":"other"}' } },
  ] } }));
  const runtime = await f.open('plan-tool-denied', { phase: 'plan', maxSearchCalls: 0, record() {}, readMaterial() { reads++; } });
  await assert.rejects(runtime.prompt('规划')); assert.equal(reads, 0); assert.equal(f.requests.length, 1);
});

test('材料工具拒绝taskId和path，不把调用者提供的身份或路径传给绑定读取器', async t => {
  let reads = 0;
  const f = await fixture(t, (_body, number) => number === 1 ? { delta: { role: 'assistant', tool_calls: [
    { index: 0, id: 'extra-fields', type: 'function', function: { name: 'read_research_material',
      arguments: JSON.stringify({ id: 'material', taskId: 'other-task', path: '../other' }) } },
  ] } } : { answer: '不读取未授权材料' });
  const runtime = await f.open('material-schema', { phase: 'write', maxSearchCalls: 0, record() {}, readMaterial() { reads++; } });
  assert.equal(await runtime.prompt('读材料'), '不读取未授权材料'); assert.equal(reads, 0);
  assert.equal(f.requests.length, 2);
});

test('review可多轮只读材料，禁止搜索和抓取，最后一轮工具关闭', async t => {
  const reads = [];
  const f = await fixture(t, (_body, number) => number <= 2 ? { reasoning: ['审查材料'], delta: {
    role: 'assistant', tool_calls: [{ index: 0, id: `review-${number}`, type: 'function', function: {
      name: 'read_research_material', arguments: JSON.stringify({ id: 'e1', offset: (number - 1) * 20 }),
    } }],
  } } : { answer: '{"verdict":"pass","reason":"已读完依据"}' }, { loop: { maxModelCalls: 3, maxToolCalls: 8 } });
  const runtime = await f.open('review-paging', { phase: 'review', maxToolCalls: 2, maxSearchCalls: 6, record() {},
    readMaterial(params) { reads.push(params); return { text: '审查绑定材料', ...(params.offset === 0 ? { nextOffset: 20 } : {}) }; } });
  assert.match(await runtime.prompt('审查正文与来源'), /"verdict":"pass"/);
  assert.deepEqual(reads, [{ id: 'e1', offset: 0 }, { id: 'e1', offset: 20 }]);
  assert.equal(f.requests.length, 3); f.requests.forEach(assertThinking);
  assert.deepEqual(f.requests[0].tools.map(tool => tool.function.name), ['read_research_material']);
  assert.deepEqual(f.requests[1].tools.map(tool => tool.function.name), ['read_research_material']);
  assert.equal(f.requests[2].tool_choice, 'none'); assert.deepEqual(f.requests[2].tools, []);
});

test('共享网页读取器跨runtime保留游标，单周期最后工具仍可续读且只抓取一次', async t => {
  const url = 'https://example.com/long-source', page = '0123456789'.repeat(16), coverages = [];
  let cursor, fetches = 0;
  const f = await fixture(t, (body, number) => number % 2 === 1 ? { delta: {
    role: 'assistant', tool_calls: [{ index: 0, id: `page-${number}`, type: 'function', function: {
      name: 'web_fetch', arguments: JSON.stringify({ url, ...(cursor ? { cursor } : {}) }),
    } }],
  } } : (() => {
    const raw = body.messages.findLast(message => message.role === 'tool').content;
    const result = JSON.parse(raw.slice(raw.lastIndexOf('\n') + 1)); cursor = result.nextCursor;
    return { answer: '本周期检查点' };
  })(), { loop: { maxModelCalls: 2, maxToolCalls: 8 } });
  const reader = new WebFetchReader({ ...f.config.fetch, maxTextChars: 40 },
    { maxResultBytes: 16000, maxReads: 4, maxTotalBytes: 64000 }, async () => { fetches++; return { url, text: page }; });
  t.after(() => reader.dispose());
  for (let cycle = 0; cycle < 4; cycle++) {
    const runtime = await f.open(`shared-cycle-${cycle}`, { phase: 'write', fetchReader: reader, maxToolCalls: 1,
      maxSearchCalls: 0, record(event) { if (event.kind === 'tool_result' && event.tool === 'web_fetch') coverages.push(event.result.coverage); } });
    assert.equal(await runtime.prompt('读取下一片段'), '本周期检查点');
    await runtime.close();
    assert.equal(Boolean(cursor), cycle < 3);
  }
  assert.equal(fetches, 1); assert.equal(coverages.length, 4);
  assert.deepEqual(coverages.map(range => [range.offset, range.end]), [[0, 40], [40, 80], [80, 120], [120, 160]]);
  assert.ok(coverages.every(range => range.totalChars === page.length && range.contentHash === coverages[0].contentHash));
});
