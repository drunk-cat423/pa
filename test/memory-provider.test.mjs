import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createMemoryProvider, MemoryInputTooLargeError, prepareMemoryExtraction, parseMemoryResponse } from '../dist/memory-provider.js';
import { DiagnosticLog } from '../dist/diagnostics.js';
import { replayDiagnosticCall } from '../dist/logs.js';
import { personProfileCapacityPrompt } from '../dist/profile-limits.js';

const output = {
  ignoredMessageIds: [], topics: [], fragments: [], profiles: [], continuationSummary: '继续讨论行程安排。',
};
const input = {
  job: { id: 'job-1', conversationId: 'conversation-1', reason: 'count', status: 'running', startSeq: 1,
    endSeq: 1, messageIds: ['message-1'], attempts: 1 },
  roomType: 'private',
  messages: [{ id: 'message-1', conversationId: 'conversation-1', role: 'user', text: '我下周去杭州。',
    ingestSeq: 1, createdAt: '2026-10-13T00:00:00.000Z' }],
  profiles: [],
};

test('pure offline request preparation omits worker leases and states the human-only coverage contract', () => {
  const prepared=prepareMemoryExtraction({...input,job:{...input.job,leaseToken:'private-worker-lease'},
    profiles:[{personId:'alice',baseVersion:1,facts:[{field:'diet',content:'喜欢茶',sourceType:'self',messageIds:['old']}]}],
    roomRules:[{key:'rsi',content:'术语约定'}]},100000);
  assert.doesNotMatch(prepared.userContent,/private-worker-lease|"job"|"field"/);
  assert.match(prepared.userContent,/message-1|roomRules/);
  assert.match(prepared.systemPrompt,/忽略项只能列 user/);
  assert.match(prepared.systemPrompt,/不能新写为人物事实或 AI 自我画像/);
});

test('new profile preparation requests complete bounded replacement and typed pending decisions', () => {
  const prepared = prepareMemoryExtraction({ ...input, profileProtocol: 2 }, 100000);
  assert.match(prepared.systemPrompt, /facts 是该人的完整最终画像/);
  assert.ok(prepared.systemPrompt.includes(personProfileCapacityPrompt()));
  assert.match(prepared.systemPrompt, /最多80条facts/);
  assert.match(prepared.systemPrompt, /120个Unicode字符/);
  assert.match(prepared.systemPrompt, /8000字节/);
  assert.match(prepared.systemPrompt, /16000字节/);
  assert.match(prepared.systemPrompt, /事实数达到60条/);
  assert.match(prepared.systemPrompt, /正文达到6000字节/);
  assert.match(prepared.systemPrompt, /完整JSON达到12000字节/);
  assert.match(prepared.systemPrompt, /pendingResults/);
  assert.doesNotMatch(prepared.systemPrompt, /"pendingIds"\?:string\[\]/);
  assert.match(prepared.systemPrompt, /not_profile/);
  assert.match(prepared.systemPrompt, /replacementMessageId/);
  assert.doesNotMatch(prepared.systemPrompt, /未给出的旧事实由/);
});

test('profiles-only requests have no self result gate and explicitly disable message coverage', () => {
  const profileInput = { ...input, profileProtocol: 2, mode: 'profiles', selfProfile: {} };
  const prepared = prepareMemoryExtraction(profileInput, 100000);
  assert.match(prepared.systemPrompt, /mode=profiles/);
  assert.match(prepared.systemPrompt, /不执行消息覆盖/);
  assert.doesNotMatch(prepared.systemPrompt, /本轮还必须输出 selfProfile/);
  const result = { profiles: [] };
  assert.deepEqual(parseMemoryResponse({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(result) }] }, profileInput), result);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-memory-provider-'));
  const requests = [];
  let mode = 'success';
  let result = output;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({ url: request.url, headers: request.headers, body: raw ? JSON.parse(raw) : undefined });
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404); response.end(); return;
    }
    if (mode === 'http-error') { response.writeHead(503); response.end('private provider rejection'); return; }
    const stopReason = mode === 'length' ? 'length' : 'stop';
    const content = mode === 'invalid-json' ? '{invalid json' : mode === 'empty' ? '' : JSON.stringify(result);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: stopReason }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const config = {
    cwd: directory, dataDir: directory, provider: 'deepseek', model: 'deepseek-chat', apiKey: 'local-model-key',
    baseUrl, contextWindow: 100_000, maxOutputTokens: 2048, timeoutMs: 5000,
    memory: { enabled: true, maxCalls: 10, timeoutMs: 5000 },
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { config, requests, setMode: value => { mode = value; }, setOutput: value => { result = value; } };
}

test('new wire protocol reaches the local SDK with aliases and preserves replay and response diagnostics', async t => {
  const f = await fixture(t);
  const sourceId = '00000000-0000-4000-8000-000000000001';
  const personId = '00000000-0000-4000-8000-000000000002';
  const pendingId = '00000000-0000-4000-8000-000000000003';
  const snapshot = { ...input, extractionProtocol: 2, profileProtocol: 2, contextProtocol: 1,
    job: { ...input.job, reason: 'capacity', messageIds: [sourceId] },
    messages: [{ ...input.messages[0], id: sourceId, personId }],
    profiles: [{ personId, baseVersion: 0, facts: [], pending: [{ id: pendingId,
      content: '喜欢茶', sourceMessageId: sourceId, sourceType: 'self' }] }] };
  const wire = { topics: [{ summary: '话题 m0' }], continuationSummary: '继续 m0',
    profiles: [{ personId: 'p0', baseVersion: 0, facts: [{ content: '喜欢茶 m0', sourceType: 'self', messageIds: ['m0'] }],
      pendingResults: [{ pendingId: 'q0', status: 'merged', factIndex: 0 }] }] };
  f.setOutput(wire);
  let callId;
  const result = await createMemoryProvider(f.config).extract(snapshot, new AbortController().signal, { onCall: id => { callId = id; } });
  assert.equal(f.requests.length, 1);
  const request = f.requests[0].body;
  assert.equal(request.tools, undefined);
  assert.deepEqual(request.response_format, { type: 'json_object' });
  const user = JSON.parse(request.messages.find(message => message.role === 'user').content);
  assert.equal(user.messages[0].id, 'm0');
  assert.equal(user.profiles[0].personId, 'p0');
  assert.equal(user.profiles[0].pending[0].id, 'q0');
  assert.doesNotMatch(JSON.stringify(request), /00000000-0000-4000-8000-/);
  assert.equal(result.profiles[0].personId, personId);
  assert.deepEqual(result.profiles[0].facts[0].messageIds, [sourceId]);
  assert.equal(result.profiles[0].pendingResults[0].pendingId, pendingId);
  assert.equal(result.profiles[0].facts[0].content, '喜欢茶 m0');
  assert.deepEqual(result.topics, [{ summary: '话题 m0', messageIds: [] }]);
  const diagnostic = name => readFile(join(f.config.dataDir, 'diagnostics', 'calls', callId, `${name}.json`), 'utf8').then(JSON.parse);
  assert.equal((await diagnostic('input')).messages[0].id, sourceId);
  assert.ok(JSON.stringify(await diagnostic('request')).includes('m0'));
  const response = await diagnostic('response');
  assert.equal(response.stopReason, 'stop');
  assert.deepEqual(JSON.parse(response.content.find(block => block.type === 'text').text), wire);
  const replay = replayDiagnosticCall(new DiagnosticLog(f.config.dataDir), callId);
  assert.equal(replay.ok, true); assert.equal(replay.networkRequests, 0); assert.equal(replay.businessWrites, 0);
});

test('离线请求准备明确摘要缺口，不把搁置区间当作已整理内容', () => {
  const prepared=prepareMemoryExtraction({...input,previousSummary:'已完成的后续话题',deferredRanges:[{startSeq:1,endSeq:80}]},100000);
  assert.deepEqual(JSON.parse(prepared.userContent).deferredRanges,[{startSeq:1,endSeq:80}]);
  assert.match(prepared.systemPrompt,/previousSummary只覆盖已完成部分/);
  assert.match(prepared.systemPrompt,/不将缺口视为已整理/);
  assert.doesNotMatch(prepareMemoryExtraction(input,100000).systemPrompt,/deferredRanges/);
});

test('saved normalized responses parse offline without API credentials and retain all response failure gates', () => {
  const message = { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify(output) }] };
  assert.deepEqual(parseMemoryResponse(message, input), output);
  assert.throws(() => parseMemoryResponse({ ...message, stopReason: 'length' }, input), /输出长度上限/);
  assert.throws(() => parseMemoryResponse({ ...message, content: [{ type: 'text', text: '{broken' }] }, input), /不是有效 JSON/);
  assert.throws(() => parseMemoryResponse({ ...message, stopReason: 'error', errorMessage: 'HTTP 503 secret-body' }, input), /请求未完成/);
  assert.throws(() => parseMemoryResponse(message, { ...input, selfProfile: {} }), /缺少自我画像/);
});

test('SDK transport errors use zero automatic retries', async t => {
  const f = await fixture(t); f.setMode('http-error');
  await assert.rejects(createMemoryProvider(f.config).extract(input, new AbortController().signal), /请求未完成/);
  assert.equal(f.requests.length, 1);
});

test('uses local Pi model with no embedding interface; DeepSeek thinking stays disabled', async t => {
  const f = await fixture(t);
  const provider = createMemoryProvider(f.config);
  const result = await provider.extract(input, new AbortController().signal);
  assert.deepEqual(result, output);
  const chat = f.requests.find(request => request.url === '/v1/chat/completions');
  assert.equal(chat.headers.authorization, 'Bearer local-model-key');
  assert.equal(chat.body.model, 'deepseek-chat');
  assert.deepEqual(chat.body.thinking, { type: 'disabled' });
  assert.deepEqual(chat.body.response_format, { type: 'json_object' });
  assert.equal(chat.body.max_tokens, 2048);
  assert.ok(chat.body.messages.some(message => message.role === 'system' && message.content.includes('只输出一个严格 JSON')));
  assert.ok(chat.body.messages.some(message => message.role === 'user' && message.content.includes('message-1')));

  assert.equal(provider.embedding,undefined);
  assert.equal(f.requests.length,1);
});

test('model errors, length limits, malformed JSON, and oversized input never return success', async t => {
  const f = await fixture(t);
  const provider = createMemoryProvider(f.config);
  f.setMode('length');
  await assert.rejects(provider.extract(input, new AbortController().signal), /输出长度上限/);
  assert.equal(f.requests.length, 1);
  f.setMode('empty');
  await assert.rejects(provider.extract(input, new AbortController().signal), /没有返回 JSON 文本/);
  assert.equal(f.requests.length, 2);
  f.setMode('invalid-json');
  await assert.rejects(provider.extract(input, new AbortController().signal), /不是有效 JSON/);
  assert.equal(f.requests.length, 3);

  const tooSmall = createMemoryProvider({ ...f.config, contextWindow: 1024, maxOutputTokens: 256 });
  const before = f.requests.length;
  await assert.rejects(tooSmall.extract(input, new AbortController().signal), error => error instanceof MemoryInputTooLargeError);
  assert.equal(f.requests.length, before);
});

test('self profile extraction uses the same model request and requires a self result for captured snapshots', async t => {
  const f = await fixture(t);
  const provider = createMemoryProvider(f.config);
  const selfProfile = { baseVersion: 0, content: '', sourceMessageIds: [],
    pending: [{ id: 'pending-1', content: 'PA 指的是 Personal Agent', sourceMessageId: 'explicit-1' }] };
  // The fixture intentionally returns only old memory fields: do not silently archive self input.
  await assert.rejects(provider.extract({ ...input, selfProfile }, new AbortController().signal), /缺少自我画像/);
  assert.equal(f.requests.length, 1);
  const body = f.requests[0].body;
  assert.equal(body.model, f.config.model);
  assert.ok(body.messages.find(m => m.role === 'system').content.includes('不要求管理者身份'));
  assert.ok(body.messages.find(m => m.role === 'user').content.includes('pending-1'));
});

test('offline preparation rejects obsolete personal-event snapshots before any model call', () => {
  const legacy={...input,profiles:[{personId:'alice',baseVersion:0,facts:[],pending:[{id:'old',content:'事件',sourceMessageId:'message-1',sourceType:'self',purpose:'memory'}]}]};
  assert.throws(()=>prepareMemoryExtraction(legacy,100000),/协议已过期/);
  const prepared=prepareMemoryExtraction(input,100000);
  assert.match(prepared.systemPrompt,/只用于稳定画像/);
  assert.match(prepared.systemPrompt,/不建立个人长期事件记忆/);
});
