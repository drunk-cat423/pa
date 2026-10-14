import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openConversation, RequestError } from '../dist/runtime.js';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-confirm-'));
  const cwd = join(directory, 'project');
  await mkdir(cwd);
  const requests = [];
  let mode = 'success';
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ url: request.url, body });
    if (mode === 'hang') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      return;
    }
    if (mode === 'error') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'local model failure', type: 'server_error' } }));
      return;
    }
    const content = mode === 'empty' ? '' : mode === 'long' ? '🙂'.repeat(161) : '已保存为待整理建议，我会在整理后再说明结果。';
    const finishReason = mode === 'length' ? 'length' : 'stop';
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choices of [
      [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: finishReason }],
    ]) response.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {
    cwd, dataDir: join(directory, 'data'), provider: 'pa-test', model: 'test-model', apiKey: 'local-key',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 32768,
    maxOutputTokens: 512, timeoutMs: 2000, ...options,
  };
  const runtimes = [];
  async function conversation(id = 'confirmation', overrides = {}) {
    const runtime = await openConversation({ ...config, ...overrides }, id);
    runtimes.push(runtime);
    return runtime;
  }
  t.after(async () => {
    await Promise.allSettled(runtimes.map(runtime => runtime.close()));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { config, conversation, requests, setMode: value => { mode = value; } };
}

test('confirmation uses one isolated, tool-free request capped at 192 tokens', async t => {
  const f = await fixture(t);
  const runtime = await f.conversation();
  await runtime.prompt('SECRET_PRIOR_CONVERSATION');
  const before = runtime.info().messageCount;
  const result = await runtime.confirmSavedUpdate('请把偏好改为简短回答', '已保存为待整理 AI 自我画像建议');
  assert.match(result, /已保存/);
  assert.equal(f.requests.length, 2);
  const request = f.requests[1];
  assert.equal(request.url, '/v1/chat/completions');
  assert.ok((request.body.max_tokens ?? request.body.max_completion_tokens) <= 192, JSON.stringify(request.body));
  assert.equal('tools' in request.body, false);
  assert.equal('functions' in request.body, false);
  const encoded = JSON.stringify(request.body.messages);
  assert.doesNotMatch(encoded, /SECRET_PRIOR_CONVERSATION/);
  assert.match(encoded, /请把偏好改为简短回答/);
  assert.match(encoded, /已保存为待整理 AI 自我画像建议/);
  assert.equal(runtime.info().messageCount, before);
});

test('model and output failures become RequestError and are not retried', async t => {
  const f = await fixture(t);
  const runtime = await f.conversation();
  for (const mode of ['error', 'length', 'empty', 'long']) {
    f.setMode(mode);
    const before = f.requests.length;
    await assert.rejects(runtime.confirmSavedUpdate('更新', '已保存'), error => error instanceof RequestError);
    assert.equal(f.requests.length, before + 1, `${mode} should make exactly one request`);
  }
});

test('abort, close, and configured timeout cancel the lightweight request', async t => {
  const f = await fixture(t, { timeoutMs: 5000 });
  const runtime = await f.conversation();
  f.setMode('hang');
  const cancelled = runtime.confirmSavedUpdate('更新', '已保存');
  await new Promise(resolve => setTimeout(resolve, 30));
  await runtime.abort();
  await assert.rejects(cancelled, error => error instanceof RequestError && error.kind === 'cancelled');

  const closing = await f.conversation('closing');
  const closingRequest = closing.confirmSavedUpdate('更新', '已保存');
  await new Promise(resolve => setTimeout(resolve, 30));
  await closing.close();
  await assert.rejects(closingRequest, error => error instanceof RequestError && error.kind === 'cancelled');

  const short = await f.conversation('timeout-short', { timeoutMs: 120 });
  const request = short.confirmSavedUpdate('更新', '已保存');
  await assert.rejects(request, error => error instanceof RequestError && error.kind === 'timeout');
  assert.equal(f.requests.length, 3);
});
