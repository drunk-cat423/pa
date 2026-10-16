import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createMemoryProvider, MemoryInputTooLargeError, prepareMemoryExtraction } from '../dist/memory-provider.js';

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

async function fixture(t) {
  const requests = [];
  let mode = 'success';
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({ url: request.url, headers: request.headers, body: raw ? JSON.parse(raw) : undefined });
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404); response.end(); return;
    }
    const stopReason = mode === 'length' ? 'length' : 'stop';
    const content = mode === 'invalid-json' ? '{invalid json' : JSON.stringify(output);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: stopReason }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const config = {
    cwd: process.cwd(), dataDir: process.cwd(), provider: 'deepseek', model: 'deepseek-chat', apiKey: 'local-model-key',
    baseUrl, contextWindow: 100_000, maxOutputTokens: 2048, timeoutMs: 5000,
    memory: { enabled: true, maxCalls: 10, timeoutMs: 5000 },
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { config, requests, setMode: value => { mode = value; } };
}

test('uses local Pi model with no embedding interface; DeepSeek thinking stays disabled', async t => {
  const f = await fixture(t);
  const provider = createMemoryProvider(f.config);
  const result = await provider.extract(input, new AbortController().signal);
  assert.deepEqual(result, output);
  const chat = f.requests.find(request => request.url === '/v1/chat/completions');
  assert.equal(chat.headers.authorization, 'Bearer local-model-key');
  assert.equal(chat.body.model, 'deepseek-chat');
  assert.deepEqual(chat.body.thinking, { type: 'disabled' });
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
  f.setMode('invalid-json');
  await assert.rejects(provider.extract(input, new AbortController().signal), /不是有效 JSON/);

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
