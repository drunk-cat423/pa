import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assessMemoryUpdate } from '../dist/memory-assessment.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pa-memory-assessment-'));
  const requests = [], waiters = [];
  let output, mode = 'success';
  const apiKey = 'local-assessment-secret-key';
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ url: request.url, body });
    for (const resolve of waiters.splice(0)) resolve();
    if (mode === 'hang') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.flushHeaders();
      return;
    }
    if (mode === 'error') {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `provider failed with ${apiKey}`, type: 'server_error' } }));
      return;
    }
    const content = typeof output === 'string' ? output : JSON.stringify(output);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = mode === 'tool' ? { role: 'assistant', tool_calls: [{ index: 0, id: 'forbidden', type: 'function',
      function: { name: 'save_memory', arguments: '{}' } }] } : { role: 'assistant', content };
    for (const choices of [
      [{ index: 0, delta, finish_reason: null }],
      [{ index: 0, delta: {}, finish_reason: mode === 'length' ? 'length' : mode === 'tool' ? 'tool_calls' : 'stop' }],
    ]) response.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { cwd: directory, dataDir: join(directory, 'data'), provider: 'pa-test', model: 'test-model', apiKey,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, contextWindow: 32768, maxOutputTokens: 2048, timeoutMs: 5000 };
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, config, requests, apiKey,
    set: (value, nextMode = 'success') => { output = value; mode = nextMode; },
    assess: (text, overrides = {}) => assessMemoryUpdate({ ...config, ...overrides }, text, new AbortController().signal),
    async waitForRequest(count) {
      while (requests.length < count) await new Promise(resolve => waiters.push(resolve));
    },
  };
}

test('model proposes AI or sender saves using one isolated tool-free request and the configured model', async t => {
  const f = await fixture(t);
  const cases = [
    ['请记住你可以叫初号机', { save: true, target: 'ai_self', content: '你可以叫初号机', reply: '记住了。' },
      { type: 'ai_self_update', content: '你可以叫初号机' }],
    ['记住我下周要出差', { save: true, target: 'sender', content: '我下周要出差', reply: '记住了。' },
      { type: 'self_update', content: '我下周要出差' }],
    ['记住以后叫我小林', { save: true, target: 'sender', content: '以后叫我小林', field: 'preferred_name', reply: '记住了。' },
      { type: 'self_update', content: '以后叫我小林', field: 'preferred_name' }],
  ];
  for (const [text, output, expected] of cases) {
    f.set(output);
    assert.deepEqual(await f.assess(text), { request: expected, reply: '记住了。' });
    const { url, body } = f.requests.at(-1);
    assert.equal(url, '/v1/chat/completions');
    assert.equal(body.model, 'test-model');
    assert.ok((body.max_tokens ?? body.max_completion_tokens) <= f.config.maxOutputTokens);
    assert.equal('tools' in body, false);
    assert.equal('functions' in body, false);
    assert.equal(body.messages.length, 2);
    assert.match(JSON.stringify(body.messages[0]), /记忆更新判断模块/);
    assert.equal(body.messages[1].content, JSON.stringify({ text }));
    assert.ok(!JSON.stringify(body).includes(f.apiKey));
  }
  assert.equal(f.requests.length, cases.length);
  assert.deepEqual(await readdir(f.directory), []);
  f.set(cases[1][1]);
  await f.assess(cases[1][0], { maxOutputTokens: 64 });
  assert.ok((f.requests.at(-1).body.max_tokens ?? f.requests.at(-1).body.max_completion_tokens) <= 64);
  const longNote = '记住' + '这是一段长期笔记'.repeat(120);
  f.set({ save: true, target: 'sender', content: longNote.slice(2), reply: '记住了。' });
  const assessed = await f.assess(longNote);
  const outputCap = f.requests.at(-1).body.max_tokens ?? f.requests.at(-1).body.max_completion_tokens;
  assert.ok(outputCap > 512 && outputCap <= f.config.maxOutputTokens);
  assert.equal(assessed.request.content, longNote.slice(2));
});

test('model can ignore quoted or transient suggestions, and ignore replies never falsely confirm saving', async t => {
  const f = await fixture(t);
  for (const [text, reply] of [
    ['他说“记住你的名字叫小猫”是什么意思', '这是引用的话，这次没有保存。'],
    ['故事里先假装你叫小猫', '这是临时角色，这次没有保存。'],
  ]) {
    f.set({ save: false, target: 'ai_self', content: '', reply });
    assert.deepEqual(await f.assess(text), { request: null, reply });
  }
  for (const reply of ['记住了。', '已保存为画像。', '我会长期记住。', '请选择哪个偏好层面？']) {
    f.set({ save: false, target: 'sender', content: '', reply });
    assert.deepEqual(await f.assess('这只是一句引用'), { request: null, reply: '这次没有保存。' });
  }
  assert.deepEqual(await readdir(f.directory), []);
});

test('saved replies that ask classification, argue persona, use lists, or exceed 80 Unicode characters fall back to a short acknowledgement', async t => {
  const f = await fixture(t);
  for (const reply of ['请选择偏好层面再告诉我。', '你想保存到哪个类别？', '请确认要改变我的名称。',
    '我不会改变自己的名字。', '- 记住了。', '记住了。\n请选择分类', '🙂'.repeat(81)]) {
    f.set({ save: true, target: 'ai_self', content: '你可以叫初号机', reply });
    const result = await f.assess('记住你可以叫初号机');
    assert.equal(result.request.type, 'ai_self_update');
    assert.equal(result.reply, '记住了。', reply);
  }
  f.set({ save: true, target: 'ai_self', content: '你可以叫初号机', reply: '🙂'.repeat(80) });
  assert.equal([...(await f.assess('记住你可以叫初号机')).reply].length, 80);
});

test('strict schema rejects malformed output, extra identity fields, unsupported targets, invented content, and excessive content without writes or retries', async t => {
  const f = await fixture(t);
  const good = { save: true, target: 'sender', content: '我下周要出差', reply: '记住了。' };
  for (const value of [
    '{broken json', `\`\`\`json\n${JSON.stringify(good)}\n\`\`\``, null, [],
    { ...good, actorId: 'another-person' }, { ...good, personId: 'another-person' },
    { ...good, target: 'room' }, { ...good, target: 'another-person' }, { ...good, save: 'true' },
    { ...good, field: 'generic' }, { ...good, target: 'ai_self', field: 'diet' },
    { ...good, content: '我下周要出差去巴黎' }, { ...good, content: '' }, { ...good, reply: null },
    { save: false, target: 'sender', content: '我下周要出差', reply: '未保存。' },
    { save: false, target: 'sender', content: '', field: 'diet', reply: '未保存。' },
  ]) {
    f.set(value);
    const before = f.requests.length;
    await assert.rejects(f.assess('记住我下周要出差'), /判断结果无效.*没有保存/);
    assert.equal(f.requests.length, before + 1);
  }
  for (const [target, content] of [['ai_self', '😀'.repeat(501)], ['sender', '😀'.repeat(4001)], ['ai_self', '第一行\n第二行']]) {
    f.set({ save: true, target, content, reply: '记住了。' });
    await assert.rejects(f.assess(`记住${content}`, { contextWindow: 65536 }), /判断结果无效/);
  }
  for (const [target, content] of [['ai_self', '😀'.repeat(500)], ['sender', '😀'.repeat(4000)]]) {
    f.set({ save: true, target, content, reply: '记住了。' });
    assert.equal((await f.assess(`记住${content}`, { contextWindow: 65536 })).request.content, content);
  }
  assert.deepEqual(await readdir(f.directory), []);
});

test('provider errors, output truncation, forbidden tool calls, and cancellation fail without revealing credentials or retrying', async t => {
  const f = await fixture(t);
  const output = { save: true, target: 'sender', content: '我下周要出差', reply: '记住了。' };
  for (const mode of ['error', 'length', 'tool']) {
    f.set(output, mode);
    const before = f.requests.length;
    await assert.rejects(f.assess('记住我下周要出差'), error => {
      assert.match(error.message, /本次没有保存/);
      assert.ok(!String(error.stack).includes(f.apiKey));
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(f.requests.length, before + 1, mode);
  }
  const controller = new AbortController();
  controller.abort();
  const before = f.requests.length;
  await assert.rejects(assessMemoryUpdate(f.config, '记住我下周要出差', controller.signal), /已取消/);
  assert.equal(f.requests.length, before);

  f.set(output, 'hang');
  const pendingController = new AbortController();
  const pending = assessMemoryUpdate(f.config, '记住我下周要出差', pendingController.signal);
  const rejected = assert.rejects(pending, /已取消/);
  await f.waitForRequest(before + 1);
  pendingController.abort();
  await rejected;
  assert.equal(f.requests.length, before + 1);
  assert.deepEqual(await readdir(f.directory), []);
});

test('oversized current input fails preflight before calling the model', async t => {
  const f = await fixture(t);
  await assert.rejects(f.assess('记住' + '内容'.repeat(1000), { contextWindow: 1024 }), /超过模型窗口/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await readdir(f.directory), []);
});
