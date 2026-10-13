import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createMemoryProvider, MemoryInputTooLargeError } from '../dist/memory-provider.js';

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

async function fixture(t) {
  const requests = [];
  let mode = 'success';
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    requests.push({ url: request.url, headers: request.headers, body: raw ? JSON.parse(raw) : undefined });
    if (request.url === '/v1/embeddings') {
      if (mode === 'hang') return;
      if (mode === 'bad-json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{');
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ embedding: mode === 'bad-dimensions' ? [1] : [0.25, -0.5, 0.75] }] }));
      return;
    }
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
    memory: { enabled: true, maxCalls: 10, timeoutMs: 5000, maxRetries: 2,
      embedding: { url: `${baseUrl}/embeddings`, model: 'local-embed', apiKey: 'local-embed-key', dimensions: 3, maxCalls: 10 } },
  };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { config, requests, setMode: value => { mode = value; } };
}

test('uses local Pi model and explicit embedding endpoint; DeepSeek thinking stays disabled', async t => {
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

  assert.deepEqual(await provider.embedding.embed('杭州行程', new AbortController().signal), [0.25, -0.5, 0.75]);
  const embedding = f.requests.find(request => request.url === '/v1/embeddings');
  assert.equal(embedding.headers.authorization, 'Bearer local-embed-key');
  assert.deepEqual(embedding.body, { model: 'local-embed', input: '杭州行程' });
  assert.deepEqual({ model: provider.embedding.model, dimensions: provider.embedding.dimensions, inputVersion: provider.embedding.inputVersion },
    { model: 'local-embed', dimensions: 3, inputVersion: 1 });
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

test('embedding rejects invalid JSON, wrong dimensions, and aborts promptly', async t => {
  const f = await fixture(t);
  const provider = createMemoryProvider(f.config);
  f.setMode('bad-json');
  await assert.rejects(provider.embedding.embed('text', new AbortController().signal), /无效 JSON/);
  f.setMode('bad-dimensions');
  await assert.rejects(provider.embedding.embed('text', new AbortController().signal), /维度或数值无效/);
  f.setMode('hang');
  const controller = new AbortController();
  const pending = provider.embedding.embed('text', controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error?.name === 'AbortError');
});
